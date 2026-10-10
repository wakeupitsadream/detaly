// Real BullMQ against the shared Redis 7: the Job Schedulers fire the heartbeat job at once and
// the housekeeping Worker writes the key with a TTL. Keys live under a `test:<uuid>:` prefix.
import {
  createLogger,
  createRedis,
  createWorkerRedis,
  HEARTBEAT_TTL_SEC,
  type Redis,
} from '@detaly/config';
import { deleteKeysByPrefix, testKeyPrefix, testRedisUrl } from '@detaly/config/testing';
import type { Worker } from 'bullmq';
import { afterAll, beforeAll, describe, expect, inject, it, vi } from 'vitest';
import { checkHeartbeat } from '../src/health';
import { registerSchedulers, SCHEDULER_TZ } from '../src/queues';
import { createWorkers } from '../src/workers';
import { createTestDeps, type TestDeps } from './helpers/test-deps';

describe.skipIf(!inject('workerDatabaseUrl'))('heartbeat via the Job Scheduler', () => {
  let t: TestDeps;
  let workerRedis: Redis;
  let workers: Worker[];

  beforeAll(async () => {
    t = await createTestDeps();
    workerRedis = createWorkerRedis(testRedisUrl());
    workers = createWorkers({
      connection: workerRedis,
      logger: createLogger('worker-test', { level: 'silent' }),
      deps: t.deps,
    });
  });

  afterAll(async () => {
    await Promise.all(workers.map((w) => w.close()));
    await t.close();
    await workerRedis.quit();
  });

  it('uses RESP2 connections, workers with maxRetriesPerRequest: null', () => {
    expect(t.deps.redis.options.protocol).toBe(2);
    expect(workerRedis.options.protocol).toBe(2);
    expect(workerRedis.options.maxRetriesPerRequest).toBeNull();
  });

  it('writes the heartbeat key with a TTL', async () => {
    const { redis, heartbeatKey, queues } = t.deps;
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
  });

  it('declares every scheduler of phase 1B, idempotently', async () => {
    const { queues } = t.deps;
    await registerSchedulers(queues);
    await registerSchedulers(queues);

    const housekeeping = await queues.housekeeping.getJobSchedulers();
    const byKey = Object.fromEntries(housekeeping.map((s) => [s.key, s]));
    expect(Object.keys(byKey).sort()).toEqual(
      [
        'deferred-1a',
        'finance-reminders',
        'fit-checks',
        'heartbeat',
        'month-close',
        'price-check',
        'reminders',
        'retention',
        'reviews-check',
        'sms-budget',
        'timers',
      ].sort(),
    );
    expect(byKey['heartbeat']).toMatchObject({ name: 'heartbeat', every: 30_000 });
    expect(byKey['timers']).toMatchObject({ every: 60_000 });
    expect(byKey['reminders']).toMatchObject({ every: 900_000 });
    expect(byKey['sms-budget']).toMatchObject({ every: 3_600_000 });
    expect(byKey['deferred-1a']).toMatchObject({ every: 600_000 });
    // phase 1C: VIN photo retention, daily at 04:40 local
    expect(byKey['retention']).toMatchObject({ pattern: '40 4 * * *', tz: SCHEDULER_TZ });
    // step 2: the weekly price check, Mondays at 10:00 local
    expect(byKey['price-check']).toMatchObject({ pattern: '0 10 * * 1', tz: SCHEDULER_TZ });
    // step 3: the weekly reviews check, Mondays at 10:05 local
    expect(byKey['reviews-check']).toMatchObject({ pattern: '5 10 * * 1', tz: SCHEDULER_TZ });
    // step 4: fit checks, every 5 minutes
    expect(byKey['fit-checks']).toMatchObject({ every: 300_000 });
    // step 7: the month close on the 1st at 09:00 local, the finance reminders daily at 09:10
    expect(byKey['month-close']).toMatchObject({ pattern: '0 9 1 * *', tz: SCHEDULER_TZ });
    expect(byKey['finance-reminders']).toMatchObject({ pattern: '10 9 * * *', tz: SCHEDULER_TZ });

    const reconciliation = await queues.reconciliation.getJobSchedulers();
    const rec = Object.fromEntries(reconciliation.map((s) => [s.key, s]));
    expect(Object.keys(rec).sort()).toEqual(['nightly', 'sweep']);
    expect(rec['sweep']).toMatchObject({ every: 600_000 });
    expect(rec['nightly']).toMatchObject({ pattern: '15 3 * * *', tz: SCHEDULER_TZ });
    expect(await queues.housekeeping.getJobSchedulersCount()).toBe(11);
  });
});

describe('checkHeartbeat', () => {
  it('is not ok without a key or with a stale one', async () => {
    const prefix = testKeyPrefix();
    const redis = createRedis(testRedisUrl());
    try {
      const key = `${prefix}stale`;
      expect(await checkHeartbeat(redis, { key })).toEqual({ ok: false, ageSec: null });
      await redis.set(key, String(Date.now() - 120_000), 'EX', 60);
      expect(await checkHeartbeat(redis, { key })).toEqual({ ok: false, ageSec: 120 });
      await redis.set(key, String(Date.now() - 119_000), 'EX', 60);
      expect(await checkHeartbeat(redis, { key })).toMatchObject({ ok: true });
    } finally {
      await deleteKeysByPrefix(redis, prefix);
      await redis.quit();
    }
  });
});
