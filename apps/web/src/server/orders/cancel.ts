/**
 * Client cancellation of an order from /o/<token> (docs/phase-1a-implementation.md 7.2,
 * decisions Д3 and Д16). The link token alone is not enough: the client confirms with the last
 * four digits of the order phone, and wrong guesses are limited per order in Redis (5 per hour,
 * fail closed: Redis unavailable means no cancellation).
 *
 * The status change goes through the state machine under a row lock: `select … for update`,
 * resolveTransition(status, 'client_cancelled', ctx), then the order row and one order_events
 * row in the same transaction.
 */
import { timingSafeEqual } from 'node:crypto';
import { slidingWindowHit, type Redis } from '@detaly/config';
import { desc, eq, orderEvents, orders, payments, users, type Executor } from '@detaly/db';
import { phoneLast4, resolveTransition, type OrderStatus } from '@detaly/domain';
import { clientCancelContext, isOrderToken } from './access';

/** Wrong last-4 attempts per order and window (decision Д16). */
export const CANCEL_FAIL_LIMIT = 5;
export const CANCEL_FAIL_WINDOW_MS = 60 * 60_000;

const LAST4_RE = /^\d{4}$/;

export function isLast4(value: unknown): value is string {
  return typeof value === 'string' && LAST4_RE.test(value);
}

/** Redis key of the failure counter of one order (sorted set of attempt timestamps). */
export function cancelFailKey(orderId: string, keyPrefix = ''): string {
  return `${keyPrefix}rl:cancel-fail:${orderId}`;
}

/** Redis could not count attempts: the caller answers 503 and nothing changes. */
export class CancelUnavailableError extends Error {
  override name = 'CancelUnavailableError';
}

export type CancelResult =
  | { kind: 'not_found' }
  | { kind: 'too_many_attempts'; retryAfterSec: number }
  | { kind: 'wrong_digits'; attemptsLeft: number }
  | {
      kind: 'not_cancellable';
      status: OrderStatus;
      reason: 'no_rule' | 'guard_failed';
      failed: string[];
    }
  | { kind: 'cancelled'; orderId: string; number: string; from: OrderStatus };

export interface CancelDeps {
  db: Executor;
  redis: Redis;
  /** Prepended to Redis keys; tests use `test:<uuid>:`. */
  keyPrefix?: string;
  now?: () => Date;
}

async function withRedis<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    throw new CancelUnavailableError('cancel attempt counter unavailable', { cause: error });
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
  const min = `(${nowMs - CANCEL_FAIL_WINDOW_MS}`;
  const count = await redis.zcount(key, min, '+inf');
  if (count < CANCEL_FAIL_LIMIT) return { count, retryAfterSec: 0 };
  const oldest = await redis.zrangebyscore(key, min, '+inf', 'WITHSCORES', 'LIMIT', 0, 1);
  const oldestMs = Number(oldest[1] ?? nowMs);
  const retryMs = Math.max(1_000, oldestMs + CANCEL_FAIL_WINDOW_MS - nowMs);
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
 * Cancels the order of `token` when `last4` matches. Throws CancelUnavailableError when the
 * attempt counter cannot be read or written; database errors propagate.
 */
export async function cancelOrderByToken(
  { db, redis, keyPrefix = '', now = () => new Date() }: CancelDeps,
  { token, last4 }: { token: string; last4: string },
): Promise<CancelResult> {
  if (!isOrderToken(token)) return { kind: 'not_found' };
  const found = await db.query.orders.findFirst({
    where: (t, ops) => ops.eq(t.accessToken, token),
    columns: { id: true },
  });
  if (!found) return { kind: 'not_found' };

  const key = cancelFailKey(found.id, keyPrefix);
  const before = await withRedis(() => recentFailures(redis, key, now().getTime()));
  if (before.count >= CANCEL_FAIL_LIMIT) {
    return { kind: 'too_many_attempts', retryAfterSec: before.retryAfterSec };
  }

  return db.transaction(async (tx): Promise<CancelResult> => {
    const [order] = await tx
      .select({
        id: orders.id,
        number: orders.number,
        status: orders.status,
        scheme: orders.paymentScheme,
        userId: orders.userId,
      })
      .from(orders)
      .where(eq(orders.id, found.id))
      .for('update');
    if (!order) return { kind: 'not_found' };

    const [user] = await tx
      .select({ phone: users.phone })
      .from(users)
      .where(eq(users.id, order.userId));
    if (!last4Matches(last4, user?.phone)) {
      const at = now().getTime();
      const hit = await withRedis(() =>
        slidingWindowHit(redis, {
          key,
          limit: CANCEL_FAIL_LIMIT,
          windowMs: CANCEL_FAIL_WINDOW_MS,
          now: at,
        }),
      );
      if (!hit.allowed) {
        return {
          kind: 'too_many_attempts',
          retryAfterSec: Math.max(1, Math.ceil(hit.retryAfterMs / 1000)),
        };
      }
      return { kind: 'wrong_digits', attemptsLeft: Math.max(0, CANCEL_FAIL_LIMIT - hit.count) };
    }

    const [payment] = await tx
      .select({ status: payments.status })
      .from(payments)
      .where(eq(payments.orderId, order.id))
      .orderBy(desc(payments.createdAt), desc(payments.id))
      .limit(1);
    const ctx = clientCancelContext({
      scheme: order.scheme,
      latestPaymentStatus: payment?.status ?? null,
    });
    const decision = resolveTransition(order.status, 'client_cancelled', ctx);
    if (!decision.ok) {
      return {
        kind: 'not_cancellable',
        status: order.status,
        reason: decision.reason,
        failed: decision.failed,
      };
    }

    const at = now();
    await tx
      .update(orders)
      .set({ status: decision.rule.to, cancelledAt: at, expiresAt: null })
      .where(eq(orders.id, order.id));
    await tx.insert(orderEvents).values({
      orderId: order.id,
      type: 'client_cancelled',
      fromStatus: order.status,
      toStatus: decision.rule.to,
      actorType: 'client',
      actorId: order.userId,
      payload: {},
      createdAt: at,
    });
    return { kind: 'cancelled', orderId: order.id, number: order.number, from: order.status };
  });
}
