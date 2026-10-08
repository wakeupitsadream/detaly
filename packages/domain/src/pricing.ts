/**
 * Client price from the supplier price and the markup table (settings `pricing.markup_rules`).
 * Formula (PLAN "Текущий шаг", decision 11): ceil(p * (10000 + bp) / 1_000_000) * 100, i.e. the
 * marked-up price rounded up to a whole ruble, computed in integers only.
 *
 * Step 2 (docs/pricing.md): the markup of the base table may be adjusted per price group
 * (settings `pricing.group_adjustments`, basis points, negative lowers it). priceOffer is the one
 * function every place that prices an offer calls (search, cart, checkout, the VIN preview, the
 * demo): base markup of the range -> + the adjustment of the offer's group -> never past the
 * floor when lowering, never past the ceiling when raising -> applyMarkup. Without adjustments
 * it returns exactly what price() returns.
 */
import { ceilDiv, floorDiv, MoneyError, safeMul } from './money';
import { priceGroupOf } from './price-groups';
import { isOneOf, PRICE_GROUPS, type PriceGroup } from './statuses';
import type {
  BasisPoints,
  GroupAdjustment,
  Kop,
  MarkupRule,
  Offer,
  OfferPrice,
  PriceResult,
  PricingConfig,
  SettingsValues,
  StockInfo,
} from './types';

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

/** Validated markup rules, or null when the value is not a valid table (settings readers). */
export function parseMarkupRules(value: unknown): MarkupRule[] | null {
  if (!Array.isArray(value)) return null;
  try {
    validateMarkupRules(value as MarkupRule[]);
    return value as MarkupRule[];
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Step 2: group adjustments, the floor and the ceiling (docs/pricing.md)
// ---------------------------------------------------------------------------

/** Largest group adjustment either way: 50 percentage points. */
export const MAX_GROUP_DELTA_BP = 5_000;
/** Default of settings pricing.min_markup_bp: an adjustment never lowers a markup below 10%. */
export const DEFAULT_MIN_MARKUP_BP = 1_000;
/** Default of settings pricing.max_markup_bp: an adjustment never raises a markup above 60%. */
export const DEFAULT_MAX_MARKUP_BP = 6_000;
/** Largest value accepted for the floor and the ceiling settings (500%). */
export const MAX_MARKUP_BOUND_BP = 50_000;

export class GroupAdjustmentsError extends Error {
  override name = 'GroupAdjustmentsError';
}

function isDelta(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    Math.abs(value) <= MAX_GROUP_DELTA_BP
  );
}

/**
 * Throws GroupAdjustmentsError unless `value` is a list of {group, localDeltaBp, orderDeltaBp}
 * with known groups (each at most once) and integer deltas within ±MAX_GROUP_DELTA_BP. Separate
 * from validateMarkupRules: the base table and the adjustments are edited separately.
 */
export function validateGroupAdjustments(value: unknown): asserts value is GroupAdjustment[] {
  if (!Array.isArray(value)) throw new GroupAdjustmentsError('group adjustments must be a list');
  const seen = new Set<string>();
  for (const entry of value as unknown[]) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new GroupAdjustmentsError('group adjustment must be an object');
    }
    const { group, localDeltaBp, orderDeltaBp } = entry as Record<string, unknown>;
    if (!isOneOf(PRICE_GROUPS, group)) {
      throw new GroupAdjustmentsError(`unknown price group ${String(group)}`);
    }
    if (seen.has(group)) throw new GroupAdjustmentsError(`price group ${group} is listed twice`);
    seen.add(group);
    if (!isDelta(localDeltaBp) || !isDelta(orderDeltaBp)) {
      throw new GroupAdjustmentsError(
        `adjustment of ${group} must be an integer number of bp within ±${MAX_GROUP_DELTA_BP}`,
      );
    }
  }
}

/** The stored form: no zero entries, only the three fields, in PRICE_GROUPS order. */
export function normalizeGroupAdjustments(
  adjustments: readonly GroupAdjustment[],
): GroupAdjustment[] {
  return adjustments
    .filter((a) => a.localDeltaBp !== 0 || a.orderDeltaBp !== 0)
    .map((a) => ({ group: a.group, localDeltaBp: a.localDeltaBp, orderDeltaBp: a.orderDeltaBp }))
    .sort((a, b) => PRICE_GROUPS.indexOf(a.group) - PRICE_GROUPS.indexOf(b.group));
}

/** Validated and normalized adjustments, or null when the value is not valid (settings readers). */
export function parseGroupAdjustments(value: unknown): GroupAdjustment[] | null {
  try {
    validateGroupAdjustments(value);
    return normalizeGroupAdjustments(value);
  } catch (error) {
    if (error instanceof GroupAdjustmentsError) return null;
    throw error;
  }
}

/** The adjustment of a group, 0/0 when it has none. */
export function groupAdjustmentOf(
  adjustments: readonly GroupAdjustment[],
  group: PriceGroup,
): GroupAdjustment {
  return adjustments.find((a) => a.group === group) ?? { group, localDeltaBp: 0, orderDeltaBp: 0 };
}

/**
 * The smallest markup that keeps the margin (of the client price) at `marginBp`:
 * ceil(margin · 10000 / (10000 − margin)); 10% of margin needs 11.12% of markup.
 */
export function markupForMarginBp(marginBp: BasisPoints): BasisPoints {
  if (!Number.isSafeInteger(marginBp) || marginBp <= 0) return 0;
  if (marginBp >= 10_000) return MAX_MARKUP_BOUND_BP;
  return Math.min(MAX_MARKUP_BOUND_BP, ceilDiv(safeMul(marginBp, 10_000), 10_000 - marginBp));
}

/**
 * Base markup plus an adjustment. A raise never goes above the ceiling and a cut never goes below
 * the floor; neither moves the markup the other way, so a base table that is already outside
 * [floor; ceiling] is left as it is by an adjustment that would push it further. 0 -> the base.
 */
export function adjustMarkupBp(
  baseBp: BasisPoints,
  deltaBp: number,
  bounds: Pick<PricingConfig, 'minMarkupBp' | 'maxMarkupBp'>,
): BasisPoints {
  if (deltaBp > 0) return Math.max(baseBp, Math.min(baseBp + deltaBp, bounds.maxMarkupBp));
  if (deltaBp < 0) return Math.min(baseBp, Math.max(baseBp + deltaBp, bounds.minMarkupBp));
  return baseBp;
}

/** The base table alone: no adjustments, the default floor and ceiling (tests, tools). */
export function basePricingConfig(markupRules: readonly MarkupRule[]): PricingConfig {
  return {
    markupRules,
    groupAdjustments: [],
    minMarkupBp: DEFAULT_MIN_MARKUP_BP,
    maxMarkupBp: DEFAULT_MAX_MARKUP_BP,
  };
}

export interface MarkupInput {
  priceSupplierKop: Kop;
  isLocal: boolean;
  group: PriceGroup;
}

/** Final markup of a supplier price at a stock in a group, and how it was made. */
export function markupFor(
  config: PricingConfig,
  input: MarkupInput,
): Pick<OfferPrice, 'markupBp' | 'baseMarkupBp' | 'adjustmentBp'> {
  const rule = findMarkupRule(config.markupRules, input.priceSupplierKop);
  const baseMarkupBp = input.isLocal ? rule.localBp : rule.orderBp;
  if (!isBp(baseMarkupBp)) throw new MarkupRulesError('markup must be non-negative integer bp');
  const adjustment = groupAdjustmentOf(config.groupAdjustments, input.group);
  const deltaBp = input.isLocal ? adjustment.localDeltaBp : adjustment.orderDeltaBp;
  const markupBp = adjustMarkupBp(baseMarkupBp, deltaBp, config);
  return { markupBp, baseMarkupBp, adjustmentBp: markupBp - baseMarkupBp };
}

/**
 * Client unit price for a known group (the admin preview prices benchmark snapshots with it).
 * `priceSupplierKop` must be a positive safe integer (MoneyError otherwise), as for price().
 */
export function priceFor(config: PricingConfig, input: MarkupInput): OfferPrice {
  if (!Number.isSafeInteger(input.priceSupplierKop) || input.priceSupplierKop <= 0) {
    throw new MoneyError('supplier price must be a positive integer number of kopecks');
  }
  const markup = markupFor(config, input);
  return {
    priceClientKop: applyMarkup(input.priceSupplierKop, markup.markupBp),
    ...markup,
    priceGroup: input.group,
  };
}

/** What priceOffer reads of an offer. */
export type PriceableOffer = Pick<Offer, 'priceSupplierKop' | 'name' | 'group'> & {
  stock: Pick<StockInfo, 'isLocal'>;
};

/**
 * The client price of a supplier offer: its price group (priceGroupOf: the supplier product
 * group, then the name), the markup of the base table for its price and stock, the group
 * adjustment within the floor and the ceiling. The only pricing entry point of the shop.
 */
export function priceOffer(config: PricingConfig, offer: PriceableOffer): OfferPrice {
  return priceFor(config, {
    priceSupplierKop: offer.priceSupplierKop,
    isLocal: offer.stock.isLocal,
    group: priceGroupOf({ productGroup: offer.group, name: offer.name }),
  });
}

/** The floor and the ceiling as read from settings (the admin page shows where they come from). */
export interface PricingBounds {
  /** settings pricing.min_markup_bp (or its default). */
  configuredMinBp: BasisPoints;
  /** The markup that keeps the margin at pricing.margin_floor_pct («Заказать всё равно»). */
  marginFloorMarkupBp: BasisPoints;
  /** The floor priceOffer applies: the larger of the two above. */
  minMarkupBp: BasisPoints;
  /** settings pricing.max_markup_bp (or its default). */
  maxMarkupBp: BasisPoints;
}

function isBound(value: unknown, min: number): value is number {
  return (
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= min &&
    value <= MAX_MARKUP_BOUND_BP
  );
}

/**
 * Floor and ceiling from raw settings values. The pair is taken only when both are integers
 * within [0; MAX_MARKUP_BOUND_BP] and the floor is below the ceiling; otherwise both defaults.
 * `marginFloorBp` is pricing.margin_floor_pct in bp: the floor never lets a margin drop below it.
 */
export function resolvePricingBounds(
  rawMin: unknown,
  rawMax: unknown,
  defaults: { minBp: BasisPoints; maxBp: BasisPoints },
  marginFloorBp: BasisPoints,
): PricingBounds {
  const min = rawMin === undefined ? defaults.minBp : rawMin;
  const max = rawMax === undefined ? defaults.maxBp : rawMax;
  const valid = isBound(min, 0) && isBound(max, 1) && min < max;
  const configuredMinBp = valid ? min : defaults.minBp;
  const maxMarkupBp = valid ? max : defaults.maxBp;
  const marginFloorMarkupBp = markupForMarginBp(marginFloorBp);
  return {
    configuredMinBp,
    marginFloorMarkupBp,
    minMarkupBp: Math.max(configuredMinBp, marginFloorMarkupBp),
    maxMarkupBp,
  };
}

export type PricingDefaults = Pick<
  SettingsValues,
  | 'pricing.markup_rules'
  | 'pricing.group_adjustments'
  | 'pricing.min_markup_bp'
  | 'pricing.max_markup_bp'
>;

/**
 * PricingConfig from raw `settings` rows over the env defaults (settingsDefaultsFromEnv): web
 * (search, cart, checkout, admin) and the worker (VIN preview in the seller bot, recheck) read
 * the same keys through this one function, so their prices cannot differ. A malformed value
 * falls back to its default, as every settings reader does; for the adjustments the default is
 * an empty list, i.e. the base table as is.
 */
export function resolvePricingConfig(
  rows: ReadonlyMap<string, unknown>,
  defaults: PricingDefaults,
  marginFloorBp: BasisPoints,
): PricingConfig {
  const bounds = resolvePricingBounds(
    rows.get('pricing.min_markup_bp'),
    rows.get('pricing.max_markup_bp'),
    { minBp: defaults['pricing.min_markup_bp'], maxBp: defaults['pricing.max_markup_bp'] },
    marginFloorBp,
  );
  return {
    markupRules:
      parseMarkupRules(rows.get('pricing.markup_rules')) ?? defaults['pricing.markup_rules'],
    groupAdjustments:
      parseGroupAdjustments(rows.get('pricing.group_adjustments')) ??
      normalizeGroupAdjustments(defaults['pricing.group_adjustments']),
    minMarkupBp: bounds.minMarkupBp,
    maxMarkupBp: bounds.maxMarkupBp,
  };
}

// ---------------------------------------------------------------------------
// Percentage points in admin forms: '+3', '-1,5', '0.25' <-> bp (integers only)
// ---------------------------------------------------------------------------

const POINTS_RE = /^([+\-\u2212\u2013]?)(\d{1,3})(?:[.,](\d{1,2}))?$/u;

/**
 * Percentage points typed by a person -> bp: '3' -> 300, '+3' -> 300, '-1,5' -> -150,
 * '−0.25' -> -25, '' -> 0. Spaces, '%' and 'п.п.' around the number are ignored. null for
 * anything else (three decimals, letters, several signs).
 */
export function parsePercentPoints(text: string): number | null {
  const compact = text
    .replace(/\s+/gu, '')
    .replace(/(?:п\.?п\.?|%)$/u, '')
    .trim();
  if (compact === '') return 0;
  const match = POINTS_RE.exec(compact);
  if (!match) return null;
  const sign = match[1] === '' || match[1] === '+' ? 1 : -1;
  const whole = Number(match[2]);
  const fraction = Number((match[3] ?? '').padEnd(2, '0'));
  const bp = whole * 100 + fraction;
  return bp === 0 ? 0 : sign * bp;
}

function pointsText(abs: number): string {
  const fraction = abs % 100;
  const whole = (abs - fraction) / 100;
  if (fraction === 0) return String(whole);
  return `${whole},${String(fraction).padStart(2, '0').replace(/0$/u, '')}`;
}

/** bp -> percentage points with a sign: 300 -> '+3', -150 -> '−1,5', 25 -> '+0,25', 0 -> '0'. */
export function formatPercentPoints(bp: number): string {
  if (!Number.isSafeInteger(bp)) throw new MoneyError('bp must be a safe integer');
  if (bp === 0) return '0';
  return `${bp > 0 ? '+' : '\u2212'}${pointsText(Math.abs(bp))}`;
}

/** bp -> percent: 2800 -> '28%', 1112 -> '11,12%', -150 -> '−1,5%'. */
export function formatBpPercent(bp: number): string {
  if (!Number.isSafeInteger(bp)) throw new MoneyError('bp must be a safe integer');
  return `${bp < 0 ? '\u2212' : ''}${pointsText(Math.abs(bp))}%`;
}

/** n / d rounded half up, d > 0, integers only: roundDiv(5, 2) = 3, roundDiv(-5, 2) = -2. */
export function roundDiv(n: number, d: number): number {
  return floorDiv(safeMul(n, 2) + d, safeMul(d, 2));
}
