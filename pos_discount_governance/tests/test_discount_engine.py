# -*- coding: utf-8 -*-
from odoo.exceptions import UserError
from odoo.tests import TransactionCase, tagged


@tagged('post_install', '-at_install', 'pos_discount_governance')
class TestDiscountEngine(TransactionCase):
    """Pure arithmetic: fixed-amount rounding, tax policies, global splits."""

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.engine = cls.env['pos.discount.engine']
        cls.currency = cls.env.ref('base.USD')
        cls.currency.rounding = 0.01
        Tax = cls.env['account.tax']
        common = {'amount_type': 'percent', 'type_tax_use': 'sale', 'company_id': cls.env.company.id}
        cls.tax15 = Tax.create(dict(common, name='DG 15% excl', amount=15.0))
        cls.tax15_incl = Tax.create(dict(common, name='DG 15% incl', amount=15.0,
                                         price_include=True, include_base_amount=False))
        cls.tax5 = Tax.create(dict(common, name='DG 5% excl', amount=5.0))
        cls.no_tax = Tax.browse()

    def _total(self, taxes, price_unit, qty, discount, policy='before_tax'):
        return self.engine._dg_line_total(taxes, price_unit, qty, discount, self.currency, policy)

    def _line(self, taxes, price_unit, qty, mode, value, policy='before_tax'):
        return self.engine._dg_compute_line_discount(
            taxes, price_unit, qty, mode, value, policy, self.currency)

    # ------------------------------------------------------------------
    # Fixed-amount rounding
    # ------------------------------------------------------------------
    def test_fixed_amount_single_unit(self):
        """0.05 off a 10.05 item lands exactly on 10.00."""
        res = self._line(self.no_tax, 10.05, 1, 'fixed', 0.05)
        self.assertEqual(res['amount'], 0.05)
        self.assertEqual(self._total(self.no_tax, 10.05, 1, res['percent']), 10.00)

    def test_fixed_amount_multi_quantity(self):
        """The fixed amount applies to the line, whatever the quantity."""
        for qty, expected in ((3, 30.10), (7, 70.30), (1000, 10049.95)):
            res = self._line(self.tax15, 10.05, qty, 'fixed', 0.05)
            self.assertEqual(self._total(self.tax15, 10.05, qty, res['percent']), expected,
                             "qty %s: untaxed total must drop by exactly 0.05" % qty)
            self.assertEqual(res['amount'], 0.05)

    def test_fixed_amount_tax_included_price(self):
        """Tax-included prices: the before-tax reduction is exact on the untaxed basis."""
        res = self._line(self.tax15_incl, 1.99, 7, 'fixed', 0.10)
        before = self._total(self.tax15_incl, 1.99, 7, 0.0)
        after = self._total(self.tax15_incl, 1.99, 7, res['percent'])
        self.assertAlmostEqual(before - after, 0.10, places=6)

    def test_fixed_amount_refund_line(self):
        res = self._line(self.no_tax, 10.05, -2, 'fixed', 0.05)
        self.assertEqual(self._total(self.no_tax, 10.05, -2, res['percent']), -20.05)

    def test_fixed_amount_exceeding_line(self):
        with self.assertRaises(UserError):
            self._line(self.no_tax, 10.05, 1, 'fixed', 10.06)

    # ------------------------------------------------------------------
    # Tax policy
    # ------------------------------------------------------------------
    def test_before_tax_policy(self):
        res = self._line(self.tax15, 100.0, 1, 'fixed', 10.0, 'before_tax')
        self.assertAlmostEqual(res['percent'], 10.0, places=6)
        self.assertEqual(self._total(self.tax15, 100.0, 1, res['percent'], 'before_tax'), 90.0)
        self.assertEqual(self._total(self.tax15, 100.0, 1, res['percent'], 'after_tax'), 103.5)

    def test_after_tax_policy(self):
        res = self._line(self.tax15, 100.0, 1, 'fixed', 11.5, 'after_tax')
        self.assertEqual(self._total(self.tax15, 100.0, 1, res['percent'], 'after_tax'), 103.5)
        self.assertEqual(self._total(self.tax15, 100.0, 1, res['percent'], 'before_tax'), 90.0)
        self.assertEqual(res['amount'], 11.5)

    def test_after_tax_policy_tax_included_price(self):
        res = self._line(self.tax15_incl, 115.0, 1, 'fixed', 11.5, 'after_tax')
        self.assertEqual(self._total(self.tax15_incl, 115.0, 1, res['percent'], 'after_tax'), 103.5)
        res_pct = self._line(self.tax15_incl, 115.0, 1, 'percent', 10.0, 'after_tax')
        self.assertEqual(res_pct['amount'], 11.5)

    def test_percent_before_tax_keeps_nominal_rate(self):
        res = self._line(self.tax15, 10.05, 3, 'percent', 10.0, 'before_tax')
        self.assertEqual(res['percent'], 10.0)

    # ------------------------------------------------------------------
    # Global discounts over mixed taxes
    # ------------------------------------------------------------------
    def _groups(self):
        return [
            {'taxes': self.tax15, 'excluded': 100.0, 'included': 115.0},
            {'taxes': self.tax5, 'excluded': 50.0, 'included': 52.5},
            {'taxes': self.no_tax, 'excluded': 25.0, 'included': 25.0},
        ]

    def test_split_proportional_largest_remainder(self):
        parts = self.engine._dg_split_proportional(10.0, [100.0, 50.0, 25.0], self.currency)
        self.assertEqual(parts, [5.71, 2.86, 1.43])
        self.assertAlmostEqual(sum(parts), 10.0, places=6)
        ties = self.engine._dg_split_proportional(0.01, [1.0, 1.0], self.currency)
        self.assertEqual(ties, [0.01, 0.0])

    def test_global_fixed_mixed_taxes_before_tax(self):
        plan = self.engine._dg_plan_global_discount(self._groups(), 'fixed', 10.0, 'before_tax', self.currency)
        self.assertEqual([l['amount'] for l in plan['lines']], [5.71, 2.86, 1.43])
        total = 0.0
        for line in plan['lines']:
            untaxed = self._total(line['taxes'], line['price'], 1, 0.0, 'before_tax')
            self.assertEqual(untaxed, -line['amount'])
            total += untaxed
        self.assertAlmostEqual(total, -10.0, places=6)
        # Tax of each group is reduced on its own base: 15% of 5.71, 5% of 2.86.
        taxed = [self._total(l['taxes'], l['price'], 1, 0.0, 'after_tax') for l in plan['lines']]
        self.assertEqual(taxed, [-6.57, -3.0, -1.43])

    def test_global_fixed_mixed_taxes_after_tax(self):
        plan = self.engine._dg_plan_global_discount(self._groups(), 'fixed', 19.25, 'after_tax', self.currency)
        self.assertEqual([l['amount'] for l in plan['lines']], [11.5, 5.25, 2.5])
        for line in plan['lines']:
            self.assertEqual(self._total(line['taxes'], line['price'], 1, 0.0, 'after_tax'), -line['amount'])

    def test_global_percent_mixed_taxes(self):
        plan = self.engine._dg_plan_global_discount(self._groups(), 'percent', 10.0, 'before_tax', self.currency)
        self.assertEqual(plan['amount'], 17.5)
        self.assertAlmostEqual(plan['percent'], 10.0, places=6)

    def test_global_tax_included_group(self):
        groups = [{'taxes': self.tax15_incl, 'excluded': 100.0, 'included': 115.0}]
        plan = self.engine._dg_plan_global_discount(groups, 'fixed', 5.71, 'before_tax', self.currency)
        line = plan['lines'][0]
        self.assertEqual(self._total(line['taxes'], line['price'], 1, 0.0, 'before_tax'), -5.71)

    def test_global_exceeding_order(self):
        with self.assertRaises(UserError):
            self.engine._dg_plan_global_discount(self._groups(), 'fixed', 175.01, 'before_tax', self.currency)
