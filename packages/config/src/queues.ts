/** BullMQ queue names (PLAN section 1). */
export const QUEUE_NAMES = [
  'payments',
  'receipts',
  'rossko',
  'notify',
  'reconciliation',
  'housekeeping',
  'dead-letter',
] as const;
export type QueueName = (typeof QUEUE_NAMES)[number];

/** Named access: QUEUE.deadLetter === 'dead-letter'. */
export const QUEUE = {
  payments: 'payments',
  receipts: 'receipts',
  rossko: 'rossko',
  notify: 'notify',
  reconciliation: 'reconciliation',
  housekeeping: 'housekeeping',
  deadLetter: 'dead-letter',
} as const satisfies Record<string, QueueName>;

/** Queues an outbox row may target (decision Б1): dead-letter is filled by the worker only. */
export const OUTBOX_QUEUES = QUEUE_NAMES.filter(
  (name): name is Exclude<QueueName, 'dead-letter'> => name !== QUEUE.deadLetter,
);
export type OutboxQueue = (typeof OUTBOX_QUEUES)[number];

/** BullMQ key prefix (instead of the default 'bull'); tests should use their own prefix. */
export const BULLMQ_PREFIX = 'detaly:bull';

/**
 * Redis pub/sub channel (decision Б1): web PUBLISHes '1' after committing a transition that wrote
 * outbox rows; the worker's dispatcher wakes up at once instead of waiting for its poll.
 */
export const OUTBOX_CHANNEL = 'detaly:outbox';

/**
 * BullMQ job id for a logical job key (decision Б2). BullMQ 6 rejects custom ids containing ':'
 * (except exactly three parts), while PLAN keys look like `payment.succeeded:<object.id>` or
 * `${order_event_id}:${channel}`. The logical key stays in outbox.job_id; BullMQ gets it with
 * every ':' replaced by '|'.
 */
export function bullJobId(key: string): string {
  return key.replaceAll(':', '|');
}

/** Job names of the housekeeping queue. */
export const HOUSEKEEPING_JOBS = {
  heartbeat: 'heartbeat',
  /** Every minute: expires_at of awaiting_* / ready / handed orders, approval timeouts (Б27). */
  timers: 'timers',
  /** Every 15 minutes: reminders, deduplicated by outbox keys (Б27). */
  reminders: 'reminders',
  /** Hourly: SMS monthly budget alert at 80% (Б21). */
  smsBudget: 'sms-budget',
  /** Every 10 minutes: deferred effects of phase 1A order events (Б26). */
  deferred1a: 'deferred-1a',
  /** Daily at 04:40 local: VIN request photos older than 90 days are deleted (phase 1C, С16). */
  retention: 'retention',
  /**
   * Mondays at 10:00 local (step 2, docs/pricing.md): «Пора сверить цены» to the sellers chat
   * unless the last week already has 20 price comparisons.
   */
  priceCheck: 'price-check',
  /**
   * Mondays at 10:05 local (step 3, docs/reviews.md): «Отзывы: обновите рейтинг…» to the sellers
   * chat while a review link is set and the rating snapshot is older than 7 days.
   */
  reviewsCheck: 'reviews-check',
  /**
   * Every 5 minutes (step 4, docs/fit-check.md): fit checks unanswered for 24 hours expire, and
   * a request waiting longer than `fit_check.sla_minutes` of working time is re-posted to the
   * sellers chat once.
   */
  fitChecks: 'fit-checks',
  /**
   * On the 1st at 09:00 local (step 7, docs/month-close.md): «Закрытие <месяц>» of the month that
   * ended to the owner, once per month.
   */
  monthClose: 'month-close',
  /**
   * Daily at 09:10 local (step 7): the owner's reminders of the act, the bank check and the tax
   * payment date on the days of settings finance.reminder_days, once per month each.
   */
  financeReminders: 'finance-reminders',
  /**
   * Every 10 minutes (step 8, docs/rossko-automation.md): the deadline alerts to the sellers chat,
   * one per order and kind — «Не заказано у поставщика», «Срок поставщика под угрозой», «Срок
   * сорван», «Не забирают».
   */
  rosskoDeadlines: 'rossko-deadlines',
  /**
   * Every 5 minutes (step 8): 25 minutes before a Rossko cutoff of settings rossko.cutoff_times on
   * a working day, one push «Через 25 минут отсечка Rossko: не заказано N заказов» when there is
   * something to order.
   */
  rosskoCutoff: 'rossko-cutoff',
} as const;

/** Job names of the reconciliation queue (decision Б29, PLAN section 1). */
export const RECONCILIATION_JOBS = {
  /** Every 10 minutes: pending payments and refunds older than 10 minutes. */
  sweep: 'sweep',
  /** Nightly: the shop's payments of the last day against the database (alerts only). */
  nightly: 'nightly',
} as const;

/** Job names of the payments queue (docs/phase-1b-implementation.md section 10). */
export const PAYMENTS_JOBS = {
  webhook: 'webhook',
  paymentCreate: 'payment-create',
  paymentRecheck: 'payment-recheck',
  refundCreate: 'refund-create',
} as const;

/** Job names of the receipts queue (decision Б22, Б23). */
export const RECEIPTS_JOBS = {
  offset: 'offset',
  offsetPoll: 'offset-poll',
  paymentReceipt: 'payment-receipt',
  /** The refund receipt, registered after refund.succeeded (receipt_registration of the refund). */
  refundReceipt: 'refund-receipt',
} as const;

/** Job names of the rossko queue (decisions Б12–Б15). */
export const ROSSKO_JOBS = {
  recheck: 'recheck',
  checkout: 'checkout',
  recover: 'recover',
  /**
   * Every 20 minutes (step 8, docs/rossko-automation.md): GetOrders of the open supplier orders,
   * only with ROSSKO_MODE=live and settings rossko.poll_enabled; acts on mapped status codes only.
   */
  pollOrders: 'poll-orders',
} as const;

/** Job names of the notify queue (section 12.1). */
export const NOTIFY_JOBS = {
  order: 'order',
  alert: 'alert',
  /** Phase 1C (decision С20): a VIN request message to the client or the sellers card. */
  vin: 'vin',
  /** Step 4 (docs/fit-check.md): the fit check card of a request in the sellers chat. */
  fit: 'fit',
} as const;
