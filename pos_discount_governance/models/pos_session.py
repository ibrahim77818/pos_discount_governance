# -*- coding: utf-8 -*-
from odoo import api, models


class PosSession(models.Model):
    _inherit = 'pos.session'

    @api.model
    def _load_pos_data_models(self, config_id):
        models_to_load = super()._load_pos_data_models(config_id)
        if 'pos.discount.level' not in models_to_load:
            models_to_load.append('pos.discount.level')
        return models_to_load

    def _load_pos_data(self, data):
        res = super()._load_pos_data(data)
        employee = self.env.user.with_company(self.company_id).employee_id
        res['data'][0]['_dg_user_employee'] = {
            'id': employee.id,
            'name': employee.name,
            'pos_discount_level_id': employee.pos_discount_level_id.id or False,
        } if employee else False
        res['data'][0]['_dg_price_digits'] = self.env['pos.discount.engine']._dg_price_digits(self.currency_id)
        return res
