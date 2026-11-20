# -*- coding: utf-8 -*-
from odoo import api, fields, models, _
from odoo.exceptions import ValidationError

from .discount_engine import AUTH_METHOD_SELECTION, TAX_POLICY_SELECTION


class PosConfig(models.Model):
    _inherit = 'pos.config'

    discount_tax_policy = fields.Selection(
        TAX_POLICY_SELECTION, string='Discount Tax Policy', default='before_tax', required=True,
        help="Before Tax: discounts reduce the untaxed amount. "
             "After Tax: discounts reduce the tax-included amount.")
    allow_fixed_discount = fields.Boolean(string='Allow Fixed Amount Discounts', default=True)
    require_discount_auth = fields.Boolean(
        string='Require Discount Authorization', default=False,
        help="Ask for employee verification before any line or global discount.")
    discount_auth_method = fields.Selection(
        AUTH_METHOD_SELECTION, string='Verification Method', default='pin', required=True)
    enforce_discount_limits = fields.Boolean(
        string='Enforce Discount Levels', default=True,
        help="Block discounts above the employee's discount level and ask "
             "for a supervisor override.")
    default_discount_level_id = fields.Many2one(
        'pos.discount.level', string='Default Discount Level',
        help="Level used for employees who have no discount level.")
    discount_violation_action = fields.Selection(
        [('block', 'Reject the order'), ('flag', 'Accept and flag the order')],
        string='On Server Violation', default='block', required=True,
        help="What the server does when an order arrives with discounts that "
             "are not covered by a verified authorization.")

    @api.model
    def _load_pos_data_read(self, records, config):
        # Odoo 19 sends session-level extras on the pos.config record.
        read_records = super()._load_pos_data_read(records, config)
        if read_records:
            employee = self.env.user.with_company(config.company_id).employee_id
            read_records[0]['_dg_user_employee'] = {
                'id': employee.id,
                'name': employee.name,
                'pos_discount_level_id': employee.pos_discount_level_id.id or False,
            } if employee else False
            read_records[0]['_dg_price_digits'] = self.env['pos.discount.engine']._dg_price_digits(
                config.currency_id)
        return read_records

    @api.constrains('require_discount_auth', 'module_pos_hr')
    def _check_discount_auth_requires_hr(self):
        for config in self:
            if config.require_discount_auth and not config.module_pos_hr:
                raise ValidationError(_(
                    "Discount authorization needs employee login: enable "
                    "'Log in with Employees' on the point of sale '%s'.") % config.name)
