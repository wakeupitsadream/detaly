// Helpers shared by the payments, receipts and reconciliation processors: job data checks,
// provider error classification and the outbox notify rows of the staff templates. Nothing
// here logs or returns personal data: errors are reduced to the provider code and HTTP status.
import { RefundPlanError, ReceiptLinesError, type OrderNotifyTemplate } from '@detaly/domain';
import { enqueueOutbox, isUuid, type Tx } from '@detaly/orders';
import {
  PaymentProviderError,
  PaymentRequestError,
  type PaymentProvider,
  type ReceiptProvider,
} from '@detaly/payments';
import { UnrecoverableError, type Job } from 'bullmq';
import type { WorkerDeps } from '../../deps';
import { notImplemented } from '../not-implemented';

/** The actor id of everything the provider tells us (order_events.actor_id). */
export const YOOKASSA_ACTOR = { type: 'system', id: 'yookassa' } as const;

/** A uuid field of the job data; anything else is a programming error (no retries). */
export function uuidField(job: Pick<Job, 'name' | 'data'>, field: string): string {
  const value: unknown = (job.data as Record<string, unknown> | undefined)?.[field];
  if (!isUuid(value)) {
    throw new UnrecoverableError(`${job.name}: job data has no valid ${field}`);
  }
  return value;
}

/** The payment provider, or a non-retried failure while payments are off (decision Б6). */
export function requirePayments(deps: Pick<WorkerDeps, 'payments'>): PaymentProvider {
  if (deps.payments === null) throw new UnrecoverableError('payments are not configured');
  return deps.payments;
}

export function requireReceipts(deps: Pick<WorkerDeps, 'receipts'>): ReceiptProvider {
  if (deps.receipts === null) throw new UnrecoverableError('receipts are not configured');
  return deps.receipts;
}

/**
 * How a failed provider call is treated:
 * - `retry`: network, timeout, 5xx, 429, HTTP 202 `processing` — the same request with the same
 *   Idempotence-Key may still succeed;
 * - `final`: 4xx and requests rejected locally (receipt lines, limits) — repeating the same
 *   body never helps;
 * - anything else (database, programming errors) is rethrown by the caller.
 */
export type ProviderFailure = {
  kind: 'retry' | 'final';
  code: string | null;
  status: number | null;
};

export function classifyProviderError(error: unknown): ProviderFailure | null {
  if (error instanceof PaymentProviderError) {
    return {
      kind: error.details.retryable ? 'retry' : 'final',
      code: error.details.code,
      status: error.details.status,
    };
  }
  if (
    error instanceof PaymentRequestError ||
    error instanceof ReceiptLinesError ||
    error instanceof RefundPlanError
  ) {
    return { kind: 'final', code: error.name, status: null };
  }
  return null;
}

/** HTTP 404 of a GET: the object does not exist at the provider. */
export function isNotFound(failure: ProviderFailure | null): boolean {
  return failure !== null && failure.status === 404;
}

/** Short error text without PD for rows and logs: `invalid_request (HTTP 400)`. */
export function failureText(failure: ProviderFailure): string {
  const code = failure.code ?? 'error';
  return failure.status === null ? code : `${code} (HTTP ${failure.status})`;
}

/** The message part of a receipt error (`<code>: <message>` in receipts.error). */
export function failureMessage(failure: ProviderFailure): string {
  return failure.status === null ? 'no answer' : `HTTP ${failure.status}`;
}

/**
 * A notify/order outbox row for a staff template. The key keeps the engine format
 * (`notify:<order_event_id>:<template>`) and adds the audience when a template goes to both
 * sellers and the owner, so the two rows do not collide.
 */
export async function enqueueStaffNotify(
  tx: Tx,
  input: {
    orderId: string;
    orderEventId: string;
    audience: 'sellers' | 'owner';
    template: OrderNotifyTemplate;
    /** Append the audience to the key (one event, the same template, two audiences). */
    keyByAudience?: boolean;
  },
): Promise<boolean> {
  const base = `notify:${input.orderEventId}:${input.template}`;
  return enqueueOutbox(tx, {
    queue: 'notify',
    name: 'order',
    key: input.keyByAudience ? `${base}:${input.audience}` : base,
    data: {
      orderId: input.orderId,
      orderEventId: input.orderEventId,
      audience: input.audience,
      template: input.template,
    },
  });
}

/** deps.engine.nudge after a commit of our own transaction; never throws (decision Б1). */
export function nudgeOutbox(deps: Pick<WorkerDeps, 'engine'>): void {
  try {
    deps.engine.nudge?.();
  } catch {
    // best effort: the dispatcher polls anyway
  }
}

/**
 * Unknown job name of a queue: fail at once, without retries, with the shared message of
 * jobs/not-implemented.ts (the name is logged by the caller).
 */
export function unknownJob(
  deps: Pick<WorkerDeps, 'logger'> | undefined,
  queue: string,
  name: string,
): never {
  deps?.logger?.error({ queue, job: name }, 'unknown job name');
  notImplemented();
}
