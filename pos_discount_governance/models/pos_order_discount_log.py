# -*- coding: utf-8 -*-
import hashlib
import hmac
import logging
import math
from datetime import datetime, timezone

from odoo import api, fields, models

from .discount_engine import AUTH_METHOD_SELECTION, DISCOUNT_MODE_SELECTION, TAX_POLICY_SELECTION

_logger = logging.getLogger(__name__)


def dg_value_units(mode, value, rounding):
    """Integer form of the approved value, identical in JS (governance.js):
    percentages to 4 decimals, fixed amounts in currency units."""
    value = float(value or 0.0)
    if mode == 'fixed':
        return int(math.floor(value / rounding + 0.5 + 1e-9))
    return int(math.floor(value * 10000 + 0.5 + 1e-9))


def dg_auth_proof(method, secret, order_uid, log_uid, scope, product_id, mode, value_units):
    """Proof sent by the POS for a verified authorization.

    It binds the plain credential (which the POS only holds while the
    employee types/scans it; pos_hr ships SHA-1 hashes only) to one order,
    one log entry, its scope, product, mode and approved value. Changing any
    of them, or reusing the proof on another line or order, breaks it.
    Mirrored by ``makeProof`` in static/src/js/governance.js.
    """
    payload = '%s:%s:%s:%s:%s:%s:%s:%s' % (
        method, secret or '', order_uid or '', log_uid or '', scope or '',
        product_id or 0, mode or '', value_units)
    return hashlib.sha1(payload.encode('utf-8')).hexdigest()


class PosOrderDiscountLog(models.Model):
    _name = 'pos.order.discount.log'
    _description = 'POS Order Discount Audit Log'
    _order = 'timestamp desc, id desc'
    _rec_name = 'order_id'

    order_id = fields.Many2one('pos.order', string='Order', required=True,
                               ondelete='cascade', index=True, readonly=True)
    session_id = fields.Many2one(related='order_id.session_id', store=True, string='Session')
    config_id = fields.Many2one(related='order_id.config_id', store=True, string='Point of Sale')
    company_id = fields.Many2one(related='order_id.company_id', store=True, string='Company')
    currency_id = fields.Many2one(related='order_id.currency_id', string='Currency')
    timestamp = fields.Datetime(string='Timestamp', required=True, readonly=True,
                                default=fields.Datetime.now)
    scope = fields.Selection([('line', 'Line'), ('global', 'Global')],
                             string='Scope', required=True, readonly=True)
    mode = fields.Selection(DISCOUNT_MODE_SELECTION, string='Mode', required=True, readonly=True)
    tax_policy = fields.Selection(TAX_POLICY_SELECTION, string='Tax Policy', readonly=True)
    value = fields.Float(string='Entered Value', digits=(16, 4), readonly=True)
    discount_amount = fields.Monetary(string='Discount Amount', readonly=True)
    effective_percent = fields.Float(string='Effective %', digits=(16, 4), readonly=True)
    product_id = fields.Many2one('product.product', string='Product', readonly=True)
    cashier_employee_id = fields.Many2one('hr.employee', string='Cashier', readonly=True)
    authorizer_employee_id = fields.Many2one('hr.employee', string='Authorized By', readonly=True)
    auth_method = fields.Selection(
        [('none', 'No Verification')] + AUTH_METHOD_SELECTION,
        string='Authorization Method', default='none', readonly=True)
    escalated = fields.Boolean(string='Supervisor Override', readonly=True)
    order_uid = fields.Char(string='Order UID', readonly=True)
    log_uid = fields.Char(string='Log UID', readonly=True, index=True)
    auth_proof = fields.Char(string='Authorization Proof', readonly=True, groups='base.group_system')
    proof_verified = fields.Boolean(string='Credentials Verified', readonly=True,
                                    help="The server confirmed the badge/PIN proof sent by the POS.")

    # ------------------------------------------------------------------
    # Integrity: entries are created by the server only (sudo, from
    # pos.order._process_order); 'proof_verified' is never taken from input.
    # ------------------------------------------------------------------
    @api.model_create_multi
    def create(self, vals_list):
        for vals in vals_list:
            vals['proof_verified'] = False
        return super().create(vals_list)

    def write(self, vals):
        if not self.env.su:
            vals = {k: v for k, v in vals.items() if k != 'proof_verified'}
        return super().write(vals)

    # ------------------------------------------------------------------
    # UI -> backend
    # ------------------------------------------------------------------
    @api.model
    def _dg_parse_timestamp(self, value):
        if not value:
            return fields.Datetime.now()
        try:
            if isinstance(value, (int, float)):
                stamp = datetime.fromtimestamp(value / 1000.0, tz=timezone.utc)
            else:
                stamp = datetime.fromisoformat(str(value).replace('Z', '+00:00'))
            if stamp.tzinfo:
                stamp = stamp.astimezone(timezone.utc).replace(tzinfo=None)
            return fields.Datetime.to_string(stamp)
        except (ValueError, TypeError, OverflowError):
            return fields.Datetime.now()

    @api.model
    def _dg_prepare_from_ui(self, log):
        Employee = self.env['hr.employee'].sudo()

        def employee(eid):
            try:
                return int(eid) if eid and Employee.browse(int(eid)).exists() else False
            except (TypeError, ValueError):
                return False

        product_id = log.get('product_id')
        try:
            product_id = int(product_id) if product_id else False
        except (TypeError, ValueError):
            product_id = False
        if product_id and not self.env['product.product'].sudo().browse(product_id).exists():
            product_id = False
        auth_method = log.get('auth_method') or 'none'
        if auth_method not in dict(self._fields['auth_method'].selection):
            auth_method = 'none'
        return {
            'timestamp': self._dg_parse_timestamp(log.get('timestamp')),
            'scope': 'global' if log.get('scope') == 'global' else 'line',
            'mode': 'fixed' if log.get('mode') == 'fixed' else 'percent',
            'tax_policy': 'after_tax' if log.get('tax_policy') == 'after_tax' else 'before_tax',
            'value': float(log.get('value') or 0.0),
            'discount_amount': float(log.get('amount') or 0.0),
            'effective_percent': float(log.get('percent') or 0.0),
            'product_id': product_id or False,
            'cashier_employee_id': employee(log.get('cashier_employee_id')),
            'authorizer_employee_id': employee(log.get('authorizer_employee_id')),
            'auth_method': auth_method,
            'escalated': bool(log.get('escalated')),
            'order_uid': log.get('order_uid') or False,
            'log_uid': log.get('uid') or False,
            'auth_proof': log.get('proof') or False,
        }

    # ------------------------------------------------------------------
    # Proof verification
    # ------------------------------------------------------------------
    def _dg_expected_secret(self):
        self.ensure_one()
        emp = self.authorizer_employee_id.sudo()
        badge, pin = emp.barcode or '', emp.pin or ''
        if self.auth_method == 'badge':
            return badge or None
        if self.auth_method == 'pin':
            return pin or None
        if self.auth_method == 'both':
            return ('%s|%s' % (badge, pin)) if badge and pin else None
        return None

    def _dg_compute_proof_verified(self):
        """Return {log: bool}. Works on stored and on in-memory (new) records."""
        result = {}
        for log in self:
            verified = False
            sudo_log = log.sudo()
            reference = log.order_id.pos_reference or ''
            if (log.auth_method != 'none' and log.authorizer_employee_id and sudo_log.auth_proof
                    and log.order_uid and reference.endswith(log.order_uid)):
                secret = log._dg_expected_secret()
                if secret is not None:
                    rounding = log.order_id.currency_id.rounding or 0.01
                    expected = dg_auth_proof(
                        log.auth_method, secret, log.order_uid, log.log_uid, log.scope,
                        log.product_id.id, log.mode, dg_value_units(log.mode, log.value, rounding))
                    verified = hmac.compare_digest(expected, sudo_log.auth_proof)
            if not verified and log.auth_method != 'none':
                _logger.warning("POS discount log %s of order %s: authorization proof rejected.",
                                log.log_uid, reference)
            result[log] = verified
        return result

    def _dg_verify_proofs(self):
        for log, verified in self._dg_compute_proof_verified().items():
            log.sudo().proof_verified = verified

    # ------------------------------------------------------------------
    # backend -> UI (reloaded orders)
    # ------------------------------------------------------------------
    def _dg_export_for_ui(self):
        return [{
            'uid': log.log_uid,
            'order_uid': log.order_uid,
            'timestamp': fields.Datetime.to_string(log.timestamp),
            'scope': log.scope,
            'mode': log.mode,
            'tax_policy': log.tax_policy,
            'value': log.value,
            'amount': log.discount_amount,
            'percent': log.effective_percent,
            'product_id': log.product_id.id,
            'cashier_employee_id': log.cashier_employee_id.id,
            'authorizer_employee_id': log.authorizer_employee_id.id,
            'auth_method': log.auth_method,
            'escalated': log.escalated,
            'proof': log.sudo().auth_proof,
        } for log in self]
