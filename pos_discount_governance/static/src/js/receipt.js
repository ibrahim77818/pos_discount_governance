/** @odoo-module */

import { patch } from "@web/core/utils/patch";
import { _t } from "@web/core/l10n/translation";
import { GeneratePrinterData } from "@point_of_sale/app/utils/printer/generate_printer_data";
import { fmt, formatPct } from "@pos_discount_governance/js/governance";

/**
 * Odoo 20 receipts are a QWeb template fed with line data, built here in the
 * POS and by pos.order._order_receipt_generate_line_data() on the server.
 * Same keys on both sides: dg_discount_pct (percentage without float noise)
 * and dg_discount_text (a fixed-amount discount shown as an amount).
 */
patch(GeneratePrinterData.prototype, {
    generateLineData() {
        const data = super.generateLineData(...arguments);
        const lines = this.order.lines;
        for (const [index, vals] of data.entries()) {
            const line = lines[index];
            if (!line || !line.discount) {
                continue;
            }
            vals.dg_discount_pct = formatPct(line.discount);
            if (line.discount_mode === "fixed" && line.discount_fixed_amount) {
                vals.dg_discount_text = fmt(
                    _t("Discount: %s"),
                    this.formatCurrency(line.discount_fixed_amount)
                );
            }
        }
        return data;
    },
});
