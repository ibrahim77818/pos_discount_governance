/** @odoo-module */

import { AbstractAwaitablePopup } from "@point_of_sale/app/popup/abstract_awaitable_popup";
import { _t } from "@web/core/l10n/translation";
import { useState, useRef, onMounted } from "@odoo/owl";

const ARABIC_DIGITS = { '٠': '0', '١': '1', '٢': '2', '٣': '3', '٤': '4', '٥': '5', '٦': '6', '٧': '7', '٨': '8', '٩': '9',
    '۰': '0', '۱': '1', '۲': '2', '۳': '3', '۴': '4', '۵': '5', '۶': '6', '۷': '7', '۸': '8', '۹': '9' };

/** Accepts Western, Arabic-Indic and Persian digits; ',' '٫' '.' as decimal mark. */
function normalizeNumber(raw) {
    return String(raw || '')
        .replace(/[٠-٩۰-۹]/g, (d) => ARABIC_DIGITS[d])
        .replace(/[٫,]/g, '.')
        .replace(/[^0-9.]/g, '');
}

export class DiscountEntryPopup extends AbstractAwaitablePopup {
    setup() {
        super.setup();
        const start = this.props.startingValue;
        this.state = useState({
            mode: this.props.allowFixed ? this.props.startingMode || 'percent' : 'percent',
            value: start ? String(start) : '',
            error: '',
        });
        this.inputRef = useRef('value');
        onMounted(() => {
            if (this.inputRef.el) {
                this.inputRef.el.focus();
                this.inputRef.el.select();
            }
        });
    }
    get numericValue() {
        const value = parseFloat(normalizeNumber(this.state.value));
        return Number.isFinite(value) ? value : NaN;
    }
    get preview() {
        const value = this.numericValue;
        if (!this.props.preview || Number.isNaN(value)) {
            return { text: '', error: '' };
        }
        return this.props.preview(this.state.mode, value) || { text: '', error: '' };
    }
    setMode(mode) {
        if (mode === 'fixed' && !this.props.allowFixed) {
            return;
        }
        if (mode !== this.state.mode) {
            // 4 % must not silently become 4 SR: start the new mode empty.
            this.state.value = '';
            if (this.inputRef.el) {
                this.inputRef.el.value = '';
                this.inputRef.el.focus();
            }
        }
        this.state.mode = mode;
        this.state.error = '';
    }
    noop() {}
    onInput(ev) {
        this.state.value = normalizeNumber(ev.target.value);
        this.state.error = '';
    }
    onKeydown(ev) {
        if (ev.key === 'Enter') {
            ev.preventDefault();
            ev.stopPropagation();
            this.confirm();
        } else if (ev.key === 'Escape') {
            ev.preventDefault();
            this.cancel();
        }
    }
    pressKey(key) {
        if (key === 'C') {
            this.state.value = '';
        } else if (key === 'Backspace') {
            this.state.value = this.state.value.slice(0, -1);
        } else if (key === '.') {
            if (!this.state.value.includes('.')) {
                this.state.value = (this.state.value || '0') + '.';
            }
        } else {
            this.state.value += key;
        }
        this.state.error = '';
    }
    async confirm() {
        const value = this.numericValue;
        if (Number.isNaN(value) || value < 0) {
            this.state.error = _t('Enter a valid positive number.');
            return;
        }
        if (this.state.mode === 'percent' && value > 100) {
            this.state.error = _t('A percentage cannot exceed 100.');
            return;
        }
        const preview = this.preview;
        if (preview.error) {
            this.state.error = preview.error;
            return;
        }
        return super.confirm();
    }
    getPayload() {
        return { mode: this.state.mode, value: this.numericValue };
    }
    static template = "pos_discount_governance.DiscountEntryPopup";
    static defaultProps = {
        confirmText: _t('Apply'),
        cancelText: _t('Cancel'),
        title: _t('Discount'),
        subtitle: '',
        allowFixed: true,
        startingMode: 'percent',
        startingValue: 0,
        currencySymbol: '',
        policyLabel: '',
        limitText: '',
    };
}
