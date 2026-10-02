// Outbox dispatcher on the real PostgreSQL 16 and Redis 7 (section 9.2, decisions Б1–Б3): rows
// become BullMQ jobs with jobId = bullJobId(job_id) and the queue policy, nothing is added twice,
// an unreachable Redis leaves the row pending, and a PUBLISH wakes the dispatcher at once.
// Own database `_worker_outbox` (the dispatcher takes every pending row of its database) and
// Redis keys under `test:<uuid>:`.
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  bullJobId,
  createLogger,
  createRedis,
  parseEnv,
  type OutboxQueue,
  type Redis,
} from '@detaly/config';
import {
  deleteKeysByPrefix,
  minimalEnvSource,
  testKeyPrefix,
  testRedisUrl,
} from '@detaly/config/testing';
import { createDb, eq, outbox, sql, type Db } from '@detaly/db';
import { enqueueOutbox } from '@detaly/orders';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createWorkerDeps } from '../src/create-deps';
import { createOutboxDispatcher } from '../src/outbox/dispatcher';
import { closeQueues, createQueues, type Queues } from '../src/queues';
import { hasTestDatabase, prepareOwnDatabase } from './fixtures/databases';

const prefix = testKeyPrefix();
const logger = createLogger('worker-test', { level: 'silent' });

let databaseUrl: string;
let db: Db;
let redis: Redis;
let queues: Queues;

async function enqueue(input: {
  queue: OutboxQueue;
  name: string;
  key: string;
  data?: Record<string, unknown>;
  availableAt?: Date;
}): Promise<void> {
  await db.transaction(async (tx) => {
    expect(await enqueueOutbox(tx, input)).toBe(true);
  });
}

async function row(key: string) {
  const [found] = await db.select().from(outbox).where(eq(outbox.jobId, key));
  return found;
}

function dispatcher(target: Pick<Queues, OutboxQueue> = queues, addTimeoutMs?: number) {
  return createOutboxDispatcher({ db, queues: target, logger, addTimeoutMs });
}

describe.skipIf(!hasTestDatabase)('outbox dispatcher', () => {
  beforeAll(async () => {
    const url = await prepareOwnDatabase('outbox');
    if (!url) throw new Error('DATABASE_URL_TEST is not set');
    databaseUrl = url;
    db = createDb(databaseUrl, { max: 6 });
    redis = createRedis(testRedisUrl());
    queues = createQueues(redis, { prefix: `${prefix}bull` });
  });

  afterAll(async () => {
    await closeQueues(queues);
    await deleteKeysByPrefix(redis, prefix);
    await redis.quit();
    await db.close();
  });

  it('turns a row into a job with jobId = bullJobId(job_id), the policy and outboxKey', async () => {
    const orderEventId = randomUUID();
    const key = `notify:${orderEventId}:payment_link`;
    await enqueue({
      queue: 'notify',
      name: 'order',
      key,
      data: { orderEventId, audience: 'client' },
    });

    const result = await dispatcher().runOnce();
    expect(result).toMatchObject({ dispatched: 1, failed: 0 });

    const job = await queues.notify.getJob(bullJobId(key));
    expect(job?.id).toBe(`notify|${orderEventId}|payment_link`);
    expect(job?.name).toBe('order');
    expect(job?.data).toEqual({ orderEventId, audience: 'client', outboxKey: key });
    expect(job?.opts).toMatchObject({
      attempts: 5,
      backoff: { type: 'exponential', delay: 30_000 },
    });

    const stored = await row(key);
    expect(stored?.dispatchedAt).toBeInstanceOf(Date);
    expect(stored?.attempts).toBe(0);
  });

  it('gives rossko/checkout exactly one attempt and payments five from 10 s', async () => {
    const checkoutKey = `checkout:${randomUUID()}`;
    const webhookKey = `payment.succeeded:${randomUUID()}`;
    await enqueue({ queue: 'rossko', name: 'checkout', key: checkoutKey });
    await enqueue({ queue: 'payments', name: 'webhook', key: webhookKey });
    expect(await dispatcher().runOnce()).toMatchObject({ dispatched: 2 });

    const checkout = await queues.rossko.getJob(bullJobId(checkoutKey));
    expect(checkout?.opts.attempts).toBe(1);
    const webhook = await queues.payments.getJob(bullJobId(webhookKey));
    expect(webhook?.opts).toMatchObject({
      attempts: 5,
      backoff: { type: 'exponential', delay: 10_000 },
    });
  });

  it('does not add a job twice: a second pass and a lost commit keep one job', async () => {
    const key = `receipt:${randomUUID()}`;
    await enqueue({ queue: 'receipts', name: 'offset', key });
    const d = dispatcher();
    expect(await d.runOnce()).toMatchObject({ dispatched: 1 });
    expect(await d.runOnce()).toMatchObject({ dispatched: 0, selected: 0 });

    // As if the commit after queue.add had been lost: the row is pending again.
    await db.update(outbox).set({ dispatchedAt: null }).where(eq(outbox.jobId, key));
    expect(await d.runOnce()).toMatchObject({ dispatched: 1 });
    const counts = await queues.receipts.getJobCounts('waiting');
    const jobs = await queues.receipts.getJobs(['waiting']);
    expect(jobs.filter((job) => job.data.outboxKey === key)).toHaveLength(1);
    expect(counts.waiting).toBe(jobs.length);
  });

  it('two dispatchers at once move each row exactly once (for update skip locked)', async () => {
    const keys = Array.from({ length: 6 }, () => `notify:${randomUUID()}:arrived`);
    for (const key of keys) await enqueue({ queue: 'notify', name: 'order', key });
    const [a, b] = await Promise.all([dispatcher().runOnce(), dispatcher().runOnce()]);
    expect(a.dispatched + b.dispatched).toBe(6);
    for (const key of keys) {
      expect((await row(key))?.dispatchedAt).toBeInstanceOf(Date);
      expect(await queues.notify.getJob(bullJobId(key))).toBeDefined();
    }
  });

  it('leaves rows with available_at in the future alone', async () => {
    const key = `reminder:${randomUUID()}:ready:1`;
    await enqueue({
      queue: 'notify',
      name: 'order',
      key,
      availableAt: new Date(Date.now() + 3_600_000),
    });
    await dispatcher().runOnce();
    expect((await row(key))?.dispatchedAt).toBeNull();
    expect(await queues.notify.getJob(bullJobId(key))).toBeUndefined();

    await db
      .update(outbox)
      .set({ availableAt: sql`now() - interval '1 second'` })
      .where(eq(outbox.jobId, key));
    expect(await dispatcher().runOnce()).toMatchObject({ dispatched: 1 });
  });

  it('survives an unreachable Redis: attempts + 1, last_error, the row goes out later', async () => {
    const dead = createRedis('redis://127.0.0.1:1/0', {
      maxRetriesPerRequest: 1,
      retryStrategy: () => 1_000,
      connectTimeout: 200,
    });
    dead.on('error', () => undefined);
    const deadQueues = createQueues(dead, { prefix: `${prefix}dead` });
    for (const queue of Object.values(deadQueues)) queue.on('error', () => undefined);

    const key = `refund-create:${randomUUID()}`;
    await enqueue({ queue: 'payments', name: 'refund-create', key });
    try {
      const failed = await dispatcher(deadQueues, 300).runOnce();
      expect(failed).toMatchObject({ dispatched: 0, failed: 1 });
      const pending = await row(key);
      expect(pending?.dispatchedAt).toBeNull();
      expect(pending?.attempts).toBe(1);
      expect(pending?.lastError).toMatch(/timed out|Connection|retries/i);
    } finally {
      dead.disconnect();
      await Promise.race([closeQueues(deadQueues).catch(() => undefined), sleep(1_000)]);
    }

    // Redis is back: the same row is dispatched, its error cleared.
    expect(await dispatcher().runOnce()).toMatchObject({ dispatched: 1, failed: 0 });
    const done = await row(key);
    expect(done?.dispatchedAt).toBeInstanceOf(Date);
    expect(done?.lastError).toBeNull();
    expect(await queues.payments.getJob(bullJobId(key))).toBeDefined();
  });

  it('wakes up on the engine nudge (PUBLISH) in under a second', async () => {
    const channel = `${prefix}outbox`;
    const env = parseEnv(
      minimalEnvSource({ DATABASE_URL: databaseUrl, REDIS_URL: testRedisUrl() }),
    );
    const resources = createWorkerDeps({
      env,
      logger,
      keyPrefix: prefix,
      bullPrefix: `${prefix}nudge`,
      heartbeatKey: `${prefix}heartbeat`,
      outboxChannel: channel,
      dbMax: 4,
    });
    const { deps } = resources;
    // Polling far away: only the message can wake the dispatcher within the test.
    const d = createOutboxDispatcher({
      db: deps.db,
      queues: deps.queues,
      logger,
      createSubscriber: resources.createSubscriber,
      channel,
      pollMs: 60_000,
    });
    try {
      d.start();
      await vi.waitFor(
        async () => {
          const [, subscribers] = (await redis.pubsub('NUMSUB', channel)) as [string, number];
          expect(Number(subscribers)).toBe(1);
        },
        { timeout: 5_000, interval: 20 },
      );
      await d.kick(); // the start pass is over

      const key = `notify:${randomUUID()}:confirm_request`;
      await enqueue({ queue: 'notify', name: 'order', key });
      const sentAt = Date.now();
      deps.engine.nudge?.();
      await vi.waitFor(
        async () => expect(await deps.queues.notify.getJob(bullJobId(key))).toBeDefined(),
        { timeout: 1_000, interval: 10 },
      );
      expect(Date.now() - sentAt).toBeLessThan(1_000);
      expect((await row(key))?.dispatchedAt).toBeInstanceOf(Date);
    } finally {
      await d.stop();
      await closeQueues(deps.queues);
      await deps.redis.quit();
      await resources.workerRedis.quit();
      await deps.db.close();
    }
  });

  it('stop() ends the subscription and the timer', async () => {
    const channel = `${prefix}stop`;
    const d = createOutboxDispatcher({
      db,
      queues,
      logger,
      createSubscriber: () => createRedis(testRedisUrl()),
      channel,
      pollMs: 50,
    });
    d.start();
    await vi.waitFor(
      async () => {
        const [, subscribers] = (await redis.pubsub('NUMSUB', channel)) as [string, number];
        expect(Number(subscribers)).toBe(1);
      },
      { timeout: 5_000, interval: 20 },
    );
    await d.stop();
    const [, subscribers] = (await redis.pubsub('NUMSUB', channel)) as [string, number];
    expect(Number(subscribers)).toBe(0);

    const key = `notify:${randomUUID()}:after_stop`;
    await enqueue({ queue: 'notify', name: 'order', key });
    await sleep(200);
    expect((await row(key))?.dispatchedAt).toBeNull();
    await db.delete(outbox).where(eq(outbox.jobId, key));
  });
});
