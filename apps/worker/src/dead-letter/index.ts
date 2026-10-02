// Dead-letter (decision Б30, docs/phase-1b-implementation.md section 9.5). A job that failed for
// good (attempts exhausted or UnrecoverableError) is copied into the `dead-letter` queue under
// the id `${queue}|${job.id}` with its queue, name, data and a PD-free error, and the sellers
// chat gets an alert. dead-letter has no Worker: the owner retries from /queues
// (QueueInspector.retryDeadLetter in inspector.ts).
import { bullJobId, OUTBOX_QUEUES, type Logger, type OutboxQueue } from '@detaly/config';
import { UnrecoverableError, type Job, type Queue, type Worker } from 'bullmq';
import type { AlertPort } from '../deps';
import { safeErrorMessage } from './safe-error';

export { redactText, safeErrorMessage, SAFE_ERROR_MAX } from './safe-error';

/** Job name of every dead-letter entry. */
export const DEAD_LETTER_JOB = 'dead';

/** Data of a dead-letter job: enough to put the original job back. */
export interface DeadLetterData {
  queue: OutboxQueue;
  name: string;
  /** The original BullMQ job id; null for Job Scheduler runs (their ids are generated). */
  jobId: string | null;
  data: Record<string, unknown>;
  /** PD-free error text (safeErrorMessage). */
  error: string;
  failedAt: string;
  attemptsMade: number;
}

export function isOutboxQueue(name: unknown): name is OutboxQueue {
  return typeof name === 'string' && (OUTBOX_QUEUES as readonly string[]).includes(name);
}

/** A run produced by a Job Scheduler (heartbeat, timers, sweep...). */
export function isSchedulerJob(job: Pick<Job, 'id' | 'repeatJobKey'>): boolean {
  return Boolean(job.repeatJobKey) || (job.id?.startsWith('repeat:') ?? false);
}

function isUnrecoverable(error: unknown): boolean {
  return (
    error instanceof UnrecoverableError ||
    (error instanceof Error && error.name === 'UnrecoverableError')
  );
}

/**
 * Whether the `failed` event is the last one for this job. BullMQ emits `failed` after every
 * attempt; `finishedOn` is set only when the job really moved to the failed set.
 */
export function isFinalFailure(
  job: Pick<Job, 'attemptsMade' | 'finishedOn' | 'opts'>,
  error: unknown,
): boolean {
  if (isUnrecoverable(error)) return true;
  if (job.finishedOn !== undefined && job.finishedOn !== null) return true;
  return job.attemptsMade >= (job.opts.attempts ?? 1);
}

/** UTC hour bucket `2026-10-02T09` (one dead-letter entry per scheduler job and hour). */
function hourBucket(at: Date): string {
  return at.toISOString().slice(0, 13);
}

/**
 * Dead-letter job id. Regular jobs: `${queue}|${job.id}` (bullJobId keeps it free of ':').
 * Scheduler runs get a fresh id every minute, so they are bucketed by name and hour: a timer
 * that breaks every minute parks one entry (and sends one alert) per hour, not 60.
 */
export function deadLetterJobId(
  queue: OutboxQueue,
  job: Pick<Job, 'id' | 'name' | 'repeatJobKey'>,
  at: Date,
): string {
  if (isSchedulerJob(job)) return bullJobId(`${queue}|${job.name}|${hourBucket(at)}`);
  return bullJobId(`${queue}|${job.id ?? 'unknown'}`);
}

export interface DeadLetterContext {
  deadLetter: Pick<Queue, 'add'>;
  alerts: AlertPort;
  logger: Pick<Logger, 'warn' | 'error'>;
  now?: () => Date;
}

/** Russian alert text without PD: queue, job name, attempts and the masked error. */
export function deadLetterAlertText(entry: DeadLetterData): string {
  return [
    `Задача не выполнена: ${entry.queue} / ${entry.name}`,
    `Попыток: ${entry.attemptsMade}`,
    `Ошибка: ${entry.error}`,
    'Повторить — /queues',
  ].join('\n');
}

/**
 * Parks a finally failed job and alerts the sellers. Never throws: it runs from the Worker's
 * `failed` event, and a failure here is only logged (the job itself stays in the failed set).
 * Returns the dead-letter job id, or null when parking failed.
 */
export async function moveToDeadLetter(
  ctx: DeadLetterContext,
  queue: OutboxQueue,
  job: Job,
  error: unknown,
): Promise<string | null> {
  const at = ctx.now?.() ?? new Date();
  const id = deadLetterJobId(queue, job, at);
  const scheduler = isSchedulerJob(job);
  const entry: DeadLetterData = {
    queue,
    name: job.name,
    jobId: scheduler ? null : (job.id ?? null),
    data: (job.data ?? {}) as Record<string, unknown>,
    error: safeErrorMessage(error),
    failedAt: at.toISOString(),
    attemptsMade: job.attemptsMade,
  };
  try {
    await ctx.deadLetter.add(DEAD_LETTER_JOB, entry, { jobId: id });
  } catch (addError) {
    ctx.logger.error(
      { queue, jobId: job.id, jobName: job.name, err: safeErrorMessage(addError) },
      'dead-letter add failed',
    );
    return null;
  }
  ctx.logger.warn(
    { queue, jobId: job.id, jobName: job.name, deadLetterId: id, err: entry.error },
    'job moved to dead-letter',
  );
  try {
    await ctx.alerts.send({
      audience: 'sellers',
      text: deadLetterAlertText(entry),
      // A re-failure after a manual retry is a new incident; scheduler ids are hourly already.
      dedupeKey: scheduler ? `dead-letter:${id}` : `dead-letter:${id}:${at.getTime()}`,
    });
  } catch (alertError) {
    ctx.logger.error(
      { queue, deadLetterId: id, err: safeErrorMessage(alertError) },
      'dead-letter alert failed',
    );
  }
  return id;
}

/**
 * Listens to the Worker's `failed` events and parks final failures. `onParked` (tests) resolves
 * after the entry and the alert are written.
 */
export function attachDeadLetter(
  worker: Pick<Worker, 'on'>,
  queue: OutboxQueue,
  ctx: DeadLetterContext & { onParked?: (id: string | null) => void },
): void {
  worker.on('failed', (job, error) => {
    if (!job || !isFinalFailure(job, error)) return;
    void moveToDeadLetter(ctx, queue, job, error).then((id) => ctx.onParked?.(id));
  });
}
