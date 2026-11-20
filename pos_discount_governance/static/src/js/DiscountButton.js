/** @odoo-module */

import { patch } from "@web/core/utils/patch";
import { _t } from "@web/core/l10n/translation";
import { ErrorPopup } from "@point_of_sale/app/errors/popups/error_popup";
import { DiscountButton } from "@pos_discount/overrides/components/discount_button/discount_button";
import { runDiscountFlow } from "@pos_discount_governance/js/discount_flow";

patch(DiscountButton.prototype, {
    async click() {
        await runDiscountFlow({ pos: this.pos, popup: this.popup }, "global");
    },
    /**
     * Programmatic callers of the original API (percentage only) are routed
     * through the cent-exact planner, without the UI steps.
     */
    async apply_discount(pc) {
        const gov = this.pos.discountGovernance;
        const order = this.pos.get_order();
        const plan = gov.planGlobal(order, "percent", pc);
        if (plan.error) {
            await this.popup.add(ErrorPopup, { title: _t("Invalid discount"), body: plan.error });
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
