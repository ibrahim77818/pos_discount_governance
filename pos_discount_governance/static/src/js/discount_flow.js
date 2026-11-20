/** @odoo-module */

/**
 * Shared flow behind the "% Disc" numpad button (scope 'line') and the
 * global Discount button (scope 'global'):
 *   1. optional employee verification (badge / PIN / both)
 *   2. discount entry (percentage or fixed amount)
 *   3. in-memory limit check, supervisor override when exceeded
 *   4. cent-exact application
 *   5. audit log entry (synced with the order)
 *
 * `ctx` is { pos, popup }: the POS store and the popup service.
 */
import { _t } from "@web/core/l10n/translation";
import { ErrorPopup } from "@point_of_sale/app/errors/popups/error_popup";
import { ConfirmPopup } from "@point_of_sale/app/utils/confirm_popup/confirm_popup";
import { fmt, formatPct } from "@pos_discount_governance/js/governance";
import { DiscountAuthPopup } from "@pos_discount_governance/js/Popups/DiscountAuthPopup";
import { DiscountEntryPopup } from "@pos_discount_governance/js/Popups/DiscountEntryPopup";

async function showError(ctx, title, body) {
    await ctx.popup.add(ErrorPopup, { title, body });
}

export async function authenticate(ctx, { title, body, candidates }) {
    const gov = ctx.pos.discountGovernance;
    const method = gov.authMethod;
    candidates = gov.withCredentials(candidates);
    const { confirmed, payload } = await ctx.popup.add(DiscountAuthPopup, {
        title,
        body,
        method,
        candidates: candidates.map((emp) => ({ id: emp.id, name: emp.name })),
        verify: (input) => gov.verifyCredentials(Object.assign({}, input, { candidates })),
    });
    return confirmed ? payload : null;
}

function planFor(gov, scope, order, line, mode, value) {
    return scope === 'line' ? gov.planLine(line, mode, value) : gov.planGlobal(order, mode, value);
}

export async function runDiscountFlow(ctx, scope) {
    const pos = ctx.pos;
    const gov = pos.discountGovernance;
    const order = pos.get_order();
    if (!gov || !order) {
        return false;
    }

    // 0. Preconditions --------------------------------------------------
    let line = null;
    if (scope === 'line') {
        line = order.get_selected_orderline();
        if (!line) {
            await showError(ctx, _t('No line selected'), _t('Select an order line first.'));
            return false;
        }
        if (!gov.isDiscountableLine(line)) {
            await showError(ctx, _t('Not allowed'), _t('This line cannot be discounted.'));
            return false;
        }
    } else {
        if (!gov.discountProduct()) {
            await showError(ctx, _t('No discount product found'),
                _t("The discount product seems misconfigured. Make sure it is flagged as 'Can be Sold' and 'Available in Point of Sale'."));
            return false;
        }
        if (!order.get_orderlines().some((l) => gov.isDiscountableLine(l))) {
            await showError(ctx, _t('Nothing to discount'), _t('There is nothing to discount on this order.'));
            return false;
        }
    }

    // 1. Identification -------------------------------------------------
    let actor = gov.currentEmployee();
    let actorAuth = null;
    if (gov.requireAuth) {
        actorAuth = await authenticate(ctx, {
            title: _t('Authorize Discount'),
            body: _t('Verify your identity to apply a discount.'),
            candidates: gov.employees(),
        });
        if (!actorAuth) {
            return false;
        }
        actor = actorAuth.employee;
    }
    const actorLimits = gov.limitsFor(actor, Boolean(actorAuth));

    // 2. Entry ----------------------------------------------------------
    const startingMode = scope === 'line' ? line.discount_mode || 'percent' : 'percent';
    let startingValue = pos.config.discount_pc || 0;
    if (scope === 'line') {
        startingValue = startingMode === 'fixed' ? line.discount_fixed_amount : Number(formatPct(line.get_discount()));
    }
    const { confirmed, payload } = await ctx.popup.add(DiscountEntryPopup, {
        title: scope === 'line' ? _t('Line Discount') : _t('Global Discount'),
        subtitle: scope === 'line' ? line.get_full_product_name() : '',
        // A level without fixed discounts can still escalate to a supervisor.
        allowFixed: gov.allowFixed,
        startingMode,
        startingValue,
        currencySymbol: pos.currency.symbol,
        policyLabel: gov.policyLabel(),
        limitText: gov.describeLimits(actorLimits),
        preview: (mode, value) => {
            const plan = planFor(gov, scope, order, line, mode, value);
            if (plan.error) {
                return { error: plan.error, text: '' };
            }
            return {
                error: '',
                text: fmt(_t('Discount: %s (%s%%)'), gov.format(plan.amount), formatPct(mode === 'percent' ? value : plan.effectivePercent)),
            };
        },
    });
    if (!confirmed) {
        return false;
    }
    const { mode, value } = payload;
    const plan = planFor(gov, scope, order, line, mode, value);
    if (plan.error) {
        await showError(ctx, _t('Invalid discount'), plan.error);
        return false;
    }

    // 3. Limits & supervisor override ----------------------------------
    const pending = scope === 'line'
        ? { line: { cid: line.cid, percent: plan.percent } }
        : { global: { amount: plan.amount, base: plan.base } };
    const summary = gov.orderSummary(order, pending);
    const context = { scope, mode };
    let authorizer = actor;
    let auth = actorAuth;
    let escalated = false;
    const reasons = gov.pendingViolations(order, summary, actorLimits, context);
    if (reasons.length) {
        const { confirmed: wantsOverride } = await ctx.popup.add(ConfirmPopup, {
            title: _t('Discount Above Your Limit'),
            body: reasons.join('\n') + '\n\n' + _t('Ask a supervisor to approve this discount?'),
            confirmText: _t('Override'),
            cancelText: _t('Cancel'),
        });
        if (!wantsOverride) {
            return false;
        }
        const supervisors = gov.withCredentials(gov.overrideCandidates(order, summary, context));
        if (!supervisors.length) {
            await showError(ctx, _t('No supervisor available'),
                _t('No employee is allowed to approve this discount.'));
            return false;
        }
        const supervisorAuth = await authenticate(ctx, {
            title: _t('Supervisor Override'),
            body: fmt(_t('Approve a discount of %s.'), gov.format(plan.amount)),
            candidates: supervisors,
        });
        if (!supervisorAuth) {
            return false;
        }
        const supervisorLimits = gov.limitsFor(supervisorAuth.employee, true);
        if (!supervisorLimits.canOverride || gov.pendingViolations(order, summary, supervisorLimits, context).length) {
            await showError(ctx, _t('Override refused'),
                fmt(_t('%s cannot approve this discount.'), supervisorAuth.employee.name));
            return false;
        }
        authorizer = supervisorAuth.employee;
        auth = supervisorAuth;
        escalated = true;
    }

    // 4. Apply (the discount carries the uid of its own approval) -------
    const uid = gov.newLogUid(order);
    if (scope === 'line') {
        gov.applyLinePlan(line, plan, mode, value, uid);
    } else {
        await gov.applyGlobalPlan(order, plan, mode, value, uid);
    }

    // 5. Audit -----------------------------------------------------------
    gov.logDiscount(order, { uid, scope, mode, value, plan, line, authorizer, auth, escalated });
    return true;
}

