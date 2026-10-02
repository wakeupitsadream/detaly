/**
 * Per-client rate limits (PLAN section 1, "Защита"; docs/phase-1a-implementation.md section 8):
 * - search: 20 requests per minute and 300 per 24 hours (protects the Rossko quota);
 * - checkout: 10 POST /api/checkout per hour (each one reprices the cart past the cache);
 * - cancel: 5 POST /api/orders/<token>/cancel per hour (brute force of the phone digits);
 * - cart: 120 writes to /api/cart/** per hour (adding a line may miss the search cache).
 *
 * The bucket key is `rl:<kind>:<window>:<HMAC-SHA256(SESSION_SECRET, subject)>`, where the
 * subject is the IPv4 address or the IPv6 /64 prefix (rateLimitSubject): the IP itself never
 * reaches Redis. Every window uses slidingWindowHit from @detaly/config (atomic Lua).
 */
import { createHmac } from 'node:crypto';
import { slidingWindowHit, type Redis } from '@detaly/config';
import { rateLimitSubject } from './client-ip';

export type RateLimitKind = 'search' | 'checkout' | 'cancel' | 'cart';

/** Name reported in decisions. */
export type RateLimitWindowName = 'minute' | 'hour' | 'day';

export interface RateLimitRule {
  window: RateLimitWindowName;
  /** Segment of the Redis key (`min` keeps the phase 0 search keys). */
  keySegment: 'min' | 'hour' | 'day';
  limit: number;
  windowMs: number;
}

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/**
 * Windows are checked in order and the first rejection stops the walk, so a burst rejected
 * by a short window does not eat into a longer one.
 */
export const RATE_LIMITS = {
  search: [
    { window: 'minute', keySegment: 'min', limit: 20, windowMs: MINUTE_MS },
    { window: 'day', keySegment: 'day', limit: 300, windowMs: DAY_MS },
  ],
  checkout: [{ window: 'hour', keySegment: 'hour', limit: 10, windowMs: HOUR_MS }],
  cancel: [{ window: 'hour', keySegment: 'hour', limit: 5, windowMs: HOUR_MS }],
  cart: [{ window: 'hour', keySegment: 'hour', limit: 120, windowMs: HOUR_MS }],
} as const satisfies Record<RateLimitKind, readonly RateLimitRule[]>;

/** Phase 0 shape of the search limits (kept for existing imports). */
export const SEARCH_LIMITS = {
  minute: { limit: RATE_LIMITS.search[0].limit, windowMs: RATE_LIMITS.search[0].windowMs },
  day: { limit: RATE_LIMITS.search[1].limit, windowMs: RATE_LIMITS.search[1].windowMs },
} as const;

export interface RateLimitDecision {
  allowed: boolean;
  /** 0 when allowed. */
  retryAfterSec: number;
  /** Which window rejected the request. */
  window: RateLimitWindowName | null;
}

export function clientBucket(secret: string, ip: string): string {
  return createHmac('sha256', secret).update(ip).digest('hex').slice(0, 32);
}

/** Redis key of one window of one client bucket (without the optional test prefix). */
export function rateLimitKey(kind: RateLimitKind, rule: RateLimitRule, bucket: string): string {
  return `rl:${kind}:${rule.keySegment}:${bucket}`;
}

export interface RateLimitOptions {
  kind: RateLimitKind;
  secret: string;
  /** Client ip as returned by getClientIp ('local' when the header is not trusted). */
  ip: string;
  /** Prepended to keys; tests use `test:<uuid>:`. */
  keyPrefix?: string;
  now?: number;
}

/** Counts one request of `kind` for the client's bucket. */
export async function hitRateLimit(
  redis: Redis,
  { kind, secret, ip, keyPrefix = '', now = Date.now() }: RateLimitOptions,
): Promise<RateLimitDecision> {
  const bucket = clientBucket(secret, rateLimitSubject(ip));
  const rules: readonly RateLimitRule[] = RATE_LIMITS[kind];
  for (const rule of rules) {
    const hit = await slidingWindowHit(redis, {
      key: `${keyPrefix}${rateLimitKey(kind, rule, bucket)}`,
      limit: rule.limit,
      windowMs: rule.windowMs,
      now,
    });
    if (!hit.allowed) {
      return {
        allowed: false,
        retryAfterSec: Math.max(1, Math.ceil(hit.retryAfterMs / 1000)),
        window: rule.window,
      };
    }
  }
  return { allowed: true, retryAfterSec: 0, window: null };
}

export type SearchRateLimitOptions = Omit<RateLimitOptions, 'kind'>;

/** Counts one search request (phase 0 entry point). */
export function hitSearchRateLimit(
  redis: Redis,
  options: SearchRateLimitOptions,
): Promise<RateLimitDecision> {
  return hitRateLimit(redis, { ...options, kind: 'search' });
}
