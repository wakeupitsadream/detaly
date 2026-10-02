/**
 * Journal events: order_events.type values that do not change the order status and are written
 * outside TRANSITIONS (by the engine under the same order row lock). The client timeline and
 * the monthly act read them together with the transition events.
 */
export const JOURNAL_EVENTS = [
  /** «Проверить и заказать» pressed; the rossko/recheck job follows. */
  'recheck_requested',
  /** Recheck outcome: drift, availability, alternatives (no PD). */
  'recheck_result',
  /** POST /payments answered: provider id, confirmation type. */
  'payment_created',
  /** A payment status change without a transition (pending, stale, duplicate). */
  'payment_status',
  /** A receipt (offset, prepayment, full, refund) reached `succeeded`. */
  'receipt_succeeded',
  /** A receipt was finally rejected or timed out (alert sent). */
  'receipt_failed',
  /** A refund row and its refund receipt were created. */
  'refund_created',
  /** A payment of an already refunded order: refunded back automatically (scope orphan). */
  'orphan_payment',
  /** A client approval (alternative / new ETA) was created. */
  'approval_created',
  /** decision_needed was delivered: the approval timer started. */
  'approval_notified',
  /** decision_needed was skipped (no channel): no timer, the sellers call the client. */
  'approval_unreachable',
  /** The client was reminded of an open approval. */
  'approval_reminder',
  /** A reminder (payment, pickup 3/6/9 days, supplier return, refund deadline) was queued. */
  'reminder',
  /** «Заказано вручную в ЛК Rossko»: a supplier order recorded by hand. */
  'supplier_order_manual',
  /** A supplier return / claim row was created. */
  'supplier_return_created',
  /** A stock item (part Rossko did not take back) was created. */
  'stock_item_created',
  /** A webhook about a payment that is not the order's current one. */
  'webhook_stale',
  /** Deferred effects of a phase 1A event were queued (decision Б26). */
  'deferred_1a_processed',
  /** effect open_claim in 1B: claims arrive in phase 1C, the journal keeps the request. */
  'claim_deferred',
] as const;
export type JournalEvent = (typeof JOURNAL_EVENTS)[number];

export function isJournalEvent(value: unknown): value is JournalEvent {
  return typeof value === 'string' && (JOURNAL_EVENTS as readonly string[]).includes(value);
}
