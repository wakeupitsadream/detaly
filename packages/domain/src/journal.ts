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
  /** «Повторить чек» of a receipt sent inside a payment: a new polling window. */
  'receipt_retry_requested',
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
  // phase 1C (docs/phase-1c-implementation.md section 3.3)
  /** «Принял возврат» with a photo of the returned part (claims.return_accepted_at). */
  'claim_return_accepted',
  /** A claim decision (refund / replace / reject) with the answer text (text not journaled). */
  'claim_decided',
  /**
   * A claim closed without a refund transition («Замена выдана», reject), or superseded by the
   * order's refund or cancellation (payload.reason 'superseded').
   */
  'claim_closed',
  /**
   * «Замена заказана» of a replace decision: the replacement items (replaced_by_item_id) and
   * their supplier order with the Rossko numbers (PLAN section 3 «replace → новый заказ позиции»).
   */
  'claim_replacement_ordered',
  /** Compensation under art. 23.1 recorded by the owner (paid outside the system). */
  'claim_compensation',
  /** Installation booking requested by the client (web or bot) or staff. */
  'install_requested',
  'install_confirmed',
  'install_declined',
  'install_cancelled',
  'install_done',
  'install_no_show',
  /** The client was reminded of a confirmed installation slot (24 hours before). */
  'install_reminder',
  /** A messenger was bound by a deep link of this order (phone confirmed). */
  'messenger_bound',
  /** Notifications switched off (/stop); not shown on the timeline. */
  'messenger_unbound',
  /** A photo (packaging, handover, return) was added to the order. */
  'photo_added',
  /** The order was checked out from a VIN proposal (/p/<token>). */
  'vin_order',
  // step 3 (docs/reviews.md)
  /**
   * The client opened a review link of the order (/o/<token>/review/<platform>) for the first
   * time on that platform: payload {platform}. A service record, not on the timeline; the
   * review reminder and the funnel of /admin/reviews read it.
   */
  'review_link_opened',
  // step 7 (docs/month-close.md): supplier returns to the end, the stock
  /** «Сдал водителю»: the part left with Rossko's driver (payload supplierReturnId, itemId). */
  'supplier_return_shipped',
  /** «Деньги вернулись»: Rossko paid the part back (payload supplierReturnId, amountKop). */
  'supplier_return_refunded',
  /** «Списать» of a part kept in stock (payload stockItemId, itemId). */
  'stock_item_written_off',
  // step 8 (docs/rossko-automation.md): Rossko without the manual cabinet
  /**
   * The shadow auto-order at «Проверить и заказать», after the recheck: payload decision
   * ('yes' | 'no'), reasons, masterOrdered (the press sent the order to the supplier), outcome
   * (the status it led to), recheckEventId. The real auto-order stays off (PLAN decision 7).
   */
  'auto_order_shadow',
  /**
   * GetOrders polling saw a new status code of a Rossko order: payload supplierOrderId,
   * rosskoOrderId, code, name, previousCode and the mapped action (or 'unmapped').
   */
  'rossko_status',
] as const;
export type JournalEvent = (typeof JOURNAL_EVENTS)[number];

export function isJournalEvent(value: unknown): value is JournalEvent {
  return typeof value === 'string' && (JOURNAL_EVENTS as readonly string[]).includes(value);
}
