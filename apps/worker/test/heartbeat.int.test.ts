// Real BullMQ against the shared Redis 7: the Job Scheduler fires the heartbeat job at once,
// the housekeeping Worker writes the key with a TTL. Keys live under a `test:<uuid>:` prefix.
import {
  createRedis,
  createWorkerRedis,
  createLogger,
  HEARTBEAT_TTL_SEC,
  type Redis,
} from '@detaly/config';
import { deleteKeysByPrefix, testKeyPrefix, testRedisUrl } from '@detaly/config/testing';
import type { Worker } from 'bullmq';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { checkHeartbeat } from '../src/health';
import { closeQueues, createQueues, registerSchedulers, type Queues } from '../src/queues';
import { createWorkers } from '../src/workers';

const prefix = testKeyPrefix();
const bullPrefix = `${prefix}bull`;
const heartbeatKey = `${prefix}heartbeat`;

let redis: Redis;
let workerRedis: Redis;
let queues: Queues;
let workers: Worker[];

beforeAll(() => {
  redis = createRedis(testRedisUrl());
  workerRedis = createWorkerRedis(testRedisUrl());
  queues = createQueues(redis, { prefix: bullPrefix });
  workers = createWorkers({
    connection: workerRedis,
    redis,
    logger: createLogger('worker-test', { level: 'silent' }),
    prefix: bullPrefix,
    heartbeatKey,
  });
});

afterAll(async () => {
  await Promise.all(workers.map((w) => w.close()));
  await closeQueues(queues);
  await deleteKeysByPrefix(redis, prefix);
  await workerRedis.quit();
  await redis.quit();
});

describe('heartbeat via the Job Scheduler', () => {
  it('uses RESP2 connections, workers with maxRetriesPerRequest: null', () => {
    expect(redis.options.protocol).toBe(2);
    expect(workerRedis.options.protocol).toBe(2);
    expect(workerRedis.options.maxRetriesPerRequest).toBeNull();
  });

  it('writes the heartbeat key with a TTL', async () => {
    expect(await redis.exists(heartbeatKey)).toBe(0);
    await registerSchedulers(queues);

    await vi.waitFor(async () => expect(await redis.exists(heartbeatKey)).toBe(1), {
      timeout: 10_000,
      interval: 100,
    });
    const ttl = await redis.ttl(heartbeatKey);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(HEARTBEAT_TTL_SEC);
    expect(await checkHeartbeat(redis, { key: heartbeatKey })).toMatchObject({ ok: true });

    const schedulers = await queues.housekeeping.getJobSchedulers();
    expect(schedulers).toEqual([
      expect.objectContaining({ key: 'heartbeat', name: 'heartbeat', every: 30_000 }),
    ]);
  });

  it('registers the scheduler idempotently', async () => {
    await registerSchedulers(queues);
    await registerSchedulers(queues);
    expect(await queues.housekeeping.getJobSchedulersCount()).toBe(1);
  });

  it('fails stub jobs without retries', async () => {
    const job = await queues.payments.add('capture', {}, { attempts: 5 });
    await vi.waitFor(async () => expect(await job.getState()).toBe('failed'), {
      timeout: 10_000,
      interval: 100,
    });
    const failed = await queues.payments.getJob(job.id!);
    expect(failed?.failedReason).toBe('phase 0');
    expect(failed?.attemptsMade).toBe(1);
  });
});

describe('checkHeartbeat', () => {
  it('is not ok without a key or with a stale one', async () => {
    const key = `${prefix}stale`;
    expect(await checkHeartbeat(redis, { key })).toEqual({ ok: false, ageSec: null });
    await redis.set(key, String(Date.now() - 120_000), 'EX', 60);
    expect(await checkHeartbeat(redis, { key })).toEqual({ ok: false, ageSec: 120 });
    await redis.set(key, String(Date.now() - 119_000), 'EX', 60);
    expect(await checkHeartbeat(redis, { key })).toMatchObject({ ok: true });
  });
});
