# -*- coding: utf-8 -*-
import json
import logging

from odoo import api, fields, models, _
from odoo.exceptions import ValidationError
from odoo.tools.misc import formatLang

from .discount_engine import DISCOUNT_MODE_SELECTION, TAX_POLICY_SELECTION

_logger = logging.getLogger(__name__)

# UI line keys needed to evaluate discounts on an in-memory order.
_PRECHECK_LINE_KEYS = (
    'product_id', 'qty', 'price_unit', 'discount', 'tax_ids', 'full_product_name',
    'refunded_orderline_id', 'discount_mode', 'discount_fixed_amount', 'discount_log_uid',
    'is_reward_line',
)


class PosOrder(models.Model):
    _inherit = 'pos.order'

    discount_log_ids = fields.One2many('pos.order.discount.log', 'order_id',
                                       string='Discount Audit Log', readonly=True)
    discount_log_count = fields.Integer(string='Discount Log Count',
                                        compute='_compute_discount_log_count')
    discount_tax_policy = fields.Selection(TAX_POLICY_SELECTION, string='Discount Tax Policy',
                                           readonly=True)
    discount_violation = fields.Boolean(string='Discount Violation', readonly=True, copy=False)
    discount_violation_note = fields.Text(string='Discount Violation Details', readonly=True, copy=False)
    dg_discount_log_payload = fields.Text(string='Discount Log Payload', copy=False,
                                          help="Audit entries as sent by the POS (JSON).")

    @api.depends('discount_log_ids')
    def _compute_discount_log_count(self):
        for order in self:
            order.discount_log_count = len(order.discount_log_ids)

    # ------------------------------------------------------------------
    # UI synchronisation (Odoo 18+: sync_from_ui -> _process_order)
    # ------------------------------------------------------------------
    @api.model
    def _dg_log_vals_from_ui(self, ui_order):
        """The POS sends its audit entries as JSON in dg_discount_log_payload;
        entries are created by the server (POS users have no create right)."""
        Log = self.env['pos.order.discount.log']
        raw = ui_order.get('dg_discount_log_payload') or '[]'
        try:
            logs = json.loads(raw) if isinstance(raw, str) else (raw or [])
        except ValueError:
            logs = []
        return [Log._dg_prepare_from_ui(log) for log in logs if isinstance(log, dict)]

    @api.model
    def _process_order(self, order, existing_order):
        draft = order.get('state') == 'draft'
        log_vals = self._dg_log_vals_from_ui(order)
        if not draft and not existing_order:
            # Reject before create(): a rejected order must not consume an
            # order number from the POS sequence.
            self._dg_precheck(order, log_vals)
        order_id = super()._process_order(order, existing_order)
        pos_order = self.browse(order_id)
        if not pos_order.discount_tax_policy:
            pos_order.discount_tax_policy = pos_order.config_id.discount_tax_policy or 'before_tax'
        pos_order._dg_store_logs(log_vals)
        if not draft:
            pos_order._dg_enforce_discount_governance()
        return order_id

    def _dg_store_logs(self, log_vals):
        self.ensure_one()
        Log = self.env['pos.order.discount.log'].sudo()
        self.sudo().discount_log_ids.unlink()  # re-synced draft orders replace their log
        logs = Log.create([dict(vals, order_id=self.id) for vals in log_vals])
        logs._dg_verify_proofs()
        return logs

    @api.model
    def _dg_precheck(self, ui_order, log_vals):
        session = self.env['pos.session'].browse(ui_order.get('session_id'))
        config = session.config_id
        if not (config.enforce_discount_limits or config.require_discount_auth):
            return
        if config.discount_violation_action != 'block':
            return
        try:
            line_fields = self.env['pos.order.line']._fields
            lines = []
            for line in ui_order.get('lines') or []:
                data = line[2] if isinstance(line, (list, tuple)) and len(line) > 2 else {}
                lines.append((0, 0, {k: data[k] for k in _PRECHECK_LINE_KEYS
                                     if k in data and k in line_fields}))
            vals = {
                'session_id': session.id,
                'company_id': session.company_id.id,
                'pos_reference': ui_order.get('pos_reference') or ui_order.get('name'),
                'partner_id': ui_order.get('partner_id') or False,
                'fiscal_position_id': ui_order.get('fiscal_position_id') or False,
                'pricelist_id': ui_order.get('pricelist_id') or False,
                'user_id': ui_order.get('user_id') or False,
                'discount_tax_policy': self._dg_policy_from_ui(ui_order),
                'lines': lines,
            }
            if 'employee_id' in self._fields:
                vals['employee_id'] = ui_order.get('employee_id') or False
            virtual = self.new(vals)
            Log = self.env['pos.order.discount.log']
            logs = Log.browse()
            for log in log_vals:
                logs |= Log.new(dict(log, order_id=virtual))
            violations = virtual._dg_governance_violations(logs, logs._dg_compute_proof_verified())
        except Exception:  # pragma: no cover - the post-create check still applies
            _logger.exception("POS discount governance pre-check failed; checking after creation.")
            return
        if violations:
            raise ValidationError(virtual._dg_rejection_message(violations))

    # ------------------------------------------------------------------
    # Invoicing: keep the full-precision discount (see account_move_line.py)
    # ------------------------------------------------------------------
    @api.model
    def _get_invoice_lines_values(self, line_values, pos_line, move_type):
        vals = super()._get_invoice_lines_values(line_values, pos_line, move_type)
        if pos_line.discount:
            vals['pos_discount_exact'] = pos_line.discount
        return vals

    # ------------------------------------------------------------------
    # Governance (server-side re-validation)
    # ------------------------------------------------------------------
    def _dg_cashier_employee(self):
        self.ensure_one()
        employee = self.employee_id if 'employee_id' in self._fields else self.env['hr.employee']
        if not employee and self.user_id:
            employee = self.user_id.with_company(self.company_id).employee_id
        return employee

    def _dg_employee_limits(self, employee, verified):
        """(max_percent, max_amount|None) of an employee. An employee acting
        without verification who has an approving level but no PIN (e.g. a
        manager anyone can switch to at the lock screen) only gets the
        default level."""
        default_level = self.config_id.default_discount_level_id
        level = employee.pos_discount_level_id or default_level
        if not verified and employee and level.can_override and not employee.sudo().pin:
            level = default_level
        return level._dg_limits()

    def _dg_discount_summary(self):
        """Discount entries recomputed from the order lines, in the order's
        tax basis. Refund lines and loyalty rewards are not governed."""
        self.ensure_one()
        engine = self.env['pos.discount.engine']
        config = self.config_id
        currency = self.currency_id
        policy = self.discount_tax_policy or config.discount_tax_policy
        discount_product = config.discount_product_id if config.module_pos_discount else False
        entries, regular_total = [], 0.0
        global_lines = self.env['pos.order.line']
        for line in self.lines:
            if line.refunded_orderline_id or line._dg_is_reward_line():
                continue
            if discount_product and line.product_id == discount_product:
                global_lines |= line
                continue
            taxes = line.tax_ids_after_fiscal_position
            discounted = engine._dg_line_total(taxes, line.price_unit, line.qty, line.discount,
                                               currency, policy, line.product_id, self.partner_id)
            regular_total += discounted
            if not line.discount:
                continue
            undiscounted = engine._dg_line_total(taxes, line.price_unit, line.qty, 0.0,
                                                 currency, policy, line.product_id, self.partner_id)
            entries.append({
                'scope': 'line',
                'label': line.full_product_name or line.product_id.display_name,
                'product_id': line.product_id.id,
                'log_uid': line.discount_log_uid,
                'amount': currency.round(abs(undiscounted - discounted)),
                'base': abs(undiscounted),
            })
        if global_lines:
            amount = sum(engine._dg_line_total(l.tax_ids_after_fiscal_position, l.price_unit, l.qty,
                                               l.discount, currency, policy) for l in global_lines)
            uids = [uid for uid in global_lines.mapped('discount_log_uid') if uid]
            entries.append({
                'scope': 'global',
                'label': _("Global discount"),
                'product_id': discount_product.id,
                # All global discount lines must come from one approval.
                'log_uid': uids[0] if uids and len(set(uids)) == 1 and len(uids) == len(global_lines) else False,
                'amount': currency.round(abs(amount)),
                'base': abs(regular_total),
            })
        return {
            'entries': entries,
            'amount': currency.round(sum(e['amount'] for e in entries)),
        }

    def _dg_governance_violations(self, logs=None, verified=None):
        """Each discount must be covered by its own authorization:
        * the log entry referenced by the line (same scope and product) with a
          server-verified proof -> limits of that authorizer, and the discount
          may not exceed what was approved;
        * otherwise, when verification is not mandatory -> cashier's limits.
        The per-order amount cap is the highest cap among those authorities.
        """
        self.ensure_one()
        config = self.config_id
        if not (config.enforce_discount_limits or config.require_discount_auth):
            return []
        currency = self.currency_id
        summary = self._dg_discount_summary()
        if currency.is_zero(summary['amount']):
            return []
        if logs is None:
            logs = self.discount_log_ids
        if verified is None:
            verified = {log: log.proof_verified for log in logs}
        logs_by_uid = {log.log_uid: log for log in logs if log.log_uid}
        cashier_limits = self._dg_employee_limits(self._dg_cashier_employee(), False)

        def fmt_amount(value):
            return formatLang(self.env, value, currency_obj=currency)

        violations, used_limits = [], []
        for entry in summary['entries']:
            log = logs_by_uid.get(entry['log_uid']) if entry['log_uid'] else None
            if log and (log.scope != entry['scope'] or log.product_id.id != entry['product_id']
                        or not verified.get(log)):
                log = None
            if log:
                limits = self._dg_employee_limits(log.authorizer_employee_id, True)
            elif not config.require_discount_auth:
                limits = cashier_limits
            else:
                violations.append(_("%(label)s: discount without a verified employee authorization.") % {
                    'label': entry['label']})
                continue
            used_limits.append(limits)
            if config.enforce_discount_limits:
                allowed = entry['base'] * limits[0] / 100.0
                if currency.compare_amounts(entry['amount'], allowed) > 0:
                    violations.append(_(
                        "%(label)s: discount of %(amount)s exceeds the authorized "
                        "maximum of %(percent)s%% (%(allowed)s).") % {
                        'label': entry['label'],
                        'amount': fmt_amount(entry['amount']),
                        'percent': formatLang(self.env, limits[0]),
                        'allowed': fmt_amount(allowed),
                    })
            if log:
                approved = log.value if log.mode == 'fixed' else entry['base'] * log.value / 100.0
                if currency.compare_amounts(entry['amount'], approved + currency.rounding) > 0:
                    violations.append(_(
                        "%(label)s: discount of %(amount)s is higher than the approved %(approved)s.") % {
                        'label': entry['label'],
                        'amount': fmt_amount(entry['amount']),
                        'approved': fmt_amount(approved),
                    })
        if config.enforce_discount_limits and used_limits:
            caps = [limit[1] for limit in used_limits]
            if None not in caps and currency.compare_amounts(summary['amount'], max(caps)) > 0:
                violations.append(_(
                    "Total discount of %(amount)s exceeds the authorized maximum of "
                    "%(allowed)s per order.") % {
                    'amount': fmt_amount(summary['amount']),
                    'allowed': fmt_amount(max(caps)),
                })
        return violations

    def _dg_rejection_message(self, violations):
        return _("Order %(order)s was rejected by POS Discount Governance:\n%(details)s") % {
            'order': self.pos_reference or self.name,
            'details': '\n'.join(violations),
        }

    def _dg_enforce_discount_governance(self):
        for order in self:
            violations = order._dg_governance_violations()
            if not violations:
                continue
            if order.config_id.discount_violation_action == 'block':
                raise ValidationError(order._dg_rejection_message(violations))
            order.sudo().write({
                'discount_violation': True,
                'discount_violation_note': '\n'.join(violations),
            })

    def action_view_discount_logs(self):
        self.ensure_one()
        action = self.env['ir.actions.act_window']._for_xml_id(
            'pos_discount_governance.action_pos_order_discount_log')
        action['domain'] = [('order_id', '=', self.id)]
        action['context'] = {'create': False}
        return action


class PosOrderLine(models.Model):
    _inherit = 'pos.order.line'

    discount_mode = fields.Selection(DISCOUNT_MODE_SELECTION, string='Discount Mode', default='percent')
    discount_fixed_amount = fields.Float(string='Fixed Discount', digits='Account')
    discount_log_uid = fields.Char(string='Discount Log UID', copy=False,
                                   help="Audit log entry that authorized the discount of this line.")

    @api.model
    def _load_pos_data_fields(self, config):
        return super()._load_pos_data_fields(config) + [
            'discount_mode', 'discount_fixed_amount', 'discount_log_uid',
        ]

    def _dg_is_reward_line(self):
        self.ensure_one()
        return bool('is_reward_line' in self._fields and self.is_reward_line)

