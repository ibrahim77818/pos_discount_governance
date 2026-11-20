/** @odoo-module */

import { _t } from "@web/core/l10n/translation";
import { Component, onMounted, proxy, signal, t, useProps } from "@odoo/owl";
import { Dialog } from "@web/core/dialog/dialog";

export class DiscountAuthPopup extends Component {
    static components = { Dialog };
    static template = "pos_discount_governance.DiscountAuthPopup";

    // Odoo 20 / Owl 3: props are declared with useProps (static props are refused).
    props = useProps({
        title: t.any().optional(() => _t('Employee Verification')),
        body: t.any().optional(''),
        method: t.string().optional('pin'),
        candidates: t.array().optional(() => []),
        confirmText: t.any().optional(() => _t('Verify')),
        cancelText: t.any().optional(() => _t('Cancel')),
        verify: t.function(),
        getPayload: t.function(),
        close: t.function(),
    });
    badgeRef = signal.ref();
    pinRef = signal.ref();

    setup() {
        this.state = proxy({ badge: '', pin: '', employeeId: '', error: '' });
        this.result = null;
        onMounted(() => {
            const target = this.needsBadge ? this.badgeRef() : this.pinRef();
            if (target) {
                target.focus();
            }
        });
    }
    get needsBadge() {
        return this.props.method === 'badge' || this.props.method === 'both';
    }
    get needsPin() {
        return this.props.method === 'pin' || this.props.method === 'both';
    }
    get candidates() {
        return this.props.candidates || [];
    }
    noop() {}
    onKeydown(ev) {
        if (ev.key === 'Enter') {
            ev.preventDefault();
            ev.stopPropagation();
            if (this.needsBadge && this.needsPin && ev.target === this.badgeRef() && !this.state.pin) {
                this.pinRef() && this.pinRef().focus();
                return;
            }
            this.confirm();
        } else if (ev.key === 'Escape') {
            ev.preventDefault();
            this.cancel();
        }
    }
    pressKey(key) {
        if (key === 'C') {
            this.state.pin = '';
            if (this.pinRef()) {
                this.pinRef().value = '';
            }
        } else if (key === 'Backspace') {
            this.state.pin = this.state.pin.slice(0, -1);
        } else {
            this.state.pin += key;
        }
        this.state.error = '';
    }
    get pinMask() {
        return '•'.repeat(this.state.pin.length);
    }
    async confirm() {
        const result = this.props.verify({
            badge: this.state.badge,
            pin: this.state.pin,
            employeeId: this.state.employeeId,
        });
        if (result.error) {
            this.state.error = result.error;
            this.clearPin();
            if (result.locked) {
                setTimeout(() => this.cancel(), 1500);
            }
            return;
        }
        this.result = result;
        this.props.getPayload(this.getPayload());
        this.props.close();
    }
    clearPin() {
        this.state.pin = '';
        // Also reset the DOM: t-model may keep the old masked value.
        if (this.pinRef()) {
            this.pinRef().value = '';
            this.pinRef().focus();
        } else if (this.badgeRef() && this.props.method === 'badge') {
            this.state.badge = '';
            this.badgeRef().value = '';
            this.badgeRef().focus();
        }
    }
    getPayload() {
        return this.result;
    }
    cancel() {
        this.props.close();
    }
}
