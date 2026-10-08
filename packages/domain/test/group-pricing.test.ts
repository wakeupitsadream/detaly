// Step 2 (docs/pricing.md): group adjustments of the markup, the floor and the ceiling,
// priceOffer as the single pricing entry point and resolvePricingConfig over settings rows.
import { describe, expect, it } from 'vitest';
import {
  adjustMarkupBp,
  applyMarkup,
  basePricingConfig,
  DEFAULT_MAX_MARKUP_BP,
  DEFAULT_MIN_MARKUP_BP,
  formatBpPercent,
  formatPercentPoints,
  GroupAdjustmentsError,
  markupForMarginBp,
  MAX_GROUP_DELTA_BP,
  MoneyError,
  normalizeGroupAdjustments,
  parseGroupAdjustments,
  parseMarkupRules,
  parsePercentPoints,
  price,
  priceFor,
  priceOffer,
  PRICE_GROUPS,
  resolvePricingBounds,
  resolvePricingConfig,
  roundDiv,
  validateGroupAdjustments,
  type GroupAdjustment,
  type PriceableOffer,
  type PricingConfig,
  type PricingDefaults,
} from '../src';
import type { MarkupRule } from '../src/types';

const FLAT: MarkupRule[] = [
  { fromKop: 0, toKop: 100_000, localBp: 2800, orderBp: 2800 },
  { fromKop: 100_000, toKop: 500_000, localBp: 2800, orderBp: 2800 },
  { fromKop: 500_000, toKop: null, localBp: 2800, orderBp: 2800 },
];
const RANGES: MarkupRule[] = [
  { fromKop: 0, toKop: 30_000, localBp: 7000, orderBp: 7500 },
  { fromKop: 30_000, toKop: 100_000, localBp: 3000, orderBp: 3550 },
  { fromKop: 100_000, toKop: null, localBp: 2000, orderBp: 2575 },
];

function offer(name: string, priceSupplierKop: number, isLocal = true): PriceableOffer {
  return { name, group: null, priceSupplierKop, stock: { isLocal } };
}

function config(over: Partial<PricingConfig> = {}): PricingConfig {
  return { ...basePricingConfig(FLAT), ...over };
}

describe('priceOffer without adjustments is exactly price()', () => {
  const names = ['Фильтр масляный', 'Колодки тормозные', 'Масло моторное', 'Деталь'];
  it.each([
    ['flat 28%', FLAT],
    ['ranges with local/order', RANGES],
  ])('%s: every price from 1 kop to 12 000 ₽', (_name, rules) => {
    const cfg = basePricingConfig(rules);
    for (let p = 1; p < 1_200_000; p += 997) {
      for (const isLocal of [true, false]) {
        const expected = price(rules, p, isLocal);
        const got = priceOffer(cfg, offer(names[p % names.length] as string, p, isLocal));
        expect(got.priceClientKop).toBe(expected.priceClientKop);
        expect(got.markupBp).toBe(expected.markupBp);
        expect(got.baseMarkupBp).toBe(expected.markupBp);
        expect(got.adjustmentBp).toBe(0);
      }
    }
  });

  it('an adjustment of another group changes nothing', () => {
    const cfg = config({
      groupAdjustments: [{ group: 'brakes', localDeltaBp: 500, orderDeltaBp: -500 }],
    });
    expect(priceOffer(cfg, offer('Фильтр масляный', 41_250))).toEqual({
      priceClientKop: 52_800,
      markupBp: 2800,
      baseMarkupBp: 2800,
      adjustmentBp: 0,
      priceGroup: 'filters',
    });
  });

  it('rejects unusable supplier prices like price()', () => {
    for (const bad of [0, -1, 12.5, Number.NaN]) {
      expect(() => priceOffer(config(), offer('Фильтр', bad))).toThrow(MoneyError);
    }
  });
});

describe('priceOffer with group adjustments', () => {
  const cfg = config({
    groupAdjustments: [
      { group: 'filters', localDeltaBp: 300, orderDeltaBp: -150 },
      { group: 'brakes', localDeltaBp: -2000, orderDeltaBp: 4000 },
    ],
  });

  it('adds the delta of the offer group and stock kind to the base markup', () => {
    // Knecht OC 90 in Orenburg: 412.50 ₽ -> 31% -> 540.375 -> 541 ₽
    expect(priceOffer(cfg, offer('Фильтр масляный', 41_250, true))).toEqual({
      priceClientKop: 54_100,
      markupBp: 3100,
      baseMarkupBp: 2800,
      adjustmentBp: 300,
      priceGroup: 'filters',
    });
    // to order: 28% − 1.5 p.p. = 26.5%
    const toOrder = priceOffer(cfg, offer('Фильтр масляный', 38_900, false));
    expect(toOrder.markupBp).toBe(2650);
    expect(toOrder.priceClientKop).toBe(applyMarkup(38_900, 2650));
  });

  it('never lowers below the floor and never raises above the ceiling', () => {
    // brakes local: 28% − 20 p.p. = 8% < floor 10%
    expect(priceOffer(cfg, offer('Колодки тормозные', 183_400, true)).markupBp).toBe(
      DEFAULT_MIN_MARKUP_BP,
    );
    // brakes to order: 28% + 40 p.p. = 68% > ceiling 60%
    expect(priceOffer(cfg, offer('Колодки тормозные', 171_240, false)).markupBp).toBe(
      DEFAULT_MAX_MARKUP_BP,
    );
  });

  it('uses the product group of the offer first', () => {
    const viaGroup: PriceableOffer = {
      name: 'Датчик износа',
      group: 'Тормозная система',
      priceSupplierKop: 100_000,
      stock: { isLocal: false },
    };
    expect(priceOffer(cfg, viaGroup).priceGroup).toBe('brakes');
    expect(priceOffer(cfg, viaGroup).markupBp).toBe(DEFAULT_MAX_MARKUP_BP);
  });

  it('priceFor prices a known group the same way', () => {
    expect(priceFor(cfg, { priceSupplierKop: 41_250, isLocal: true, group: 'filters' })).toEqual(
      priceOffer(cfg, offer('Фильтр масляный', 41_250, true)),
    );
  });
});

describe('adjustMarkupBp', () => {
  const bounds = { minMarkupBp: 1000, maxMarkupBp: 6000 };
  it.each([
    [2800, 0, 2800],
    [2800, 300, 3100],
    [2800, -300, 2500],
    [2800, 5000, 6000],
    [2800, -5000, 1000],
    // a base already outside the bounds is not pushed further, nor pulled back
    [7000, 300, 7000],
    [7000, -300, 6700],
    [7000, -6500, 1000],
    [500, -300, 500],
    [500, 300, 800],
    [500, 7000, 6000],
  ])('base %i + %i -> %i', (base, delta, expected) => {
    expect(adjustMarkupBp(base, delta, bounds)).toBe(expected);
  });

  it('a floor above the ceiling only blocks changes', () => {
    const odd = { minMarkupBp: 7000, maxMarkupBp: 6000 };
    expect(adjustMarkupBp(6500, 300, odd)).toBe(6500);
    expect(adjustMarkupBp(6500, -300, odd)).toBe(6500);
  });
});

describe('validateGroupAdjustments', () => {
  it('accepts every group, negative deltas and the limits', () => {
    const all: GroupAdjustment[] = PRICE_GROUPS.map((group, i) => ({
      group,
      localDeltaBp: i % 2 === 0 ? MAX_GROUP_DELTA_BP : -MAX_GROUP_DELTA_BP,
      orderDeltaBp: -i * 10,
    }));
    expect(() => validateGroupAdjustments(all)).not.toThrow();
    expect(() => validateGroupAdjustments([])).not.toThrow();
  });

  it.each<[string, unknown]>([
    ['not a list', { group: 'filters', localDeltaBp: 0, orderDeltaBp: 0 }],
    ['null entry', [null]],
    ['unknown group', [{ group: 'tyres', localDeltaBp: 100, orderDeltaBp: 0 }]],
    [
      'duplicate group',
      [
        { group: 'filters', localDeltaBp: 100, orderDeltaBp: 0 },
        { group: 'filters', localDeltaBp: 0, orderDeltaBp: 100 },
      ],
    ],
    ['fraction', [{ group: 'filters', localDeltaBp: 12.5, orderDeltaBp: 0 }]],
    ['string', [{ group: 'filters', localDeltaBp: '300', orderDeltaBp: 0 }]],
    ['missing delta', [{ group: 'filters', localDeltaBp: 300 }]],
    ['too large', [{ group: 'filters', localDeltaBp: MAX_GROUP_DELTA_BP + 1, orderDeltaBp: 0 }]],
    ['too small', [{ group: 'filters', localDeltaBp: 0, orderDeltaBp: -MAX_GROUP_DELTA_BP - 1 }]],
  ])('rejects %s', (_name, value) => {
    expect(() => validateGroupAdjustments(value)).toThrow(GroupAdjustmentsError);
    expect(parseGroupAdjustments(value)).toBeNull();
  });

  it('normalizes: no zero entries, only the fields, in group order', () => {
    const raw = [
      { group: 'body', localDeltaBp: 0, orderDeltaBp: 50, note: 'x' },
      { group: 'filters', localDeltaBp: 0, orderDeltaBp: 0 },
      { group: 'brakes', localDeltaBp: -100, orderDeltaBp: 0 },
    ];
    expect(parseGroupAdjustments(raw)).toEqual([
      { group: 'brakes', localDeltaBp: -100, orderDeltaBp: 0 },
      { group: 'body', localDeltaBp: 0, orderDeltaBp: 50 },
    ]);
    expect(normalizeGroupAdjustments([])).toEqual([]);
  });
});

describe('markupForMarginBp', () => {
  it.each([
    [0, 0],
    [-5, 0],
    [1000, 1112], // 10% of margin = 11.12% of markup
    [2000, 2500],
    [500, 527],
    [10_000, 50_000],
  ])('%i bp of margin -> %i bp of markup', (margin, markup) => {
    expect(markupForMarginBp(margin)).toBe(markup);
  });

  it('keeps the margin at the floor after rounding to a ruble', () => {
    const markup = markupForMarginBp(1000);
    for (let p = 100; p < 2_000_000; p += 7919) {
      const client = applyMarkup(p, markup);
      expect((client - p) * 10_000).toBeGreaterThanOrEqual(1000 * client);
    }
  });
});

describe('resolvePricingConfig', () => {
  const defaults: PricingDefaults = {
    'pricing.markup_rules': FLAT,
    'pricing.group_adjustments': [],
    'pricing.min_markup_bp': 1000,
    'pricing.max_markup_bp': 6000,
  };

  it('defaults: the base table, no adjustments, the margin floor lifts the markup floor', () => {
    expect(resolvePricingConfig(new Map(), defaults, 1000)).toEqual({
      markupRules: FLAT,
      groupAdjustments: [],
      minMarkupBp: 1112,
      maxMarkupBp: 6000,
    });
    expect(resolvePricingConfig(new Map(), defaults, 0).minMarkupBp).toBe(1000);
  });

  it('takes valid rows', () => {
    const rows = new Map<string, unknown>([
      ['pricing.markup_rules', RANGES],
      [
        'pricing.group_adjustments',
        [
          { group: 'filters', localDeltaBp: 300, orderDeltaBp: 0 },
          { group: 'body', localDeltaBp: 0, orderDeltaBp: 0 },
        ],
      ],
      ['pricing.min_markup_bp', 1500],
      ['pricing.max_markup_bp', 9000],
    ]);
    expect(resolvePricingConfig(rows, defaults, 1000)).toEqual({
      markupRules: RANGES,
      groupAdjustments: [{ group: 'filters', localDeltaBp: 300, orderDeltaBp: 0 }],
      minMarkupBp: 1500,
      maxMarkupBp: 9000,
    });
  });

  it('ignores malformed rows (prices fall back to the base table)', () => {
    const rows = new Map<string, unknown>([
      ['pricing.markup_rules', [{ fromKop: 1, toKop: null, localBp: 1, orderBp: 1 }]],
      ['pricing.group_adjustments', [{ group: 'tyres', localDeltaBp: 300, orderDeltaBp: 0 }]],
      ['pricing.min_markup_bp', 7000],
      ['pricing.max_markup_bp', 6000],
    ]);
    expect(resolvePricingConfig(rows, defaults, 0)).toEqual({
      markupRules: FLAT,
      groupAdjustments: [],
      minMarkupBp: 1000,
      maxMarkupBp: 6000,
    });
    expect(parseMarkupRules('[]')).toBeNull();
  });

  it('bounds: a pair or the defaults', () => {
    const d = { minBp: 1000, maxBp: 6000 };
    expect(resolvePricingBounds(800, undefined, d, 0)).toEqual({
      configuredMinBp: 800,
      marginFloorMarkupBp: 0,
      minMarkupBp: 800,
      maxMarkupBp: 6000,
    });
    expect(resolvePricingBounds(-1, 6000, d, 0).configuredMinBp).toBe(1000);
    expect(resolvePricingBounds(1000, 1.5, d, 0).maxMarkupBp).toBe(6000);
    expect(resolvePricingBounds(1000, 60_000, d, 0).maxMarkupBp).toBe(6000);
    expect(resolvePricingBounds(1000, 6000, d, 2000)).toEqual({
      configuredMinBp: 1000,
      marginFloorMarkupBp: 2500,
      minMarkupBp: 2500,
      maxMarkupBp: 6000,
    });
  });
});

describe('percentage points in forms', () => {
  it.each<[string, number | null]>([
    ['', 0],
    ['0', 0],
    ['-0', 0],
    ['3', 300],
    ['+3', 300],
    ['3%', 300],
    ['+3 п.п.', 300],
    ['-1,5', -150],
    ['\u22121.5', -150],
    ['–2', -200],
    ['0,25', 25],
    [' + 12 ', 1200],
    ['50', 5000],
    ['1,234', null],
    ['abc', null],
    ['--3', null],
    ['1e3', null],
    ['1000', null],
  ])('%j -> %s', (text, bp) => {
    expect(parsePercentPoints(text)).toBe(bp);
  });

  it('formats bp back', () => {
    expect(formatPercentPoints(300)).toBe('+3');
    expect(formatPercentPoints(-150)).toBe('\u22121,5');
    expect(formatPercentPoints(25)).toBe('+0,25');
    expect(formatPercentPoints(0)).toBe('0');
    expect(formatBpPercent(2800)).toBe('28%');
    expect(formatBpPercent(1112)).toBe('11,12%');
    expect(formatBpPercent(-150)).toBe('\u22121,5%');
    for (const bp of [-5000, -1234, -1, 1, 99, 100, 101, 4321]) {
      expect(parsePercentPoints(formatPercentPoints(bp))).toBe(bp);
    }
  });

  it('roundDiv rounds half up with integers', () => {
    expect(roundDiv(5, 2)).toBe(3);
    expect(roundDiv(-5, 2)).toBe(-2);
    expect(roundDiv(7, 3)).toBe(2);
    expect(roundDiv(-7, 3)).toBe(-2);
  });
});
