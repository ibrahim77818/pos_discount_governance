# -*- coding: utf-8 -*-
from odoo import api, fields, models, _
from odoo.exceptions import ValidationError


class PosDiscountLevel(models.Model):
    _name = 'pos.discount.level'
    _description = 'POS Discount Level'
    _order = 'sequence, max_discount_percent, id'

    name = fields.Char(string='Level Name', required=True, translate=True)
    sequence = fields.Integer(default=10)
    active = fields.Boolean(default=True)
    company_id = fields.Many2one('res.company', string='Company',
                                 default=lambda self: self.env.company)
    currency_id = fields.Many2one('res.currency', string='Currency',
                                  compute='_compute_currency_id')
    max_discount_percent = fields.Float(
        string='Max Discount (%)', default=0.0, digits=(16, 2),
        help="Highest discount percentage this level may grant on a single "
             "line or as a global discount. 100 means no percentage limit.")
    max_discount_amount = fields.Monetary(
        string='Max Discount Amount per Order', default=0.0,
        help="Highest total discount amount (all line and global discounts "
             "of one order, in the configured tax basis). 0 means no amount limit.")
    allow_fixed_discount = fields.Boolean(string='Allow Fixed Amount Discounts', default=True)
    allow_global_discount = fields.Boolean(string='Allow Global Discounts', default=True)
    can_override = fields.Boolean(
        string='Can Approve Overrides',
        help="Employees of this level may authorize discounts above the "
             "limit of the cashier (supervisor override), within their own limits.")
    employee_ids = fields.One2many('hr.employee', 'pos_discount_level_id', string='Employees')
    employee_count = fields.Integer(string='Employee Count', compute='_compute_employee_count')

    _sql_constraints = [
        ('percent_range', 'CHECK(max_discount_percent >= 0 AND max_discount_percent <= 100)',
         'The maximum discount percentage must be between 0 and 100.'),
        ('amount_positive', 'CHECK(max_discount_amount >= 0)',
         'The maximum discount amount cannot be negative.'),
    ]

    @api.depends('company_id')
    def _compute_currency_id(self):
        for level in self:
            level.currency_id = (level.company_id or self.env.company).currency_id

    @api.depends('employee_ids')
    def _compute_employee_count(self):
        for level in self:
            level.employee_count = len(level.employee_ids)

    @api.constrains('company_id', 'employee_ids')
    def _check_company(self):
        for level in self.filtered('company_id'):
            if any(emp.company_id and emp.company_id != level.company_id for emp in level.employee_ids):
                raise ValidationError(_("Employees of a discount level must belong to the level's company."))

    # ------------------------------------------------------------------
    # Limit helpers (mirrored in governance.js)
    # ------------------------------------------------------------------
    def _dg_limits(self):
        """Return (max_percent, max_amount or None). An empty recordset means
        'no restriction'."""
        if not self:
            return 100.0, None
        self.ensure_one()
        return self.max_discount_percent, (self.max_discount_amount or None)
