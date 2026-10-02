/**
 * Search rate limit (PLAN section 1, "Защита"): 20 requests per minute and 300 per 24 hours
 * per client. The bucket key is HMAC-SHA256(SESSION_SECRET, ip): the IP itself never reaches
 * Redis. Both windows use slidingWindowHit from @detaly/config (atomic Lua).
 */
import { createHmac } from 'node:crypto';
import { slidingWindowHit, type Redis } from '@detaly/config';

export const SEARCH_LIMITS = {
  minute: { limit: 20, windowMs: 60_000 },
  day: { limit: 300, windowMs: 24 * 60 * 60_000 },
} as const;

export interface RateLimitDecision {
  allowed: boolean;
  /** 0 when allowed. */
  retryAfterSec: number;
  /** Which window rejected the request. */
  window: 'minute' | 'day' | null;
}

export function clientBucket(secret: string, ip: string): string {
  return createHmac('sha256', secret).update(ip).digest('hex').slice(0, 32);
}

export interface SearchRateLimitOptions {
  secret: string;
  ip: string;
  /** Prepended to keys; tests use `test:<uuid>:`. */
  keyPrefix?: string;
  now?: number;
}

/**
 * Counts one search request. The minute window is checked first, so a burst rejected per
 * minute does not eat into the daily allowance.
 */
export async function hitSearchRateLimit(
  redis: Redis,
  { secret, ip, keyPrefix = '', now = Date.now() }: SearchRateLimitOptions,
): Promise<RateLimitDecision> {
  const bucket = clientBucket(secret, ip);
  const minute = await slidingWindowHit(redis, {
    key: `${keyPrefix}rl:search:min:${bucket}`,
    ...SEARCH_LIMITS.minute,
    now,
  });
  if (!minute.allowed) {
    return {
      allowed: false,
      retryAfterSec: Math.max(1, Math.ceil(minute.retryAfterMs / 1000)),
      window: 'minute',
    };
  }
  const day = await slidingWindowHit(redis, {
    key: `${keyPrefix}rl:search:day:${bucket}`,
    ...SEARCH_LIMITS.day,
    now,
  });
  if (!day.allowed) {
    return {
      allowed: false,
      retryAfterSec: Math.max(1, Math.ceil(day.retryAfterMs / 1000)),
      window: 'day',
    };
  }
  return { allowed: true, retryAfterSec: 0, window: null };
}
