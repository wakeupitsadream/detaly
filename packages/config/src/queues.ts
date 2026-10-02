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

/** BullMQ key prefix (instead of the default 'bull'); tests should use their own prefix. */
export const BULLMQ_PREFIX = 'detaly:bull';

/** Job names of the housekeeping queue known in phase 0. */
export const HOUSEKEEPING_JOBS = {
  heartbeat: 'heartbeat',
} as const;
