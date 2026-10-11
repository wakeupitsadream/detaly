import { describe, expect, it } from 'vitest';
import {
  AmountFormatError,
  amountValueToKop,
  assertReceiptLines,
  kopToAmountValue,
  lineDescription,
  ReceiptLinesError,
  type ReceiptLine,
} from '../src';

const commodity = (unitPriceKop: number, quantity = 1): ReceiptLine => ({
  description: 'BOSCH 0986 Колодки тормозные',
  quantity,
  measure: 'piece',
  unitPriceKop,
  vatCode: 1,
  paymentSubject: 'commodity',
  paymentMode: 'full_payment',
});
const delivery = (unitPriceKop: number): ReceiptLine => ({
  ...commodity(unitPriceKop),
  description: 'Доставка',
  paymentSubject: 'service',
});

describe('amount conversion', () => {
  it.each([
    [128_000, '1280.00'],
    [12_345, '123.45'],
    [5, '0.05'],
    [0, '0.00'],
  ])('%i kop <-> %s', (kop, value) => {
    expect(kopToAmountValue(kop)).toBe(value);
    expect(amountValueToKop(value)).toBe(kop);
  });

  it('parses short forms without floats', () => {
    expect(amountValueToKop('1280')).toBe(128_000);
    expect(amountValueToKop('1280.5')).toBe(128_050);
    expect(amountValueToKop('0.1')).toBe(10);
    expect(amountValueToKop('1234567.89')).toBe(123_456_789);
  });

  it.each(['', '-1.00', '1.234', '1,00', 'abc', '1e3'])('rejects %j', (value) => {
    expect(() => amountValueToKop(value)).toThrow(AmountFormatError);
  });

  it('rejects non-integer kopecks', () => {
    expect(() => kopToAmountValue(1.5)).toThrow(AmountFormatError);
    expect(() => kopToAmountValue(-1)).toThrow(AmountFormatError);
  });
});

describe('receipt line invariants', () => {
  const expected = { totalKop: 150_000, paymentMode: 'full_payment' } as const;

  it('accepts goods plus one delivery line', () => {
    expect(() =>
      assertReceiptLines([commodity(64_000, 2), delivery(22_000)], expected),
    ).not.toThrow();
  });

  it('allows at most one service line', () => {
    expect(() =>
      assertReceiptLines([commodity(106_000), delivery(22_000), delivery(22_000)], expected),
    ).toThrow(/at most one service/);
  });

  it('rejects other subjects (installation is never sold)', () => {
    const install = { ...commodity(150_000), paymentSubject: 'job' } as unknown as ReceiptLine;
    expect(() => assertReceiptLines([install], expected)).toThrow(ReceiptLinesError);
  });

  it('requires the sum of lines to equal the amount', () => {
    expect(() => assertReceiptLines([commodity(149_900)], expected)).toThrow(/lines sum/);
  });

  it('requires one payment_mode', () => {
    expect(() =>
      assertReceiptLines(
        [commodity(100_000), { ...commodity(50_000), paymentMode: 'full_prepayment' }],
        expected,
      ),
    ).toThrow(/payment_mode/);
  });

  it('validates quantity, price and description', () => {
    expect(() => assertReceiptLines([], expected)).toThrow(/no lines/);
    expect(() => assertReceiptLines([commodity(75_000, 0)], expected)).toThrow(/quantity/);
    expect(() => assertReceiptLines([commodity(0)], { ...expected, totalKop: 0 })).toThrow(
      /unit price/,
    );
    expect(() =>
      assertReceiptLines([{ ...commodity(150_000), description: 'x'.repeat(129) }], expected),
    ).toThrow(/description/);
  });

  it('lineDescription joins brand, article and name within 128 characters', () => {
    expect(lineDescription('MANN', 'W 914/2', '  Фильтр   масляный ')).toBe(
      'MANN W 914/2 Фильтр масляный',
    );
    const long = lineDescription('BRAND', 'A1', 'я'.repeat(200));
    expect([...long]).toHaveLength(128);
    expect(long.endsWith('…')).toBe(true);
  });
});
