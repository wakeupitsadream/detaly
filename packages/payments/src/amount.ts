/** Conversion between integer kopecks and YooKassa amount strings, without floats. */
import type { Kop } from '@detaly/domain/types';

export class AmountFormatError extends RangeError {
  override name = 'AmountFormatError';
}

/** 128000 -> '1280.00'. */
export function kopToAmountValue(kop: Kop): string {
  if (!Number.isSafeInteger(kop) || kop < 0) {
    throw new AmountFormatError('amount must be a non-negative integer number of kopecks');
  }
  const rest = kop % 100;
  return `${(kop - rest) / 100}.${String(rest).padStart(2, '0')}`;
}

const AMOUNT_RE = /^(\d{1,13})(?:\.(\d{1,2}))?$/;

/** '1280.00' -> 128000, '1280.5' -> 128050, '1280' -> 128000. Rejects more than 2 decimals. */
export function amountValueToKop(value: string): Kop {
  const m = AMOUNT_RE.exec(value.trim());
  if (m === null) throw new AmountFormatError(`invalid amount '${value}'`);
  const rub = Number(m[1]);
  const kop = Number((m[2] ?? '').padEnd(2, '0'));
  const result = rub * 100 + kop;
  if (!Number.isSafeInteger(result)) throw new AmountFormatError(`amount too large '${value}'`);
  return result;
}
