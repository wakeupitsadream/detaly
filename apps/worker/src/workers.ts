// BullMQ Workers: every worked queue runs its processor from jobs/* with WorkerDeps. Around the
// processor:
// - RosskoRateLimitError (the per-minute Rossko window is full) delays the job by retryAfterMs
//   instead of spending an attempt (DelayedError), up to MAX_RATE_LIMIT_DELAYS times;
// - UnrecoverableSmsError (the SMS gateway refused for good) becomes UnrecoverableError;
// - a final failure is parked in dead-letter with an alert to the sellers (dead-letter/).
import type { Logger, OutboxQueue } from '@detaly/config';
import { RosskoRateLimitError } from '@detaly/rossko';
import { DelayedError, UnrecoverableError, Worker, type ConnectionOptions, type Job } from 'bullmq';
import { attachDeadLetter, safeErrorMessage } from './dead-letter';
import type { JobProcessor, WorkerDeps } from './deps';
import { PROCESSORS } from './jobs';
import { PROCESSED_QUEUES } from './queues';

/** Smallest delay after a Rossko rate limit (the limiter's estimate may be 0). */
export const MIN_RATE_LIMIT_DELAY_MS = 1_000;
/** After this many starts a rate-limited job fails like any other error (no endless delays). */
export const MAX_RATE_LIMIT_DELAYS = 20;

export interface CreateWorkersOptions {
  /**
   * Connection for the Workers: an ioredis client from createWorkerRedis()
   * (`protocol: 2`, `maxRetriesPerRequest: null`). BullMQ duplicates it for blocking calls.
   */
  connection: ConnectionOptions;
  logger: Logger;
  deps: WorkerDeps;
  /** BullMQ prefix; default deps.bullPrefix. */
  prefix?: string;
  /** Processors by queue; default PROCESSORS (tests replace one). */
  processors?: Partial<Record<OutboxQueue, JobProcessor>>;
  /** Called after a dead-letter entry is written (tests). */
  onDeadLetter?: (id: string | null) => void;
}

function isUnrecoverableSmsError(error: unknown): error is Error {
  return error instanceof Error && error.name === 'UnrecoverableSmsError';
}

/** Wraps a processor with the rate-limit delay and the error mapping described above. */
export function wrapProcessor(
  processor: JobProcessor,
  deps: WorkerDeps,
): (job: Job, token?: string) => Promise<unknown> {
  return async (job, token) => {
    try {
      return await processor(job, deps);
    } catch (error) {
      if (
        error instanceof RosskoRateLimitError &&
        token !== undefined &&
        job.attemptsStarted <= MAX_RATE_LIMIT_DELAYS
      ) {
        const delayMs = Math.max(MIN_RATE_LIMIT_DELAY_MS, error.retryAfterMs);
        await job.moveToDelayed(Date.now() + delayMs, token);
        throw new DelayedError();
      }
      if (isUnrecoverableSmsError(error)) throw new UnrecoverableError(error.message);
      throw error;
    }
  };
}

export function createWorkers(options: CreateWorkersOptions): Worker[] {
  const { connection, logger, deps } = options;
  const prefix = options.prefix ?? deps.bullPrefix;
  const processors = { ...PROCESSORS, ...options.processors };

  return PROCESSED_QUEUES.map((name) => {
    const worker = new Worker(name, wrapProcessor(processors[name], deps), {
      connection,
      prefix,
      concurrency: 1,
    });
    worker.on('failed', (job, error) => {
      logger.warn(
        {
          queue: name,
          jobId: job?.id,
          jobName: job?.name,
          attemptsMade: job?.attemptsMade,
          err: safeErrorMessage(error),
        },
        'job failed',
      );
    });
    worker.on('error', (error) => {
      logger.error({ queue: name, err: safeErrorMessage(error) }, 'worker error');
    });
    attachDeadLetter(worker, name, {
      deadLetter: deps.queues['dead-letter'],
      alerts: deps.alerts,
      logger,
      now: deps.now,
      onParked: options.onDeadLetter,
    });
    return worker;
  });
}
