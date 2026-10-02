// Shared pieces of the housekeeping jobs: the system actor, date comparisons through drizzle
// operators (column-aware parameter mapping), queuing a notify job with its journal event.
import { eq, gt, orders, outbox, sql, type SQL, type Tx } from '@detaly/db';
import type { JournalEvent, NotifyAudience, OrderNotifyTemplate } from '@detaly/domain';
import { enqueueOutbox, recordJournalEvent, type ActorRef } from '@detaly/orders';
import type { WorkerDeps } from '../../deps';
import type { NotifyOrderJobData } from '../notify/order';

export const MINUTE_MS = 60_000;
export const HOUR_MS = 60 * MINUTE_MS;
export const DAY_MS = 24 * HOUR_MS;

/** Rows per query and run: a backlog is worked off over the next runs. */
export const BATCH = 200;

export const HOUSEKEEPING_ACTOR: ActorRef = { type: 'system', id: 'housekeeping' };

/** `column <= at` (null -> false). */
export function notAfter(column: Parameters<typeof gt>[0], at: Date): SQL {
  return sql`not (${gt(column, at)})`;
}

/** Wakes the outbox dispatcher after a commit; never throws (decision Б1). */
export function nudge(deps: Pick<WorkerDeps, 'engine'>): void {
  try {
    deps.engine.nudge?.();
  } catch {
    // best effort: the dispatcher polls anyway
  }
}

export type NotifyExtras = Omit<
  NotifyOrderJobData,
  'orderId' | 'orderEventId' | 'audience' | 'template'
>;

/**
 * One reminder (decision Б27): outbox notify/order with key `reminder:<order_id>:<kind>:<n>` and
 * a journal event (`reminder` or `approval_reminder`) whose id the notification carries, in one
 * transaction under the order row lock. A key queued before -> nothing is written, false.
 * `inTx` runs in the same transaction after the rows (e.g. client_approvals.reminded_at).
 */
export async function queueReminder(
  deps: Pick<WorkerDeps, 'db' | 'now'>,
  input: {
    orderId: string;
    kind: string;
    n: string | number;
    audience: NotifyAudience;
    template: OrderNotifyTemplate;
    journal?: Extract<JournalEvent, 'reminder' | 'approval_reminder'>;
    extras?: NotifyExtras;
    inTx?: (tx: Tx) => Promise<void>;
  },
): Promise<boolean> {
  const key = `reminder:${input.orderId}:${input.kind}:${input.n}`;
  return deps.db.transaction(async (tx) => {
    const [locked] = await tx
      .select({ id: orders.id })
      .from(orders)
      .where(eq(orders.id, input.orderId))
      .for('update');
    if (!locked) return false;
    const queued = await enqueueOutbox(tx, { queue: 'notify', name: 'order', key });
    if (!queued) return false;
    const { orderEventId } = await recordJournalEvent(tx, {
      orderId: input.orderId,
      type: input.journal ?? 'reminder',
      actor: HOUSEKEEPING_ACTOR,
      payload: {
        kind: input.kind,
        n: String(input.n),
        audience: input.audience,
        template: input.template,
      },
      at: deps.now(),
    });
    const data: NotifyOrderJobData = {
      ...input.extras,
      orderId: input.orderId,
      orderEventId,
      audience: input.audience,
      template: input.template,
    };
    await tx
      .update(outbox)
      .set({ data: data as unknown as Record<string, unknown> })
      .where(eq(outbox.jobId, key));
    await input.inTx?.(tx);
    return true;
  });
}
