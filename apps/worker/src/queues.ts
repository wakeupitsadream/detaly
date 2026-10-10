// BullMQ queues (PLAN section 1), their retry policies and the Job Schedulers that feed them.
// BullMQ 6 removed repeatable jobs: periodic work is declared with upsertJobScheduler.
import {
  BULLMQ_PREFIX,
  HOUSEKEEPING_JOBS,
  QUEUE,
  QUEUE_NAMES,
  RECONCILIATION_JOBS,
  ROSSKO_JOBS,
  type OutboxQueue,
  type QueueName,
} from '@detaly/config';
import { Queue, type ConnectionOptions, type JobsOptions } from 'bullmq';

export type Queues = Record<QueueName, Queue>;

export interface CreateQueuesOptions {
  /** BullMQ key prefix; tests pass their own `test:<uuid>:` prefix. */
  prefix?: string;
}

/** Heartbeat period: the healthcheck allows 120 s, /api/health 300 s. */
export const HEARTBEAT_EVERY_MS = 30_000;

/** Retry policy of a job: BullMQ `attempts` (total runs, not retries) and backoff. */
export interface JobPolicy {
  attempts: number;
  backoff?: { type: 'exponential' | 'fixed'; delay: number };
}

/**
 * Per-queue policies (docs/phase-1b-implementation.md section 9.3). Idempotency never relies
 * on them (decision Б3): every processor re-reads its database row first.
 *
 * - payments: 5 attempts, exponential from 10 s (10, 20, 40, 80 s);
 * - receipts: 3 attempts; the 2-minute polling of a receipt is done with its own delayed jobs;
 * - rossko: 3 attempts; RosskoRateLimitError delays the job instead (workers.ts);
 *   GetCheckout has exactly one attempt (jobPolicy), a retry goes through recovery only;
 * - notify: 5 attempts, exponential from 30 s;
 * - reconciliation and housekeeping: one attempt, the next scheduled run is the retry.
 */
export const QUEUE_POLICIES: Readonly<Record<OutboxQueue, JobPolicy>> = {
  payments: { attempts: 5, backoff: { type: 'exponential', delay: 10_000 } },
  receipts: { attempts: 3, backoff: { type: 'exponential', delay: 10_000 } },
  rossko: { attempts: 3, backoff: { type: 'exponential', delay: 10_000 } },
  notify: { attempts: 5, backoff: { type: 'exponential', delay: 30_000 } },
  reconciliation: { attempts: 1 },
  housekeeping: { attempts: 1 },
};

/** GetCheckout must never be repeated by the queue (decision Б13): one job per attempt. */
export const ROSSKO_CHECKOUT_POLICY: JobPolicy = { attempts: 1 };

/** The policy of one job: the queue policy, except rossko/checkout. */
export function jobPolicy(queue: OutboxQueue, name: string): JobPolicy {
  if (queue === QUEUE.rossko && name === ROSSKO_JOBS.checkout) return ROSSKO_CHECKOUT_POLICY;
  return QUEUE_POLICIES[queue];
}

/** Completed and failed jobs kept in Redis (the database is the source of truth). */
const RETENTION: Pick<JobsOptions, 'removeOnComplete' | 'removeOnFail'> = {
  removeOnComplete: { count: 1000 },
  removeOnFail: { count: 5000 },
};

function defaultJobOptions(name: QueueName): JobsOptions {
  // dead-letter has no Worker: its jobs wait until /queues retries or an operator removes them.
  if (name === QUEUE.deadLetter) return { attempts: 1 };
  return { ...RETENTION, ...QUEUE_POLICIES[name] };
}

/**
 * One Queue per name in QUEUE_NAMES. `conn` is an ioredis client created with
 * `protocol: 2` (createRedis); the queues share it and never close it themselves. Every queue
 * carries its policy as default job options, so jobs added by processors (receipt polling,
 * retries from dead-letter) get it too.
 */
export function createQueues(conn: ConnectionOptions, options: CreateQueuesOptions = {}): Queues {
  const prefix = options.prefix ?? BULLMQ_PREFIX;
  const entries = QUEUE_NAMES.map(
    (name) =>
      [
        name,
        new Queue(name, { connection: conn, prefix, defaultJobOptions: defaultJobOptions(name) }),
      ] as const,
  );
  return Object.fromEntries(entries) as Queues;
}

/** Time zone of the nightly reconciliation cron (TZ of the deployment, PLAN section 1). */
export const SCHEDULER_TZ = 'Asia/Yekaterinburg';

export interface SchedulerSpec {
  queue: 'housekeeping' | 'reconciliation' | 'rossko';
  /** Scheduler key and job name. */
  name: string;
  repeat: { every: number } | { pattern: string; tz: string };
  /** Completed jobs kept: frequent jobs keep only the last few. */
  keep: number;
}

/**
 * Every Job Scheduler (section 9.4): heartbeat 30 s, timers 60 s, reminders 15 min, SMS budget
 * 1 h, deferred 1A effects 10 min, reconciliation sweep 10 min, the nightly check at 03:15, the
 * VIN photo retention at 04:40 Asia/Yekaterinburg (phase 1C, decision С16), the weekly price
 * check reminder on Mondays at 10:00 Asia/Yekaterinburg (step 2, docs/pricing.md), the
 * weekly reviews reminder on Mondays at 10:05 (step 3, docs/reviews.md), the fit checks
 * every 5 minutes: expiry and the SLA reminder (step 4, docs/fit-check.md), the month close
 * on the 1st at 09:00 with the finance reminders daily at 09:10 (step 7, docs/month-close.md),
 * and step 8 (docs/rossko-automation.md): the deadline alerts every 10 minutes, the cutoff
 * reminder every 5 minutes on the clock (:00, :05…, so a cutoff on a 5-minute mark is reminded
 * exactly 25 minutes before), and the GetOrders polling every 20 minutes on the rossko queue
 * (it does nothing unless ROSSKO_MODE=live and settings rossko.poll_enabled).
 */
export const SCHEDULERS: readonly SchedulerSpec[] = [
  {
    queue: 'housekeeping',
    name: HOUSEKEEPING_JOBS.heartbeat,
    repeat: { every: HEARTBEAT_EVERY_MS },
    keep: 10,
  },
  { queue: 'housekeeping', name: HOUSEKEEPING_JOBS.timers, repeat: { every: 60_000 }, keep: 10 },
  {
    queue: 'housekeeping',
    name: HOUSEKEEPING_JOBS.reminders,
    repeat: { every: 15 * 60_000 },
    keep: 20,
  },
  {
    queue: 'housekeeping',
    name: HOUSEKEEPING_JOBS.smsBudget,
    repeat: { every: 60 * 60_000 },
    keep: 20,
  },
  {
    queue: 'housekeeping',
    name: HOUSEKEEPING_JOBS.deferred1a,
    repeat: { every: 10 * 60_000 },
    keep: 20,
  },
  {
    queue: 'housekeeping',
    name: HOUSEKEEPING_JOBS.retention,
    repeat: { pattern: '40 4 * * *', tz: SCHEDULER_TZ },
    keep: 30,
  },
  {
    queue: 'housekeeping',
    name: HOUSEKEEPING_JOBS.priceCheck,
    repeat: { pattern: '0 10 * * 1', tz: SCHEDULER_TZ },
    keep: 10,
  },
  {
    queue: 'housekeeping',
    name: HOUSEKEEPING_JOBS.reviewsCheck,
    repeat: { pattern: '5 10 * * 1', tz: SCHEDULER_TZ },
    keep: 10,
  },
  {
    queue: 'housekeeping',
    name: HOUSEKEEPING_JOBS.fitChecks,
    repeat: { every: 5 * 60_000 },
    keep: 20,
  },
  {
    queue: 'housekeeping',
    name: HOUSEKEEPING_JOBS.monthClose,
    repeat: { pattern: '0 9 1 * *', tz: SCHEDULER_TZ },
    keep: 12,
  },
  {
    queue: 'housekeeping',
    name: HOUSEKEEPING_JOBS.financeReminders,
    repeat: { pattern: '10 9 * * *', tz: SCHEDULER_TZ },
    keep: 30,
  },
  {
    queue: 'housekeeping',
    name: HOUSEKEEPING_JOBS.rosskoDeadlines,
    repeat: { every: 10 * 60_000 },
    keep: 20,
  },
  {
    queue: 'housekeeping',
    name: HOUSEKEEPING_JOBS.rosskoCutoff,
    repeat: { pattern: '*/5 * * * *', tz: SCHEDULER_TZ },
    keep: 20,
  },
  {
    queue: 'rossko',
    name: ROSSKO_JOBS.pollOrders,
    repeat: { every: 20 * 60_000 },
    keep: 20,
  },
  {
    queue: 'reconciliation',
    name: RECONCILIATION_JOBS.sweep,
    repeat: { every: 10 * 60_000 },
    keep: 20,
  },
  {
    queue: 'reconciliation',
    name: RECONCILIATION_JOBS.nightly,
    repeat: { pattern: '15 3 * * *', tz: SCHEDULER_TZ },
    keep: 30,
  },
];

/**
 * Declares (idempotently) every Job Scheduler. Without `queues.reconciliation` or `queues.rossko`
 * (phase 0 callers and unit tests) only the schedulers of the queues passed are declared.
 */
export async function registerSchedulers(
  queues: Pick<Queues, 'housekeeping'> & Partial<Pick<Queues, 'reconciliation' | 'rossko'>>,
): Promise<void> {
  for (const spec of SCHEDULERS) {
    const queue = queues[spec.queue];
    if (!queue) continue;
    await queue.upsertJobScheduler(spec.name, spec.repeat, {
      name: spec.name,
      opts: {
        attempts: 1,
        removeOnComplete: { count: spec.keep },
        removeOnFail: { count: 50 },
      },
    });
  }
}

/** Queues that get a Worker; dead-letter is a parking queue inspected by hand. */
export const PROCESSED_QUEUES = QUEUE_NAMES.filter(
  (name): name is OutboxQueue => name !== QUEUE.deadLetter,
);

export async function closeQueues(queues: Queues): Promise<void> {
  await Promise.all(Object.values(queues).map((queue) => queue.close()));
}
