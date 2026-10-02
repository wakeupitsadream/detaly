// Helpers shared by the rossko queue jobs (recheck, checkout, recover).
import { isUuid, type ActorRef } from '@detaly/orders';
import { UnrecoverableError, type Job } from 'bullmq';
import type { WorkerDeps } from '../../deps';

/** The rossko jobs act as the system (rules supplier_* accept `system`). */
export const SYSTEM_ACTOR: ActorRef = { type: 'system', id: 'rossko', staffRole: null };

/**
 * Delay before the recovery lookup after an ambiguous GetCheckout failure (decision Б14): Rossko
 * may list a fresh order with a lag, and a checkout job declared stalled while its GetCheckout
 * is still in flight (ROSSKO_TIMEOUT_MS, 15 s by default) must finish before the lookup.
 */
export const RECOVER_DELAY_MS = 60_000;

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
