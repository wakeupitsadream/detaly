import { describe, expect, it } from 'vitest';
import {
  ceilDiv,
  driftBp,
  floorDiv,
  formatRub,
  MarkupRulesError,
  marginBp,
  MoneyError,
  price,
  sumKop,
  validateMarkupRules,
} from '../src';
import type { MarkupRule } from '../src/types';

const flat = (bp: number): MarkupRule[] => [
  { fromKop: 0, toKop: 100_000, localBp: bp, orderBp: bp },
  { fromKop: 100_000, toKop: 500_000, localBp: bp, orderBp: bp },
  { fromKop: 500_000, toKop: null, localBp: bp, orderBp: bp },
];

const DEFAULT = flat(2800);

describe('price', () => {
  it.each([
    [100_000, 128_000],
    [12_345, 15_900],
    [100, 200],
    // the phase0 spec names 78125 as the float trap: exactly 100000, not 100100
    [78_125, 100_000],
    [99_999, 128_000],
    [1, 100],
  ])('%i kop at 28%% -> %i kop', (supplier, client) => {
    expect(price(DEFAULT, supplier, true).priceClientKop).toBe(client);
    expect(price(DEFAULT, supplier, false).priceClientKop).toBe(client);
  });

  it.each([
    [1000, 3_000, 3_300],
    [1100, 10_000, 11_100],
    [1200, 625, 700],
    [2150, 100_000, 121_500],
  ])('exact where float math is not: %i bp of %i kop -> %i', (bp, supplier, client) => {
    const floatPrice = Math.ceil((supplier * (1 + bp / 10_000)) / 100) * 100;
    expect(floatPrice).toBe(client + 100); // e.g. 3000 * 1.1 = 3300.0000000000005
    expect(price(flat(bp), supplier, true).priceClientKop).toBe(client);
  });

  it('27.5% (2750 bp) of 100000 gives 127500', () => {
    expect(price(flat(2750), 100_000, true)).toEqual({ priceClientKop: 127_500, markupBp: 2750 });
  });

  it('range boundary: 99999 uses the first rule, 100000 the second', () => {
    const rules: MarkupRule[] = [
      { fromKop: 0, toKop: 100_000, localBp: 3000, orderBp: 3500 },
      { fromKop: 100_000, toKop: 500_000, localBp: 2000, orderBp: 2500 },
      { fromKop: 500_000, toKop: null, localBp: 1000, orderBp: 1500 },
    ];
    expect(price(rules, 99_999, true).markupBp).toBe(3000);
    expect(price(rules, 100_000, true).markupBp).toBe(2000);
    expect(price(rules, 499_999, false).markupBp).toBe(2500);
    expect(price(rules, 500_000, false).markupBp).toBe(1500);
    expect(price(rules, 10_000_000, true).markupBp).toBe(1000);
  });

  it('local and to-order stocks use different markups', () => {
    const rules: MarkupRule[] = [{ fromKop: 0, toKop: null, localBp: 2000, orderBp: 3000 }];
    expect(price(rules, 100_000, true)).toEqual({ priceClientKop: 120_000, markupBp: 2000 });
    expect(price(rules, 100_000, false)).toEqual({ priceClientKop: 130_000, markupBp: 3000 });
  });

  it('result is always a whole ruble', () => {
    for (let p = 1; p < 5000; p += 7) {
      const { priceClientKop } = price(DEFAULT, p, true);
      expect(priceClientKop % 100).toBe(0);
      expect(priceClientKop * 10_000).toBeGreaterThanOrEqual(p * 12_800);
      expect((priceClientKop - 100) * 10_000).toBeLessThan(p * 12_800);
    }
  });

  it.each([0, -1, Number.NaN, 12.5, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 2])(
    'rejects supplier price %s',
    (bad) => {
      expect(() => price(DEFAULT, bad, true)).toThrow(MoneyError);
    },
  );

  it('throws when no rule covers the price', () => {
    const rules: MarkupRule[] = [{ fromKop: 0, toKop: 100, localBp: 0, orderBp: 0 }];
    expect(() => price(rules, 100, true)).toThrow(MarkupRulesError);
  });

  it('fails loudly instead of losing precision on absurd prices', () => {
    expect(() => price(DEFAULT, 2 ** 50, true)).toThrow(MoneyError);
  });
});

describe('validateMarkupRules', () => {
  it('accepts the default table in any order', () => {
    expect(() => validateMarkupRules(DEFAULT)).not.toThrow();
    expect(() => validateMarkupRules([...DEFAULT].reverse())).not.toThrow();
    expect(() =>
      validateMarkupRules([{ fromKop: 0, toKop: null, localBp: 0, orderBp: 0 }]),
    ).not.toThrow();
  });

  it.each<[string, MarkupRule[]]>([
    ['empty', []],
    [
      'gap',
      [
        { fromKop: 0, toKop: 100_000, localBp: 2800, orderBp: 2800 },
        { fromKop: 100_001, toKop: null, localBp: 2800, orderBp: 2800 },
      ],
    ],
    [
      'overlap',
      [
        { fromKop: 0, toKop: 100_000, localBp: 2800, orderBp: 2800 },
        { fromKop: 99_999, toKop: null, localBp: 2800, orderBp: 2800 },
      ],
    ],
    ['not from zero', [{ fromKop: 1, toKop: null, localBp: 2800, orderBp: 2800 }]],
    ['no open end', [{ fromKop: 0, toKop: 100_000, localBp: 2800, orderBp: 2800 }]],
    [
      'two open ends',
      [
        { fromKop: 0, toKop: null, localBp: 2800, orderBp: 2800 },
        { fromKop: 100_000, toKop: null, localBp: 2800, orderBp: 2800 },
      ],
    ],
    ['empty range', [{ fromKop: 0, toKop: 0, localBp: 2800, orderBp: 2800 }]],
    ['negative bp', [{ fromKop: 0, toKop: null, localBp: -1, orderBp: 2800 }]],
    ['fractional bp', [{ fromKop: 0, toKop: null, localBp: 2800, orderBp: 28.5 }]],
  ])('rejects %s', (_name, rules) => {
    expect(() => validateMarkupRules(rules)).toThrow(MarkupRulesError);
  });
});

describe('money helpers', () => {
  it('ceilDiv / floorDiv are exact for signed integers', () => {
    expect(ceilDiv(1_000_000_000, 1_000_000)).toBe(1000);
    expect(ceilDiv(1_000_000_001, 1_000_000)).toBe(1001);
    expect(ceilDiv(-5, 3)).toBe(-1);
    expect(floorDiv(-5, 3)).toBe(-2);
    expect(floorDiv(5, 3)).toBe(1);
    // near 2^53 a float division would round up to the next integer
    expect(ceilDiv(9_007_199_254_000_000, 1_000_000)).toBe(9_007_199_254);
    expect(floorDiv(9_007_199_253_999_999, 1_000_000)).toBe(9_007_199_253);
  });

  it('marginBp is revenue based and rounds down', () => {
    expect(marginBp(10_000, 9_010)).toBe(990);
    expect(marginBp(10_000, 9_000)).toBe(1000);
    expect(marginBp(128_000, 100_000)).toBe(2187);
    expect(marginBp(10_000, 11_000)).toBe(-1000);
  });

  it('driftBp rounds up so any growth above 3% exceeds a 300 bp tolerance', () => {
    expect(driftBp(10_000, 10_300)).toBe(300);
    expect(driftBp(10_000, 10_301)).toBe(301);
    expect(driftBp(3_333, 3_434)).toBe(304); // 303.03 rounds up
    expect(driftBp(10_000, 9_000)).toBe(-1000);
  });

  it('formatRub uses non-breaking spaces', () => {
    expect(formatRub(128_000)).toBe('1 280 ₽');
    expect(formatRub(12_345)).toBe('123,45 ₽');
    expect(formatRub(100)).toBe('1 ₽');
    expect(formatRub(123_456_700)).toBe('1 234 567 ₽');
    expect(formatRub(5)).toBe('0,05 ₽');
    expect(() => formatRub(-1)).toThrow(MoneyError);
  });

  it('sumKop rejects non-integers', () => {
    expect(sumKop([100, 200, 0])).toBe(300);
    expect(() => sumKop([100, 0.5])).toThrow(MoneyError);
  });
});
