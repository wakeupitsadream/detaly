// reconciliation/sweep (every 10 minutes, PLAN section 1): payments and refunds still pending.
// A row with a provider id is re-read on every pass, whatever its age, and applied (source
// 'reconciliation'): a webhook that never came is closed by the next pass, at most 10 minutes
// after the payment (Verification «Фаза 1B» step 4; with an age limit too it took up to 20).
// A row without a provider id gets its lost POST repeated with the same Idempotence-Key
// (decision Б7) only once it is older than 10 minutes, so an answer still in flight is not
// raced. Refunds the same way. Errors are logged and the row waits for the next pass: the job
// itself is never retried.
import { and, desc, eq, gt, inArray, isNotNull, lt, or, payments, refunds } from '@detaly/db';
import { TIMERS } from '@detaly/domain';
import type { PaymentRow } from '@detaly/orders';
import { PaymentProviderError } from '@detaly/payments';
import type { WorkerDeps } from '../../deps';
import { IDEMPOTENCE_KEY_TTL_MS, recheckPayment, submitRefund } from '../payments/money';

/** Rows per pass and kind; the rest waits for the next pass. */
export const SWEEP_BATCH = 100;

export interface SweepOptions {
  /** Only these orders (tests share one database; production sweeps everything). */
  orderIds?: readonly string[];
  limit?: number;
}

export interface SweepReport {
  skipped?: 'payments_disabled';
  payments: Record<string, number>;
  refunds: Record<string, number>;
}

/** Log fields of an error without PD: never the message of a database error (it may echo params). */
export function errorInfo(error: unknown): Record<string, unknown> {
  if (error instanceof PaymentProviderError) {
    return { error: error.name, code: error.details.code, status: error.details.status };
  }
  return { error: error instanceof Error ? error.name : 'unknown' };
}

function bump(counts: Record<string, number>, key: string): void {
  counts[key] = (counts[key] ?? 0) + 1;
}

export async function runSweep(deps: WorkerDeps, options: SweepOptions = {}): Promise<SweepReport> {
  const report: SweepReport = { payments: {}, refunds: {} };
  if (deps.payments === null) return { ...report, skipped: 'payments_disabled' };
  const cutoff = new Date(deps.now().getTime() - TIMERS.reconcilePendingAgeMs);
  const keyCutoff = new Date(deps.now().getTime() - IDEMPOTENCE_KEY_TTL_MS);
  const limit = options.limit ?? SWEEP_BATCH;
  const scope = options.orderIds;
  if (scope !== undefined && scope.length === 0) return report;

  const pendingPayments: PaymentRow[] = await deps.db
    .select()
    .from(payments)
    .where(
      and(
        inArray(payments.status, ['pending', 'waiting_for_capture']),
        eq(payments.provider, 'yookassa'),
        or(
          // GET is read-only and idempotent: every pass, whatever the age.
          isNotNull(payments.providerPaymentId),
          // A repeated POST only after 10 minutes, and never past the Idempotence-Key lifetime
          // (repeatPaymentPost would skip it, taking a place of the batch on every pass).
          and(lt(payments.createdAt, cutoff), gt(payments.createdAt, keyCutoff)),
        ),
        scope ? inArray(payments.orderId, [...scope]) : undefined,
      ),
    )
    // Newest first: rows that stay pending for good (an order that moved on, a payment the
    // provider does not know) must not starve fresh ones out of the batch.
    .orderBy(desc(payments.createdAt))
    .limit(limit);
  for (const row of pendingPayments) {
    try {
      const outcome = await recheckPayment(deps, row, 'reconciliation');
      bump(
        report.payments,
        outcome.outcome === 'skipped' ? `skipped_${outcome.reason}` : outcome.outcome,
      );
      if (outcome.outcome === 'failed') {
        deps.logger.warn(
          { orderId: row.orderId, paymentId: row.id, error: outcome.error },
          'reconciliation: payment check failed',
        );
      } else if (outcome.outcome !== 'skipped') {
        deps.logger.info(
          { orderId: row.orderId, paymentId: row.id, ...outcome },
          'reconciliation: payment',
        );
      }
    } catch (error) {
      bump(report.payments, 'error');
      deps.logger.error(
        { orderId: row.orderId, paymentId: row.id, ...errorInfo(error) },
        'reconciliation: payment error',
      );
    }
  }

  const pendingRefunds = await deps.db
    .select({ id: refunds.id, orderId: refunds.orderId })
    .from(refunds)
    .where(
      and(
        eq(refunds.status, 'pending'),
        // GET with a provider id on every pass; a repeated POST (no id yet) after 10 minutes.
        or(isNotNull(refunds.providerRefundId), lt(refunds.createdAt, cutoff)),
        scope ? inArray(refunds.orderId, [...scope]) : undefined,
      ),
    )
    .orderBy(desc(refunds.createdAt))
    .limit(limit);
  for (const row of pendingRefunds) {
    try {
      const outcome = await submitRefund(deps, row.id, 'reconciliation');
      bump(
        report.refunds,
        outcome.outcome === 'skipped' ? `skipped_${outcome.reason}` : outcome.outcome,
      );
      deps.logger.info(
        { orderId: row.orderId, refundId: row.id, ...outcome },
        'reconciliation: refund',
      );
    } catch (error) {
      bump(report.refunds, 'error');
      deps.logger.error(
        { orderId: row.orderId, refundId: row.id, ...errorInfo(error) },
        'reconciliation: refund error',
      );
    }
  }
  return report;
}
