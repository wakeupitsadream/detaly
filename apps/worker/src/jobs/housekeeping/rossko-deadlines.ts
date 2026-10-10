// housekeeping/rossko-deadlines, every 10 minutes (step 8, docs/rossko-automation.md): the deadline
// alerts to the sellers chat, no Rossko keys needed. The decision is deadlineAlertDue of
// @detaly/domain in the working hours of the pickup point (PICKUP_HOURS, Asia/Yekaterinburg):
//
// | kind             | when                                                                       |
// | not_ordered      | `confirmed` (or stuck in `ordering`) longer than rossko.order_within_minutes |
// |                  | (120) of working time, no created supplier order                           |
// | supplier_late    | `ordered_at_supplier`, a live item not at the point at the end of the       |
// |                  | working day before orders.promised_date                                    |
// | supplier_overdue | the same from the opening of the first working day after the promised date |
// | not_picked_up    | `ready` for more than 3 working days → «позвоните клиенту» (the client's    |
// |                  | own reminders 3/6/9 stay as they are)                                      |
//
// An alert is the order card in the sellers chat (notify/order, sellers) with its buttons and the
// «Открыть в админке» link, a headline of the kind and the alert as its note line, plus a journal
// `reminder` event — queueReminder with the outbox key `reminder:<order>:rossko_<kind>:1`
// (deadlineAlertKey): one per order and kind, whatever the number of runs or restarts. After a
// gap «Срок сорван» goes without «под угрозой» (the latest only). Logs: counters only.
import { and, asc, eq, inArray, isNotNull, orderEvents, orders, sql, type SQL } from '@detaly/db';
import {
  CLIENT_TIME_ZONE,
  DEADLINE_ALERT_TEMPLATES,
  deadlineAlertDue,
  deadlineAlertNote,
  deadlineReminderKind,
  parseWorkHours,
  type DeadlineAlertKind,
  type OrderStatus,
} from '@detaly/domain';
import { loadRosskoSettings } from '@detaly/orders';
import type { WorkerDeps } from '../../deps';
import { BATCH, nudge, queueReminder } from './common';

export interface RosskoDeadlinesResult {
  /** Alerts queued by this run, by kind. */
  queued: Partial<Record<DeadlineAlertKind, number>>;
}

/** SQL: the alert of `kind` of the row's order was queued before (deadlineAlertKey). */
function alerted(kind: DeadlineAlertKind): SQL {
  return sql`exists (select 1 from outbox o where o.job_id = 'reminder:' || "orders"."id"::text || ${`:${deadlineReminderKind(kind)}:1`})`;
}

/** SQL: the order has a supplier order Rossko took (`created`). */
const HAS_SUPPLIER_ORDER = sql<boolean>`exists (select 1 from supplier_orders so where so.order_id = "orders"."id" and so.status = 'created')`;

/** SQL: live items of the order not at the point yet. */
const ITEMS_NOT_ARRIVED = sql<number>`(select count(*)::int from order_items oi where oi.order_id = "orders"."id" and oi.state in ('pending', 'ordered'))`;

interface Candidate {
  id: string;
  status: OrderStatus;
  paymentScheme: 'prepay' | 'pay_on_handover';
  promisedDate: string | null;
  receivedAt: Date | null;
  updatedAt: Date;
  hasSupplierOrder: boolean;
  itemsNotArrived: number;
  /** «Срок поставщика под угрозой» was queued before (only «Срок сорван» may follow). */
  lateAlerted: boolean;
}

async function candidates(deps: WorkerDeps, where: SQL | undefined): Promise<Candidate[]> {
  return deps.db
    .select({
      id: orders.id,
      status: orders.status,
      paymentScheme: orders.paymentScheme,
      promisedDate: orders.promisedDate,
      receivedAt: orders.receivedAt,
      updatedAt: orders.updatedAt,
      hasSupplierOrder: HAS_SUPPLIER_ORDER,
      itemsNotArrived: ITEMS_NOT_ARRIVED,
      lateAlerted: sql<boolean>`${alerted('supplier_late')}`,
    })
    .from(orders)
    .where(where)
    .orderBy(asc(orders.updatedAt), asc(orders.id))
    .limit(BATCH);
}

/**
 * When each order entered its current status: the latest transition event into it from another
 * status (updated_at without one), as the 4-hourly reminders count it.
 */
async function statusSince(
  deps: WorkerDeps,
  rows: readonly Candidate[],
): Promise<Map<string, Date>> {
  const since = new Map<string, Date>();
  if (rows.length === 0) return since;
  const entries = await deps.db
    .select({
      orderId: orderEvents.orderId,
      toStatus: orderEvents.toStatus,
      at: sql<string | Date>`max(${orderEvents.createdAt})`,
    })
    .from(orderEvents)
    .where(
      and(
        inArray(
          orderEvents.orderId,
          rows.map((row) => row.id),
        ),
        isNotNull(orderEvents.toStatus),
        sql`${orderEvents.fromStatus} is distinct from ${orderEvents.toStatus}`,
      ),
    )
    .groupBy(orderEvents.orderId, orderEvents.toStatus);
  const byOrder = new Map(rows.map((row) => [row.id, row]));
  for (const entry of entries) {
    if (byOrder.get(entry.orderId)?.status === entry.toStatus) {
      since.set(entry.orderId, new Date(entry.at));
    }
  }
  return since;
}

export async function runRosskoDeadlines(deps: WorkerDeps): Promise<RosskoDeadlinesResult> {
  const now = deps.now();
  const schedule = parseWorkHours(deps.env.PICKUP_HOURS ?? null);
  const { orderWithinMinutes } = await loadRosskoSettings(deps.db);
  const result: RosskoDeadlinesResult = { queued: {} };

  // Orders that may be due, without the ones whose last alert of the group is queued already: a
  // full batch of alerted orders never hides a newer one.
  const rows = [
    ...(await candidates(
      deps,
      and(inArray(orders.status, ['confirmed', 'ordering']), sql`not ${alerted('not_ordered')}`),
    )),
    ...(await candidates(
      deps,
      and(
        eq(orders.status, 'ordered_at_supplier'),
        isNotNull(orders.promisedDate),
        sql`not ${alerted('supplier_overdue')}`,
      ),
    )),
    ...(await candidates(
      deps,
      and(
        eq(orders.status, 'ready'),
        isNotNull(orders.receivedAt),
        sql`not ${alerted('not_picked_up')}`,
      ),
    )),
  ];
  const since = await statusSince(deps, rows);

  for (const row of rows) {
    const kind = deadlineAlertDue(
      {
        status: row.status,
        statusSince: since.get(row.id) ?? row.updatedAt,
        hasSupplierOrder: row.hasSupplierOrder,
        promisedDate: row.promisedDate,
        itemsNotArrived: Number(row.itemsNotArrived),
        receivedAt: row.receivedAt,
      },
      { now, schedule, timeZone: CLIENT_TIME_ZONE, orderWithinMinutes },
    );
    if (kind === null || (kind === 'supplier_late' && row.lateAlerted)) continue;
    const queued = await queueReminder(deps, {
      orderId: row.id,
      kind: deadlineReminderKind(kind),
      n: 1,
      audience: 'sellers',
      template: DEADLINE_ALERT_TEMPLATES[kind],
      extras: {
        note: deadlineAlertNote(kind, {
          status: row.status,
          scheme: row.paymentScheme,
          promisedDate: row.promisedDate,
          orderWithinMinutes,
        }),
      },
      payload: { alert: kind, ...(row.promisedDate ? { promisedDate: row.promisedDate } : {}) },
    });
    if (queued) result.queued[kind] = (result.queued[kind] ?? 0) + 1;
  }

  if (Object.keys(result.queued).length > 0) {
    nudge(deps);
    deps.logger.info({ ...result.queued }, 'rossko deadline alerts queued');
  }
  return result;
}
