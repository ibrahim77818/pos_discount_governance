# -*- coding: utf-8 -*-
"""Pure discount arithmetic shared by the backend validation, the invoice
precision fix and the automated tests.

The JavaScript twin lives in ``static/src/js/discount_engine.js``; both
implementations follow the same algorithm step by step so the POS frontend
and the server always land on the same cent.

Core idea
---------
Odoo stores a line discount as a percentage (``pos.order.line.discount`` has
``digits=0``, i.e. full float precision). A *fixed* discount is therefore
converted into the exact percentage that makes the rounded line total drop by
exactly the requested amount, under the configured tax policy. Because the
percentage is solved against Odoo's own ``compute_all`` (same rounding as the
order, the invoice and the session entries), every document reconciles.
"""
import math

from odoo import api, models, _
from odoo.exceptions import UserError
from odoo.tools import float_is_zero

TAX_POLICY_SELECTION = [
    ('before_tax', 'Before Tax'),
    ('after_tax', 'After Tax'),
]
DISCOUNT_MODE_SELECTION = [
    ('percent', 'Percentage'),
    ('fixed', 'Fixed Amount'),
]
AUTH_METHOD_SELECTION = [
    ('badge', 'Badge Scan'),
    ('pin', 'PIN Code'),
    ('both', 'Badge + PIN'),
]

_MAX_ITERATIONS = 8
_PRICE_PROBE = 10000.0


class PosDiscountEngine(models.AbstractModel):
    _name = 'pos.discount.engine'
    _description = 'POS Discount Computation Engine'

    # ------------------------------------------------------------------
    # Basic helpers
    # ------------------------------------------------------------------
    @api.model
    def _dg_basis_key(self, policy):
        return 'total_included' if policy == 'after_tax' else 'total_excluded'

    @api.model
    def _dg_line_total(self, taxes, price_unit, qty, discount, currency,
                       policy='before_tax', product=None, partner=None):
        """Rounded line total (excluded or included, depending on policy),
        computed exactly as pos.order.line / account.move.line do it."""
        price = price_unit * (1.0 - (discount or 0.0) / 100.0)
        if taxes:
            res = taxes.compute_all(price, currency, qty, product=product, partner=partner)
            return res[self._dg_basis_key(policy)]
        return currency.round(price * qty)

    @api.model
    def _dg_price_digits(self, currency):
        """Precision used for prices of global discount lines: the coarser
        of the currency precision and the 'Product Price' precision, so the
        price survives the account.move.line rounding untouched."""
        product_digits = self.env['decimal.precision'].precision_get('Product Price')
        return min(currency.decimal_places, product_digits)

    # ------------------------------------------------------------------
    # Line discounts
    # ------------------------------------------------------------------
    @api.model
    def _dg_solve_percent(self, evaluate, reduction, currency, guess=None):
        """Find the discount percentage p so that evaluate(0) - evaluate(p)
        equals ``reduction`` (in absolute value) to the cent.

        ``evaluate`` is linear in p up to rounding, so a secant start followed
        by a few Newton corrections converges immediately.
        Returns None when the reduction exceeds the line value.
        """
        if currency.is_zero(reduction) or reduction < 0:
            return 0.0
        f0 = evaluate(0.0)
        f100 = evaluate(100.0)
        span = f0 - f100
        if float_is_zero(span, precision_rounding=currency.rounding):
            return None
        if currency.compare_amounts(reduction, abs(span)) > 0:
            return None
        sign = 1.0 if span > 0 else -1.0
        target = currency.round(f0 - sign * reduction)
        pct = guess if guess is not None else reduction / abs(span) * 100.0
        best = (math.inf, pct)
        for _i in range(_MAX_ITERATIONS):
            pct = min(max(pct, 0.0), 100.0)
            diff = currency.round(evaluate(pct) - target)
            if abs(diff) < best[0]:
                best = (abs(diff), pct)
            if currency.is_zero(diff):
                return pct
            pct += diff / span * 100.0
        return best[1]

    @api.model
    def _dg_compute_line_discount(self, taxes, price_unit, qty, mode, value, policy,
                                  currency, product=None, partner=None):
        """Translate a cashier input (mode + value) into the exact line
        discount percentage.

        :return: dict(percent=<exact %>, amount=<reduction in policy basis>,
                      base=<undiscounted line total in policy basis>)
        """
        def evaluate(pct):
            return self._dg_line_total(taxes, price_unit, qty, pct, currency,
                                       policy=policy, product=product, partner=partner)

        f0 = evaluate(0.0)
        if mode == 'percent':
            value = min(max(value or 0.0, 0.0), 100.0)
            if policy == 'before_tax':
                pct = value
            else:
                reduction = currency.round(abs(f0) * value / 100.0)
                pct = self._dg_solve_percent(evaluate, reduction, currency, guess=value)
        else:
            reduction = currency.round(value or 0.0)
            pct = self._dg_solve_percent(evaluate, reduction, currency)
        if pct is None:
            raise UserError(_("The discount exceeds the line total."))
        amount = currency.round(abs(f0 - evaluate(pct)))
        return {'percent': pct, 'amount': amount, 'base': abs(f0)}

    # ------------------------------------------------------------------
    # Global discounts
    # ------------------------------------------------------------------
    @api.model
    def _dg_split_proportional(self, amount, weights, currency):
        """Split ``amount`` proportionally to ``weights`` using the largest
        remainder method so the parts sum exactly to ``amount``.
        Ties go to the earliest weight (same rule as the JS twin)."""
        weights = [abs(w) for w in weights]
        total_weight = sum(weights)
        if not weights or float_is_zero(total_weight, precision_digits=12):
            return [0.0 for _w in weights]
        unit = currency.rounding
        total_units = int(round(amount / unit))
        raw = [total_units * w / total_weight for w in weights]
        floors = [int(math.floor(r + 1e-9)) for r in raw]
        remainder = total_units - sum(floors)
        order = sorted(range(len(raw)), key=lambda i: (-(raw[i] - floors[i]), i))
        for i in order[:max(remainder, 0)]:
            floors[i] += 1
        return [currency.round(u * unit) for u in floors]

    @api.model
    def _dg_solve_discount_line_price(self, taxes, reduction, policy, currency):
        """Price of a qty-1 discount line carrying ``taxes`` whose total (in
        the policy basis) equals ``-reduction`` to the cent. The price is
        rounded to a precision that survives invoicing unchanged."""
        def evaluate(price):
            return self._dg_line_total(taxes, price, 1.0, 0.0, currency, policy=policy)

        digits = self._dg_price_digits(currency)
        step = 10 ** -digits
        a = evaluate(0.0)
        slope = (evaluate(_PRICE_PROBE) - a) / _PRICE_PROBE
        if float_is_zero(slope, precision_digits=9):
            return -reduction
        ideal = round((-reduction - a) / slope, digits)
        target = currency.round(-reduction)
        best = (math.inf, ideal)
        for k in (0, -1, 1, -2, 2, -3, 3):
            price = round(ideal + k * step, digits)
            diff = abs(currency.round(evaluate(price) - target))
            if diff < best[0]:
                best = (diff, price)
            if currency.is_zero(diff):
                return price
        return best[1]

    @api.model
    def _dg_plan_global_discount(self, groups, mode, value, policy, currency):
        """Plan the global discount lines.

        :param groups: list of dict(taxes=<account.tax recordset>,
                                    excluded=<float>, included=<float>)
        :return: dict(lines=[dict(taxes, price, amount)], amount, percent, base)
        """
        key = 'included' if policy == 'after_tax' else 'excluded'
        bases = [g[key] for g in groups]
        base = sum(bases)
        if currency.compare_amounts(base, 0.0) <= 0:
            raise UserError(_("There is nothing to discount on this order."))
        if mode == 'percent':
            value = min(max(value or 0.0, 0.0), 100.0)
            total = currency.round(base * value / 100.0)
        else:
            total = currency.round(value or 0.0)
            if currency.compare_amounts(total, base) > 0:
                raise UserError(_("The discount exceeds the order total."))
        parts = self._dg_split_proportional(total, bases, currency)
        lines = []
        for group, part in zip(groups, parts):
            if currency.is_zero(part):
                continue
            price = self._dg_solve_discount_line_price(group['taxes'], part, policy, currency)
            lines.append({'taxes': group['taxes'], 'price': price, 'amount': part})
        return {
            'lines': lines,
            'amount': total,
            'base': base,
            'percent': total / base * 100.0 if base else 0.0,
        }
