odoo.define('pos_discount_governance.DiscountAuthPopup', function (require) {
    'use strict';

    const AbstractAwaitablePopup = require('point_of_sale.AbstractAwaitablePopup');
    const Registries = require('point_of_sale.Registries');
    const { _lt } = require('@web/core/l10n/translation');

    const { useState, useRef, onMounted } = owl;

    /**
     * Employee verification (badge, PIN or both) against pos_hr's offline
     * SHA-1 hashes. Badge scanners act as keyboards: the focused input is an
     * editable element, so the POS barcode reader leaves the keystrokes alone
     * and the cashier is not switched by mistake.
     */
    class DiscountAuthPopup extends AbstractAwaitablePopup {
        setup() {
            super.setup();
            this.state = useState({ badge: '', pin: '', employeeId: '', error: '' });
            this.badgeRef = useRef('badge');
            this.pinRef = useRef('pin');
            this.result = null;
            onMounted(() => {
                const target = this.needsBadge ? this.badgeRef.el : this.pinRef.el;
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
                if (this.needsBadge && this.needsPin && ev.target === this.badgeRef.el && !this.state.pin) {
                    this.pinRef.el && this.pinRef.el.focus();
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
                if (this.pinRef.el) {
                    this.pinRef.el.value = '';
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
            return super.confirm();
        }
        clearPin() {
            this.state.pin = '';
            // Also reset the DOM: t-model may keep the old masked value.
            if (this.pinRef.el) {
                this.pinRef.el.value = '';
                this.pinRef.el.focus();
            } else if (this.badgeRef.el && this.props.method === 'badge') {
                this.state.badge = '';
                this.badgeRef.el.value = '';
                this.badgeRef.el.focus();
            }
        }
        getPayload() {
            return this.result;
        }
    }
    DiscountAuthPopup.template = 'pos_discount_governance.DiscountAuthPopup';
    DiscountAuthPopup.defaultProps = {
        confirmText: _lt('Verify'),
        cancelText: _lt('Cancel'),
        title: _lt('Employee Verification'),
        body: '',
        method: 'pin',
        candidates: [],
    };

    Registries.Component.add(DiscountAuthPopup);
    return DiscountAuthPopup;
});
