import { createHmac } from 'node:crypto';
import { createRedis, type Redis } from '@detaly/config';
import { deleteKeysByPrefix, testKeyPrefix, testRedisUrl } from '@detaly/config/testing';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createSmsGuard, FALLBACK_REASONS, type SmsBudgetState } from '../src';

const SECRET = 'test-session-secret-0123456789abcdef';
const PHONE = '+79123456789';
const MIN = 60_000;
const T0 = Date.parse('2026-10-02T06:00:00Z');

let redis: Redis;
let prefix: string;
let clock: number;

beforeAll(() => {
  redis = createRedis(testRedisUrl());
});
beforeEach(() => {
  prefix = testKeyPrefix();
  clock = T0;
});
afterEach(async () => {
  await deleteKeysByPrefix(redis, prefix);
});
afterAll(async () => {
  await redis.quit();
});

const guard = (budget?: () => SmsBudgetState) =>
  createSmsGuard({
    redis,
    secret: SECRET,
    keyPrefix: prefix,
    now: () => clock,
    ...(budget === undefined ? {} : { budget }),
  });

const at = (minutes: number): void => {
  clock = T0 + minutes * MIN;
};

describe('SMS guard on Redis', () => {
  it('1 per number in 10 minutes: the second SMS is rate limited', async () => {
    const g = guard();
    expect(await g.check(PHONE)).toEqual({ allowed: true });
    at(5);
    const second = await g.check(PHONE);
    expect(second).toMatchObject({ allowed: false, reason: FALLBACK_REASONS.smsRateLimited });
    expect(second.allowed === false && second.retryAfterMs).toBe(5 * MIN);
    // Another number is independent; formatting of the same number is not.
    expect(await g.check('+79120000000')).toEqual({ allowed: true });
    expect(await g.check('7 (912) 345-67-89')).toMatchObject({ allowed: false });
    at(10);
    expect(await g.check(PHONE)).toEqual({ allowed: true });
  });

  it('3 per number in 24 hours: the fourth is rate limited, a day later allowed again', async () => {
    const g = guard();
    for (const minutes of [0, 11, 22]) {
      at(minutes);
      expect(await g.check(PHONE), `t+${minutes}m`).toEqual({ allowed: true });
    }
    at(40);
    expect(await g.check(PHONE)).toMatchObject({
      allowed: false,
      reason: FALLBACK_REASONS.smsRateLimited,
    });
    at(24 * 60 - 1);
    expect(await g.check(PHONE)).toMatchObject({ allowed: false });
    // The first SMS (t+0) has left the day window; the ten-minute window is clear too.
    at(24 * 60 + 10);
    expect(await g.check(PHONE)).toEqual({ allowed: true });
  });

  it('a retry of a granted notification passes without consuming the limit', async () => {
    const g = guard();
    expect(await g.check(PHONE, { dedupeKey: 'evt-1:arrived:sms' })).toEqual({ allowed: true });
    at(1);
    expect(await g.check(PHONE, { dedupeKey: 'evt-1:arrived:sms' })).toEqual({ allowed: true });
    expect(await g.check(PHONE, { dedupeKey: 'evt-2:arrived:sms' })).toMatchObject({
      allowed: false,
      reason: FALLBACK_REASONS.smsRateLimited,
    });
    // The refused notification is not granted: its retry is refused as well.
    expect(await g.check(PHONE, { dedupeKey: 'evt-2:arrived:sms' })).toMatchObject({
      allowed: false,
    });
    // Retries did not spend the daily allowance: two more fit in the day.
    for (const minutes of [11, 22]) {
      at(minutes);
      expect(await g.check(PHONE)).toEqual({ allowed: true });
    }
  });

  it('an exhausted budget stops SMS before the rate windows', async () => {
    let state: SmsBudgetState = 'exhausted';
    const g = guard(() => state);
    expect(await g.check(PHONE)).toEqual({
      allowed: false,
      reason: FALLBACK_REASONS.smsBudgetExhausted,
    });
    state = 'alert';
    expect(await g.check(PHONE)).toEqual({ allowed: true });
  });

  it('Redis keys carry the prefix and an HMAC, never the number', async () => {
    const g = guard();
    await g.check(PHONE, { dedupeKey: 'evt-9:arrived:sms' });
    const keys = await redis.keys(`${prefix}*`);
    expect(keys.length).toBe(3);
    const id = createHmac('sha256', SECRET).update('79123456789').digest('base64url');
    expect(keys.sort()).toEqual(
      [
        `${prefix}sms:rl:10m:${id}`,
        `${prefix}sms:rl:1d:${id}`,
        expect.stringMatching(new RegExp(`^${prefix}sms:grant:[A-Za-z0-9_-]{43}$`)),
      ].sort(),
    );
    for (const key of keys) {
      expect(key).not.toMatch(/912345|3456789/);
      expect(key).not.toContain('evt-9');
    }
    // Values are hit timestamps, not numbers either.
    for (const member of await redis.zrange(`${prefix}sms:rl:1d:${id}`, '0', '-1')) {
      expect(member).not.toContain('3456789');
    }
  });

  it('refuses an empty secret or phone', async () => {
    expect(() => createSmsGuard({ redis, secret: '', keyPrefix: prefix })).toThrow('secret');
    await expect(guard().check('')).rejects.toThrow('phone');
  });
});
