/** @odoo-module */

import { patch } from "@web/core/utils/patch";
import { _t } from "@web/core/l10n/translation";
import { AlertDialog } from "@web/core/confirmation_dialog/confirmation_dialog";
import { ControlButtons } from "@point_of_sale/app/screens/product_screen/control_buttons/control_buttons";
import { runDiscountFlow } from "@pos_discount_governance/js/discount_flow";
// Load after pos_discount's own patch of ControlButtons.
import "@pos_discount/app/screens/product_screen/control_buttons/control_buttons";

patch(ControlButtons.prototype, {
    async clickDiscount() {
        await runDiscountFlow({ pos: this.pos, dialog: this.dialog }, "global");
    },
    /**
     * Programmatic callers of the original API (Odoo 20: value + "percent" or
     * "fixed") are routed through the cent-exact planner, without the UI steps.
     */
    async applyDiscount(value, type = "percent") {
        const gov = this.pos.discountGovernance;
        const order = this.pos.getOrder();
        const mode = type === "fixed" ? "fixed" : "percent";
        const plan = gov.planGlobal(order, mode, value);
        if (plan.error) {
            this.dialog.add(AlertDialog, { title: _t("Invalid discount"), body: plan.error });
            return;
        }
        const uid = gov.newLogUid(order);
        await gov.applyGlobalPlan(order, plan, mode, value, uid);
        gov.logDiscount(order, {
            uid,
            scope: "global",
            mode,
            value,
            plan,
            line: null,
            authorizer: null,
            auth: null,
            escalated: false,
        });
    },
});
