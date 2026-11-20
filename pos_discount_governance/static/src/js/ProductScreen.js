/** @odoo-module */

import { patch } from "@web/core/utils/patch";
import { ProductScreen } from "@point_of_sale/app/screens/product_screen/product_screen";
import { runDiscountFlow } from "@pos_discount_governance/js/discount_flow";

/**
 * "% Disc" opens the governed discount flow instead of switching the numpad
 * to discount mode, so the discount is validated once (not on every
 * keystroke) and can be a fixed amount.
 */
patch(ProductScreen.prototype, {
    async onNumpadClick(buttonValue) {
        if (buttonValue === "discount" && this.pos.discountGovernance) {
            if (!this.pos.config.manual_discount) {
                return;
            }
            this.numberBuffer.capture();
            this.numberBuffer.reset();
            this.pos.numpadMode = "quantity";
            await runDiscountFlow({ pos: this.pos, popup: this.popup }, "line");
            return;
        }
        return super.onNumpadClick(...arguments);
    },
});
