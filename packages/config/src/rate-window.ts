import { createHash, randomUUID } from 'node:crypto';
import type { Redis } from 'ioredis';

/** Moscow has been UTC+3 without DST since 2014; Rossko's daily quota resets at MSK midnight. */
const MSK_DAY_FORMAT = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Europe/Moscow',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/** Calendar day in Europe/Moscow as 'YYYY-MM-DD' (2026-10-01T20:59:59Z -> '2026-10-01'). */
export function mskDayKey(date: Date): string {
  const parts: Record<string, string> = {};
  for (const part of MSK_DAY_FORMAT.formatToParts(date)) parts[part.type] = part.value;
  return `${parts.year}-${parts.month}-${parts.day}`;
}

// ---------------------------------------------------------------------------
// Script runner: EVALSHA with a fallback to EVAL on NOSCRIPT.
// ---------------------------------------------------------------------------

interface LuaScript {
  source: string;
  sha: string;
}

function lua(source: string): LuaScript {
  return { source, sha: createHash('sha1').update(source).digest('hex') };
}

async function runScript(
  redis: Redis,
  script: LuaScript,
  keys: readonly string[],
  args: readonly (string | number)[],
): Promise<unknown> {
  try {
    return await redis.evalsha(script.sha, keys.length, ...keys, ...args);
  } catch (error) {
    if (error instanceof Error && error.message.includes('NOSCRIPT')) {
      return redis.eval(script.source, keys.length, ...keys, ...args);
    }
    throw error;
  }
}

function toIntTuple(reply: unknown, size: number): number[] {
  if (!Array.isArray(reply) || reply.length !== size) {
    throw new Error(`unexpected Lua reply: ${JSON.stringify(reply)}`);
  }
  return reply.map((value) => Number(value));
}

function assertPositiveInt(name: string, value: number): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive integer, got ${value}`);
  }
}

// ---------------------------------------------------------------------------
// Sliding window (sorted set of hit timestamps)
// ---------------------------------------------------------------------------

/**
 * KEYS[1] window key; ARGV: now(ms), windowMs, limit, member.
 * Hits with score <= now - windowMs fall out of the window. Rejected hits are not recorded,
 * so a client that keeps retrying is not locked out forever.
 * Returns {allowed(0|1), count, retryAfterMs}.
 */
const SLIDING_WINDOW = lua(`
local key = KEYS[1]
local now = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
local limit = tonumber(ARGV[3])
redis.call('ZREMRANGEBYSCORE', key, '-inf', now - window)
local count = redis.call('ZCARD', key)
if count < limit then
  redis.call('ZADD', key, now, ARGV[4])
  redis.call('PEXPIRE', key, window)
  return {1, count + 1, 0}
end
local oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
local retry = window
if oldest[2] then
  retry = tonumber(oldest[2]) + window - now
end
if retry < 1 then
  retry = 1
end
return {0, count, retry}
`);

export interface SlidingWindowOptions {
  /** Full Redis key, e.g. `rl:search:min:<hmac>`. */
  key: string;
  /** Maximum hits inside the window. */
  limit: number;
  windowMs: number;
  /** Injected clock for tests; defaults to Date.now(). */
  now?: number | Date;
}

export interface SlidingWindowResult {
  allowed: boolean;
  /** Hits in the window, including this one when allowed. */
  count: number;
  /** 0 when allowed; otherwise ms until the oldest hit leaves the window. */
  retryAfterMs: number;
}

/** Atomic sliding-window hit: 20 per 60 s lets 20 through and rejects the 21st. */
export async function slidingWindowHit(
  redis: Redis,
  { key, limit, windowMs, now = Date.now() }: SlidingWindowOptions,
): Promise<SlidingWindowResult> {
  assertPositiveInt('limit', limit);
  assertPositiveInt('windowMs', windowMs);
  const nowMs = now instanceof Date ? now.getTime() : now;
  const member = `${nowMs}:${randomUUID()}`;
  const [allowed, count, retryAfterMs] = toIntTuple(
    await runScript(redis, SLIDING_WINDOW, [key], [nowMs, windowMs, limit, member]),
    3,
  );
  return { allowed: allowed === 1, count: count ?? 0, retryAfterMs: retryAfterMs ?? 0 };
}

// ---------------------------------------------------------------------------
// Daily counter (Moscow calendar day)
// ---------------------------------------------------------------------------

/**
 * KEYS[1] day key; ARGV: limit, ttlSec. Increments only when below the limit, so rejected
 * calls do not consume quota. Returns {allowed(0|1), count}.
 */
const DAILY_COUNTER = lua(`
local key = KEYS[1]
local limit = tonumber(ARGV[1])
local current = tonumber(redis.call('GET', key) or '0')
if current >= limit then
  return {0, current}
end
local count = redis.call('INCR', key)
if count == 1 then
  redis.call('EXPIRE', key, tonumber(ARGV[2]))
end
return {1, count}
`);

/** Day keys live 26 h: long enough to read yesterday's total around midnight. */
export const DAILY_COUNTER_TTL_SEC = 26 * 3600;

export interface DailyCounterOptions {
  /** Key prefix; the full key is `${prefix}:${mskDayKey(now)}`, e.g. `rossko:quota:2026-10-02`. */
  prefix: string;
  /**
   * Allow while the count is below this value. Callers apply their own threshold, e.g. the
   * Rossko breaker passes 70% of the daily limit for searches and 100% for critical calls.
   */
  limit: number;
  now?: number | Date;
  ttlSec?: number;
}

export interface DailyCounterResult {
  allowed: boolean;
  /** Count for the day after this call (unchanged when rejected). */
  count: number;
  key: string;
  day: string;
}

export function dailyCounterKey(prefix: string, now: number | Date = Date.now()): string {
  return `${prefix}:${mskDayKey(new Date(now))}`;
}

export async function dailyCounterHit(
  redis: Redis,
  { prefix, limit, now = Date.now(), ttlSec = DAILY_COUNTER_TTL_SEC }: DailyCounterOptions,
): Promise<DailyCounterResult> {
  assertPositiveInt('limit', limit);
  assertPositiveInt('ttlSec', ttlSec);
  const day = mskDayKey(new Date(now));
  const key = `${prefix}:${day}`;
  const [allowed, count] = toIntTuple(
    await runScript(redis, DAILY_COUNTER, [key], [limit, ttlSec]),
    2,
  );
  return { allowed: allowed === 1, count: count ?? 0, key, day };
}

/** Current count for the Moscow day of `now` without incrementing. */
export async function dailyCounterGet(
  redis: Redis,
  { prefix, now = Date.now() }: Pick<DailyCounterOptions, 'prefix' | 'now'>,
): Promise<number> {
  const raw = await redis.get(dailyCounterKey(prefix, now));
  return raw === null ? 0 : Number(raw);
}
