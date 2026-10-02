import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Redis } from 'ioredis';
import { HEARTBEAT_TTL_SEC, readHeartbeatAgeSec, writeHeartbeat } from '../src/heartbeat';
import { createRedis } from '../src/redis';
import { deleteKeysByPrefix, testKeyPrefix, testRedisUrl } from '../src/testing';

let redis: Redis;
const prefix = testKeyPrefix();

beforeAll(() => {
  redis = createRedis(testRedisUrl());
});

afterAll(async () => {
  await deleteKeysByPrefix(redis, prefix);
  await redis.quit();
});

describe('heartbeat (real Redis)', () => {
  it('returns null when absent', async () => {
    expect(await readHeartbeatAgeSec(redis, { key: `${prefix}missing` })).toBeNull();
  });

  it('writes with TTL and reports age in whole seconds', async () => {
    const key = `${prefix}heartbeat`;
    const at = new Date('2026-10-02T10:00:00Z');
    await writeHeartbeat(redis, { key, now: at });
    const ttl = await redis.ttl(key);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(HEARTBEAT_TTL_SEC);
    expect(
      await readHeartbeatAgeSec(redis, { key, now: new Date('2026-10-02T10:00:42.900Z') }),
    ).toBe(42);
    expect(await readHeartbeatAgeSec(redis, { key, now: new Date('2026-10-02T09:59:00Z') })).toBe(
      0,
    );
  });

  it('treats garbage as absent', async () => {
    const key = `${prefix}garbage`;
    await redis.set(key, 'not-a-number', 'EX', 60);
    expect(await readHeartbeatAgeSec(redis, { key })).toBeNull();
  });
});
