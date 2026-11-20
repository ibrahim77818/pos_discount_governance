/** @odoo-module */

import { patch } from "@web/core/utils/patch";
import { accountTaxHelpers } from "@account/helpers/account_tax";
import { roundPrecision as round_pr } from "@web/core/utils/numbers";
import { PosStore } from "@point_of_sale/app/services/pos_store";
import { TicketScreen } from "@point_of_sale/app/screens/ticket_screen/ticket_screen";
import * as engine from "@pos_discount_governance/js/discount_engine";
// Load after pos_discount's own patches, so ours wrap them.
import "@pos_discount/app/services/pos_store";
import "@pos_discount/app/screens/ticket_screen/ticket_screen";

/**
 * Refunds of orders with a global discount.
 *
 * Odoo's pos_discount rebuilds the refund's discount lines as a plain
 * before-tax percentage read from extra_tax_data, which governed discount
 * lines do not carry (they must not: pos_discount would otherwise re-price
 * them on every line change). Governed discounts can also be fixed amounts
 * or after-tax, so the refund instead returns each original discount line
 * in proportion to what is refunded from its tax group:
 *  - a full refund returns the original discount lines exactly;
 *  - partial refunds return a share, and the last one returns the
 *    remainder, so all refunds together equal the original discount.
 */
patch(PosStore.prototype, {
    async applyDiscount(percent, order) {
        if (this._dgRefundInProgress) {
            return;
        }
        return await super.applyDiscount(...arguments);
    },
});

function sortedKey(taxes) {
    return taxes.map((t) => t.id).sort((a, b) => a - b).join(",");
}

patch(TicketScreen.prototype, {
    async onDoRefund() {
        const source = this.getSelectedOrder();
        this.pos._dgRefundInProgress = true;
        try {
            await super.onDoRefund(...arguments);
        } finally {
            this.pos._dgRefundInProgress = false;
        }
        const destination = this.pos.getOrder();
        if (source && destination && destination !== source) {
            this._dgAddRefundDiscountLines(source, destination);
        }
    },

    _dgAddRefundDiscountLines(source, destination) {
        const gov = this.pos.discountGovernance;
        if (!gov) {
            return;
        }
        const discountLines = source.lines.filter(
            (line) => gov.isGlobalDiscountLine(line) && !line.refunded_orderline_id
        );
        if (!discountLines.length) {
            return;
        }
        const destLines = destination.lines;
        const refundsSource = destLines.some(
            (line) => line.refunded_orderline_id && line.refunded_orderline_id.order_id === source
        );
        const alreadyDone = destLines.some(
            (line) => line.refunded_orderline_id && discountLines.includes(line.refunded_orderline_id)
        );
        if (!refundsSource || alreadyDone) {
            return;
        }
        const policy = gov.policy;
        const rounding = gov.rounding;

        // Value of each tax group of the original order, and the share of it
        // refunded before this refund and including this refund.
        const groups = new Map();
        for (const line of source.lines) {
            if (gov.isGlobalDiscountLine(line) || line.refunded_orderline_id || line.is_reward_line) {
                continue;
            }
            if (typeof line.isGlobalDiscountApplicable === "function" && !line.isGlobalDiscountApplicable()) {
                continue;
            }
            const qty = line.getQuantity();
            if (!qty) {
                continue;
            }
            const taxes = engine
                .lineTaxes(this.pos, line)
                .filter((tax) => accountTaxHelpers.can_be_discounted(tax));
            const key = sortedKey(taxes);
            const value = policy === "after_tax" ? line.priceIncl : line.priceExcl;
            const unit = value / qty;
            const inThisRefund = destLines
                .filter((l) => l.refunded_orderline_id === line)
                .reduce((sum, l) => sum - l.getQuantity(), 0);
            const refundedAfter = line.refundedQty;
            const refundedBefore = refundedAfter - inThisRefund;
            if (!groups.has(key)) {
                groups.set(key, { total: 0, before: 0, after: 0 });
            }
            const group = groups.get(key);
            group.total += value;
            group.before += unit * refundedBefore;
            group.after += unit * refundedAfter;
        }

        for (const discountLine of discountLines) {
            const group = groups.get(sortedKey(discountLine.tax_ids));
            if (!group || !group.total) {
                continue;
            }
            const clamp = (x) => Math.min(1, Math.max(0, x));
            const amount = discountLine.price_unit * discountLine.getQuantity();
            const shareBefore = clamp(group.before / group.total);
            const shareAfter = clamp(group.after / group.total);
            const price = round_pr(
                round_pr(amount * shareAfter, rounding) - round_pr(amount * shareBefore, rounding),
                rounding
            );
            if (engine.isZero(price, rounding)) {
                continue;
            }
            this.pos.models["pos.order.line"].create({
                qty: -1,
                price_unit: price,
                product_id: discountLine.product_id,
                order_id: destination,
                discount: 0,
                tax_ids: discountLine.tax_ids.map((tax) => ["link", tax]),
                refunded_orderline_id: discountLine,
                price_type: "manual",
            });
        }
    },
});
