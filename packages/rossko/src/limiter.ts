/**
 * Rossko call limiter in Redis, shared by web and worker:
 * - per-minute sliding window (sorted set of call timestamps), ROSSKO_RPM_LIMIT;
 * - daily counter per Moscow calendar day (`rossko:quota:<YYYY-MM-DD>`, TTL 26 h),
 *   ROSSKO_DAILY_LIMIT, with a breaker at ROSSKO_QUOTA_BREAKER_PCT for `search` calls;
 *   `critical` calls (checkout, recheck, orders) may use the quota up to 100%.
 *
 * Both checks and both writes happen in one Lua script, so a call rejected by one limit does
 * not consume the other, and rejected calls are not recorded at all.
 */
import { createHash, randomUUID } from 'node:crypto';
import { DAILY_COUNTER_TTL_SEC, mskDayKey } from '@detaly/config';
import type { Redis } from 'ioredis';
import { QuotaBreakerError, RosskoRateLimitError } from './errors';
import type {
  AcquireOptions,
  AcquireResult,
  CallPriority,
  QuotaStatus,
  RosskoLimiter,
  TryAcquireResult,
} from './types';

export const WINDOW_MS = 60_000;

export interface RosskoLimiterOptions {
  /** Calls per sliding minute (ROSSKO_RPM_LIMIT, 250). */
  rpm: number;
  /** Calls per Moscow day (ROSSKO_DAILY_LIMIT, 90000). */
  daily: number;
  /** Search calls stop at this share of `daily` (ROSSKO_QUOTA_BREAKER_PCT, 70). */
  breakerPct: number;
  /** Prepended to every key; tests use `test:<uuid>:`. Default ''. */
  keyPrefix?: string;
  /** Default for acquire({maxWaitMs}). */
  maxWaitMs?: number;
  /** Injected clock (ms). */
  now?: () => number;
  /** Injected sleep; tests advance the fake clock here. */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * KEYS: window key, day key. ARGV: now, windowMs, rpm, dayLimit, ttlSec, member.
 * Returns {status, dayCount, waitMs}: status 1 = allowed, 0 = window full, 2 = day limit.
 */
const ACQUIRE_LUA = `
local now = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
local rpm = tonumber(ARGV[3])
local day_limit = tonumber(ARGV[4])
local day = tonumber(redis.call('GET', KEYS[2]) or '0')
if day >= day_limit then
  return {2, day, 0}
end
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now - window)
local count = redis.call('ZCARD', KEYS[1])
if count >= rpm then
  local oldest = redis.call('ZRANGE', KEYS[1], 0, 0, 'WITHSCORES')
  local wait = window
  if oldest[2] then
    wait = tonumber(oldest[2]) + window - now
  end
  if wait < 1 then
    wait = 1
  end
  return {0, day, wait}
end
redis.call('ZADD', KEYS[1], now, ARGV[6])
redis.call('PEXPIRE', KEYS[1], window)
local day_count = redis.call('INCR', KEYS[2])
if redis.call('TTL', KEYS[2]) < 0 then
  redis.call('EXPIRE', KEYS[2], tonumber(ARGV[5]))
end
return {1, day_count, 0}
`;
const ACQUIRE_SHA = createHash('sha1').update(ACQUIRE_LUA).digest('hex');

function assertPositiveInt(name: string, value: number): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive integer, got ${value}`);
  }
}

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function createRosskoLimiter(redis: Redis, options: RosskoLimiterOptions): RosskoLimiter {
  assertPositiveInt('rpm', options.rpm);
  assertPositiveInt('daily', options.daily);
  if (!Number.isInteger(options.breakerPct) || options.breakerPct < 1 || options.breakerPct > 100) {
    throw new RangeError(`breakerPct must be 1..100, got ${options.breakerPct}`);
  }
  const prefix = options.keyPrefix ?? '';
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? realSleep;
  const defaultMaxWaitMs = options.maxWaitMs ?? 10_000;
  // Integer math: 90000 * 70 / 100 = 63000.
  const breakerLimit = Math.max(1, Math.floor((options.daily * options.breakerPct) / 100));
  const windowKey = `${prefix}rossko:rpm`;
  const dayKey = (at: number) => `${prefix}rossko:quota:${mskDayKey(new Date(at))}`;

  async function runAcquire(at: number, dayLimit: number): Promise<number[]> {
    const keys = [windowKey, dayKey(at)];
    const args = [
      at,
      WINDOW_MS,
      options.rpm,
      dayLimit,
      DAILY_COUNTER_TTL_SEC,
      `${at}:${randomUUID()}`,
    ];
    let reply: unknown;
    try {
      reply = await redis.evalsha(ACQUIRE_SHA, keys.length, ...keys, ...args);
    } catch (error) {
      if (!(error instanceof Error && error.message.includes('NOSCRIPT'))) throw error;
      reply = await redis.eval(ACQUIRE_LUA, keys.length, ...keys, ...args);
    }
    if (!Array.isArray(reply) || reply.length !== 3) {
      throw new Error(`unexpected limiter reply: ${JSON.stringify(reply)}`);
    }
    return reply.map(Number);
  }

  function limitFor(priority: CallPriority): number {
    return priority === 'search' ? breakerLimit : options.daily;
  }

  async function tryAcquire({ priority }: { priority: CallPriority }): Promise<TryAcquireResult> {
    const [status = 0, dailyCount = 0, waitMs = 0] = await runAcquire(now(), limitFor(priority));
    if (status === 1) return { allowed: true, dailyCount };
    if (status === 2) {
      const reason = dailyCount >= options.daily ? 'exhausted' : 'breaker';
      return { allowed: false, reason, waitMs: 0, dailyCount };
    }
    return { allowed: false, reason: 'rate', waitMs, dailyCount };
  }

  return {
    tryAcquire,

    async acquire({
      priority,
      maxWaitMs = defaultMaxWaitMs,
    }: AcquireOptions): Promise<AcquireResult> {
      const startedAt = now();
      for (;;) {
        const result = await tryAcquire({ priority });
        if (result.allowed) return { waitedMs: now() - startedAt, dailyCount: result.dailyCount };
        if (result.reason !== 'rate') {
          throw new QuotaBreakerError(
            result.reason === 'breaker'
              ? `Rossko quota breaker: ${result.dailyCount}/${options.daily} calls today, searches stop at ${breakerLimit}`
              : `Rossko daily quota exhausted: ${result.dailyCount}/${options.daily}`,
            {
              reason: result.reason,
              priority,
              dailyCount: result.dailyCount,
              limit: limitFor(priority),
            },
          );
        }
        const waited = now() - startedAt;
        if (waited + result.waitMs > maxWaitMs) throw new RosskoRateLimitError(result.waitMs);
        await sleep(result.waitMs);
      }
    },

    async status(): Promise<QuotaStatus> {
      const at = now();
      const raw = await redis.get(dayKey(at));
      const dailyCount = raw === null ? 0 : Number(raw);
      return {
        day: mskDayKey(new Date(at)),
        dailyCount,
        dailyLimit: options.daily,
        breakerLimit,
        breakerOpen: dailyCount >= breakerLimit,
        exhausted: dailyCount >= options.daily,
      };
    },
  };
}

/** Limiter that always allows; only for fixtures mode and unit tests. */
export function createUnlimitedLimiter(): RosskoLimiter {
  return {
    acquire: () => Promise.resolve({ waitedMs: 0, dailyCount: 0 }),
    tryAcquire: () => Promise.resolve({ allowed: true, dailyCount: 0 }),
    status: () =>
      Promise.resolve({
        day: mskDayKey(new Date()),
        dailyCount: 0,
        dailyLimit: Number.MAX_SAFE_INTEGER,
        breakerLimit: Number.MAX_SAFE_INTEGER,
        breakerOpen: false,
        exhausted: false,
      }),
  };
}
