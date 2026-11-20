# -*- coding: utf-8 -*-
import json
from random import randint

from odoo import fields
from odoo.exceptions import AccessError, ValidationError
from odoo.tests import tagged

from odoo.addons.point_of_sale.tests.common import TestPoSCommon
from odoo.addons.pos_discount_governance.models.pos_order_discount_log import dg_auth_proof, dg_value_units


@tagged('post_install', '-at_install', 'pos_discount_governance')
class TestDiscountGovernance(TestPoSCommon):
    """End-to-end: sync_from_ui -> _process_order re-validation, audit log
    persistence, invoices and session entries reconciling to the cent."""

    def setUp(self):
        super().setUp()
        self.config = self.basic_config
        self.currency = self.config.currency_id
        Level = self.env['pos.discount.level']
        self.level_cashier = Level.create({
            'name': 'DG Cashier', 'max_discount_percent': 5.0, 'company_id': self.env.company.id,
        })
        self.level_supervisor = Level.create({
            'name': 'DG Supervisor', 'max_discount_percent': 50.0, 'max_discount_amount': 200.0,
            'can_override': True, 'company_id': self.env.company.id,
        })
        Employee = self.env['hr.employee']
        self.cashier = Employee.create({
            'name': 'DG Cashier Emp', 'pin': '1111', 'barcode': 'DGCASH01',
            'pos_discount_level_id': self.level_cashier.id, 'company_id': self.env.company.id,
        })
        self.supervisor = Employee.create({
            'name': 'DG Supervisor Emp', 'pin': '9999', 'barcode': 'DGSUP01',
            'pos_discount_level_id': self.level_supervisor.id, 'company_id': self.env.company.id,
        })
        self.config.write({
            'module_pos_hr': True,
            'enforce_discount_limits': True,
            'discount_tax_policy': 'before_tax',
            'discount_violation_action': 'block',
        })
        self.tax15 = self.env['account.tax'].create({
            'name': 'DG POS 15%', 'amount': 15.0, 'amount_type': 'percent',
            'type_tax_use': 'sale', 'company_id': self.env.company.id,
        })
        self.product = self.env['product.product'].create({
            'name': 'DG Product', 'type': 'consu', 'available_in_pos': True,
            'lst_price': 10.05, 'taxes_id': [(6, 0, self.tax15.ids)],
        })
        self.product_100 = self.env['product.product'].create({
            'name': 'DG Product 100', 'type': 'consu', 'available_in_pos': True,
            'lst_price': 100.0, 'taxes_id': [(6, 0, [])],
        })
        self.partner = self.env['res.partner'].create({'name': 'DG Customer'})
        self.open_new_session()

    # ------------------------------------------------------------------
    # UI payload helpers (Odoo 19 sync_from_ui format)
    # ------------------------------------------------------------------
    def _ui_line(self, product, qty, discount=0.0, mode='percent', fixed=0.0, log=None):
        taxes = product.taxes_id
        price_unit = product.lst_price
        price = price_unit * (1 - discount / 100.0)
        res = taxes.compute_all(price, self.currency, qty, product=product)
        return [0, 0, {
            'id': randint(1, 1000000),
            'product_id': product.id,
            'full_product_name': product.display_name,
            'qty': qty,
            'price_unit': price_unit,
            'discount': discount,
            'discount_mode': mode,
            'discount_fixed_amount': fixed,
            'discount_log_uid': log['uid'] if log else False,
            'tax_ids': [(6, 0, taxes.ids)],
            'price_subtotal': res['total_excluded'],
            'price_subtotal_incl': res['total_included'],
            'pack_lot_ids': [],
        }]

    def _ui_order(self, uid, lines, logs=(), employee=None, to_invoice=False):
        total = self.currency.round(sum(l[2]['price_subtotal_incl'] for l in lines))
        untaxed = self.currency.round(sum(l[2]['price_subtotal'] for l in lines))
        return {
            'uuid': uid,
            'name': 'Order %s' % uid,
            'pos_reference': uid,
            'session_id': self.pos_session.id,
            'user_id': self.env.uid,
            'employee_id': (employee or self.cashier).id,
            'partner_id': self.partner.id if to_invoice else False,
            'fiscal_position_id': False,
            'pricelist_id': self.config.pricelist_id.id,
            'sequence_number': randint(1, 100000),
            'date_order': fields.Datetime.to_string(fields.Datetime.now()),
            'last_order_preparation_change': '{}',
            'lines': lines,
            'amount_total': total,
            'amount_tax': self.currency.round(total - untaxed),
            'amount_paid': total,
            'amount_return': 0.0,
            'to_invoice': to_invoice,
            'discount_tax_policy': 'before_tax',
            'dg_discount_log_payload': json.dumps(list(logs)),
            'payment_ids': [(0, 0, {
                'name': fields.Datetime.now(),
                'payment_method_id': self.cash_pm1.id,
                'amount': total,
            })],
        }

    def _log(self, uid, employee, method='none', secret=None, value=20.0, amount=20.0,
             escalated=False, product=None, scope='line', mode='percent'):
        log_uid = '%s-log-%s' % (uid, randint(1, 10 ** 6))
        product = product or self.product_100
        log = {
            'uid': log_uid,
            'order_uid': uid,
            'timestamp': '2026-11-18T09:15:00.000Z',
            'scope': scope,
            'mode': mode,
            'tax_policy': 'before_tax',
            'value': value,
            'amount': amount,
            'percent': value,
            'product_id': product.id,
            'cashier_employee_id': self.cashier.id,
            'authorizer_employee_id': employee.id,
            'auth_method': method,
            'escalated': escalated,
            'proof': False,
        }
        if secret:
            log['proof'] = dg_auth_proof(method, secret, uid, log_uid, scope, product.id, mode,
                                         dg_value_units(mode, value, self.currency.rounding))
        return log

    def _discounted(self, uid, product, qty, pct, log_kwargs, mode='percent', fixed=0.0):
        """Order line + the log entry that authorized it."""
        log = self._log(uid, product=product, mode=mode, **log_kwargs)
        return self._ui_line(product, qty, pct, mode, fixed, log=log), log

    def _create(self, ui_order):
        res = self.env['pos.order'].sync_from_ui([ui_order])
        return self.env['pos.order'].browse(res['pos.order'][0]['id'])

    # ------------------------------------------------------------------
    # Tier enforcement & escalation
    # ------------------------------------------------------------------
    SUP = {'employee': None, 'method': 'pin', 'secret': '9999', 'escalated': True}

    def _sup(self, **kw):
        return dict(self.SUP, employee=self.supervisor, **kw)

    def test_within_cashier_limit_is_accepted(self):
        uid = '00901-001-0001'
        line, log = self._discounted(uid, self.product_100, 1, 5.0,
                                     {'employee': self.cashier, 'value': 5.0, 'amount': 5.0})
        order = self._create(self._ui_order(uid, [line], logs=[log]))
        self.assertFalse(order.discount_violation)
        self.assertEqual(order.amount_total, 95.0)

    def test_over_limit_without_override_is_rejected(self):
        uid = '00901-001-0002'
        line, log = self._discounted(uid, self.product_100, 1, 20.0, {'employee': self.cashier})
        with self.assertRaises(ValidationError):
            self._create(self._ui_order(uid, [line], logs=[log]))

    def test_rejection_creates_no_order(self):
        uid = '00901-001-0003'
        line, log = self._discounted(uid, self.product_100, 1, 20.0, {'employee': self.cashier})
        with self.assertRaises(ValidationError):
            self._create(self._ui_order(uid, [line], logs=[log]))
        self.assertFalse(self.env['pos.order'].search_count([('pos_reference', '=', uid)]))

    def test_forged_supervisor_without_proof_is_rejected(self):
        uid = '00901-001-0004'
        line, log = self._discounted(uid, self.product_100, 1, 20.0, self._sup())
        log['proof'] = 'deadbeef' * 5
        with self.assertRaises(ValidationError):
            self._create(self._ui_order(uid, [line], logs=[log]))

    def test_supervisor_override_with_valid_proof(self):
        uid = '00901-001-0005'
        line, log = self._discounted(uid, self.product_100, 1, 20.0, self._sup())
        order = self._create(self._ui_order(uid, [line], logs=[log]))
        self.assertEqual(order.amount_total, 80.0)
        self.assertTrue(order.discount_log_ids.proof_verified)

    def test_proof_bound_to_order(self):
        """A valid proof replayed on another order is not accepted."""
        uid, other_uid = '00901-001-0006', '00901-001-0007'
        line, log = self._discounted(uid, self.product_100, 1, 20.0, self._sup())
        log['order_uid'] = other_uid
        with self.assertRaises(ValidationError):
            self._create(self._ui_order(uid, [line], logs=[log]))

    def test_one_approval_does_not_cover_other_lines(self):
        """Report #1: approved 10% on one line + unapproved 45% on another."""
        uid = '00901-001-0008'
        approved, log = self._discounted(uid, self.product_100, 1, 10.0, self._sup(value=10.0, amount=10.0))
        unapproved = self._ui_line(self.product, 1, 45.0)
        with self.assertRaises(ValidationError):
            self._create(self._ui_order(uid, [approved, unapproved], logs=[log]))

    def test_approval_cannot_be_borrowed_by_another_line(self):
        uid = '00901-001-0009'
        approved, log = self._discounted(uid, self.product_100, 1, 10.0, self._sup(value=10.0, amount=10.0))
        borrowing = self._ui_line(self.product, 1, 45.0, log=log)  # points at the other line's approval
        with self.assertRaises(ValidationError):
            self._create(self._ui_order(uid, [approved, borrowing], logs=[log]))

    def test_discount_raised_after_approval_is_rejected(self):
        uid = '00901-001-0010'
        log = self._log(uid, product=self.product_100, **self._sup(value=10.0, amount=10.0))
        line = self._ui_line(self.product_100, 1, 40.0, log=log)  # approved 10%, applied 40%
        with self.assertRaises(ValidationError):
            self._create(self._ui_order(uid, [line], logs=[log]))

    def test_tampered_log_value_breaks_proof(self):
        uid = '00901-001-0011'
        line, log = self._discounted(uid, self.product_100, 1, 40.0, self._sup(value=10.0, amount=10.0))
        log['value'] = 40.0  # proof was made for 10%
        with self.assertRaises(ValidationError):
            self._create(self._ui_order(uid, [line], logs=[log]))

    def test_small_discount_after_approved_one_is_accepted(self):
        """Report #3: an earlier approval must not block a later in-limit discount."""
        uid = '00901-001-0012'
        approved, sup_log = self._discounted(uid, self.product_100, 1, 10.0, self._sup(value=10.0, amount=10.0))
        small, own_log = self._discounted(uid, self.product, 1, 3.0,
                                          {'employee': self.cashier, 'value': 3.0, 'amount': 0.3})
        order = self._create(self._ui_order(uid, [approved, small], logs=[sup_log, own_log]))
        self.assertFalse(order.discount_violation)
        self.assertEqual(len(order.discount_log_ids), 2)

    def test_amount_limit_per_order(self):
        """Supervisor allows 50% but at most 200 per order."""
        uid = '00901-001-0013'
        line, log = self._discounted(uid, self.product_100, 5, 45.0,
                                     self._sup(method='badge', secret='DGSUP01', value=45.0, amount=225.0))
        with self.assertRaises(ValidationError):
            self._create(self._ui_order(uid, [line], logs=[log]))

    def test_flag_mode_accepts_and_flags(self):
        self.config.discount_violation_action = 'flag'
        uid = '00901-001-0014'
        line, log = self._discounted(uid, self.product_100, 1, 20.0, {'employee': self.cashier})
        order = self._create(self._ui_order(uid, [line], logs=[log]))
        self.assertTrue(order.discount_violation)
        self.assertIn('DG Product 100', order.discount_violation_note)

    def test_require_auth_needs_verified_log(self):
        self.config.require_discount_auth = True
        uid = '00901-001-0015'
        line, log = self._discounted(uid, self.product_100, 1, 5.0,
                                     {'employee': self.cashier, 'value': 5.0, 'amount': 5.0})
        with self.assertRaises(ValidationError):
            self._create(self._ui_order(uid, [line], logs=[log]))
        uid = '00901-001-0016'
        line, log = self._discounted(uid, self.product_100, 1, 5.0, {
            'employee': self.cashier, 'method': 'both', 'secret': 'DGCASH01|1111', 'value': 5.0, 'amount': 5.0})
        order = self._create(self._ui_order(uid, [line], logs=[log]))
        self.assertTrue(order.discount_log_ids.proof_verified)

    def test_approver_level_requires_pin(self):
        with self.assertRaises(ValidationError):
            self.env['hr.employee'].create({
                'name': 'DG No PIN Manager', 'pos_discount_level_id': self.level_supervisor.id,
                'company_id': self.env.company.id,
            })

    # ------------------------------------------------------------------
    # Audit log integrity & persistence
    # ------------------------------------------------------------------
    def test_pos_user_cannot_create_audit_entries(self):
        """Report #2: no fake 'approved via PIN, verified' entries over RPC."""
        uid = '00901-001-0017'
        order = self._create(self._ui_order(uid, [self._ui_line(self.product_100, 1)]))
        pos_user = self.env['res.users'].create({
            'name': 'DG POS User', 'login': 'dg_pos_user',
            'group_ids': [(6, 0, [self.env.ref('point_of_sale.group_pos_user').id])],
        })
        Log = self.env['pos.order.discount.log'].with_user(pos_user)
        with self.assertRaises(AccessError):
            Log.create({'order_id': order.id, 'scope': 'line', 'mode': 'percent',
                        'authorizer_employee_id': self.supervisor.id, 'auth_method': 'pin',
                        'proof_verified': True})
        with self.assertRaises(AccessError):
            order.with_user(pos_user).write({'discount_log_ids': [(0, 0, {
                'scope': 'line', 'mode': 'percent', 'proof_verified': True})]})
        # Even a privileged create cannot set the verified flag.
        forged = self.env['pos.order.discount.log'].create({
            'order_id': order.id, 'scope': 'line', 'mode': 'percent', 'proof_verified': True})
        self.assertFalse(forged.proof_verified)

    def test_audit_log_persistence(self):
        uid = '00901-001-0018'
        line, log = self._discounted(uid, self.product_100, 1, 20.0, self._sup(), mode='fixed', fixed=20.0)
        order = self._create(self._ui_order(uid, [line], logs=[log]))
        entry = order.discount_log_ids
        self.assertEqual(len(entry), 1)
        self.assertEqual(order.discount_log_count, 1)
        self.assertRecordValues(entry, [{
            'scope': 'line', 'mode': 'fixed', 'tax_policy': 'before_tax', 'value': 20.0,
            'discount_amount': 20.0, 'cashier_employee_id': self.cashier.id,
            'authorizer_employee_id': self.supervisor.id, 'auth_method': 'pin',
            'escalated': True, 'proof_verified': True, 'product_id': self.product_100.id,
        }])
        self.assertEqual(fields.Datetime.to_string(entry.timestamp), '2026-11-18 09:15:00')
        self.assertEqual(order.lines.discount_mode, 'fixed')
        self.assertEqual(order.lines.discount_fixed_amount, 20.0)
        self.assertEqual(order.lines.discount_log_uid, log['uid'])

    # ------------------------------------------------------------------
    # Cent-exact reconciliation
    # ------------------------------------------------------------------
    def _fixed_discount_line(self, qty, amount):
        engine = self.env['pos.discount.engine']
        res = engine._dg_compute_line_discount(
            self.product.taxes_id, self.product.lst_price, qty, 'fixed', amount, 'before_tax', self.currency)
        return self._ui_line(self.product, qty, res['percent'], 'fixed', amount)

    def test_invoice_matches_order_to_the_cent(self):
        self.level_cashier.max_discount_percent = 100.0
        uid = '00901-001-0012'
        line = self._fixed_discount_line(1000, 0.05)
        self.assertEqual(line[2]['price_subtotal'], 10049.95)
        order = self._create(self._ui_order(uid, [line], logs=[self._log(
            uid, self.cashier, mode='fixed', value=0.05, amount=0.05, product=self.product)], to_invoice=True))
        invoice = order.account_move
        self.assertTrue(invoice)
        self.assertEqual(invoice.amount_untaxed, 10049.95)
        self.assertEqual(invoice.amount_total, order.amount_total)
        self.assertEqual(invoice.amount_tax, order.amount_tax)

    def test_invoice_precision_fix_standalone(self):
        """Without the exact field the 0.0005% discount would round to 0.00%."""
        exact = 0.05 / (10.05 * 1000) * 100
        move = self.env['account.move'].create({
            'move_type': 'out_invoice',
            'partner_id': self.partner.id,
            'invoice_line_ids': [(0, 0, {
                'product_id': self.product.id, 'quantity': 1000, 'price_unit': 10.05,
                'discount': exact, 'pos_discount_exact': exact, 'tax_ids': [(6, 0, [])],
            })],
        })
        self.assertEqual(move.invoice_line_ids.discount, 0.0)
        self.assertEqual(move.amount_untaxed, 10049.95)
        # Editing the visible discount drops the exact value.
        move.invoice_line_ids.discount = 1.0
        self.assertEqual(move.amount_untaxed, 9949.5)

    def test_session_closing_reconciles(self):
        self.level_cashier.max_discount_percent = 100.0
        orders = self.env['pos.order']
        expected_untaxed = 0.0
        for index, (qty, amount) in enumerate(((3, 0.05), (7, 0.11), (1000, 0.05))):
            uid = '00901-001-01%02d' % index
            line = self._fixed_discount_line(qty, amount)
            expected_untaxed += line[2]['price_subtotal']
            orders |= self._create(self._ui_order(uid, [line], logs=[self._log(
                uid, self.cashier, mode='fixed', value=amount, amount=amount, product=self.product)]))
        self.assertAlmostEqual(sum(orders.mapped('amount_total')) - sum(orders.mapped('amount_tax')),
                               expected_untaxed, places=2)
        self.pos_session.action_pos_session_validate()
        self.assertEqual(self.pos_session.state, 'closed')
        income_account = self.product.categ_id.property_account_income_categ_id
        sales = self.pos_session.move_id.line_ids.filtered(lambda l: l.account_id == income_account)
        self.assertAlmostEqual(-sum(sales.mapped('balance')), expected_untaxed, places=2)

    # ------------------------------------------------------------------
    # Refunds of global discounts
    # ------------------------------------------------------------------
    def _global_line(self, discount_product, qty, price, refunded=False):
        return [0, 0, {
            'id': randint(1, 1000000),
            'product_id': discount_product.id,
            'full_product_name': discount_product.display_name,
            'qty': qty,
            'price_unit': price,
            'discount': 0.0,
            'discount_mode': 'percent',
            'discount_fixed_amount': 0.0,
            'discount_log_uid': False,
            'tax_ids': [(6, 0, [])],
            'price_subtotal': qty * price,
            'price_subtotal_incl': qty * price,
            'pack_lot_ids': [],
            'refunded_orderline_id': refunded or False,
        }]

    def test_refund_returns_global_discount(self):
        """A refund returns the governed global discount lines (linked to the
        originals), needs no new approval and refunds exactly what was paid."""
        discount_product = self.env['product.product'].create({
            'name': 'DG Global Discount', 'type': 'service', 'available_in_pos': True,
            'lst_price': 0.0, 'taxes_id': [(6, 0, [])],
        })
        self.config.write({'module_pos_discount': True, 'discount_product_id': discount_product.id})
        uid = '00901-001-0201'
        log = self._log(uid, product=discount_product, scope='global', value=10.0, amount=20.0,
                        **self._sup())
        glob = self._global_line(discount_product, 1, -20.0)
        glob[2]['discount_log_uid'] = log['uid']
        sale = self._create(self._ui_order(uid, [self._ui_line(self.product_100, 2), glob], logs=[log]))
        self.assertFalse(sale.discount_violation)
        self.assertEqual(sale.amount_total, 180.0)

        sale_line = sale.lines.filtered(lambda l: l.product_id == self.product_100)
        sale_disc = sale.lines.filtered(lambda l: l.product_id == discount_product)
        refund_line = self._ui_line(self.product_100, -2)
        refund_line[2]['refunded_orderline_id'] = sale_line.id
        refund_uid = '00901-001-0202'
        refund = self._create(self._ui_order(refund_uid, [
            refund_line, self._global_line(discount_product, -1, -20.0, refunded=sale_disc.id),
        ]))
        self.assertFalse(refund.discount_violation)
        self.assertEqual(refund.amount_total, -180.0)
        self.assertEqual(sale_disc.refunded_qty, 1.0)
        self.assertFalse(refund.discount_log_ids)
