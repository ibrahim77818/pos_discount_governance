# -*- coding: utf-8 -*-
from odoo import fields, models


class ResConfigSettings(models.TransientModel):
    _inherit = 'res.config.settings'

    pos_discount_tax_policy = fields.Selection(
        related='pos_config_id.discount_tax_policy', readonly=False)
    pos_allow_fixed_discount = fields.Boolean(
        related='pos_config_id.allow_fixed_discount', readonly=False)
    pos_require_discount_auth = fields.Boolean(
        related='pos_config_id.require_discount_auth', readonly=False)
    pos_discount_auth_method = fields.Selection(
        related='pos_config_id.discount_auth_method', readonly=False)
    pos_enforce_discount_limits = fields.Boolean(
        related='pos_config_id.enforce_discount_limits', readonly=False)
    pos_default_discount_level_id = fields.Many2one(
        related='pos_config_id.default_discount_level_id', readonly=False)
    pos_discount_violation_action = fields.Selection(
        related='pos_config_id.discount_violation_action', readonly=False)
