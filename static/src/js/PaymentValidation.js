/** @odoo-module */

import { patch } from "@web/core/utils/patch";
import { _t } from "@web/core/l10n/translation";
import { AlertDialog } from "@web/core/confirmation_dialog/confirmation_dialog";
import OrderPaymentValidation from "@point_of_sale/app/utils/order_payment_validation";

/**
 * Last in-memory gate before the order is validated: the same rules the
 * server applies in _process_order, so a governed order never gets stuck in
 * the synchronisation queue. Odoo 20 validates every order (payment screen
 * and fast payment buttons) through OrderPaymentValidation.
 */
patch(OrderPaymentValidation.prototype, {
    async validateOrder(isForceValidate) {
        const gov = this.pos.discountGovernance;
        const order = this.order;
        if (gov && order) {
            const problems = gov.orderViolations(order);
            if (problems.length) {
                this.pos.dialog.add(AlertDialog, {
                    title: _t("Discount not authorized"),
                    body:
                        problems.join("\n") +
                        "\n\n" +
                        _t("Adjust the discounts or ask a supervisor to approve them."),
                });
                return false;
            }
        }
        return super.validateOrder(...arguments);
    },
});
