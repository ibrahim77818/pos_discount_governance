/** @odoo-module */

import { patch } from "@web/core/utils/patch";
import { _t } from "@web/core/l10n/translation";
import { AlertDialog } from "@web/core/confirmation_dialog/confirmation_dialog";
import { PaymentScreen } from "@point_of_sale/app/screens/payment_screen/payment_screen";

/**
 * Last in-memory gate before the order is validated: the same rules the
 * server applies in _process_order, so a governed order never gets stuck in
 * the synchronisation queue.
 */
patch(PaymentScreen.prototype, {
    async validateOrder(isForceValidate) {
        const gov = this.pos.discountGovernance;
        if (gov) {
            const problems = gov.orderViolations(this.currentOrder);
            if (problems.length) {
                this.dialog.add(AlertDialog, {
                    title: _t("Discount not authorized"),
                    body:
                        problems.join("\n") +
                        "\n\n" +
                        _t("Adjust the discounts or ask a supervisor to approve them."),
                });
                return;
            }
        }
        return super.validateOrder(...arguments);
    },
});
