/**
 * Confirmation of destructive client actions on /o/<token> by the last four digits of the order
 * phone (PLAN section 1; phase 1A decision Д16, phase 1B decision Б24). Shared by the 1A
 * cancellation (POST /api/orders/<token>/cancel) and the 1B actions «Вернуть деньги»,
 * «Отказаться от заказа», «Отменить позицию» (POST /api/orders/<token>/actions): one failure
 * counter per order in Redis (5 per hour), fail closed (Redis unavailable means no action).
 *
 * The comparison runs under the order row lock (`select … for update`), so parallel guesses of
 * one order are serialized and none of them reaches the comparison after the fifth failure.
 */
import { timingSafeEqual } from 'node:crypto';
import { slidingWindowHit, type Redis } from '@detaly/config';
import { eq, orders, users, type Executor } from '@detaly/db';
import { phoneLast4 } from '@detaly/domain';

/** Wrong last-4 attempts per order and window (decision Д16). */
export const DIGITS_FAIL_LIMIT = 5;
export const DIGITS_FAIL_WINDOW_MS = 60 * 60_000;

const LAST4_RE = /^\d{4}$/;

export function isLast4(value: unknown): value is string {
  return typeof value === 'string' && LAST4_RE.test(value);
}

/**
 * Redis key of the failure counter of one order (sorted set of attempt timestamps). The name
 * stays the one of phase 1A: every digit-confirmed action of an order spends the same counter.
 */
export function digitsFailKey(orderId: string, keyPrefix = ''): string {
  return `${keyPrefix}rl:cancel-fail:${orderId}`;
}

/** Redis could not count attempts: the caller answers 503 and nothing changes. */
export class DigitsUnavailableError extends Error {
  override name = 'DigitsUnavailableError';
}

export interface DigitsDeps {
  redis: Redis;
  /** Prepended to Redis keys; tests use `test:<uuid>:`. */
  keyPrefix?: string;
  now?: () => Date;
}

export type DigitsCheck =
  | { kind: 'ok' }
  | { kind: 'not_found' }
  | { kind: 'too_many_attempts'; retryAfterSec: number }
  | { kind: 'wrong_digits'; attemptsLeft: number };

async function withRedis<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    throw new DigitsUnavailableError('digit attempt counter unavailable', { cause: error });
  }
}

/**
 * Failures inside the window and when the oldest one leaves it. Same window semantics as
 * slidingWindowHit: a hit with score <= now - window has expired.
 */
async function recentFailures(
  redis: Redis,
  key: string,
  nowMs: number,
): Promise<{ count: number; retryAfterSec: number }> {
  const min = `(${nowMs - DIGITS_FAIL_WINDOW_MS}`;
  const count = await redis.zcount(key, min, '+inf');
  if (count < DIGITS_FAIL_LIMIT) return { count, retryAfterSec: 0 };
  const oldest = await redis.zrangebyscore(key, min, '+inf', 'WITHSCORES', 'LIMIT', 0, 1);
  const oldestMs = Number(oldest[1] ?? nowMs);
  const retryMs = Math.max(1_000, oldestMs + DIGITS_FAIL_WINDOW_MS - nowMs);
  return { count, retryAfterSec: Math.ceil(retryMs / 1000) };
}

/**
 * Constant-time comparison of the entered digits with the order phone. An anonymized phone
 * (`anon:<id>`) or anything that is not E.164 never matches.
 */
export function last4Matches(entered: string, phone: string | null | undefined): boolean {
  if (!isLast4(entered) || typeof phone !== 'string' || !/^\+\d{5,15}$/.test(phone)) {
    return false;
  }
  const expected = Buffer.from(phoneLast4(phone));
  const given = Buffer.from(entered);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

/**
 * Cheap answer before any lock: the order already used up its attempts. Throws
 * DigitsUnavailableError when Redis cannot be read.
 */
export async function digitsBlocked(
  { redis, keyPrefix = '', now = () => new Date() }: DigitsDeps,
  orderId: string,
): Promise<Extract<DigitsCheck, { kind: 'too_many_attempts' }> | null> {
  const key = digitsFailKey(orderId, keyPrefix);
  const before = await withRedis(() => recentFailures(redis, key, now().getTime()));
  return before.count >= DIGITS_FAIL_LIMIT
    ? { kind: 'too_many_attempts', retryAfterSec: before.retryAfterSec }
    : null;
}

/**
 * Locks the order row in `tx` and compares `last4` with the client's phone, counting a wrong
 * guess. The lock stays with the caller's transaction: a transition applied in the same `tx`
 * (cancel.ts) sees the order exactly as checked. Throws DigitsUnavailableError when Redis fails.
 */
export async function verifyDigitsLocked(
  tx: Executor,
  { redis, keyPrefix = '', now = () => new Date() }: DigitsDeps,
  { orderId, last4 }: { orderId: string; last4: string },
): Promise<DigitsCheck> {
  const [order] = await tx
    .select({ id: orders.id, userId: orders.userId })
    .from(orders)
    .where(eq(orders.id, orderId))
    .for('update');
  if (!order) return { kind: 'not_found' };

  // Attempts of one order are serialized by the row lock above, so the counter read here is
  // the one every earlier attempt already wrote to (decision Д16).
  const key = digitsFailKey(order.id, keyPrefix);
  const locked = await withRedis(() => recentFailures(redis, key, now().getTime()));
  if (locked.count >= DIGITS_FAIL_LIMIT) {
    return { kind: 'too_many_attempts', retryAfterSec: locked.retryAfterSec };
  }

  const [user] = await tx
    .select({ phone: users.phone })
    .from(users)
    .where(eq(users.id, order.userId));
  if (last4Matches(last4, user?.phone)) return { kind: 'ok' };

  const hit = await withRedis(() =>
    slidingWindowHit(redis, {
      key,
      limit: DIGITS_FAIL_LIMIT,
      windowMs: DIGITS_FAIL_WINDOW_MS,
      now: now().getTime(),
    }),
  );
  if (!hit.allowed) {
    return {
      kind: 'too_many_attempts',
      retryAfterSec: Math.max(1, Math.ceil(hit.retryAfterMs / 1000)),
    };
  }
  return { kind: 'wrong_digits', attemptsLeft: Math.max(0, DIGITS_FAIL_LIMIT - hit.count) };
}
