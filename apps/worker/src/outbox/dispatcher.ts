// Outbox dispatcher (decisions Б1–Б3, docs/phase-1b-implementation.md section 9.2).
//
// The engine writes job rows into `outbox` in the transaction of a transition; this loop moves
// them into BullMQ:
//
//   select ... where dispatched_at is null and available_at <= now()
//     order by created_at limit 100 for update skip locked
//   -> queues[queue].add(name, {...data, outboxKey: job_id}, {jobId: bullJobId(job_id), ...policy})
//   -> dispatched_at = now()
//
// The row lock is held while the jobs are added, so two worker processes never add the same
// rows concurrently. A Redis failure only bumps `attempts` and `last_error`; the row stays
// pending and goes out on a later pass. If the commit fails after an add, the next pass adds the
// same jobId again: BullMQ ignores a duplicate id while the job is kept, and every processor
// re-reads its database row first anyway (Б3).
//
// Wake-ups: a subscription to OUTBOX_CHANNEL on a connection of its own (web and the engine
// PUBLISH after a commit) plus a poll every TIMERS.outboxPollMs.
import { bullJobId, OUTBOX_CHANNEL, type Logger, type Redis } from '@detaly/config';
import { and, asc, eq, inArray, isNull, outbox, sql, type Db } from '@detaly/db';
import { TIMERS } from '@detaly/domain';
import { isOutboxQueue, safeErrorMessage } from '../dead-letter';
import { jobPolicy, type Queues } from '../queues';

/** Rows taken per pass; a full batch triggers the next pass at once. */
export const OUTBOX_BATCH_SIZE = 100;

/** Longest wait for one queue.add: an unreachable Redis must not hold the row locks for long. */
export const OUTBOX_ADD_TIMEOUT_MS = 5_000;

export interface OutboxPassResult {
  /** Rows moved to BullMQ in this pass. */
  dispatched: number;
  /** Rows whose add failed (attempts + 1). */
  failed: number;
  /** Rows selected in this pass (dispatched + failed + left untouched after a Redis failure). */
  selected: number;
}

export interface OutboxDispatcherOptions {
  db: Db;
  queues: Pick<
    Queues,
    'payments' | 'receipts' | 'rossko' | 'notify' | 'reconciliation' | 'housekeeping'
  >;
  logger: Pick<Logger, 'debug' | 'info' | 'warn' | 'error'>;
  /**
   * Creates the subscriber connection (createRedis(url)); it is used for SUBSCRIBE only and
   * quit by stop(). Omitted: no subscription, polling only.
   */
  createSubscriber?: () => Redis;
  /** Pub/sub channel; tests use a prefixed one. Default OUTBOX_CHANNEL. */
  channel?: string;
  /** Poll interval; default TIMERS.outboxPollMs (2 s). */
  pollMs?: number;
  batchSize?: number;
  addTimeoutMs?: number;
}

export interface OutboxDispatcher {
  /** Subscribes, starts the poll timer and runs the first pass. */
  start(): void;
  /** Runs a pass now (coalesced with a pass in flight); resolves when it is done. */
  kick(): Promise<void>;
  /** One pass, bypassing the scheduling (tests). */
  runOnce(): Promise<OutboxPassResult>;
  /** Stops the timer and the subscription and waits for the pass in flight. */
  stop(): Promise<void>;
}

class AddTimeoutError extends Error {
  override name = 'AddTimeoutError';
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new AddTimeoutError(`queue.add timed out after ${ms} ms`)), ms);
    timer.unref();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Errors after which the rest of the batch is left alone: Redis is unreachable, so every other
 * add would wait for the timeout too. Any other error (a row BullMQ rejects) only skips its row.
 */
function isConnectionError(error: unknown): boolean {
  if (error instanceof AddTimeoutError) return true;
  if (!(error instanceof Error)) return false;
  const code = (error as { code?: unknown }).code;
  return (
    (typeof code === 'string' &&
      /^E(CONN|HOSTUNREACH|NOTFOUND|PIPE|TIMEDOUT|AI_AGAIN)/.test(code)) ||
    /Connection is closed|max retries|Stream isn't writeable|enableOfflineQueue|ECONNREFUSED/i.test(
      error.message,
    )
  );
}

export function createOutboxDispatcher(options: OutboxDispatcherOptions): OutboxDispatcher {
  const { db, queues, logger } = options;
  const channel = options.channel ?? OUTBOX_CHANNEL;
  const pollMs = options.pollMs ?? TIMERS.outboxPollMs;
  const batchSize = options.batchSize ?? OUTBOX_BATCH_SIZE;
  const addTimeoutMs = options.addTimeoutMs ?? OUTBOX_ADD_TIMEOUT_MS;

  let stopped = false;
  let started = false;
  let timer: NodeJS.Timeout | undefined;
  let subscriber: Redis | null = null;
  let running: Promise<void> | null = null;
  let again = false;

  async function pass(): Promise<OutboxPassResult> {
    return db.transaction(async (tx) => {
      const rows = await tx
        .select()
        .from(outbox)
        .where(and(isNull(outbox.dispatchedAt), sql`${outbox.availableAt} <= now()`))
        .orderBy(asc(outbox.createdAt), asc(outbox.id))
        .limit(batchSize)
        .for('update', { skipLocked: true });

      const dispatched: string[] = [];
      let failed = 0;
      for (const row of rows) {
        if (stopped) break;
        try {
          if (!isOutboxQueue(row.queue)) throw new Error(`unknown queue: ${row.queue}`);
          await withTimeout(
            queues[row.queue].add(
              row.name,
              { ...row.data, outboxKey: row.jobId },
              { jobId: bullJobId(row.jobId), ...jobPolicy(row.queue, row.name) },
            ),
            addTimeoutMs,
          );
          dispatched.push(row.id);
        } catch (error) {
          failed += 1;
          const message = safeErrorMessage(error);
          await tx
            .update(outbox)
            .set({ attempts: sql`${outbox.attempts} + 1`, lastError: message })
            .where(eq(outbox.id, row.id));
          logger.warn(
            {
              outboxId: row.id,
              queue: row.queue,
              jobName: row.name,
              attempts: row.attempts + 1,
              err: message,
            },
            'outbox dispatch failed',
          );
          if (isConnectionError(error)) break;
        }
      }
      if (dispatched.length > 0) {
        await tx
          .update(outbox)
          .set({ dispatchedAt: sql`now()`, lastError: null })
          .where(inArray(outbox.id, dispatched));
        logger.debug({ dispatched: dispatched.length }, 'outbox dispatched');
      }
      return { dispatched: dispatched.length, failed, selected: rows.length };
    });
  }

  async function safePass(): Promise<OutboxPassResult | null> {
    try {
      return await pass();
    } catch (error) {
      // Postgres unavailable: the next tick tries again.
      logger.error({ err: safeErrorMessage(error) }, 'outbox pass failed');
      return null;
    }
  }

  function kick(): Promise<void> {
    if (stopped) return running ?? Promise.resolve();
    if (running) {
      again = true;
      return running;
    }
    running = (async () => {
      do {
        again = false;
        const result = await safePass();
        // A full batch without failures: more rows are probably waiting.
        if (result && result.dispatched === batchSize) again = true;
      } while (again && !stopped);
    })().finally(() => {
      running = null;
    });
    return running;
  }

  return {
    start() {
      if (started || stopped) return;
      started = true;
      if (options.createSubscriber) {
        const sub = options.createSubscriber();
        subscriber = sub;
        sub.on('error', (error: Error) =>
          logger.warn({ err: safeErrorMessage(error) }, 'outbox subscriber error'),
        );
        sub.on('message', (from: string) => {
          if (from === channel) void kick();
        });
        // ioredis re-subscribes by itself after a reconnect (autoResubscribe).
        sub
          .subscribe(channel)
          .catch((error: unknown) =>
            logger.warn({ err: safeErrorMessage(error) }, 'outbox subscribe failed'),
          );
      }
      timer = setInterval(() => void kick(), pollMs);
      timer.unref();
      void kick();
    },
    kick,
    runOnce: pass,
    async stop() {
      stopped = true;
      clearInterval(timer);
      const sub = subscriber;
      subscriber = null;
      if (sub) {
        if (sub.status === 'ready') {
          await sub.quit().catch(() => sub.disconnect());
        } else {
          sub.disconnect();
        }
      }
      await running;
    },
  };
}
