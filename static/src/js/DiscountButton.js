odoo.define('pos_discount_governance.DiscountButton', function (require) {
    'use strict';

    const DiscountButton = require('pos_discount.DiscountButton');
    const Registries = require('point_of_sale.Registries');
    const { runDiscountFlow } = require('pos_discount_governance.discount_flow');

    const DGDiscountButton = (DiscountButton) => class DGDiscountButton extends DiscountButton {
        async onClick() {
            await runDiscountFlow(this, 'global');
        }
        /**
         * Programmatic callers of the original API (percentage only) are
         * routed through the cent-exact planner, without the UI steps.
         */
        async apply_discount(pc) {
            const gov = this.env.pos.discountGovernance;
            const order = this.env.pos.get_order();
            const plan = gov.planGlobal(order, 'percent', pc);
            if (plan.error) {
                await this.showPopup('ErrorPopup', { title: this.env._t('Invalid discount'), body: plan.error });
                return;
            }
            const uid = gov.newLogUid(order);
            await gov.applyGlobalPlan(order, plan, 'percent', pc, uid);
            gov.logDiscount(order, { uid, scope: 'global', mode: 'percent', value: pc, plan, line: null, authorizer: null, auth: null, escalated: false });
        }
    };

    Registries.Component.extend(DiscountButton, DGDiscountButton);
    return DiscountButton;
});
