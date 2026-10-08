/**
 * Internal price benchmark (docs/pricing.md, step 2): once a week the owner records 20–30
 * popular parts as seen at competitors (Emex, Exist, Autodoc, Rossko retail, Avito...) with the
 * delivery to Orenburg, next to a snapshot of our own best exact offer. This module turns the
 * records of a period into statistics per price group and a hint for the group adjustment. It is
 * advice for the owner only: nothing is applied automatically and no competitor price is ever
 * shown to clients.
 *
 * The hint, per group and per stock kind (Orenburg / to order, the two deltas of an adjustment):
 * 1. headroom of a position = the largest markup at which our price (applyMarkup of our supplier
 *    price) is still not above the competitor's price with delivery, minus our markup now
 *    (markupFor with the current settings): + means we could raise, − means we are dearer;
 * 2. the median headroom over the positions (at least BENCHMARK_MIN_POSITIONS);
 * 3. median ≥ +0.5 p.p. and we are not slower (median of our days minus theirs ≤ 0, or no days
 *    known) -> «можно поднять до +X» with X the median rounded down to 0.5 p.p.; median ≤ −0.5
 *    p.p. -> «стоит снизить на Y» with Y rounded up to 0.5 p.p.; otherwise keep. After such a
 *    change the median position costs no more than at the competitor, i.e. we are not dearer
 *    than the competitors' median;
 * 4. the new adjustment stays within ±MAX_GROUP_DELTA_BP and is not pushed past the point where
 *    the floor (cut) or the ceiling (raise) stops it for every position of the group.
 * Integers only: money in kopecks, ratios in basis points.
 */
import { ceilDiv, floorDiv, safeMul } from './money';
import { groupAdjustmentOf, markupFor, MAX_GROUP_DELTA_BP, roundDiv } from './pricing';
import { PRICE_GROUPS, type PriceGroup } from './statuses';
import type { BasisPoints, Kop, PricingConfig } from './types';

/** Fewest compared positions of one stock kind before a hint is given. */
export const BENCHMARK_MIN_POSITIONS = 3;
/** Hints move adjustments in steps of 0.5 percentage points. */
export const BENCHMARK_HINT_STEP_BP = 50;
/** Default report period. */
export const BENCHMARK_DEFAULT_DAYS = 28;

/** A price_benchmarks row as the statistics see it. */
export interface BenchmarkRecord {
  priceGroup: PriceGroup;
  competitorPriceKop: Kop;
  /** Delivery to Orenburg, 0 for pickup. */
  competitorDeliveryKop: Kop;
  competitorEtaDays: number | null;
  /** Snapshot of our best exact offer when the record was made; null when none was found. */
  ourSupplierKop: Kop | null;
  ourPriceKop: Kop | null;
  ourIsLocal: boolean | null;
  ourEtaDays: number | null;
}

/** A record with our snapshot: the only kind the statistics use. */
type Compared = BenchmarkRecord & { ourSupplierKop: Kop; ourPriceKop: Kop; ourIsLocal: boolean };

function isCompared(record: BenchmarkRecord): record is Compared {
  return (
    record.ourSupplierKop !== null &&
    record.ourSupplierKop > 0 &&
    record.ourPriceKop !== null &&
    record.ourPriceKop > 0 &&
    record.ourIsLocal !== null
  );
}

/** The competitor's price with delivery to Orenburg. */
export function competitorTotalKop(
  record: Pick<BenchmarkRecord, 'competitorPriceKop' | 'competitorDeliveryKop'>,
): Kop {
  return record.competitorPriceKop + record.competitorDeliveryKop;
}

export interface BenchmarkDiff {
  /** Competitor price + delivery. */
  totalKop: Kop;
  /** Our price − their total: negative when we are cheaper. */
  diffKop: number;
  /** The same in bp of their total, rounded half up. */
  diffBp: BasisPoints;
}

/** Our snapshot against the competitor's total; null without our snapshot. */
export function benchmarkDiff(record: BenchmarkRecord): BenchmarkDiff | null {
  if (!isCompared(record)) return null;
  const totalKop = competitorTotalKop(record);
  const diffKop = record.ourPriceKop - totalKop;
  return { totalKop, diffKop, diffBp: roundDiv(safeMul(diffKop, 10_000), totalKop) };
}

/**
 * The largest markup at which applyMarkup(supplier, markup) is not above `limitKop`:
 * floor(floor(limit / 100) · 1 000 000 / supplier) − 10 000 (negative when even the supplier
 * price is above the limit). Exact: one bp more already rounds to a ruble above the limit.
 */
export function maxMarkupWithinBp(supplierKop: Kop, limitKop: Kop): BasisPoints {
  return floorDiv(safeMul(floorDiv(limitKop, 100), 1_000_000), supplierKop) - 10_000;
}

/** Median of integers; an even count takes the floor of the two middle values' mean. */
export function medianInt(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const upper = sorted[mid] as number;
  return sorted.length % 2 === 1 ? upper : floorDiv((sorted[mid - 1] as number) + upper, 2);
}

export type BenchmarkHint =
  /** Raise the adjustment by `byBp` to `newDeltaBp`. */
  | { kind: 'raise'; byBp: number; newDeltaBp: number }
  /** Lower the adjustment by `byBp` to `newDeltaBp`. */
  | { kind: 'lower'; byBp: number; newDeltaBp: number }
  /**
   * Keep it: balanced (within ±0.5 p.p.), slower (cheaper, but we deliver later), bounds (the
   * floor or the ceiling already stops a change).
   */
  | { kind: 'keep'; reason: 'balanced' | 'slower' | 'bounds' }
  /** Fewer than `needed` compared positions. */
  | { kind: 'few'; needed: number };

/** One stock kind (Orenburg or to order) of a group: one delta of its adjustment. */
export interface BenchmarkSideStats {
  compared: number;
  /** Median headroom (bp, see the module comment); null without positions. */
  medianHeadroomBp: BasisPoints | null;
  /** Median of our days minus the competitor's, where both are known; null when none. */
  medianEtaDiffDays: number | null;
  /** The group's current delta of this stock kind. */
  currentDeltaBp: number;
  hint: BenchmarkHint;
}

export interface BenchmarkGroupStats {
  group: PriceGroup;
  /** Records of the group in the period. */
  records: number;
  /** Of them with our snapshot (the statistics below use only these). */
  compared: number;
  /** Median of our price − competitor total, kop; null when nothing is compared. */
  medianDiffKop: number | null;
  /** Median of the same in bp of the competitor total. */
  medianDiffBp: BasisPoints | null;
  /** Positions where our price is below the competitor total. */
  cheaper: number;
  /** Median of our days minus theirs over positions with both; null when none. */
  medianEtaDiffDays: number | null;
  local: BenchmarkSideStats;
  order: BenchmarkSideStats;
}

interface HintInput {
  compared: number;
  medianHeadroomBp: number | null;
  medianEtaDiffDays: number | null;
  currentDeltaBp: number;
  /** Lowest and highest base markup among the positions (the bounds caps use them). */
  minBaseBp: number;
  maxBaseBp: number;
}

/** Step 3–4 of the module comment. */
export function benchmarkHint(
  input: HintInput,
  bounds: Pick<PricingConfig, 'minMarkupBp' | 'maxMarkupBp'>,
): BenchmarkHint {
  if (input.compared < BENCHMARK_MIN_POSITIONS || input.medianHeadroomBp === null) {
    return { kind: 'few', needed: BENCHMARK_MIN_POSITIONS };
  }
  const step = BENCHMARK_HINT_STEP_BP;
  const median = input.medianHeadroomBp;
  const current = input.currentDeltaBp;
  if (median >= step) {
    if (input.medianEtaDiffDays !== null && input.medianEtaDiffDays > 0) {
      return { kind: 'keep', reason: 'slower' };
    }
    const by = floorDiv(median, step) * step;
    // Above this delta even the position with the lowest base hits the ceiling.
    const cap = Math.min(
      MAX_GROUP_DELTA_BP,
      floorDiv(bounds.maxMarkupBp - input.minBaseBp, step) * step,
    );
    const next = Math.min(current + by, cap);
    return next > current
      ? { kind: 'raise', byBp: next - current, newDeltaBp: next }
      : { kind: 'keep', reason: 'bounds' };
  }
  if (median <= -step) {
    const by = ceilDiv(-median, step) * step;
    // Below this delta even the position with the highest base hits the floor.
    const cap = Math.max(
      -MAX_GROUP_DELTA_BP,
      ceilDiv(bounds.minMarkupBp - input.maxBaseBp, step) * step,
    );
    const next = Math.max(current - by, cap);
    return next < current
      ? { kind: 'lower', byBp: current - next, newDeltaBp: next }
      : { kind: 'keep', reason: 'bounds' };
  }
  return { kind: 'keep', reason: 'balanced' };
}

function etaDiffs(records: readonly BenchmarkRecord[]): number[] {
  const out: number[] = [];
  for (const r of records) {
    if (r.ourEtaDays !== null && r.competitorEtaDays !== null) {
      out.push(r.ourEtaDays - r.competitorEtaDays);
    }
  }
  return out;
}

function sideStats(
  group: PriceGroup,
  isLocal: boolean,
  records: readonly Compared[],
  config: PricingConfig,
): BenchmarkSideStats {
  const adjustment = groupAdjustmentOf(config.groupAdjustments, group);
  const currentDeltaBp = isLocal ? adjustment.localDeltaBp : adjustment.orderDeltaBp;
  const headrooms: number[] = [];
  const bases: number[] = [];
  for (const r of records) {
    const markup = markupFor(config, { priceSupplierKop: r.ourSupplierKop, isLocal, group });
    headrooms.push(maxMarkupWithinBp(r.ourSupplierKop, competitorTotalKop(r)) - markup.markupBp);
    bases.push(markup.baseMarkupBp);
  }
  const medianHeadroomBp = medianInt(headrooms);
  const medianEtaDiffDays = medianInt(etaDiffs(records));
  const hint = benchmarkHint(
    {
      compared: records.length,
      medianHeadroomBp,
      medianEtaDiffDays,
      currentDeltaBp,
      minBaseBp: bases.length > 0 ? Math.min(...bases) : 0,
      maxBaseBp: bases.length > 0 ? Math.max(...bases) : 0,
    },
    config,
  );
  return {
    compared: records.length,
    medianHeadroomBp,
    medianEtaDiffDays,
    currentDeltaBp,
    hint,
  };
}

/**
 * Statistics of every group that has records, in PRICE_GROUPS order. `config` is the current
 * PricingConfig: headroom is measured from today's markups, so a hint already accounts for an
 * adjustment made after the records.
 */
export function benchmarkReport(
  records: readonly BenchmarkRecord[],
  config: PricingConfig,
): BenchmarkGroupStats[] {
  const out: BenchmarkGroupStats[] = [];
  for (const group of PRICE_GROUPS) {
    const ofGroup = records.filter((r) => r.priceGroup === group);
    if (ofGroup.length === 0) continue;
    const compared = ofGroup.filter(isCompared);
    const diffs = compared.map((r) => benchmarkDiff(r) as BenchmarkDiff);
    out.push({
      group,
      records: ofGroup.length,
      compared: compared.length,
      medianDiffKop: medianInt(diffs.map((d) => d.diffKop)),
      medianDiffBp: medianInt(diffs.map((d) => d.diffBp)),
      cheaper: diffs.filter((d) => d.diffKop < 0).length,
      medianEtaDiffDays: medianInt(etaDiffs(compared)),
      local: sideStats(
        group,
        true,
        compared.filter((r) => r.ourIsLocal),
        config,
      ),
      order: sideStats(
        group,
        false,
        compared.filter((r) => !r.ourIsLocal),
        config,
      ),
    });
  }
  return out;
}
