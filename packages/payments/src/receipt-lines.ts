/**
 * Receipt line invariants (PLAN section 2): only `commodity` lines plus at most one `service`
 * line (delivery), one payment_mode per receipt, the sum of lines equals the amount, line
 * description at most 128 characters.
 *
 * Moved to @detaly/domain (receipts.ts) in phase 1B together with the receipt builders; this
 * module re-exports them so the public API of @detaly/payments does not change.
 */
export {
  assertReceiptLines,
  lineDescription,
  linesTotalKop,
  RECEIPT_DESCRIPTION_MAX,
  ReceiptLinesError,
} from '@detaly/domain';
