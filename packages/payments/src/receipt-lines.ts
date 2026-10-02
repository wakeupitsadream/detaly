/**
 * Receipt line invariants (PLAN section 2): only `commodity` lines plus at most one `service`
 * line (delivery), one payment_mode per receipt, the sum of lines equals the amount, line
 * description at most 128 characters.
 */
import type { Kop } from '@detaly/domain/types';
import type { PaymentMode, ReceiptLine } from './types';

export const RECEIPT_DESCRIPTION_MAX = 128;

export class ReceiptLinesError extends Error {
  override name = 'ReceiptLinesError';
}

/** 'MANN W 914/2 Фильтр масляный', collapsed spaces, cut to 128 characters. */
export function lineDescription(brand: string, article: string, name: string): string {
  const text = `${brand} ${article} ${name}`.replace(/\s+/gu, ' ').trim();
  const chars = [...text];
  return chars.length <= RECEIPT_DESCRIPTION_MAX
    ? text
    : `${chars.slice(0, RECEIPT_DESCRIPTION_MAX - 1).join('')}…`;
}

export function linesTotalKop(lines: readonly ReceiptLine[]): Kop {
  let total = 0;
  for (const line of lines) total += line.unitPriceKop * line.quantity;
  if (!Number.isSafeInteger(total)) throw new ReceiptLinesError('receipt total overflow');
  return total;
}

/** Throws ReceiptLinesError when any invariant is broken. */
export function assertReceiptLines(
  lines: readonly ReceiptLine[],
  expected: { totalKop: Kop; paymentMode: PaymentMode },
): void {
  if (lines.length === 0) throw new ReceiptLinesError('receipt has no lines');
  let services = 0;
  for (const [i, line] of lines.entries()) {
    const desc = line.description.trim();
    if (desc === '' || [...desc].length > RECEIPT_DESCRIPTION_MAX) {
      throw new ReceiptLinesError(`line ${i}: description must be 1..128 characters`);
    }
    if (!Number.isSafeInteger(line.quantity) || line.quantity <= 0) {
      throw new ReceiptLinesError(`line ${i}: quantity must be a positive integer`);
    }
    if (!Number.isSafeInteger(line.unitPriceKop) || line.unitPriceKop <= 0) {
      throw new ReceiptLinesError(`line ${i}: unit price must be a positive integer of kopecks`);
    }
    if (line.paymentMode !== expected.paymentMode) {
      throw new ReceiptLinesError(`line ${i}: payment_mode must be ${expected.paymentMode}`);
    }
    if (line.paymentSubject === 'service') services += 1;
    else if (line.paymentSubject !== 'commodity') {
      throw new ReceiptLinesError(`line ${i}: unsupported payment_subject`);
    }
  }
  if (services > 1) throw new ReceiptLinesError('at most one service line (delivery) is allowed');
  const total = linesTotalKop(lines);
  if (total !== expected.totalKop) {
    throw new ReceiptLinesError(`lines sum ${total} differs from amount ${expected.totalKop}`);
  }
}
