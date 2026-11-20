# -*- coding: utf-8 -*-
{
    'name': 'POS Discount Governance',
    'version': '19.0.1.1.4',
    'category': 'Sales/Point of Sale',
    'summary': 'Percentage & fixed POS discounts with cent-exact rounding, '
               'before/after-tax policy, employee discount tiers, '
               'supervisor override and a tamper-proof discount audit log.',
    'description': """
POS Discount Governance
=======================
* Line (% Disc) and global (Discount button) discounts in percentage or
  fixed amount, rounded to the currency so POS, orders, invoices and session
  journal entries reconcile to the cent.
* Global fixed discounts are split proportionally across tax groups.
* Before-tax / after-tax discount policy per POS.
* Optional employee verification (badge, PIN or both) using pos_hr offline
  credentials, discount levels per employee and supervisor escalation.
* Server-side re-validation of every discount in _process_order.
* Discount audit log on every POS order.
    """,
    'author': 'Ibrahim Yahia',
    'website': 'https://www.linkedin.com/in/ibrahim-yahia',
    'license': 'LGPL-3',
    'depends': ['point_of_sale', 'pos_hr', 'pos_discount'],
    'data': [
        'security/pos_discount_governance_security.xml',
        'security/ir.model.access.csv',
        'data/pos_discount_level_data.xml',
        'views/pos_discount_level_views.xml',
        'views/pos_order_discount_log_views.xml',
        'views/pos_order_views.xml',
        'views/hr_employee_views.xml',
        'views/res_config_settings_views.xml',
        'views/menus.xml',
    ],
    'assets': {
        'point_of_sale._assets_pos': [
            'pos_discount_governance/static/src/**/*',
        ],
    },
    'images': ['static/description/banner.png'],
    'installable': True,
    'application': False,
    'auto_install': False,
}
