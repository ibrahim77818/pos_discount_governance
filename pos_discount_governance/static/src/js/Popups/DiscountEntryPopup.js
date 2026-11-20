/** @odoo-module */

import { _t } from "@web/core/l10n/translation";
import { Component, onMounted, proxy, signal, t, useProps } from "@odoo/owl";
import { Dialog } from "@web/core/dialog/dialog";

const ARABIC_DIGITS = { '٠': '0', '١': '1', '٢': '2', '٣': '3', '٤': '4', '٥': '5', '٦': '6', '٧': '7', '٨': '8', '٩': '9',
    '۰': '0', '۱': '1', '۲': '2', '۳': '3', '۴': '4', '۵': '5', '۶': '6', '۷': '7', '۸': '8', '۹': '9' };

/** Accepts Western, Arabic-Indic and Persian digits; ',' '٫' '.' as decimal mark. */
function normalizeNumber(raw) {
    return String(raw || '')
        .replace(/[٠-٩۰-۹]/g, (d) => ARABIC_DIGITS[d])
        .replace(/[٫,]/g, '.')
        .replace(/[^0-9.]/g, '');
}

export class DiscountEntryPopup extends Component {
    static components = { Dialog };
    static template = "pos_discount_governance.DiscountEntryPopup";

    // Odoo 20 / Owl 3: props are declared with useProps (static props are refused).
    props = useProps({
        title: t.any().optional(() => _t('Discount')),
        subtitle: t.any().optional(''),
        allowFixed: t.boolean().optional(true),
        startingMode: t.string().optional('percent'),
        startingValue: t.any().optional(0),
        currencySymbol: t.string().optional(''),
        policyLabel: t.any().optional(''),
        limitText: t.any().optional(''),
        confirmText: t.any().optional(() => _t('Apply')),
        cancelText: t.any().optional(() => _t('Cancel')),
        preview: t.function().optional(),
        getPayload: t.function(),
        close: t.function(),
    });
    inputRef = signal.ref();

    setup() {
        const start = this.props.startingValue;
        this.state = proxy({
            mode: this.props.allowFixed ? this.props.startingMode || 'percent' : 'percent',
            value: start ? String(start) : '',
            error: '',
        });
        onMounted(() => {
            const input = this.inputRef();
            if (input) {
                input.focus();
                input.select();
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
            const input = this.inputRef();
            if (input) {
                input.value = '';
                input.focus();
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
        this.props.getPayload(this.getPayload());
        this.props.close();
    }
    getPayload() {
        return { mode: this.state.mode, value: this.numericValue };
    }
    cancel() {
        this.props.close();
    }
}
