/** @odoo-module */

import { patch } from "@web/core/utils/patch";
import { _t } from "@web/core/l10n/translation";
import { PosStore } from "@point_of_sale/app/services/pos_store";
import { PosOrder } from "@point_of_sale/app/models/pos_order";
import { PosOrderline } from "@point_of_sale/app/models/pos_order_line";
import { Orderline } from "@point_of_sale/app/components/orderline/orderline";
import { DiscountGovernance, fmt, formatPct } from "@pos_discount_governance/js/governance";

/** Records have no handle on the store: keep one here. */
export const dgStore = { pos: null };

patch(PosStore.prototype, {
    async setup() {
        dgStore.pos = this;
        return await super.setup(...arguments);
    },
    async afterProcessServerData() {
        await super.afterProcessServerData(...arguments);
        // Built once per session from the loaded models: later checks are in-memory.
        this.discountGovernance = new DiscountGovernance(this);
    },
});

patch(PosOrder.prototype, {
    setup(vals) {
        super.setup(...arguments);
        if (!this.discount_tax_policy) {
            this.discount_tax_policy = this.config?.discount_tax_policy || "before_tax";
        }
    },
    /** Audit entries are kept in a synced text field (persisted and sent with the order). */
    getDiscountLogs() {
        try {
            return JSON.parse(this.dg_discount_log_payload || "[]");
        } catch {
            return [];
        }
    },
    addDiscountLog(entry) {
        this.dg_discount_log_payload = JSON.stringify([...this.getDiscountLogs(), entry]);
    },
});

patch(PosOrderline.prototype, {
    setup(vals) {
        super.setup(...arguments);
        this.discount_mode = this.discount_mode || "percent";
        this.discount_fixed_amount = this.discount_fixed_amount || 0;
        this.discount_log_uid = this.discount_log_uid || false;
    },
    setDiscount(discount) {
        super.setDiscount(...arguments);
        if (!this.getDiscount()) {
            this.discount_mode = "percent";
            this.discount_fixed_amount = 0;
            this.discount_log_uid = false;
        }
    },
    setQuantity() {
        const result = super.setQuantity(...arguments);
        // A fixed discount stays a fixed amount when the quantity changes.
        const gov = dgStore.pos?.discountGovernance;
        if (this.discount_mode === "fixed" && this.discount_fixed_amount && gov) {
            gov.reapplyFixedLineDiscount(this);
        }
        return result;
    },
    getDiscountStr() {
        // Display only; the exact percentage is what gets synced.
        return formatPct(this.getDiscount());
    },
    /** Text shown instead of the percentage for a fixed-amount discount. */
    get dgFixedDiscountText() {
        if (this.discount_mode !== "fixed" || !this.discount_fixed_amount || !dgStore.pos) {
            return false;
        }
        return fmt(
            _t("Discount: %s"),
            dgStore.pos.env.utils.formatCurrency(this.discount_fixed_amount)
        );
    },
});

/** Order widget and receipt: a fixed discount shows as an amount. */
patch(Orderline.prototype, {
    get lineScreenValues() {
        const vals = super.lineScreenValues;
        const text = this.line?.dgFixedDiscountText;
        if (text && vals.discount && !this.props.basic_receipt) {
            vals.discount = false;
            vals.dgFixedDiscount = text;
        }
        return vals;
    },
});
