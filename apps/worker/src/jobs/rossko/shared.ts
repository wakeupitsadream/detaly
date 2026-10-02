// Helpers shared by the rossko queue jobs (recheck, checkout, recover).
import type { Env } from '@detaly/config';
import { isUuid, type ActorRef } from '@detaly/orders';
import { UnrecoverableError, type Job } from 'bullmq';
import type { WorkerDeps } from '../../deps';

/** The rossko jobs act as the system (rules supplier_* accept `system`). */
export const SYSTEM_ACTOR: ActorRef = { type: 'system', id: 'rossko', staffRole: null };

/**
 * Minimum delay before the recovery lookup after an ambiguous GetCheckout failure (decision
 * Б14): Rossko may list a fresh order with a lag. See recoverDelayMs for the in-flight case.
 */
export const RECOVER_DELAY_MS = 60_000;

/**
 * How long a critical Rossko call may wait for the per-minute limiter before it is sent: the
 * default `criticalMaxWaitMs` of createRosskoClient. The claim (`called_at`) is committed before
 * that wait, so a stalled run may reach Rossko this long plus ROSSKO_TIMEOUT_MS after it.
 */
export const CRITICAL_LIMITER_WAIT_MS = 60_000;

/** Slack on top of the limiter wait and the call timeout (clock skew, slow commit). */
const RECOVER_SLACK_MS = 15_000;

/**
 * Delay of rossko/recover after the claim: at least RECOVER_DELAY_MS, and long enough for a
 * run that is still waiting for the limiter or for its GetCheckout answer to finish first, so
 * the lookup does not read "not found" for an order that is about to be created.
 */
export function recoverDelayMs(env: Pick<Env, 'ROSSKO_TIMEOUT_MS'>): number {
  return Math.max(
    RECOVER_DELAY_MS,
    CRITICAL_LIMITER_WAIT_MS + env.ROSSKO_TIMEOUT_MS + RECOVER_SLACK_MS,
  );
}

/**
 * Whether this run is the job's last attempt (BullMQ counts `attemptsMade` after failures).
 * Without `opts.attempts` a job has a single attempt.
 */
export function isFinalAttempt(job: Pick<Job, 'attemptsMade' | 'opts'>): boolean {
  const attempts = Math.max(1, job.opts?.attempts ?? 1);
  return (job.attemptsMade ?? 0) + 1 >= attempts;
}

/** A uuid field of the job data; malformed data is never retried. */
export function uuidField(job: Pick<Job, 'name' | 'data'>, field: string): string {
  const data = (job.data ?? {}) as Record<string, unknown>;
  const value = data[field];
  if (!isUuid(value)) {
    throw new UnrecoverableError(`rossko/${job.name}: invalid ${field}`);
  }
  return value;
}

/** An optional uuid field (staffId may be null when the admin pressed the button). */
export function optionalUuidField(job: Pick<Job, 'data'>, field: string): string | null {
  const data = (job.data ?? {}) as Record<string, unknown>;
  const value = data[field];
  return isUuid(value) ? value : null;
}

/** deps.engine.nudge after a commit that wrote outbox rows; never throws. */
export function nudge(deps: Pick<WorkerDeps, 'engine'>): void {
  try {
    deps.engine.nudge?.();
  } catch {
    // best effort (decision Б1): the dispatcher polls anyway
  }
}

/** Error text for logs and supplier_orders.error: no PD, bounded. */
export function errorText(error: unknown): string {
  const text = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return text.length > 500 ? `${text.slice(0, 497)}...` : text;
}
