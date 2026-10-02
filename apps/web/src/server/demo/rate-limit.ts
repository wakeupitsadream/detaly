/**
 * Per-client rate limits of DEMO_MODE: the same rules, buckets and answers as
 * server/rate-limit.ts, counted in this process's memory instead of Redis. On Vercel every
 * instance counts on its own, which is enough for a demo: the fixtures cost nothing, the limit
 * only keeps a crawler from spinning the search.
 */
import {
  clientBucket,
  RATE_LIMITS,
  rateLimitKey,
  type RateLimitDecision,
  type RateLimitOptions,
  type RateLimitRule,
} from '../rate-limit';
import { rateLimitSubject } from '../client-ip';

/** Most buckets kept; the least recently touched ones are dropped beyond it. */
export const MEMORY_RATE_LIMIT_MAX_KEYS = 10_000;

export interface MemoryRateLimiter {
  hit(options: Omit<RateLimitOptions, 'keyPrefix'>): RateLimitDecision;
}

export function createMemoryRateLimiter(maxKeys = MEMORY_RATE_LIMIT_MAX_KEYS): MemoryRateLimiter {
  /** key -> hit instants inside the window, ascending (Map order = least recently used first). */
  const windows = new Map<string, number[]>();

  function touch(key: string, hits: number[]): void {
    windows.delete(key);
    windows.set(key, hits);
    while (windows.size > maxKeys) {
      const oldest = windows.keys().next();
      if (oldest.done) break;
      windows.delete(oldest.value);
    }
  }

  return {
    hit({ kind, secret, ip, now = Date.now() }) {
      const bucket = clientBucket(secret, rateLimitSubject(ip));
      const rules: readonly RateLimitRule[] = RATE_LIMITS[kind];
      // Check every window before recording, like the Lua script: a rejected request does not
      // eat into the longer windows.
      const current = rules.map((rule) => {
        const key = rateLimitKey(kind, rule, bucket);
        const hits = (windows.get(key) ?? []).filter((at) => at > now - rule.windowMs);
        return { rule, key, hits };
      });
      for (const { rule, key, hits } of current) {
        if (hits.length >= rule.limit) {
          touch(key, hits);
          const oldest = hits[0] ?? now;
          const retryAfterMs = Math.max(1, oldest + rule.windowMs - now);
          return {
            allowed: false,
            retryAfterSec: Math.max(1, Math.ceil(retryAfterMs / 1000)),
            window: rule.window,
          };
        }
      }
      for (const { key, hits } of current) touch(key, [...hits, now]);
      return { allowed: true, retryAfterSec: 0, window: null };
    },
  };
}
