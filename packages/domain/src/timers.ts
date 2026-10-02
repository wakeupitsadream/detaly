/**
 * Fixed periods of phase 1B (PLAN section 1, docs/phase-1b-implementation.md section 3.3) in
 * one place. Business deadlines that the owner may tune (payment TTL, pickup windows, QR TTL,
 * approval timeout) live in `settings`, not here.
 */
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export const TIMERS = {
  /** Offset / payment receipt status is polled every 2 minutes ... */
  receiptPollEveryMs: 2 * MINUTE,
  /** ... until 15 minutes after the first attempt, then an alert («Выдал» stays blocked). */
  receiptGiveUpMs: 15 * MINUTE,
  /**
   * After that alert a receipt sent inside a payment (or a refund) is still polled, rarely: it
   * cannot be sent again, and a late registration must unlock «Выдал» by itself ...
   */
  receiptSlowPollEveryMs: 10 * MINUTE,
  /** ... up to a day after the window opened; «Повторить чек» opens a new window. */
  receiptSlowPollUntilMs: DAY,
  /**
   * Reconciliation repeats a lost POST /payments or /refunds answer (a pending row without a
   * provider id) only for rows older than 10 minutes; rows with a provider id are re-read on
   * every pass. The nightly check leaves payments younger than this to the sweep.
   */
  reconcilePendingAgeMs: 10 * MINUTE,
  /** The sweep runs every 10 minutes: a lost webhook is closed at most 10 minutes later. */
  reconcileEveryMs: 10 * MINUTE,
  /** «Оплатить счёт Rossko» reminder to the owner. */
  invoiceReminderEveryMs: 4 * HOUR,
  /** needs_attention reminder to the sellers. */
  attentionReminderEveryMs: 4 * HOUR,
  /** The client gets one reminder of an open approval after 12 hours. */
  approvalReminderAfterMs: 12 * HOUR,
  /** The owner is warned 2 days before the 10-day refund deadline. */
  refundDeadlineWarnMs: 2 * DAY,
  /** Outbox dispatcher poll period when no PUBLISH nudge arrives. */
  outboxPollMs: 2_000,
} as const;

export type TimerName = keyof typeof TIMERS;
