// BullMQ queues (PLAN section 1) and the Job Schedulers that feed them.
// BullMQ 6 removed repeatable jobs: periodic work is declared with upsertJobScheduler.
import {
  BULLMQ_PREFIX,
  HOUSEKEEPING_JOBS,
  QUEUE,
  QUEUE_NAMES,
  type QueueName,
} from '@detaly/config';
import { Queue, type ConnectionOptions } from 'bullmq';

export type Queues = Record<QueueName, Queue>;

export interface CreateQueuesOptions {
  /** BullMQ key prefix; tests pass their own `test:<uuid>:` prefix. */
  prefix?: string;
}

/** Heartbeat period: the healthcheck allows 120 s, /api/health 300 s. */
export const HEARTBEAT_EVERY_MS = 30_000;

/**
 * One Queue per name in QUEUE_NAMES. `conn` is an ioredis client created with
 * `protocol: 2` (createRedis); the queues share it and never close it themselves.
 */
export function createQueues(conn: ConnectionOptions, options: CreateQueuesOptions = {}): Queues {
  const prefix = options.prefix ?? BULLMQ_PREFIX;
  const entries = QUEUE_NAMES.map(
    (name) =>
      [
        name,
        new Queue(name, {
          connection: conn,
          prefix,
          defaultJobOptions: {
            removeOnComplete: { count: 1000 },
            removeOnFail: { count: 5000 },
          },
        }),
      ] as const,
  );
  return Object.fromEntries(entries) as Queues;
}

/** Declares (idempotently) every Job Scheduler of phase 0. */
export async function registerSchedulers(queues: Pick<Queues, 'housekeeping'>): Promise<void> {
  await queues.housekeeping.upsertJobScheduler(
    HOUSEKEEPING_JOBS.heartbeat,
    { every: HEARTBEAT_EVERY_MS },
    {
      name: HOUSEKEEPING_JOBS.heartbeat,
      // 2880 heartbeats a day: keep only the last few in Redis.
      opts: { removeOnComplete: { count: 10 }, removeOnFail: { count: 50 } },
    },
  );
}

/** Queues that get a Worker; dead-letter is a parking queue inspected by hand. */
export const PROCESSED_QUEUES = QUEUE_NAMES.filter((name) => name !== QUEUE.deadLetter);

export async function closeQueues(queues: Queues): Promise<void> {
  await Promise.all(Object.values(queues).map((queue) => queue.close()));
}
