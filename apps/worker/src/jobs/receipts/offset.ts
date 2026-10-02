// receipts/offset and receipts/offset-poll {receiptId} (decision Б22): the offset receipt of a
// prepay order, issued at «Клиент пришёл». POST /receipts with the stored request and the same
// Idempotence-Key until the provider knows the receipt, then GET /receipts/{id} every 2 minutes;
// 15 minutes after the first attempt without `succeeded`, or a final rejection (4xx), the
// sellers and the owner are alerted and «Выдал» stays blocked until «Повторить чек».
import { RECEIPTS_JOBS } from '@detaly/config';
import { applyReceiptObject, type ReceiptRow } from '@detaly/orders';
import type { CreateOffsetReceiptRequest, ProviderReceipt } from '@detaly/payments';
import { UnrecoverableError, type Job } from 'bullmq';
import type { WorkerDeps } from '../../deps';
import {
  classifyProviderError,
  failureMessage,
  failureText,
  isRejection,
  requireReceipts,
  uuidField,
  type ProviderFailure,
} from '../payments/shared';
import {
  alertReceiptFailed,
  loadReceiptRow,
  schedulePoll,
  startAttempt,
  windowElapsed,
} from './polling';

export type OffsetJobResult =
  | { skipped: string }
  | { status: 'succeeded' }
  | { status: 'canceled'; alerted: boolean }
  | { status: 'pending'; nextPollAt: string }
  | { status: 'pending'; alerted: boolean };

const GIVE_UP_NOTE = 'Чек зачёта не зарегистрирован за 15 минут.';

export async function processOffsetReceipt(
  job: Pick<Job, 'name' | 'data'>,
  deps: WorkerDeps,
): Promise<OffsetJobResult> {
  const receiptId = uuidField(job, 'receiptId');
  const row = await loadReceiptRow(deps, receiptId);
  if (row === null) return { skipped: 'not_found' };
  if (row.kind !== 'offset') throw new UnrecoverableError(`receipt kind ${row.kind} is not offset`);
  if (row.status !== 'pending') return { skipped: row.status };
  const provider = requireReceipts(deps);
  const log = { orderId: row.orderId, receiptId };

  // A fresh `offset` job after the alert is «Повторить чек» of a pending receipt: a new window.
  const restart = job.name === RECEIPTS_JOBS.offset && row.alertedAt !== null;
  const windowStart = await startAttempt(deps, row.id, { restart });

  let answer: ProviderReceipt | null = null;
  let failure: ProviderFailure | null = null;
  const posting = row.providerReceiptId === null;
  try {
    if (row.providerReceiptId === null) {
      if (row.request === null) throw new UnrecoverableError('offset receipt has no request');
      answer = await provider.createOffsetReceipt(row.request as CreateOffsetReceiptRequest);
    } else {
      answer = await provider.getReceipt(row.providerReceiptId);
    }
  } catch (error) {
    failure = classifyProviderError(error);
    if (failure === null) throw error;
  }

  // Only a POST the provider refused proves the receipt does not exist. A failed GET of a known
  // receipt (404, 401, an unreadable answer) and an unreadable answer to the POST say nothing
  // about it: the receipt stays pending and the same Idempotence-Key is used again, since a
  // "rejected" receipt lets «Повторить чек» take a new key and could fiscalise it twice.
  if (posting && isRejection(failure)) {
    // The provider rejected the receipt (e.g. a wrong tax_system_code): it is never created.
    const text = failureText(failure);
    await applyReceiptObject(deps.engine, row.id, {
      error: { code: failure.code, message: failureMessage(failure), final: true },
    });
    const alerted = await alertReceiptFailed(deps, row.id, {
      code: failure.code ?? 'rejected',
      note: `ЮKassa отклонила чек зачёта: ${text}.`,
    });
    await refreshCard(deps, row);
    deps.logger.error({ ...log, error: text }, 'offset receipt rejected');
    return { status: 'canceled', alerted };
  }

  if (answer !== null) {
    const applied = await applyReceiptObject(deps.engine, row.id, answer);
    if (applied.status === 'succeeded') {
      await refreshCard(deps, row);
      deps.logger.info(log, 'offset receipt succeeded');
      return { status: 'succeeded' };
    }
    if (applied.status === 'canceled') {
      const alerted = await alertReceiptFailed(deps, row.id, {
        code: 'canceled',
        note: 'ЮKassa не зарегистрировала чек зачёта.',
      });
      await refreshCard(deps, row);
      deps.logger.error(log, 'offset receipt canceled by the provider');
      return { status: 'canceled', alerted };
    }
  } else if (failure !== null) {
    // Network, 5xx, 202, an unreadable answer, a failed GET: the next poll repeats the same
    // request (the POST with the same Idempotence-Key).
    await applyReceiptObject(deps.engine, row.id, {
      error: { code: failure.code, message: failureMessage(failure), final: false },
    });
    deps.logger.warn({ ...log, error: failureText(failure) }, 'offset receipt attempt failed');
  }

  if (windowElapsed(deps, windowStart)) {
    const alerted = await alertReceiptFailed(deps, row.id, { code: 'timeout', note: GIVE_UP_NOTE });
    if (alerted) await refreshCard(deps, row);
    deps.logger.error(log, 'offset receipt not registered in 15 minutes');
    return { status: 'pending', alerted };
  }
  const nextPollAt = await schedulePoll(deps, {
    receipt: row,
    windowStart,
    name: RECEIPTS_JOBS.offsetPoll,
    keyPrefix: 'offset-poll',
  });
  return { status: 'pending', nextPollAt: nextPollAt.toISOString() };
}

/** The seller card shows «Выдал» or «Повторить чек» from the new receipt state. */
export async function refreshCard(
  deps: WorkerDeps,
  row: Pick<ReceiptRow, 'orderId'>,
): Promise<void> {
  try {
    await deps.sellerCards.refresh(row.orderId);
  } catch (error) {
    // The receipt state is committed; a card that failed to redraw is fixed by the next one.
    deps.logger.warn(
      { orderId: row.orderId, error: (error as Error).name },
      'seller card refresh failed',
    );
  }
}
