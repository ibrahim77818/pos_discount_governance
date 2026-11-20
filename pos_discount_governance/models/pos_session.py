# -*- coding: utf-8 -*-
from odoo import models


class PosSession(models.Model):
    _inherit = 'pos.session'

    def _pos_ui_models_to_load(self):
        models_to_load = super()._pos_ui_models_to_load()
        if 'pos.discount.level' not in models_to_load:
            models_to_load.append('pos.discount.level')
        return models_to_load

    def _loader_params_pos_discount_level(self):
        return {
            'search_params': {
                'domain': [('company_id', 'in', [False, self.company_id.id])],
                'fields': [
                    'id', 'name', 'sequence', 'max_discount_percent', 'max_discount_amount',
                    'allow_fixed_discount', 'allow_global_discount', 'can_override',
                ],
            },
        }

    def _get_pos_ui_pos_discount_level(self, params):
        return self.env['pos.discount.level'].search_read(**params['search_params'])

    def _loader_params_hr_employee(self):
        params = super()._loader_params_hr_employee()
        fields_list = params['search_params'].setdefault('fields', [])
        if fields_list and 'pos_discount_level_id' not in fields_list:
            fields_list.append('pos_discount_level_id')
        return params

    def _pos_data_process(self, loaded_data):
        super()._pos_data_process(loaded_data)
        employee = self.env.user.with_company(self.company_id).employee_id
        loaded_data['pos_discount_governance'] = {
            'user_employee': {
                'id': employee.id,
                'name': employee.name,
                'pos_discount_level_id': employee.pos_discount_level_id.id or False,
            } if employee else False,
            'price_digits': self.env['pos.discount.engine']._dg_price_digits(self.currency_id),
        }
