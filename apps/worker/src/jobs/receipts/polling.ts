// The polling window of a receipt (decision Б22): attempts every 2 minutes up to 15 minutes
// after the first one, then one alert (staff_receipt_failed to the sellers and the owner) while
// «Выдал» stays blocked. Polls are delayed outbox rows, so they survive a Redis loss.
import { and, desc, eq, orderEvents, receipts, sql } from '@detaly/db';
import { TIMERS } from '@detaly/domain';
import {
  enqueueOutbox,
  loadOrderSnapshot,
  recordJournalEvent,
  type ReceiptRow,
} from '@detaly/orders';
import type { WorkerDeps } from '../../deps';
import { enqueueStaffNotify, nudgeOutbox, YOOKASSA_ACTOR } from '../payments/shared';

export async function loadReceiptRow(
  deps: Pick<WorkerDeps, 'db'>,
  id: string,
): Promise<ReceiptRow | null> {
  const [row] = await deps.db.select().from(receipts).where(eq(receipts.id, id));
  return row ?? null;
}

/**
 * One attempt of the window: attempts + 1 and first_attempt_at on the first one. `restart`
 * opens a new window («Повторить чек» after the alert): first_attempt_at = now, alerted_at
 * cleared. Returns the window start.
 */
export async function startAttempt(
  deps: Pick<WorkerDeps, 'db' | 'now'>,
  receiptId: string,
  options: { restart: boolean },
): Promise<Date> {
  const at = deps.now();
  const [row] = await deps.db
    .update(receipts)
    .set({
      attempts: sql`${receipts.attempts} + 1`,
      firstAttemptAt: options.restart
        ? at
        : sql`coalesce(${receipts.firstAttemptAt}, ${at.toISOString()}::timestamptz)`,
      ...(options.restart ? { alertedAt: null } : {}),
      updatedAt: at,
    })
    .where(eq(receipts.id, receiptId))
    .returning({ firstAttemptAt: receipts.firstAttemptAt });
  return row?.firstAttemptAt ?? at;
}

export function windowElapsed(deps: Pick<WorkerDeps, 'now'>, windowStart: Date): boolean {
  return deps.now().getTime() - windowStart.getTime() >= TIMERS.receiptGiveUpMs;
}

/**
 * The next poll as a delayed outbox row: in 2 minutes, the last one exactly at the end of the
 * window. The key is the 2-minute slot of the window, so two overlapping jobs schedule one poll.
 */
export async function schedulePoll(
  deps: WorkerDeps,
  input: {
    receipt: Pick<ReceiptRow, 'id' | 'orderId'>;
    windowStart: Date;
    name: string;
    keyPrefix: string;
  },
): Promise<Date> {
  const now = deps.now().getTime();
  const start = input.windowStart.getTime();
  const at = new Date(Math.min(now + TIMERS.receiptPollEveryMs, start + TIMERS.receiptGiveUpMs));
  const slot = Math.ceil((at.getTime() - start) / TIMERS.receiptPollEveryMs);
  await enqueueOutbox(deps.db, {
    queue: 'receipts',
    name: input.name,
    key: `${input.keyPrefix}:${input.receipt.id}:${start}:${slot}`,
    data: { receiptId: input.receipt.id, orderId: input.receipt.orderId },
    availableAt: at,
  });
  nudgeOutbox(deps);
  return at;
}

/**
 * Once per window: alerted_at, a `receipt_failed` journal event (the engine's own one when it
 * recorded the final rejection, else a new one with the reason) and staff_receipt_failed to the
 * sellers and to the owner. Returns false when the window was already alerted.
 */
export async function alertReceiptFailed(
  deps: WorkerDeps,
  receiptId: string,
  input: { code: string; note: string },
): Promise<boolean> {
  const alerted = await deps.db.transaction(async (tx) => {
    const [found] = await tx.select().from(receipts).where(eq(receipts.id, receiptId));
    if (found === undefined) return false;
    await loadOrderSnapshot(tx, found.orderId, { lock: true });
    const [row] = await tx.select().from(receipts).where(eq(receipts.id, receiptId));
    if (row === undefined || row.alertedAt !== null || row.status === 'succeeded') return false;
    const at = deps.now();
    const since = row.firstAttemptAt ?? row.createdAt;
    const [engineEvent] = await tx
      .select({ id: orderEvents.id })
      .from(orderEvents)
      .where(
        and(
          eq(orderEvents.orderId, row.orderId),
          eq(orderEvents.type, 'receipt_failed'),
          sql`${orderEvents.payload}->>'receiptId' = ${row.id}`,
          sql`${orderEvents.createdAt} >= ${since.toISOString()}::timestamptz`,
        ),
      )
      .orderBy(desc(orderEvents.createdAt))
      .limit(1);
    const orderEventId =
      engineEvent?.id ??
      (
        await recordJournalEvent(tx, {
          orderId: row.orderId,
          type: 'receipt_failed',
          actor: YOOKASSA_ACTOR,
          payload: { receiptId: row.id, kind: row.kind, code: input.code, note: input.note },
          at,
        })
      ).orderEventId;
    await tx.update(receipts).set({ alertedAt: at, updatedAt: at }).where(eq(receipts.id, row.id));
    for (const audience of ['sellers', 'owner'] as const) {
      await enqueueStaffNotify(tx, {
        orderId: row.orderId,
        orderEventId,
        audience,
        template: 'staff_receipt_failed',
        keyByAudience: true,
      });
    }
    return true;
  });
  if (alerted) nudgeOutbox(deps);
  return alerted;
}
