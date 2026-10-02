// housekeeping/reminders, every 15 minutes (decision Б27, docs/phase-1b-implementation.md 12.2,
// PLAN section 1 «напоминания»). Each reminder is a journal event plus an outbox notify/order row
// with the key `reminder:<order_id>:<kind>:<n>`: a key queued before is never queued again, so
// every reminder goes out once however often the job runs.
//
// | kind           | when                                                   | to      | template                    |
// | ready          | day N of reminder.days (3/6/9) since received_at       | client  | arrived (readyDays = N)     |
// | approval       | 12 h after decision_needed was delivered, once         | client  | decision_needed (reminder)  |
// | invoice        | every 4 h in awaiting_supplier_invoice                 | owner   | staff_supplier_invoice_due  |
// | attention      | every 4 h in needs_attention                           | sellers | staff_problem               |
// | supplier_return| 3 days before supplier_return_deadline_at, open returns| sellers | staff_supplier_return_task  |
// | refund_deadline| 2 days before refunds.deadline_at, refund not done     | owner   | staff_refund_deadline       |
// | payment        | half of the payment TTL, once per deadline             | client  | payment_link                |
// | confirmation   | half of the confirmation TTL, once per deadline        | client  | confirm_request             |
//
// After a gap (worker stopped) only the latest due reminder of a kind is sent: no backlog of
// «day 3» after «day 6».
import {
  and,
  asc,
  clientApprovals,
  eq,
  gt,
  inArray,
  isNotNull,
  isNull,
  orderItems,
  orderEvents,
  orders,
  refunds,
  sql,
  supplierReturns,
} from '@detaly/db';
import { localDate, TIMERS, type OrderStatus } from '@detaly/domain';
import { loadOrderSettings } from '@detaly/orders';
import type { WorkerDeps } from '../../deps';
import { BATCH, DAY_MS, HOUR_MS, MINUTE_MS, notAfter, nudge, queueReminder } from './common';

/** The sellers get the supplier return reminder this long before the deadline. */
export const SUPPLIER_RETURN_WARN_MS = 3 * DAY_MS;

export interface RemindersResult {
  queued: number;
  byKind: Record<string, number>;
}

export async function runReminders(deps: WorkerDeps): Promise<RemindersResult> {
  const now = deps.now();
  const nowMs = now.getTime();
  const settings = await loadOrderSettings(deps.db, deps.env);
  const result: RemindersResult = { queued: 0, byKind: {} };
  const add = (kind: string, queued: boolean) => {
    if (!queued) return;
    result.queued += 1;
    result.byKind[kind] = (result.byKind[kind] ?? 0) + 1;
  };

  // 1. ready: day 3/6/9 since the order arrived (the last one carries the storage phrase).
  const days = [...settings.reminderDays].sort((a, b) => a - b);
  const ready = await deps.db
    .select({ id: orders.id, receivedAt: orders.receivedAt })
    .from(orders)
    .where(and(eq(orders.status, 'ready'), isNotNull(orders.receivedAt)))
    .orderBy(asc(orders.receivedAt))
    .limit(BATCH);
  for (const order of ready) {
    if (order.receivedAt === null) continue;
    const elapsed = nowMs - order.receivedAt.getTime();
    const dueDay = days.filter((day) => day * DAY_MS <= elapsed).at(-1);
    if (dueDay === undefined) continue;
    add(
      'ready',
      await queueReminder(deps, {
        orderId: order.id,
        kind: 'ready',
        n: dueDay,
        audience: 'client',
        template: 'arrived',
        extras: { readyDays: dueDay },
      }),
    );
  }

  // 2. approval: one reminder 12 h after the client got decision_needed, while it is open.
  const approvals = await deps.db
    .select({ id: clientApprovals.id, orderId: clientApprovals.orderId })
    .from(clientApprovals)
    .innerJoin(orders, eq(orders.id, clientApprovals.orderId))
    .where(
      and(
        isNull(clientApprovals.decidedAt),
        isNull(clientApprovals.remindedAt),
        notAfter(clientApprovals.notifiedAt, new Date(nowMs - TIMERS.approvalReminderAfterMs)),
        gt(clientApprovals.expiresAt, now),
        eq(orders.status, 'awaiting_client_approval'),
      ),
    )
    .limit(BATCH);
  for (const approval of approvals) {
    add(
      'approval',
      await queueReminder(deps, {
        orderId: approval.orderId,
        kind: 'approval',
        n: approval.id,
        audience: 'client',
        template: 'decision_needed',
        journal: 'approval_reminder',
        extras: { reminder: true },
        inTx: async (tx) => {
          await tx
            .update(clientApprovals)
            .set({ remindedAt: now, updatedAt: now })
            .where(eq(clientApprovals.id, approval.id));
        },
      }),
    );
  }

  // 3–4. every 4 h while waiting for the Rossko invoice / in needs_attention.
  const periodic = [
    {
      status: 'awaiting_supplier_invoice',
      kind: 'invoice',
      everyMs: TIMERS.invoiceReminderEveryMs,
      audience: 'owner',
      template: 'staff_supplier_invoice_due',
    },
    {
      status: 'needs_attention',
      kind: 'attention',
      everyMs: TIMERS.attentionReminderEveryMs,
      audience: 'sellers',
      template: 'staff_problem',
    },
  ] as const;
  for (const spec of periodic) {
    for (const order of await enteredAt(deps, spec.status)) {
      const n = Math.floor((nowMs - order.since.getTime()) / spec.everyMs);
      if (n < 1) continue;
      add(
        spec.kind,
        await queueReminder(deps, {
          orderId: order.id,
          // The entry time keeps the keys of a second stay in the status apart.
          kind: spec.kind,
          n: `${Math.floor(order.since.getTime() / 1000)}-${n}`,
          audience: spec.audience,
          template: spec.template,
        }),
      );
    }
  }

  // 5. supplier returns still requested 3 days before the Rossko deadline.
  const returns = await deps.db
    .selectDistinct({ id: orders.id, deadline: orders.supplierReturnDeadlineAt })
    .from(orders)
    .innerJoin(orderItems, eq(orderItems.orderId, orders.id))
    .innerJoin(supplierReturns, eq(supplierReturns.orderItemId, orderItems.id))
    .where(
      and(
        eq(supplierReturns.status, 'requested'),
        notAfter(orders.supplierReturnDeadlineAt, new Date(nowMs + SUPPLIER_RETURN_WARN_MS)),
      ),
    )
    .limit(BATCH);
  for (const order of returns) {
    if (order.deadline === null) continue;
    const deadlineDate = localDate(order.deadline);
    add(
      'supplier_return',
      await queueReminder(deps, {
        orderId: order.id,
        kind: 'supplier_return',
        n: deadlineDate,
        audience: 'sellers',
        template: 'staff_supplier_return_task',
        extras: { deadlineDate },
      }),
    );
  }

  // 6. refunds not done 2 days before the 10-day legal deadline (a failed one too).
  const late = await deps.db
    .select({ id: refunds.id, orderId: refunds.orderId, deadline: refunds.deadlineAt })
    .from(refunds)
    .where(
      and(
        inArray(refunds.status, ['pending', 'failed']),
        notAfter(refunds.deadlineAt, new Date(nowMs + TIMERS.refundDeadlineWarnMs)),
      ),
    )
    .orderBy(asc(refunds.deadlineAt))
    .limit(BATCH);
  for (const refund of late) {
    add(
      'refund_deadline',
      await queueReminder(deps, {
        orderId: refund.orderId,
        kind: 'refund_deadline',
        n: refund.id,
        audience: 'owner',
        template: 'staff_refund_deadline',
        extras: { deadlineDate: localDate(refund.deadline) },
      }),
    );
  }

  // 7–8. half of the payment / confirmation time: one nudge to the client.
  const halfway = [
    {
      status: 'awaiting_payment',
      kind: 'payment',
      ttlMs: settings.paymentTtlMin * MINUTE_MS,
      template: 'payment_link',
    },
    {
      status: 'awaiting_confirmation',
      kind: 'confirmation',
      ttlMs: settings.onPickupConfirmTtlH * HOUR_MS,
      template: 'confirm_request',
    },
  ] as const;
  for (const spec of halfway) {
    const rows = await deps.db
      .select({ id: orders.id, expiresAt: orders.expiresAt, createdAt: orders.createdAt })
      .from(orders)
      .where(eq(orders.status, spec.status))
      .limit(BATCH);
    for (const order of rows) {
      // 1A orders have no expires_at: the deadline counts from created_at.
      const deadline = order.expiresAt?.getTime() ?? order.createdAt.getTime() + spec.ttlMs;
      if (nowMs < deadline - spec.ttlMs / 2 || nowMs >= deadline) continue;
      add(
        spec.kind,
        await queueReminder(deps, {
          orderId: order.id,
          kind: spec.kind,
          n: Math.floor(deadline / 1000),
          audience: 'client',
          template: spec.template,
        }),
      );
    }
  }

  if (result.queued > 0) nudge(deps);
  return result;
}

/**
 * Orders in `status` with the moment they entered it: the latest transition event into the
 * status from another one (updated_at when the journal has none).
 */
async function enteredAt(
  deps: WorkerDeps,
  status: OrderStatus,
): Promise<{ id: string; since: Date }[]> {
  const rows = await deps.db
    .select({ id: orders.id, updatedAt: orders.updatedAt })
    .from(orders)
    .where(eq(orders.status, status))
    .limit(BATCH);
  if (rows.length === 0) return [];
  const entries = await deps.db
    .select({
      orderId: orderEvents.orderId,
      since: sql<string | Date>`max(${orderEvents.createdAt})`,
    })
    .from(orderEvents)
    .where(
      and(
        inArray(
          orderEvents.orderId,
          rows.map((row) => row.id),
        ),
        eq(orderEvents.toStatus, status),
        sql`${orderEvents.fromStatus} is distinct from ${orderEvents.toStatus}`,
      ),
    )
    .groupBy(orderEvents.orderId);
  const since = new Map(entries.map((entry) => [entry.orderId, new Date(entry.since)]));
  return rows.map((row) => ({ id: row.id, since: since.get(row.id) ?? row.updatedAt }));
}
