/**
 * In-memory twins of the Redis search cache and limiter, for the storefront demo without Redis
 * (DEMO_MODE, docs/design.md section 5). Same contracts and the same semantics, per process:
 * - createMemorySearchCache: TTL per entry, bounded number of entries (oldest evicted first);
 * - createMemoryLimiter: per-minute sliding window and a daily counter per Moscow day with the
 *   breaker for `search` calls, exactly as createRosskoLimiter.
 *
 * Never use these where several processes share a quota (live Rossko): each instance counts
 * only its own calls.
 */
import { mskDayKey } from '@detaly/config';
import { SEARCH_CACHE_TTL_SEC, type CachedSearch, type SearchCache } from './cache';
import { QuotaBreakerError, RosskoRateLimitError } from './errors';
import { WINDOW_MS, type RosskoLimiterOptions } from './limiter';
import type {
  AcquireOptions,
  AcquireResult,
  CallPriority,
  QuotaStatus,
  RosskoLimiter,
  TryAcquireResult,
} from './types';

/** Default cap of cached articles per process. */
export const MEMORY_CACHE_MAX_ENTRIES = 500;

export interface MemorySearchCacheOptions {
  ttlSec?: number;
  keyPrefix?: string;
  /** Oldest entries are evicted beyond this many keys. */
  maxEntries?: number;
  /** Injected clock (ms). */
  now?: () => number;
}

export function createMemorySearchCache(options: MemorySearchCacheOptions = {}): SearchCache {
  const ttlSec = options.ttlSec ?? SEARCH_CACHE_TTL_SEC;
  const prefix = options.keyPrefix ?? '';
  const maxEntries = Math.max(1, options.maxEntries ?? MEMORY_CACHE_MAX_ENTRIES);
  const now = options.now ?? Date.now;
  // Map keeps insertion order: re-set entries move to the end, the first one is the oldest.
  const entries = new Map<string, { json: string; expiresAt: number }>();

  return {
    key(articleNorm, deliveryId) {
      return `${prefix}rossko:search:v2:${articleNorm}:${deliveryId ?? '-'}`;
    },
    get(key) {
      const entry = entries.get(key);
      if (entry === undefined) return Promise.resolve(null);
      if (entry.expiresAt <= now()) {
        entries.delete(key);
        return Promise.resolve(null);
      }
      // A copy, like a Redis round trip: callers may not mutate the cached value.
      return Promise.resolve(JSON.parse(entry.json) as CachedSearch);
    },
    set(key, value, entryTtlSec) {
      entries.delete(key);
      entries.set(key, {
        json: JSON.stringify(value),
        expiresAt: now() + (entryTtlSec ?? ttlSec) * 1000,
      });
      while (entries.size > maxEntries) {
        const oldest = entries.keys().next();
        if (oldest.done) break;
        entries.delete(oldest.value);
      }
      return Promise.resolve();
    },
  };
}

export type MemoryLimiterOptions = Omit<RosskoLimiterOptions, 'keyPrefix'>;

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function assertPositiveInt(name: string, value: number): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive integer, got ${value}`);
  }
}

export function createMemoryLimiter(options: MemoryLimiterOptions): RosskoLimiter {
  assertPositiveInt('rpm', options.rpm);
  assertPositiveInt('daily', options.daily);
  if (!Number.isInteger(options.breakerPct) || options.breakerPct < 1 || options.breakerPct > 100) {
    throw new RangeError(`breakerPct must be 1..100, got ${options.breakerPct}`);
  }
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? realSleep;
  const defaultMaxWaitMs = options.maxWaitMs ?? 10_000;
  const breakerLimit = Math.max(1, Math.floor((options.daily * options.breakerPct) / 100));
  /** Call instants inside the sliding minute, ascending. */
  let window: number[] = [];
  let day = { key: '', count: 0 };

  function dayCount(at: number): number {
    const key = mskDayKey(new Date(at));
    if (day.key !== key) day = { key, count: 0 };
    return day.count;
  }

  function limitFor(priority: CallPriority): number {
    return priority === 'search' ? breakerLimit : options.daily;
  }

  function tryAcquireNow({ priority }: { priority: CallPriority }): TryAcquireResult {
    const at = now();
    const count = dayCount(at);
    if (count >= limitFor(priority)) {
      const reason = count >= options.daily ? 'exhausted' : 'breaker';
      return { allowed: false, reason, waitMs: 0, dailyCount: count };
    }
    window = window.filter((t) => t > at - WINDOW_MS);
    if (window.length >= options.rpm) {
      const oldest = window[0] ?? at;
      return {
        allowed: false,
        reason: 'rate',
        waitMs: Math.max(1, oldest + WINDOW_MS - at),
        dailyCount: count,
      };
    }
    window.push(at);
    day.count = count + 1;
    return { allowed: true, dailyCount: day.count };
  }

  return {
    tryAcquire: (args) => Promise.resolve(tryAcquireNow(args)),

    async acquire({
      priority,
      maxWaitMs = defaultMaxWaitMs,
    }: AcquireOptions): Promise<AcquireResult> {
      const startedAt = now();
      for (;;) {
        const result = tryAcquireNow({ priority });
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

    status(): Promise<QuotaStatus> {
      const at = now();
      const dailyCount = dayCount(at);
      return Promise.resolve({
        day: mskDayKey(new Date(at)),
        dailyCount,
        dailyLimit: options.daily,
        breakerLimit,
        breakerOpen: dailyCount >= breakerLimit,
        exhausted: dailyCount >= options.daily,
      });
    },
  };
}
