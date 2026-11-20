# -*- coding: utf-8 -*-
"""Cent-exact invoices for POS fixed-amount discounts.

``account.move.line.discount`` is rounded to the 'Discount' decimal
precision (2 digits by default), while ``pos.order.line.discount`` keeps full
precision. A fixed discount of 0.05 on 1000 x 10.05 is 0.000497...%: rounded
to 0.00% the invoice would show 10,050.00 instead of 10,049.95 and the session
would no longer reconcile.

The POS invoice line therefore also carries ``pos_discount_exact``. While the
visible ``discount`` still matches it (i.e. nobody edited the line), the
taxes computation uses the exact value. Since Odoo 18 the invoice discount
itself keeps full precision and Odoo 20 no longer goes through the POS hook
that filled this field: it is kept for invoices created by earlier versions.
"""
from odoo import api, fields, models
from odoo.tools import float_compare, float_round


class AccountMoveLine(models.Model):
    _inherit = 'account.move.line'

    pos_discount_exact = fields.Float(
        string='Exact POS Discount (%)', digits=0, copy=False,
        help="Full-precision discount coming from the Point of Sale.")

    def _dg_effective_discount(self):
        self.ensure_one()
        exact = self.pos_discount_exact
        if not exact:
            return self.discount
        digits = self.env['decimal.precision'].precision_get('Discount')
        if float_compare(float_round(exact, precision_digits=digits), self.discount,
                         precision_digits=digits) == 0:
            return exact
        return self.discount

    @api.depends('quantity', 'discount', 'price_unit', 'tax_ids', 'currency_id', 'amount_currency',
                 'pos_discount_exact')
    def _compute_totals(self):
        return super()._compute_totals()


class AccountMove(models.Model):
    _inherit = 'account.move'

    def _prepare_product_base_line_for_taxes_computation(self, product_line):
        base_line = super()._prepare_product_base_line_for_taxes_computation(product_line)
        if product_line.pos_discount_exact and self.is_invoice(include_receipts=True):
            base_line['discount'] = product_line._dg_effective_discount()
        return base_line
