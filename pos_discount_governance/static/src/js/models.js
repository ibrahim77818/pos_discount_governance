odoo.define('pos_discount_governance.models', function (require) {
    'use strict';

    const { PosGlobalState, Order, Orderline } = require('point_of_sale.models');
    const Registries = require('point_of_sale.Registries');
    const core = require('web.core');
    const { DiscountGovernance, fmt, formatPct } = require('pos_discount_governance.governance');

    const _t = core._t;

    const DGPosGlobalState = (PosGlobalState) => class DGPosGlobalState extends PosGlobalState {
        async _processData(loadedData) {
            await super._processData(...arguments);
            // Loaded once per session: all later checks are in-memory.
            this.discountGovernance = new DiscountGovernance(this, loadedData);
        }
    };
    Registries.Model.extend(PosGlobalState, DGPosGlobalState);

    const DGOrder = (Order) => class DGOrder extends Order {
        constructor() {
            super(...arguments);
            this.discountLogs = this.discountLogs || [];
            this.discount_tax_policy = this.discount_tax_policy || this.pos.config.discount_tax_policy || 'before_tax';
        }
        init_from_JSON(json) {
            super.init_from_JSON(...arguments);
            this.discountLogs = json.discount_logs || [];
            this.discount_tax_policy = json.discount_tax_policy || this.pos.config.discount_tax_policy || 'before_tax';
        }
        export_as_JSON() {
            const json = super.export_as_JSON(...arguments);
            json.discount_logs = this.discountLogs || [];
            json.discount_tax_policy = this.discount_tax_policy || this.pos.config.discount_tax_policy || 'before_tax';
            return json;
        }
        addDiscountLog(entry) {
            this.discountLogs = [...(this.discountLogs || []), entry];
            if (typeof this.save_to_db === 'function') {
                this.save_to_db();
            }
        }
    };
    Registries.Model.extend(Order, DGOrder);

    const DGOrderline = (Orderline) => class DGOrderline extends Orderline {
        constructor() {
            super(...arguments);
            this.discount_mode = this.discount_mode || 'percent';
            this.discount_fixed_amount = this.discount_fixed_amount || 0;
            this.discount_log_uid = this.discount_log_uid || false;
        }
        init_from_JSON(json) {
            super.init_from_JSON(...arguments);
            this.discount_mode = json.discount_mode || 'percent';
            this.discount_fixed_amount = json.discount_fixed_amount || 0;
            this.discount_log_uid = json.discount_log_uid || false;
        }
        export_as_JSON() {
            const json = super.export_as_JSON(...arguments);
            // `discount` keeps full precision: the exact solved percentage.
            json.discount_mode = this.discount_mode || 'percent';
            json.discount_fixed_amount = this.discount_fixed_amount || 0;
            json.discount_log_uid = this.discount_log_uid || false;
            return json;
        }
        clone() {
            const line = super.clone(...arguments);
            line.discount_mode = this.discount_mode;
            line.discount_fixed_amount = this.discount_fixed_amount;
            line.discount_log_uid = this.discount_log_uid;
            return line;
        }
        set_discount(discount) {
            super.set_discount(...arguments);
            if (!this.get_discount()) {
                this.discount_mode = 'percent';
                this.discount_fixed_amount = 0;
                this.discount_log_uid = false;
            }
        }
        set_quantity() {
            const result = super.set_quantity(...arguments);
            // A fixed discount stays a fixed amount when the quantity changes.
            if (this.discount_mode === 'fixed' && this.discount_fixed_amount && this.pos.discountGovernance) {
                this.pos.discountGovernance.reapplyFixedLineDiscount(this);
            }
            return result;
        }
        get_discount_str() {
            // Display only; export_as_JSON still sends the exact percentage.
            return formatPct(this.get_discount());
        }
        export_for_printing() {
            const data = super.export_for_printing(...arguments);
            data.discount_mode = this.discount_mode;
            data.discount_fixed_amount = this.discount_fixed_amount;
            if (this.discount_mode === 'fixed' && this.discount_fixed_amount) {
                // A fixed discount prints as an amount, not as its percentage.
                data.discount = 0;
                const text = fmt(_t('Discount: %s'), this.pos.format_currency(this.discount_fixed_amount));
                data.product_name_wrapped = [...(data.product_name_wrapped || [data.product_name]), text];
            } else {
                data.discount = Number(formatPct(this.get_discount()));
            }
            return data;
        }
    };
    Registries.Model.extend(Orderline, DGOrderline);

    return { DGOrder, DGOrderline, DGPosGlobalState };
});
