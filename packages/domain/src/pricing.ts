/**
 * Client price from the supplier price and the markup table (settings `pricing.markup_rules`).
 * Formula (PLAN "Текущий шаг", decision 11): ceil(p * (10000 + bp) / 1_000_000) * 100, i.e. the
 * marked-up price rounded up to a whole ruble, computed in integers only.
 */
import { ceilDiv, MoneyError, safeMul } from './money';
import type { BasisPoints, Kop, MarkupRule, PriceResult } from './types';

export class MarkupRulesError extends Error {
  override name = 'MarkupRulesError';
}

function isBp(value: unknown): value is BasisPoints {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/**
 * Throws MarkupRulesError unless the rules cover [0; infinity) with half-open ranges
 * [fromKop; toKop) that have no gaps and no overlaps. Order of the input does not matter.
 */
export function validateMarkupRules(rules: readonly MarkupRule[]): void {
  if (rules.length === 0) throw new MarkupRulesError('markup rules are empty');
  for (const rule of rules) {
    if (!Number.isSafeInteger(rule.fromKop) || rule.fromKop < 0) {
      throw new MarkupRulesError(`invalid fromKop ${String(rule.fromKop)}`);
    }
    if (rule.toKop !== null && (!Number.isSafeInteger(rule.toKop) || rule.toKop <= rule.fromKop)) {
      throw new MarkupRulesError(`invalid range [${rule.fromKop}; ${String(rule.toKop)})`);
    }
    if (!isBp(rule.localBp) || !isBp(rule.orderBp)) {
      throw new MarkupRulesError(`invalid markup in range starting at ${rule.fromKop}`);
    }
  }
  const sorted = [...rules].sort((a, b) => a.fromKop - b.fromKop);
  if (sorted[0]?.fromKop !== 0) throw new MarkupRulesError('markup rules must start at 0');
  for (let i = 0; i < sorted.length; i += 1) {
    const rule = sorted[i] as MarkupRule;
    const next = sorted[i + 1];
    if (next === undefined) {
      if (rule.toKop !== null) throw new MarkupRulesError('last markup range must be open-ended');
    } else if (rule.toKop === null) {
      throw new MarkupRulesError('only the last markup range may be open-ended');
    } else if (next.fromKop > rule.toKop) {
      throw new MarkupRulesError(`gap between ${rule.toKop} and ${next.fromKop}`);
    } else if (next.fromKop < rule.toKop) {
      throw new MarkupRulesError(`overlap at ${next.fromKop}`);
    }
  }
}

/** The rule whose [fromKop; toKop) contains the supplier price. */
export function findMarkupRule(rules: readonly MarkupRule[], priceSupplierKop: Kop): MarkupRule {
  const rule = rules.find(
    (r) => r.fromKop <= priceSupplierKop && (r.toKop === null || priceSupplierKop < r.toKop),
  );
  if (rule === undefined) {
    throw new MarkupRulesError(`no markup rule for supplier price ${priceSupplierKop}`);
  }
  return rule;
}

/** Applies basis points and rounds up to a whole ruble: integer-only. */
export function applyMarkup(priceSupplierKop: Kop, markupBp: BasisPoints): Kop {
  return safeMul(ceilDiv(safeMul(priceSupplierKop, 10_000 + markupBp), 1_000_000), 100);
}

/**
 * Client unit price. `priceSupplierKop` must be a positive safe integer (0, negatives, NaN and
 * fractions throw MoneyError). Local (Orenburg) stocks use `localBp`, to-order stocks `orderBp`.
 */
export function price(
  rules: readonly MarkupRule[],
  priceSupplierKop: Kop,
  isLocal: boolean,
): PriceResult {
  if (!Number.isSafeInteger(priceSupplierKop) || priceSupplierKop <= 0) {
    throw new MoneyError('supplier price must be a positive integer number of kopecks');
  }
  const rule = findMarkupRule(rules, priceSupplierKop);
  const markupBp = isLocal ? rule.localBp : rule.orderBp;
  if (!isBp(markupBp)) throw new MarkupRulesError('markup must be non-negative integer bp');
  return { priceClientKop: applyMarkup(priceSupplierKop, markupBp), markupBp };
}
