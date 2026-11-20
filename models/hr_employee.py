# -*- coding: utf-8 -*-
from odoo import api, fields, models, _
from odoo.exceptions import ValidationError


class HrEmployee(models.Model):
    _inherit = 'hr.employee'

    pos_discount_level_id = fields.Many2one(
        'pos.discount.level', string='POS Discount Level', ondelete='set null',
        help="Discount limits applied to this employee in the Point of Sale. "
             "Without a level, the default level of the POS applies; without "
             "a default level, the employee is not restricted.")

    @api.model
    def _load_pos_data_fields(self, config_id):
        fields_list = super()._load_pos_data_fields(config_id)
        if fields_list and 'pos_discount_level_id' not in fields_list:
            fields_list = fields_list + ['pos_discount_level_id']
        return fields_list

    @api.constrains('pos_discount_level_id', 'pin')
    def _check_discount_approver_pin(self):
        for employee in self.sudo():
            if employee.pos_discount_level_id.can_override and not employee.pin:
                raise ValidationError(_(
                    "%s has a discount level that can approve overrides and must have a PIN code.")
                    % employee.name)
