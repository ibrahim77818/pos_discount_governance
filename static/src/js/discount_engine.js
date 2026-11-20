/** @odoo-module */

/**
 * Pure, synchronous discount arithmetic (no RPC). Step-by-step twin of
 * models/discount_engine.py so the till and the server agree to the cent.
 */
import { roundPrecision as round_pr, roundDecimals as round_di } from "@web/core/utils/numbers";

const MAX_ITERATIONS = 8;
const PRICE_PROBE = 10000.0;

export function basisKey(policy) {
    return policy === 'after_tax' ? 'total_included' : 'total_excluded';
}

export function isZero(value, rounding) {
    return Math.abs(round_pr(value, rounding)) < rounding / 2;
}

export function compareAmounts(a, b, rounding) {
    const diff = round_pr(a, rounding) - round_pr(b, rounding);
    if (Math.abs(diff) < rounding / 2) {
        return 0;
    }
    return diff > 0 ? 1 : -1;
}

/** Taxes of an order line after fiscal position, as get_all_prices() uses them. */
export function lineTaxes(pos, line) {
    const product = line.get_product();
    let ids = line.tax_ids || product.taxes_id || [];
    ids = ids.filter((id) => id in pos.taxes_by_id);
    const fiscalPosition = line.order ? line.order.fiscal_position : null;
    if (typeof pos.get_taxes_after_fp === 'function') {
        return pos.get_taxes_after_fp(ids, fiscalPosition);
    }
    return ids.map((id) => pos.taxes_by_id[id]);
}

export function lineTotal(pos, taxes, priceUnit, qty, discount, policy) {
    const rounding = pos.currency.rounding;
    const price = priceUnit * (1.0 - (discount || 0) / 100.0);
    if (!taxes || !taxes.length) {
        return round_pr(price * qty, rounding);
    }
    return pos.compute_all(taxes, price, qty, rounding)[basisKey(policy)];
}

/** Secant start + Newton corrections; returns null if reduction > line value. */
export function solvePercent(evaluate, reduction, rounding, guess) {
    if (reduction <= 0 || isZero(reduction, rounding)) {
        return 0;
    }
    const f0 = evaluate(0);
    const f100 = evaluate(100);
    const span = f0 - f100;
    if (Math.abs(span) < rounding / 2) {
        return null;
    }
    if (compareAmounts(reduction, Math.abs(span), rounding) > 0) {
        return null;
    }
    const sign = span > 0 ? 1 : -1;
    const target = round_pr(f0 - sign * reduction, rounding);
    let pct = guess !== undefined && guess !== null ? guess : (reduction / Math.abs(span)) * 100;
    let best = { diff: Infinity, pct };
    for (let i = 0; i < MAX_ITERATIONS; i++) {
        pct = Math.min(Math.max(pct, 0), 100);
        const diff = round_pr(evaluate(pct) - target, rounding);
        if (Math.abs(diff) < best.diff) {
            best = { diff: Math.abs(diff), pct };
        }
        if (Math.abs(diff) < rounding / 2) {
            return pct;
        }
        pct += (diff / span) * 100;
    }
    return best.pct;
}

/**
 * Cashier input -> exact line discount percentage.
 * @returns {{percent, amount, base, effectivePercent}|{error}}
 */
export function computeLineDiscount(pos, line, mode, value, policy) {
    const rounding = pos.currency.rounding;
    const taxes = lineTaxes(pos, line);
    const priceUnit = line.get_unit_price();
    const qty = line.get_quantity();
    const evaluate = (pct) => lineTotal(pos, taxes, priceUnit, qty, pct, policy);
    const f0 = evaluate(0);
    let pct;
    if (mode === 'percent') {
        const clamped = Math.min(Math.max(value || 0, 0), 100);
        if (policy === 'before_tax') {
            pct = clamped;
        } else {
            const reduction = round_pr((Math.abs(f0) * clamped) / 100, rounding);
            pct = solvePercent(evaluate, reduction, rounding, clamped);
        }
    } else {
        pct = solvePercent(evaluate, round_pr(value || 0, rounding), rounding);
    }
    if (pct === null) {
        return { error: 'exceeds_line' };
    }
    const amount = round_pr(Math.abs(f0 - evaluate(pct)), rounding);
    const base = Math.abs(f0);
    return { percent: pct, amount, base, effectivePercent: base ? (amount / base) * 100 : 0 };
}

/** Largest remainder split; ties go to the earliest weight (as in Python). */
export function splitProportional(amount, weights, rounding) {
    const abs = weights.map((w) => Math.abs(w));
    const totalWeight = abs.reduce((s, w) => s + w, 0);
    if (!abs.length || totalWeight < 1e-12) {
        return abs.map(() => 0);
    }
    const totalUnits = Math.round(amount / rounding);
    const raw = abs.map((w) => (totalUnits * w) / totalWeight);
    const floors = raw.map((r) => Math.floor(r + 1e-9));
    let remainder = totalUnits - floors.reduce((s, u) => s + u, 0);
    const order = raw
        .map((r, i) => ({ i, frac: r - floors[i] }))
        .sort((a, b) => b.frac - a.frac || a.i - b.i);
    for (const item of order) {
        if (remainder <= 0) {
            break;
        }
        floors[item.i] += 1;
        remainder -= 1;
    }
    return floors.map((u) => round_pr(u * rounding, rounding));
}

/** Price of a qty-1 discount line whose total (policy basis) is -reduction. */
export function solveDiscountLinePrice(pos, taxes, reduction, policy, priceDigits) {
    const rounding = pos.currency.rounding;
    const evaluate = (price) => lineTotal(pos, taxes, price, 1, 0, policy);
    const step = Math.pow(10, -priceDigits);
    const a = evaluate(0);
    const slope = (evaluate(PRICE_PROBE) - a) / PRICE_PROBE;
    if (Math.abs(slope) < 1e-9) {
        return -reduction;
    }
    const ideal = round_di((-reduction - a) / slope, priceDigits);
    const target = round_pr(-reduction, rounding);
    let best = { diff: Infinity, price: ideal };
    for (const k of [0, -1, 1, -2, 2, -3, 3]) {
        const price = round_di(ideal + k * step, priceDigits);
        const diff = Math.abs(round_pr(evaluate(price) - target, rounding));
        if (diff < best.diff) {
            best = { diff, price };
        }
        if (diff < rounding / 2) {
            return price;
        }
    }
    return best.price;
}

/**
 * Plan a global discount over tax groups.
 * @param {Array<{taxes, taxIds, excluded, included}>} groups
 * @returns {{lines, amount, base, percent, effectivePercent}|{error}}
 */
export function planGlobalDiscount(pos, groups, mode, value, policy, priceDigits) {
    const rounding = pos.currency.rounding;
    const key = policy === 'after_tax' ? 'included' : 'excluded';
    const bases = groups.map((g) => g[key]);
    const base = bases.reduce((s, b) => s + b, 0);
    if (compareAmounts(base, 0, rounding) <= 0) {
        return { error: 'nothing_to_discount' };
    }
    let total;
    if (mode === 'percent') {
        const clamped = Math.min(Math.max(value || 0, 0), 100);
        total = round_pr((base * clamped) / 100, rounding);
    } else {
        total = round_pr(value || 0, rounding);
        if (compareAmounts(total, base, rounding) > 0) {
            return { error: 'exceeds_order' };
        }
    }
    const parts = splitProportional(total, bases, rounding);
    const lines = [];
    groups.forEach((group, index) => {
        const part = parts[index];
        if (isZero(part, rounding)) {
            return;
        }
        lines.push({
            taxes: group.taxes,
            taxIds: group.taxIds,
            amount: part,
            price: solveDiscountLinePrice(pos, group.taxes, part, policy, priceDigits),
        });
    });
    const percent = (total / base) * 100;
    return { lines, amount: total, base, percent, effectivePercent: percent };
}

