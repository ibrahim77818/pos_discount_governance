odoo.define('pos_discount_governance.NumpadWidget', function (require) {
    'use strict';

    const NumpadWidget = require('point_of_sale.NumpadWidget');
    const Registries = require('point_of_sale.Registries');
    const { runDiscountFlow } = require('pos_discount_governance.discount_flow');

    /**
     * "% Disc" opens the governed discount flow instead of switching the
     * numpad to discount mode, so the discount is validated once (not on
     * every keystroke) and can be a fixed amount.
     */
    const DGNumpadWidget = (NumpadWidget) => class DGNumpadWidget extends NumpadWidget {
        async changeMode(mode) {
            if (mode === 'discount' && this.env.pos.discountGovernance) {
                if (!this.env.pos.config.manual_discount) {
                    return;
                }
                await runDiscountFlow(this, 'line');
                return;
            }
            return super.changeMode(...arguments);
        }
    };

    Registries.Component.extend(NumpadWidget, DGNumpadWidget);
    return NumpadWidget;
});
