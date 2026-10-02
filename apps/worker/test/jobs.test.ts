import { HEARTBEAT_KEY, HEARTBEAT_TTL_SEC, type Redis } from '@detaly/config';
import { UnrecoverableError, type Job } from 'bullmq';
import { describe, expect, inject, it, vi } from 'vitest';
import type { WorkerDeps } from '../src/deps';
import { createSellerCards } from '../src/bots/seller/cards';
import { PROCESSORS } from '../src/jobs';
import { processHousekeeping } from '../src/jobs/housekeeping';
import { unknownJobMessage } from '../src/jobs/unknown-job';
import { HEARTBEAT_EVERY_MS, PROCESSED_QUEUES, registerSchedulers } from '../src/queues';
import { createTestDeps } from './helpers/test-deps';

function fakeRedis() {
  const set = vi.fn(async (..._args: unknown[]) => 'OK');
  return { redis: { set } as unknown as Redis, set };
}

describe('processHousekeeping', () => {
  it('writes the heartbeat with SET … EX 600', async () => {
    const { redis, set } = fakeRedis();
    const now = new Date('2026-10-02T09:00:00Z');
    const result = await processHousekeeping(
      { name: 'heartbeat' },
      { redis, now: () => now, heartbeatKey: HEARTBEAT_KEY },
    );
    expect(result).toEqual({ heartbeatAt: now.getTime() });
    expect(HEARTBEAT_TTL_SEC).toBe(600);
    expect(set).toHaveBeenCalledWith(HEARTBEAT_KEY, String(now.getTime()), 'EX', 600);
  });

  it('honours the heartbeat key from deps', async () => {
    const { redis, set } = fakeRedis();
    await processHousekeeping(
      { name: 'heartbeat' },
      { redis, now: () => new Date(), heartbeatKey: 'test:x:hb' },
    );
    expect(set.mock.calls[0]?.[0]).toBe('test:x:hb');
  });

  it('fails an unknown job without retries', async () => {
    const { redis } = fakeRedis();
    await expect(
      processHousekeeping({ name: 'vacuum' }, { redis, now: () => new Date(), heartbeatKey: 'k' }),
    ).rejects.toBeInstanceOf(UnrecoverableError);
  });
});

describe('phase 1B processors', () => {
  const job = { name: 'anything', data: {} } as Job;
  const deps = {} as WorkerDeps;

  it('one processor per worked queue', () => {
    expect(Object.keys(PROCESSORS).sort()).toEqual([...PROCESSED_QUEUES].sort());
  });

  it.each(['payments', 'receipts', 'rossko', 'reconciliation', 'notify'] as const)(
    '%s fails an unknown job name without retries',
    async (queue) => {
      const error = await PROCESSORS[queue](job, deps).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(UnrecoverableError);
      expect((error as Error).message).toBe(unknownJobMessage(queue, 'anything'));
    },
  );

  it('notify fails bad data without retries', async () => {
    const bad = await PROCESSORS.notify({ name: 'order', data: {} } as Job, deps).catch(
      (e: unknown) => e,
    );
    expect(bad).toBeInstanceOf(UnrecoverableError);
    expect((bad as Error).message).toBe('notify/order: bad job data');
    const alert = await PROCESSORS.notify({ name: 'alert', data: { text: '' } } as Job, deps).catch(
      (e: unknown) => e,
    );
    expect(alert).toBeInstanceOf(UnrecoverableError);
  });

  it('notify/alert goes through the AlertPort', async () => {
    const calls: unknown[] = [];
    const alerts = { send: async (input: unknown) => void calls.push(input) };
    const result = await PROCESSORS.notify(
      {
        name: 'alert',
        data: { audience: 'owner', text: 'SMS-бюджет', dedupeKey: 'sms-budget:2026-10:80' },
      } as Job,
      { alerts } as unknown as WorkerDeps,
    );
    expect(result).toEqual({ status: 'alerted' });
    expect(calls).toEqual([
      { audience: 'owner', text: 'SMS-бюджет', dedupeKey: 'sms-budget:2026-10:80' },
    ]);
  });

  it('housekeeping jobs other than the heartbeat need full WorkerDeps', async () => {
    const { redis } = fakeRedis();
    const error = await processHousekeeping(
      { name: 'timers' },
      { redis, now: () => new Date(), heartbeatKey: 'k' },
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(UnrecoverableError);
    expect((error as Error).message).toBe('housekeeping timers needs WorkerDeps');
  });

  it('seller cards port: without a bot token a card is skipped, not failed', async () => {
    const warn = vi.fn();
    const logger = { warn } as unknown as WorkerDeps['logger'];
    const cards = createSellerCards({ ...deps, telegram: null, logger });
    await expect(
      cards.post({ orderId: '00000000-0000-7000-8000-000000000000' }),
    ).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledOnce();
  });
});

describe('queues', () => {
  it('processes every queue except dead-letter', () => {
    expect(PROCESSED_QUEUES).toEqual([
      'payments',
      'receipts',
      'rossko',
      'notify',
      'reconciliation',
      'housekeeping',
    ]);
  });

  it('registers the heartbeat Job Scheduler every 30 s', async () => {
    const upsertJobScheduler = vi.fn(async () => ({}));
    await registerSchedulers({ housekeeping: { upsertJobScheduler } as never });
    expect(HEARTBEAT_EVERY_MS).toBe(30_000);
    expect(upsertJobScheduler).toHaveBeenCalledWith(
      'heartbeat',
      { every: 30_000 },
      expect.objectContaining({ name: 'heartbeat' }),
    );
  });
});

describe.skipIf(!inject('workerDatabaseUrl'))('createTestDeps (test/helpers/test-deps.ts)', () => {
  it('runs the heartbeat on full WorkerDeps with test prefixes and recording fakes', async () => {
    const now = new Date('2026-10-02T09:00:00Z');
    const t = await createTestDeps({ now: () => now });
    try {
      expect(t.deps.keyPrefix).toMatch(/^test:[0-9a-f-]{36}:$/);
      expect(t.deps.bullPrefix.startsWith(t.deps.keyPrefix)).toBe(true);
      expect(t.deps.heartbeatKey.startsWith(t.deps.keyPrefix)).toBe(true);
      expect(t.deps.queues.housekeeping.opts.prefix).toBe(t.deps.bullPrefix);
      await PROCESSORS.housekeeping({ name: 'heartbeat', data: {} } as Job, t.deps);
      expect(await t.deps.redis.get(t.deps.heartbeatKey)).toBe(String(now.getTime()));
      const [row] = await t.deps.db.$client<{ one: number }[]>`select 1 as one`;
      expect(row?.one).toBe(1);

      await t.deps.alerts.send({ audience: 'owner', text: 'проверка', dedupeKey: 'k' });
      await t.deps.sellerCards.refresh('order-1');
      t.deps.engine.nudge?.();
      expect(t.fakes.alerts.calls).toEqual([
        { audience: 'owner', text: 'проверка', dedupeKey: 'k' },
      ]);
      expect(t.fakes.sellerCards.calls).toEqual([{ method: 'refresh', orderId: 'order-1' }]);
      expect(t.fakes.nudges.count).toBe(1);
      expect(t.deps.payments).toBeNull();
      expect(t.deps.env.ROSSKO_ALLOW_CHECKOUT).toBe(false);
    } finally {
      await t.close();
    }
  });
});
