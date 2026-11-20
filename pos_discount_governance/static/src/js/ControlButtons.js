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
     * Programmatic callers of the original API (percentage only) are routed
     * through the cent-exact planner, without the UI steps.
     */
    async applyDiscount(pc) {
        const gov = this.pos.discountGovernance;
        const order = this.pos.getOrder();
        const plan = gov.planGlobal(order, "percent", pc);
        if (plan.error) {
            this.dialog.add(AlertDialog, { title: _t("Invalid discount"), body: plan.error });
            return;
        }
        const uid = gov.newLogUid(order);
        await gov.applyGlobalPlan(order, plan, "percent", pc, uid);
        gov.logDiscount(order, {
            uid,
            scope: "global",
            mode: "percent",
            value: pc,
            plan,
            line: null,
            authorizer: null,
            auth: null,
            escalated: false,
        });
    },
});
