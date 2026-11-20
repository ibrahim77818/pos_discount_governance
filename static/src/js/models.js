/** @odoo-module */

import { patch } from "@web/core/utils/patch";
import { _t } from "@web/core/l10n/translation";
import { PosStore } from "@point_of_sale/app/store/pos_store";
import { PosOrder } from "@point_of_sale/app/models/pos_order";
import { PosOrderline } from "@point_of_sale/app/models/pos_order_line";
import { DiscountGovernance, fmt, formatPct } from "@pos_discount_governance/js/governance";

patch(PosStore.prototype, {
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
    set_discount(discount) {
        super.set_discount(...arguments);
        if (!this.get_discount()) {
            this.discount_mode = "percent";
            this.discount_fixed_amount = 0;
            this.discount_log_uid = false;
        }
    },
    set_quantity() {
        const result = super.set_quantity(...arguments);
        // A fixed discount stays a fixed amount when the quantity changes.
        const gov = dgStore.pos?.discountGovernance;
        if (this.discount_mode === "fixed" && this.discount_fixed_amount && gov) {
            gov.reapplyFixedLineDiscount(this);
        }
        return result;
    },
    get_discount_str() {
        // Display only; the exact percentage is what gets synced.
        return formatPct(this.get_discount());
    },
    getDisplayData() {
        // Used by the order widget and the receipt.
        const data = super.getDisplayData(...arguments);
        if (this.discount_mode === "fixed" && this.discount_fixed_amount && dgStore.pos) {
            // A fixed discount shows as an amount, not as its percentage.
            data.discount = "0";
            data.dgFixedDiscount = fmt(
                _t("Discount: %s"),
                dgStore.pos.env.utils.formatCurrency(this.discount_fixed_amount)
            );
        }
        return data;
    },
});

/** Records have no handle on the store in Odoo 18: keep one here. */
export const dgStore = { pos: null };
patch(PosStore.prototype, {
    async setup() {
        dgStore.pos = this;
        return await super.setup(...arguments);
    },
});
