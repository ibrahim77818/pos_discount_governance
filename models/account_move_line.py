# -*- coding: utf-8 -*-
"""Cent-exact invoices for POS fixed-amount discounts.

``account.move.line.discount`` is rounded to the 'Discount' decimal
precision (2 digits by default), while ``pos.order.line.discount`` keeps full
precision. A fixed discount of 0.05 on 1000 x 10.05 is 0.000497...%: rounded
to 0.00% the invoice would show 10,050.00 instead of 10,049.95 and the session
would no longer reconcile.

The POS invoice line therefore also carries ``pos_discount_exact``. While the
visible ``discount`` still matches it (i.e. nobody edited the line), totals
and tax base lines use the exact value. Odoo 17 derives the product line
balance from ``price_subtotal`` (``_sync_invoice``) and the tax lines from
``_convert_to_tax_base_line_dict``, so these two hooks are sufficient.
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

    @api.depends('quantity', 'discount', 'price_unit', 'tax_ids', 'currency_id', 'pos_discount_exact')
    def _compute_totals(self):
        super()._compute_totals()
        for line in self.filtered(lambda l: l.display_type == 'product' and l.pos_discount_exact):
            discount = line._dg_effective_discount()
            if discount == line.discount:
                continue
            price = line.price_unit * (1 - (discount / 100.0))
            if line.tax_ids:
                taxes_res = line.tax_ids.compute_all(
                    price, quantity=line.quantity, currency=line.currency_id,
                    product=line.product_id, partner=line.partner_id, is_refund=line.is_refund)
                line.price_subtotal = taxes_res['total_excluded']
                line.price_total = taxes_res['total_included']
            else:
                line.price_total = line.price_subtotal = line.currency_id.round(price * line.quantity)

    def _convert_to_tax_base_line_dict(self):
        res = super()._convert_to_tax_base_line_dict()
        if self.pos_discount_exact and self.move_id.is_invoice(include_receipts=True):
            res['discount'] = self._dg_effective_discount()
        return res
