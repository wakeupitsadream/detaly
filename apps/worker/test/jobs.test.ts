import { HEARTBEAT_KEY, HEARTBEAT_TTL_SEC, type Redis } from '@detaly/config';
import { UnrecoverableError } from 'bullmq';
import { describe, expect, it, vi } from 'vitest';
import { processHousekeeping } from '../src/jobs/housekeeping';
import { processStub } from '../src/jobs/stub';
import { HEARTBEAT_EVERY_MS, PROCESSED_QUEUES, registerSchedulers } from '../src/queues';

function fakeRedis() {
  const set = vi.fn(async (..._args: unknown[]) => 'OK');
  return { redis: { set } as unknown as Redis, set };
}

describe('processHousekeeping', () => {
  it('writes the heartbeat with SET … EX 600', async () => {
    const { redis, set } = fakeRedis();
    const now = new Date('2026-10-02T09:00:00Z');
    const result = await processHousekeeping({ name: 'heartbeat' }, { redis, now: () => now });
    expect(result).toEqual({ heartbeatAt: now.getTime() });
    expect(HEARTBEAT_TTL_SEC).toBe(600);
    expect(set).toHaveBeenCalledWith(HEARTBEAT_KEY, String(now.getTime()), 'EX', 600);
  });

  it('honours a custom heartbeat key', async () => {
    const { redis, set } = fakeRedis();
    await processHousekeeping({ name: 'heartbeat' }, { redis, heartbeatKey: 'test:x:hb' });
    expect(set.mock.calls[0]?.[0]).toBe('test:x:hb');
  });

  it('fails an unknown job without retries', async () => {
    const { redis } = fakeRedis();
    await expect(processHousekeeping({ name: 'vacuum' }, { redis })).rejects.toBeInstanceOf(
      UnrecoverableError,
    );
  });
});

describe('processStub', () => {
  it("throws UnrecoverableError('phase 0')", async () => {
    const error = await processStub({ name: 'anything' }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(UnrecoverableError);
    expect((error as Error).message).toBe('phase 0');
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
