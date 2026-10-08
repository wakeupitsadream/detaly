// Step 2 (docs/pricing.md): statistics of the internal price benchmark and the hint for a group
// adjustment. Integers only.
import { describe, expect, it } from 'vitest';
import {
  applyMarkup,
  basePricingConfig,
  BENCHMARK_MIN_POSITIONS,
  benchmarkDiff,
  benchmarkHint,
  benchmarkReport,
  maxMarkupWithinBp,
  medianInt,
  type BenchmarkRecord,
  type PricingConfig,
} from '../src';
import type { MarkupRule } from '../src/types';

const FLAT: MarkupRule[] = [{ fromKop: 0, toKop: null, localBp: 2800, orderBp: 2800 }];
const CONFIG: PricingConfig = { ...basePricingConfig(FLAT), minMarkupBp: 1112 };

function record(over: Partial<BenchmarkRecord> = {}): BenchmarkRecord {
  const supplier = over.ourSupplierKop ?? 100_000;
  return {
    priceGroup: 'filters',
    competitorPriceKop: 140_000,
    competitorDeliveryKop: 0,
    competitorEtaDays: 3,
    ourSupplierKop: supplier,
    ourPriceKop: supplier === null ? null : applyMarkup(supplier, 2800),
    ourIsLocal: true,
    ourEtaDays: 1,
    ...over,
  };
}

describe('maxMarkupWithinBp', () => {
  it('is the exact largest markup that keeps our price within the limit', () => {
    for (const supplier of [1, 99, 100, 41_250, 62_340, 183_400, 999_999]) {
      for (const limit of [100, 52_800, 54_000, 99_900, 250_000, 1_000_000]) {
        const m = maxMarkupWithinBp(supplier, limit);
        if (m >= 0) expect(applyMarkup(supplier, m)).toBeLessThanOrEqual(limit);
        if (m + 1 >= 0) expect(applyMarkup(supplier, m + 1)).toBeGreaterThan(limit);
      }
    }
  });

  it('is negative when the competitor sells below our supplier price', () => {
    expect(maxMarkupWithinBp(100_000, 90_000)).toBe(-1000);
  });
});

describe('medianInt', () => {
  it('odd, even (floor of the mean), empty', () => {
    expect(medianInt([3, 1, 2])).toBe(2);
    expect(medianInt([4, 1, 3, 2])).toBe(2);
    expect(medianInt([-3, -2])).toBe(-3);
    expect(medianInt([5])).toBe(5);
    expect(medianInt([])).toBeNull();
  });
});

describe('benchmarkDiff', () => {
  it('our price minus their price with delivery, in kop and bp', () => {
    expect(
      benchmarkDiff(
        record({
          ourPriceKop: 128_000,
          competitorPriceKop: 130_000,
          competitorDeliveryKop: 30_000,
        }),
      ),
    ).toEqual({ totalKop: 160_000, diffKop: -32_000, diffBp: -2000 });
    expect(benchmarkDiff(record({ ourSupplierKop: null, ourPriceKop: null }))).toBeNull();
  });
});

describe('benchmarkHint', () => {
  const base = {
    compared: 5,
    medianEtaDiffDays: -1,
    currentDeltaBp: 0,
    minBaseBp: 2800,
    maxBaseBp: 2800,
  };

  it('raises by the median rounded down to 0.5 p.p. when we are cheaper and not slower', () => {
    expect(benchmarkHint({ ...base, medianHeadroomBp: 1189 }, CONFIG)).toEqual({
      kind: 'raise',
      byBp: 1150,
      newDeltaBp: 1150,
    });
    expect(benchmarkHint({ ...base, medianHeadroomBp: 300, currentDeltaBp: 200 }, CONFIG)).toEqual({
      kind: 'raise',
      byBp: 300,
      newDeltaBp: 500,
    });
  });

  it('lowers by the median rounded up to 0.5 p.p. when we are dearer', () => {
    expect(benchmarkHint({ ...base, medianHeadroomBp: -420 }, CONFIG)).toEqual({
      kind: 'lower',
      byBp: 450,
      newDeltaBp: -450,
    });
  });

  it('keeps within ±0.5 p.p., when slower, and when the bounds stop a change', () => {
    expect(benchmarkHint({ ...base, medianHeadroomBp: 49 }, CONFIG)).toEqual({
      kind: 'keep',
      reason: 'balanced',
    });
    expect(benchmarkHint({ ...base, medianHeadroomBp: -49 }, CONFIG)).toEqual({
      kind: 'keep',
      reason: 'balanced',
    });
    expect(benchmarkHint({ ...base, medianHeadroomBp: 900, medianEtaDiffDays: 2 }, CONFIG)).toEqual(
      { kind: 'keep', reason: 'slower' },
    );
    // a slower delivery does not stop a cut
    expect(
      benchmarkHint({ ...base, medianHeadroomBp: -900, medianEtaDiffDays: 2 }, CONFIG).kind,
    ).toBe('lower');
    // the ceiling (60%) is already reached by the lowest base: 2800 + 3200
    expect(benchmarkHint({ ...base, medianHeadroomBp: 900, currentDeltaBp: 3200 }, CONFIG)).toEqual(
      { kind: 'keep', reason: 'bounds' },
    );
    // a raise stops at the ceiling: 6000 − 2800 = 3200
    expect(benchmarkHint({ ...base, medianHeadroomBp: 9000 }, CONFIG)).toEqual({
      kind: 'raise',
      byBp: 3200,
      newDeltaBp: 3200,
    });
    // a cut stops at the floor: 1112 − 2800 = −1688, rounded toward zero to −1650
    expect(benchmarkHint({ ...base, medianHeadroomBp: -9000 }, CONFIG)).toEqual({
      kind: 'lower',
      byBp: 1650,
      newDeltaBp: -1650,
    });
  });

  it('asks for more data below the minimum', () => {
    expect(
      benchmarkHint(
        { ...base, compared: BENCHMARK_MIN_POSITIONS - 1, medianHeadroomBp: 900 },
        CONFIG,
      ),
    ).toEqual({ kind: 'few', needed: BENCHMARK_MIN_POSITIONS });
  });
});

describe('benchmarkReport', () => {
  it('per group: counts, medians, the share where we are cheaper and the hint per stock kind', () => {
    const records: BenchmarkRecord[] = [
      // filters in Orenburg: we sell at 1280 ₽, they ask 1400–1500 ₽ with delivery
      record({ competitorPriceKop: 140_000 }),
      record({ competitorPriceKop: 135_000, competitorDeliveryKop: 15_000 }),
      record({ competitorPriceKop: 145_000 }),
      // to order, dearer than them
      record({ ourIsLocal: false, competitorPriceKop: 120_000, ourEtaDays: 4 }),
      // no snapshot of ours: counted, not compared
      record({ ourSupplierKop: null, ourPriceKop: null, ourIsLocal: null, ourEtaDays: null }),
      // another group
      record({ priceGroup: 'brakes', competitorPriceKop: 128_000 }),
    ];
    const [filters, brakes, ...rest] = benchmarkReport(records, CONFIG);
    expect(rest).toEqual([]);
    expect(filters).toMatchObject({
      group: 'filters',
      records: 5,
      compared: 4,
      cheaper: 3,
      // diffs −12000, −22000, −17000, +8000 -> median of the two middle ones
      medianDiffKop: -14_500,
      medianEtaDiffDays: -2,
    });
    expect(filters?.medianDiffBp).toBe(-1_015);
    // headroom: max markup within 140 000 / 150 000 / 145 000 kop over 1000 ₽ minus 28%
    expect(filters?.local).toEqual({
      compared: 3,
      medianHeadroomBp: 1700,
      medianEtaDiffDays: -2,
      currentDeltaBp: 0,
      hint: { kind: 'raise', byBp: 1700, newDeltaBp: 1700 },
    });
    expect(filters?.order).toMatchObject({
      compared: 1,
      medianHeadroomBp: -800,
      hint: { kind: 'few', needed: BENCHMARK_MIN_POSITIONS },
    });
    expect(brakes).toMatchObject({ group: 'brakes', records: 1, compared: 1, cheaper: 0 });
    expect(brakes?.medianDiffKop).toBe(0);
  });

  it('measures headroom from the current markup, adjustments included', () => {
    const records = [140_000, 150_000, 145_000].map((p) => record({ competitorPriceKop: p }));
    const adjusted: PricingConfig = {
      ...CONFIG,
      groupAdjustments: [{ group: 'filters', localDeltaBp: 1500, orderDeltaBp: 0 }],
    };
    const [filters] = benchmarkReport(records, adjusted);
    expect(filters?.local.medianHeadroomBp).toBe(200);
    expect(filters?.local.currentDeltaBp).toBe(1500);
    expect(filters?.local.hint).toEqual({ kind: 'raise', byBp: 200, newDeltaBp: 1700 });
  });
});
