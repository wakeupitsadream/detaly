/**
 * Integer money helpers. Money is always an integer number of kopecks (`Kop`), ratios are
 * integer basis points (`BasisPoints`, 10000 = 100%). No floating point division is used
 * where the result is rounded: `%` and exact integer division keep results exact for every
 * safe integer input.
 */
import type { BasisPoints, Kop } from './types';

export class MoneyError extends RangeError {
  override name = 'MoneyError';
}

/** Non-negative safe integer. */
export function isKop(value: unknown): value is Kop {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

export function assertKop(value: unknown, label = 'amount'): asserts value is Kop {
  if (!isKop(value)) {
    throw new MoneyError(`${label} must be a non-negative integer number of kopecks`);
  }
}

function assertSafeInt(value: number, label: string): void {
  if (!Number.isSafeInteger(value)) {
    throw new MoneyError(`${label} must be a safe integer`);
  }
}

/** ceil(n / d) for safe integers, d > 0. Exact (no float rounding). */
export function ceilDiv(n: number, d: number): number {
  assertSafeInt(n, 'numerator');
  assertSafeInt(d, 'denominator');
  if (d <= 0) throw new MoneyError('denominator must be positive');
  const rem = n % d;
  const q = (n - rem) / d;
  return rem > 0 ? q + 1 : q;
}

/** floor(n / d) for safe integers, d > 0. Exact (no float rounding). */
export function floorDiv(n: number, d: number): number {
  assertSafeInt(n, 'numerator');
  assertSafeInt(d, 'denominator');
  if (d <= 0) throw new MoneyError('denominator must be positive');
  const rem = n % d;
  const q = (n - rem) / d;
  return rem < 0 ? q - 1 : q;
}

/** Multiplies two safe integers and fails instead of silently losing precision. */
export function safeMul(a: number, b: number): number {
  const product = a * b;
  if (!Number.isSafeInteger(product)) {
    throw new MoneyError('integer overflow in money arithmetic');
  }
  return product;
}

export function sumKop(values: readonly Kop[]): Kop {
  let total = 0;
  for (const value of values) {
    assertKop(value);
    total += value;
  }
  assertKop(total, 'sum');
  return total;
}

/**
 * Margin of a sale relative to the client price (revenue based), rounded down:
 * floor((client - supplier) * 10000 / client). 10000 kop sold for 9010 kop cost -> 990 (9.9%).
 * Negative when selling below cost.
 */
export function marginBp(clientKop: Kop, supplierKop: Kop): BasisPoints {
  assertKop(clientKop, 'client amount');
  assertKop(supplierKop, 'supplier amount');
  if (clientKop === 0) throw new MoneyError('client amount must be positive');
  return floorDiv(safeMul(clientKop - supplierKop, 10_000), clientKop);
}

/**
 * Relative change of a price, rounded up (conservative for tolerance checks):
 * ceil((next - prev) * 10000 / prev). 10000 -> 10301 gives 301 (exact); 9999 -> 10299 gives
 * 301 (300.03 rounds up past a 3% tolerance).
 */
export function driftBp(prevKop: Kop, nextKop: Kop): BasisPoints {
  assertKop(prevKop, 'previous amount');
  assertKop(nextKop, 'next amount');
  if (prevKop === 0) throw new MoneyError('previous amount must be positive');
  return ceilDiv(safeMul(nextKop - prevKop, 10_000), prevKop);
}

const NBSP = ' ';

/** 128000 -> '1 280 ₽', 12345 -> '123,45 ₽' (non-breaking spaces). */
export function formatRub(kop: Kop): string {
  assertKop(kop);
  const rest = kop % 100;
  const rub = (kop - rest) / 100;
  const grouped = String(rub).replace(/\B(?=(\d{3})+(?!\d))/g, NBSP);
  const fraction = rest === 0 ? '' : `,${String(rest).padStart(2, '0')}`;
  return `${grouped}${fraction}${NBSP}₽`;
}
