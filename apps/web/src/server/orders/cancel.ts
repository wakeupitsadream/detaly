/**
 * Client cancellation of an order from /o/<token> (docs/phase-1a-implementation.md 7.2,
 * decisions Д3 and Д16; phase 1B section 14.5). The link token alone is not enough: the client
 * confirms with the last four digits of the order phone (digits.ts: per-order failure counter in
 * Redis, 5 per hour, fail closed).
 *
 * Phase 1B: the status change goes through the order engine (@detaly/orders applyTransition) in
 * the same transaction that locked the row and checked the digits, so its effects (outbox
 * notifications, the sellers' supplier task of an order that already arrived) are written
 * atomically with the transition instead of the phase 1A `deferredEffects` payload.
 */
import type { Env } from '@detaly/config';
import type { Database } from '@detaly/db';
import type { OrderStatus } from '@detaly/domain';
import { applyTransition, type EngineDeps } from '@detaly/orders';
import { isOrderToken } from './access';
import {
  digitsBlocked,
  DigitsUnavailableError,
  verifyDigitsLocked,
  type DigitsDeps,
} from './digits';

export {
  DIGITS_FAIL_LIMIT as CANCEL_FAIL_LIMIT,
  DIGITS_FAIL_WINDOW_MS as CANCEL_FAIL_WINDOW_MS,
  digitsFailKey as cancelFailKey,
  isLast4,
  last4Matches,
} from './digits';

/** Redis could not count attempts: the caller answers 503 and nothing changes. */
export { DigitsUnavailableError as CancelUnavailableError };

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

export interface CancelDeps extends DigitsDeps {
  db: Database;
  /** Full env: the engine reads settings defaults and receipt codes from it. */
  env: Env;
  /** Wakes the worker's outbox dispatcher after the commit (getEngineDeps().nudge). */
  nudge?: () => void;
}

/** EngineDeps of a request: the engine clock follows the request clock. */
export function engineOf(deps: Pick<CancelDeps, 'db' | 'env' | 'now' | 'nudge'>): EngineDeps {
  return {
    db: deps.db,
    env: deps.env,
    ...(deps.now ? { now: deps.now } : {}),
    ...(deps.nudge ? { nudge: deps.nudge } : {}),
  };
}

/**
 * Cancels the order of `token` when `last4` matches. Throws DigitsUnavailableError when the
 * attempt counter cannot be read or written; database errors propagate.
 */
export async function cancelOrderByToken(
  deps: CancelDeps,
  { token, last4 }: { token: string; last4: string },
): Promise<CancelResult> {
  if (!isOrderToken(token)) return { kind: 'not_found' };
  const found = await deps.db.query.orders.findFirst({
    where: (t, ops) => ops.eq(t.accessToken, token),
    columns: { id: true, number: true, userId: true },
  });
  if (!found) return { kind: 'not_found' };

  // Cheap early answer without taking the row lock; the binding check is the locked one.
  const blocked = await digitsBlocked(deps, found.id);
  if (blocked) return blocked;

  const engine = engineOf(deps);
  const result = await deps.db.transaction(async (tx): Promise<CancelResult> => {
    const check = await verifyDigitsLocked(tx, deps, { orderId: found.id, last4 });
    if (check.kind !== 'ok') return check;
    const applied = await applyTransition(engine, {
      orderId: found.id,
      event: 'client_cancelled',
      actor: { type: 'client', id: found.userId },
      tx,
    });
    if (!applied.ok) {
      if (applied.reason === 'not_found' || applied.status === null) return { kind: 'not_found' };
      return {
        kind: 'not_cancellable',
        status: applied.status,
        reason: applied.reason,
        failed: applied.failed,
      };
    }
    return { kind: 'cancelled', orderId: found.id, number: found.number, from: applied.from };
  });
  if (result.kind === 'cancelled') {
    try {
      deps.nudge?.();
    } catch {
      // best effort (decision Б1): the dispatcher polls anyway
    }
  }
  return result;
}

export { DigitsUnavailableError };
