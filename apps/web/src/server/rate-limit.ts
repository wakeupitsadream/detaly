/**
 * Per-client rate limits (PLAN section 1, "Защита"; docs/phase-1a-implementation.md section 8):
 * - search: 20 requests per minute and 300 per 24 hours (protects the Rossko quota);
 * - checkout: 10 POST /api/checkout per hour (each one reprices the cart past the cache);
 * - cancel: 5 POST /api/orders/<token>/cancel per hour (brute force of the phone digits);
 * - cart: 120 writes to /api/cart/** per hour (adding a line may miss the search cache);
 * - pay: 10 POST /api/orders/<token>/pay per hour (each may create a YooKassa payment);
 * - order_action: 20 POST /api/orders/<token>/actions per hour (client decisions, some of them
 *   confirmed by the last 4 phone digits: brute force, docs/phase-1b-implementation.md 15);
 * - link: 20 POST /api/orders/<token>/link per hour (messenger deep links, phase 1C);
 * - install: 20 POST /api/orders/<token>/install and …/install/cancel per hour (phase 1C);
 * - claim: 10 POST /api/orders/<token>/claims per hour (photos, the last 4 phone digits; the
 *   wrong-digits counter of 1A works on top of it);
 * - vin: 5 POST /api/vin per hour and 20 per 24 hours (a form with personal data and photos);
 * - proposal: 30 POST /api/proposals/<token>/take per hour (copies a proposal into the cart);
 * - fit_check: 20 POST /api/fit-checks per 24 hours per client bucket (step 4,
 *   docs/fit-check.md: each one is work for the master); fit_check_cart: 10 per 24 hours per cart,
 *   counted by the handler with the cart id as the subject (hitSubjectRateLimit);
 * - admin_auth: 20 wrong /admin passwords per hour (Basic auth in src/proxy.ts). Only wrong
 *   passwords are hit; while the window is full even the right one is refused (peekRateLimit),
 *   otherwise a brute force would still learn the password from the one answer that differs.
 *
 * The bucket key is `rl:<kind>:<window>:<HMAC-SHA256(SESSION_SECRET, subject)>`, where the
 * subject is the IPv4 address or the IPv6 /64 prefix (rateLimitSubject): the IP itself never
 * reaches Redis. Every window uses slidingWindowHit from @detaly/config (atomic Lua).
 */
import { createHmac } from 'node:crypto';
import { slidingWindowHit, type Redis } from '@detaly/config';
import { FIT_CHECK_REQUESTS_PER_CART_DAY, FIT_CHECK_REQUESTS_PER_IP_DAY } from '@detaly/domain';
import { rateLimitSubject } from './client-ip';

export type RateLimitKind =
  | 'search'
  | 'checkout'
  | 'cancel'
  | 'cart'
  | 'pay'
  | 'order_action'
  | 'admin_auth'
  // phase 1C (docs/phase-1c-implementation.md decision С27)
  | 'link'
  | 'install'
  | 'claim'
  | 'vin'
  | 'proposal'
  // step 4 (docs/fit-check.md)
  | 'fit_check'
  | 'fit_check_cart';

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
  pay: [{ window: 'hour', keySegment: 'hour', limit: 10, windowMs: HOUR_MS }],
  order_action: [{ window: 'hour', keySegment: 'hour', limit: 20, windowMs: HOUR_MS }],
  admin_auth: [{ window: 'hour', keySegment: 'hour', limit: 20, windowMs: HOUR_MS }],
  link: [{ window: 'hour', keySegment: 'hour', limit: 20, windowMs: HOUR_MS }],
  install: [{ window: 'hour', keySegment: 'hour', limit: 20, windowMs: HOUR_MS }],
  claim: [{ window: 'hour', keySegment: 'hour', limit: 10, windowMs: HOUR_MS }],
  vin: [
    { window: 'hour', keySegment: 'hour', limit: 5, windowMs: HOUR_MS },
    { window: 'day', keySegment: 'day', limit: 20, windowMs: DAY_MS },
  ],
  proposal: [{ window: 'hour', keySegment: 'hour', limit: 30, windowMs: HOUR_MS }],
  fit_check: [
    { window: 'day', keySegment: 'day', limit: FIT_CHECK_REQUESTS_PER_IP_DAY, windowMs: DAY_MS },
  ],
  fit_check_cart: [
    { window: 'day', keySegment: 'day', limit: FIT_CHECK_REQUESTS_PER_CART_DAY, windowMs: DAY_MS },
  ],
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

/**
 * Counts one request of `kind` for an arbitrary subject instead of the client ip (step 4: the
 * cart id of the fit check form). The subject is HMAC'ed like an ip: it never reaches Redis as
 * is.
 */
export async function hitSubjectRateLimit(
  redis: Redis,
  {
    kind,
    secret,
    subject,
    keyPrefix = '',
    now = Date.now(),
  }: Omit<RateLimitOptions, 'ip'> & { subject: string },
): Promise<RateLimitDecision> {
  const bucket = clientBucket(secret, `subject:${subject}`);
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

/**
 * Whether the client's bucket of `kind` is full right now, without recording a hit (the
 * /admin gate: a right password is refused while the wrong-password window is full). Same
 * keys and window semantics as slidingWindowHit: hits older than the window do not count.
 */
export async function peekRateLimit(
  redis: Redis,
  { kind, secret, ip, keyPrefix = '', now = Date.now() }: RateLimitOptions,
): Promise<RateLimitDecision> {
  const bucket = clientBucket(secret, rateLimitSubject(ip));
  const rules: readonly RateLimitRule[] = RATE_LIMITS[kind];
  for (const rule of rules) {
    const key = `${keyPrefix}${rateLimitKey(kind, rule, bucket)}`;
    const since = `(${now - rule.windowMs}`;
    const count = await redis.zcount(key, since, '+inf');
    if (count >= rule.limit) {
      const oldest = await redis.zrangebyscore(key, since, '+inf', 'WITHSCORES', 'LIMIT', 0, 1);
      const oldestAt = Number(oldest[1] ?? now);
      const retryAfterMs = Math.max(1, oldestAt + rule.windowMs - now);
      return {
        allowed: false,
        retryAfterSec: Math.max(1, Math.ceil(retryAfterMs / 1000)),
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
