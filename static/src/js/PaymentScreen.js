odoo.define('pos_discount_governance.PaymentScreen', function (require) {
    'use strict';

    const PaymentScreen = require('point_of_sale.PaymentScreen');
    const Registries = require('point_of_sale.Registries');

    /**
     * Last in-memory gate before the order is validated: the same rules the
     * server applies in _process_order, so a governed order never gets stuck
     * in the synchronisation queue.
     */
    const DGPaymentScreen = (PaymentScreen) => class DGPaymentScreen extends PaymentScreen {
        async validateOrder(isForceValidate) {
            const gov = this.env.pos.discountGovernance;
            if (gov) {
                const problems = gov.orderViolations(this.currentOrder);
                if (problems.length) {
                    await this.showPopup('ErrorPopup', {
                        title: this.env._t('Discount not authorized'),
                        body: problems.join('\n') + '\n\n' +
                            this.env._t('Adjust the discounts or ask a supervisor to approve them.'),
                    });
                    return;
                }
            }
            return super.validateOrder(...arguments);
        }
    };

    Registries.Component.extend(PaymentScreen, DGPaymentScreen);
    return PaymentScreen;
});
