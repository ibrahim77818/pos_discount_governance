/** @odoo-module */

/**
 * Session-level discount governance cache.
 *
 * Built once in PosStore._processData() from data loaded with the session;
 * every check below runs purely in memory (zero RPC at checkout).
 * The authorization rules mirror pos.order._dg_governance_violations().
 */
import { _t } from "@web/core/l10n/translation";
import { roundPrecision as round_pr, roundDecimals as round_di } from "@web/core/utils/numbers";
import * as engine from "@pos_discount_governance/js/discount_engine";
import { sha1Hex } from "@pos_discount_governance/js/sha1";
import { accountTaxHelpers } from "@account/helpers/account_tax";

const MAX_FAILURES = 5;
const LOCK_SECONDS = 60;

function m2oId(value) {
    if (Array.isArray(value)) {
        return value[0];
    }
    if (value && typeof value === "object") {
        return value.id || false; // Odoo 18 related record
    }
    return value || false;
}

/** Minimal positional %s formatter (keeps msgids translatable). */
export function fmt(template, ...args) {
    let index = 0;
    return String(template).replace(/%%|%s/g, (match) => (match === '%%' ? '%' : String(args[index++])));
}

/** 1.3800000000000001 -> "1.38", 10 -> "10". */
export function formatPct(value) {
    return String(Number(round_di(value || 0, 2).toFixed(2)));
}

/** Integer form of an approved value; same as dg_value_units() in Python. */
export function valueUnits(mode, value, rounding) {
    const v = Number(value) || 0;
    if (mode === 'fixed') {
        return Math.floor(v / rounding + 0.5 + 1e-9);
    }
    return Math.floor(v * 10000 + 0.5 + 1e-9);
}

export class DiscountGovernance {
    constructor(pos) {
        this.pos = pos;
        const session = pos.session || {};
        this.levels = pos.models["pos.discount.level"]?.getAll() || [];
        this.levelById = {};
        for (const level of this.levels) {
            this.levelById[level.id] = level;
        }
        this.userEmployee = session._dg_user_employee || false;
        const currency = engine.currencyOf(pos);
        const currencyDigits = currency.decimal_places !== undefined
            ? currency.decimal_places
            : Math.max(0, Math.ceil(-Math.log10(currency.rounding)));
        this.priceDigits = session._dg_price_digits !== undefined ? session._dg_price_digits : currencyDigits;
        this.failures = 0;
        this.lockedUntil = 0;
    }

    // --------------------------------------------------------------
    // Configuration
    // --------------------------------------------------------------
    get config() {
        return this.pos.config;
    }
    get policy() {
        return this.config.discount_tax_policy || 'before_tax';
    }
    get rounding() {
        return engine.currencyOf(this.pos).rounding;
    }
    get requireAuth() {
        return Boolean(this.config.require_discount_auth);
    }
    get enforceLimits() {
        return Boolean(this.config.enforce_discount_limits);
    }
    get allowFixed() {
        return this.config.allow_fixed_discount !== false;
    }
    get authMethod() {
        return this.config.discount_auth_method || 'pin';
    }
    policyLabel() {
        return this.policy === 'after_tax' ? _t('After tax') : _t('Before tax');
    }
    discountProduct() {
        const product = this.config.discount_product_id;
        if (!this.config.module_pos_discount || !product) {
            return null;
        }
        return typeof product === "object" ? product : this.pos.models["product.product"].get(product) || null;
    }
    format(amount) {
        return this.pos.env.utils.formatCurrency(amount);
    }

    // --------------------------------------------------------------
    // Employees & levels
    // --------------------------------------------------------------
    employees() {
        return (this.config.module_pos_hr && this.pos.models["hr.employee"]?.getAll()) || [];
    }
    employeeById(id) {
        return this.employees().find((emp) => emp.id === id) || null;
    }
    currentEmployee() {
        if (this.config.module_pos_hr) {
            const cashier = this.pos.get_cashier();
            return cashier && this.employees().includes(cashier) ? cashier : null;
        }
        return this.userEmployee || null;
    }
    levelFor(employee, verified = true) {
        const defaultLevel = this.levelById[m2oId(this.config.default_discount_level_id)] || null;
        const levelId = employee ? m2oId(employee.pos_discount_level_id) : false;
        const level = this.levelById[levelId] || defaultLevel;
        // An approver-level employee without a PIN (reachable from the lock
        // screen by anyone) only gets the default level when unverified.
        if (!verified && employee && level && level.can_override && this.config.module_pos_hr && !employee._pin) {
            return defaultLevel;
        }
        return level;
    }
    limitsFor(employee, verified = true) {
        const level = this.levelFor(employee, verified);
        if (!level) {
            return { level: null, percent: 100, amount: null, allowFixed: true, allowGlobal: true, canOverride: false };
        }
        return {
            level,
            percent: level.max_discount_percent,
            amount: level.max_discount_amount || null,
            allowFixed: level.allow_fixed_discount,
            allowGlobal: level.allow_global_discount,
            canOverride: level.can_override,
        };
    }
    describeLimits(limits) {
        if (!limits.level || !this.enforceLimits) {
            return _t('No discount limit');
        }
        let text = fmt(_t('Your limit: %s%% per discount'), formatPct(limits.percent));
        if (limits.amount !== null) {
            text += ' · ' + fmt(_t('%s per order'), this.format(limits.amount));
        }
        return text;
    }

    // --------------------------------------------------------------
    // Lines
    // --------------------------------------------------------------
    isGlobalDiscountLine(line) {
        const product = this.discountProduct();
        return Boolean(product && line.get_product().id === product.id);
    }
    isGovernedLine(line) {
        return !line.refunded_orderline_id && !line.is_reward_line;
    }
    isDiscountableLine(line) {
        return this.isGovernedLine(line) && !this.isGlobalDiscountLine(line);
    }

    // --------------------------------------------------------------
    // Planning
    // --------------------------------------------------------------
    planLine(line, mode, value) {
        const plan = engine.computeLineDiscount(this.pos, line, mode, value, this.policy);
        if (plan.error) {
            return { error: _t('The discount exceeds the line total.') };
        }
        return plan;
    }
    taxGroups(order) {
        const groups = new Map();
        for (const line of order.get_orderlines()) {
            if (!this.isDiscountableLine(line)) {
                continue;
            }
            if (typeof line.isGlobalDiscountApplicable === 'function' && !line.isGlobalDiscountApplicable()) {
                continue;
            }
            const taxes = engine
                .lineTaxes(this.pos, line)
                .filter((tax) => accountTaxHelpers.can_be_discounted(tax));
            const taxIds = taxes.map((t) => t.id).sort((a, b) => a - b);
            const key = taxIds.join(',');
            if (!groups.has(key)) {
                groups.set(key, { key, taxes, taxIds, excluded: 0, included: 0 });
            }
            const prices = line.get_all_prices();
            const group = groups.get(key);
            group.excluded += prices.priceWithoutTax;
            group.included += prices.priceWithTax;
        }
        return [...groups.values()];
    }
    planGlobal(order, mode, value) {
        const plan = engine.planGlobalDiscount(
            this.pos, this.taxGroups(order), mode, value, this.policy, this.priceDigits);
        if (plan.error === 'exceeds_order') {
            return { error: _t('The discount exceeds the order total.') };
        }
        if (plan.error) {
            return { error: _t('There is nothing to discount on this order.') };
        }
        return plan;
    }

    // --------------------------------------------------------------
    // Applying (every governed discount carries the uid of its approval)
    // --------------------------------------------------------------
    newLogUid(order) {
        return `${order.pos_reference}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    }
    applyLinePlan(line, plan, mode, value, logUid) {
        line.set_discount(plan.percent);
        const discounted = plan.percent > 0;
        const fixed = mode === 'fixed' && discounted;
        line.discount_mode = fixed ? 'fixed' : 'percent';
        line.discount_fixed_amount = fixed ? round_pr(value, this.rounding) : 0;
        line.discount_log_uid = discounted ? logUid : false;
    }
    reapplyFixedLineDiscount(line) {
        const plan = engine.computeLineDiscount(
            this.pos, line, 'fixed', line.discount_fixed_amount, this.policy);
        const uid = line.discount_log_uid;
        line.set_discount(plan.error ? 100 : plan.percent);
        line.discount_log_uid = uid;
    }
    async applyGlobalPlan(order, plan, mode, value, logUid) {
        const product = this.discountProduct();
        order.get_orderlines()
            .filter((line) => this.isGlobalDiscountLine(line))
            .forEach((line) => line.delete());
        for (const planned of plan.lines) {
            await this.pos.addLineToCurrentOrder(
                {
                    product_id: product,
                    price_unit: planned.price,
                    tax_ids: [["link", ...planned.taxes]],
                    discount_log_uid: logUid,
                },
                { merge: false }
            );
        }
    }

    // --------------------------------------------------------------
    // Discount entries
    // --------------------------------------------------------------
    /**
     * Discount entries of an order (policy basis), optionally with a
     * pending change: {line: {uuid, percent}} or {global: {amount, base}}.
     * Same rules as pos.order._dg_discount_summary().
     */
    orderSummary(order, pending = {}) {
        const rounding = this.rounding;
        const entries = [];
        let regular = 0;
        let globalTotal = 0;
        const globalUids = [];
        let globalLines = 0;
        const discountProduct = this.discountProduct();
        for (const line of order.get_orderlines()) {
            if (!this.isGovernedLine(line)) {
                continue;
            }
            const taxes = engine.lineTaxes(this.pos, line);
            if (this.isGlobalDiscountLine(line)) {
                globalLines += 1;
                if (line.discount_log_uid) {
                    globalUids.push(line.discount_log_uid);
                }
                globalTotal += engine.lineTotal(
                    this.pos, taxes, line.get_unit_price(), line.get_quantity(), line.get_discount(), this.policy);
                continue;
            }
            // Odoo 18 lines have no cid (always null): identify them by uuid.
            const isPending = Boolean(pending.line && pending.line.uuid === line.uuid);
            const discount = isPending ? pending.line.percent : line.get_discount();
            const discounted = engine.lineTotal(
                this.pos, taxes, line.get_unit_price(), line.get_quantity(), discount, this.policy);
            regular += discounted;
            if (!discount) {
                continue;
            }
            const undiscounted = engine.lineTotal(
                this.pos, taxes, line.get_unit_price(), line.get_quantity(), 0, this.policy);
            entries.push({
                scope: 'line',
                pending: isPending,
                label: line.get_full_product_name ? line.get_full_product_name() : line.get_product().display_name,
                productId: line.get_product().id,
                logUid: isPending ? false : line.discount_log_uid || false,
                amount: round_pr(Math.abs(undiscounted - discounted), rounding),
                base: Math.abs(undiscounted),
            });
        }
        const globalBase = {
            scope: 'global',
            label: _t('Global discount'),
            productId: discountProduct ? discountProduct.id : false,
        };
        if (pending.global) {
            entries.push(Object.assign(globalBase, {
                pending: true, logUid: false, amount: pending.global.amount, base: pending.global.base,
            }));
        } else if (globalLines) {
            const single = globalUids.length === globalLines && new Set(globalUids).size === 1;
            entries.push(Object.assign(globalBase, {
                pending: false,
                logUid: single ? globalUids[0] : false,
                amount: round_pr(Math.abs(globalTotal), rounding),
                base: Math.abs(regular),
            }));
        }
        const amount = round_pr(entries.reduce((s, e) => s + e.amount, 0), rounding);
        return { entries, amount };
    }

    /** Authority covering an existing entry: {limits, log} or null. */
    entryAuthority(order, entry) {
        const log = entry.logUid ? order.getDiscountLogs().find((l) => l.uid === entry.logUid) : null;
        const valid = log && log.scope === entry.scope && log.product_id === entry.productId &&
            log.auth_method && log.auth_method !== 'none' && log.proof && log.authorizer_employee_id;
        if (valid) {
            return { limits: this.limitsFor(this.employeeById(log.authorizer_employee_id), true), log };
        }
        if (!this.requireAuth) {
            return { limits: this.limitsFor(this.currentEmployee(), false), log: null };
        }
        return null;
    }

    entryViolations(entry, limits, log) {
        const rounding = this.rounding;
        const reasons = [];
        if (this.enforceLimits) {
            const allowed = (entry.base * limits.percent) / 100;
            if (engine.compareAmounts(entry.amount, allowed, rounding) > 0) {
                reasons.push(fmt(_t('%s: %s exceeds the maximum of %s%%.'),
                    entry.label, this.format(entry.amount), formatPct(limits.percent)));
            }
        }
        if (log) {
            const approved = log.mode === 'fixed' ? log.value : (entry.base * log.value) / 100;
            if (engine.compareAmounts(entry.amount, approved + rounding, rounding) > 0) {
                reasons.push(fmt(_t('%s: %s is higher than the approved %s.'),
                    entry.label, this.format(entry.amount), this.format(approved)));
            }
        }
        return reasons;
    }

    capViolation(summary, limitsList) {
        if (!this.enforceLimits || !limitsList.length || limitsList.some((l) => l.amount === null)) {
            return [];
        }
        const cap = Math.max(...limitsList.map((l) => l.amount));
        if (engine.compareAmounts(summary.amount, cap, this.rounding) > 0) {
            return [fmt(_t('Order discount total %s exceeds the maximum of %s.'),
                this.format(summary.amount), this.format(cap))];
        }
        return [];
    }

    /**
     * Checks for a discount being applied: only the new discount against
     * the acting employee, plus the per-order cap. Earlier approved
     * discounts on other lines keep their own approval.
     */
    pendingViolations(order, summary, limits, context = {}) {
        const reasons = [];
        if (!this.enforceLimits) {
            return reasons;
        }
        if (context.mode === 'fixed' && !limits.allowFixed) {
            reasons.push(_t('This discount level does not allow fixed amount discounts.'));
        }
        if (context.scope === 'global' && !limits.allowGlobal) {
            reasons.push(_t('This discount level does not allow global discounts.'));
        }
        const limitsList = [limits];
        for (const entry of summary.entries) {
            if (entry.pending) {
                reasons.push(...this.entryViolations(entry, limits, null));
                continue;
            }
            const authority = this.entryAuthority(order, entry);
            if (authority) {
                limitsList.push(authority.limits);
            }
        }
        reasons.push(...this.capViolation(summary, limitsList));
        return reasons;
    }

    /** Employees able to pass the configured verification (PIN and/or badge set). */
    withCredentials(employees) {
        const method = this.authMethod;
        return employees.filter((emp) =>
            (method === 'badge' || emp._pin) && (method === 'pin' || emp._barcode));
    }

    overrideCandidates(order, summary, context) {
        return this.employees().filter((emp) => {
            const limits = this.limitsFor(emp, true);
            return limits.canOverride && !this.pendingViolations(order, summary, limits, context).length;
        });
    }

    /** Final in-memory check before payment; mirrors the server rules. */
    orderViolations(order) {
        if (!(this.enforceLimits || this.requireAuth)) {
            return [];
        }
        const summary = this.orderSummary(order);
        if (engine.isZero(summary.amount, this.rounding)) {
            return [];
        }
        const reasons = [];
        const limitsList = [];
        for (const entry of summary.entries) {
            const authority = this.entryAuthority(order, entry);
            if (!authority) {
                reasons.push(fmt(_t('%s: discount without a verified employee authorization.'), entry.label));
                continue;
            }
            limitsList.push(authority.limits);
            reasons.push(...this.entryViolations(entry, authority.limits, authority.log));
        }
        reasons.push(...this.capViolation(summary, limitsList));
        return reasons;
    }

    // --------------------------------------------------------------
    // Credentials (offline, pos_hr hashes) with a session-wide lockout
    // --------------------------------------------------------------
    verifyCredentials({ badge, pin, employeeId, candidates }) {
        const now = Date.now();
        if (this.lockedUntil > now) {
            return {
                error: fmt(_t('Too many failed attempts. Try again in %s seconds.'),
                    Math.ceil((this.lockedUntil - now) / 1000)),
                locked: true,
            };
        }
        const method = this.authMethod;
        const needsBadge = method === 'badge' || method === 'both';
        const needsPin = method === 'pin' || method === 'both';
        const badgeValue = (badge || '').trim();
        if (needsBadge && !badgeValue) {
            return { error: _t('Scan or type the badge.') };
        }
        if (needsPin && !pin) {
            return { error: _t('Enter the PIN code.') };
        }
        const pool = employeeId ? candidates.filter((emp) => emp.id === Number(employeeId)) : candidates;
        const badgeHash = needsBadge ? sha1Hex(badgeValue) : null;
        const pinHash = needsPin ? sha1Hex(pin) : null;
        const matches = pool.filter((emp) =>
            (!needsBadge || (emp._barcode && emp._barcode === badgeHash)) &&
            (!needsPin || (emp._pin && emp._pin === pinHash)));
        if (matches.length > 1) {
            return { error: _t('Several employees share this PIN: select your name first.') };
        }
        if (!matches.length) {
            this.failures += 1;
            if (this.failures >= MAX_FAILURES) {
                this.failures = 0;
                this.lockedUntil = now + LOCK_SECONDS * 1000;
                return {
                    error: fmt(_t('Too many failed attempts. Try again in %s seconds.'), LOCK_SECONDS),
                    locked: true,
                };
            }
            return { error: _t('Invalid credentials.') };
        }
        this.failures = 0;
        let secret = pin;
        if (method === 'badge') {
            secret = badgeValue;
        } else if (method === 'both') {
            secret = `${badgeValue}|${pin}`;
        }
        return { employee: matches[0], method, secret };
    }

    makeProof(method, secret, entry) {
        return sha1Hex([
            method, secret, entry.order_uid, entry.uid, entry.scope, entry.product_id || 0, entry.mode,
            valueUnits(entry.mode, entry.value, this.rounding),
        ].join(':'));
    }

    // --------------------------------------------------------------
    // Audit log
    // --------------------------------------------------------------
    logDiscount(order, { uid, scope, mode, value, plan, line, authorizer, auth, escalated }) {
        const method = auth ? auth.method : 'none';
        const cashier = this.currentEmployee();
        const product = scope === 'line' ? line.get_product() : this.discountProduct();
        const normalized = mode === 'fixed' ? round_pr(value, this.rounding) : round_di(value, 4);
        const entry = {
            uid,
            order_uid: order.pos_reference,
            timestamp: new Date().toISOString(),
            scope,
            mode,
            tax_policy: this.policy,
            value: normalized,
            amount: plan.amount,
            percent: plan.effectivePercent,
            product_id: product ? product.id : false,
            cashier_employee_id: cashier ? cashier.id : false,
            authorizer_employee_id: authorizer ? authorizer.id : (cashier ? cashier.id : false),
            auth_method: method,
            escalated: Boolean(escalated),
            proof: false,
        };
        if (auth) {
            entry.proof = this.makeProof(method, auth.secret, entry);
        }
        order.addDiscountLog(entry);
    }
}

