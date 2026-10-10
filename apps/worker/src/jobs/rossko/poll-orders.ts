/**
 * rossko/poll-orders, a Job Scheduler every 20 minutes (step 8, docs/rossko-automation.md; PLAN
 * phase 2 «GetOrders polling»). Ready, but off: it does nothing unless ROSSKO_MODE=live and
 * settings rossko.poll_enabled — the Rossko keys and the meaning of the 16 status codes are not
 * known yet (docs/external.md R11).
 *
 * 1. The open supplier orders: `created`, with Rossko order numbers and a live item still
 *    `ordered` (not at the point, not dropped); the least recently checked first, up to
 *    POLL_ORDERS_LIMIT per run.
 * 2. GetOrders through the shared client (limiter, quota breaker, api_calls) in batches of at most
 *    ORDERS_BATCH_SIZE (20) ids, with the `search` priority: the polling stops at the quota
 *    breaker and never takes the quota a GetCheckout needs. A failed batch is logged and skipped
 *    (the next run retries it); a full rate window or the breaker ends the run.
 * 3. Per supplier order, under the order row lock: every Rossko order of the attempt keeps its
 *    last code, name and whether the mapped action of that code was applied
 *    (supplier_orders.rossko_statuses); status_code / status_name / status_changed_at hold the
 *    latest change, status_checked_at the last answer. A NEW code is journaled (`rossko_status`)
 *    and its action of settings rossko.order_status_map is applied once:
 *    - shipped_to_point — the order card «Отгружено Rossko … проверьте приёмку» with the
 *      «Приехало» buttons (notify/order sellers, staff_supplier_shipped), while the order waits
 *      for the parts; «Приехало» itself stays the master's button;
 *    - refused — «Проблема с позицией» → «Отказ поставщика» (item_problem `declined`, the order
 *      goes to needs_attention) for the parts of that Rossko order, never twice for one item; when
 *      the engine cannot take it (the order is no longer waiting for the supplier, the parts are
 *      unknown) one staff alert instead;
 *    - in_progress / ignore — nothing;
 *    - a code that is not in the map — nothing is done; one staff alert per supplier order and
 *      code asks what it means («Настройте в /admin/rossko»). Once the code is mapped, the next
 *      run applies its action to the orders still in that status.
 *    The same code seen again does nothing (change only).
 *
 * Errors are logged and left to the next scheduled run: one supplier order failing never stops
 * the others, and the job itself fails only when the database is gone.
 */
import { NOTIFY_JOBS } from '@detaly/config';
import {
  and,
  asc,
  eq,
  orderEvents,
  orders,
  sql,
  supplierOrderItems,
  supplierOrders,
  type Tx,
} from '@detaly/db';
import {
  cleanRosskoStatusName,
  rosskoStatusAction,
  samePart,
  supplierRefusedText,
  supplierShippedNote,
  unmappedStatusText,
  type RosskoOrderStatusState,
  type RosskoStatusAction,
  type RosskoStatusMap,
} from '@detaly/domain';
import {
  applyTransition,
  enqueueNotify,
  enqueueOutbox,
  loadOrderSnapshot,
  loadRosskoSettings,
  ORDER_STATUS_LABELS,
  recordJournalEvent,
  type OrderItemRow,
  type OrderSnapshot,
} from '@detaly/orders';
import {
  ORDERS_BATCH_SIZE,
  QuotaBreakerError,
  RosskoRateLimitError,
  type RosskoOrder,
} from '@detaly/rossko';
import type { Job } from 'bullmq';
import type { WorkerDeps } from '../../deps';
import type { NotifyAlertJobData } from '../notify';
import { adminUrl, baseUrl } from '../notify/template-data';
import { SYSTEM_ACTOR, errorText, nudge } from './shared';

/** Supplier orders polled per run (10 GetOrders calls at most). */
export const POLL_ORDERS_LIMIT = 200;

/** The marker of the poll's item_problem events (payload.via). */
export const POLL_VIA = 'rossko_poll';

/** What a run did (counters only, no PD). */
export type PollOrdersResult =
  | { outcome: 'off'; reason: 'not_live' | 'disabled' }
  | {
      outcome: 'polled';
      supplierOrders: number;
      calls: number;
      failedCalls: number;
      /** Rossko orders with a new code. */
      changed: number;
      /** Actions applied (shipped, refused, refused_alert, unmapped, none). */
      actions: Record<string, number>;
      /** Supplier orders whose update failed (logged). */
      errors: number;
    };

interface OpenSupplierOrder {
  id: string;
  orderId: string;
  rosskoOrderIds: string[];
}

/** Created supplier orders with a live item still ordered, the least recently checked first. */
async function loadOpenSupplierOrders(deps: WorkerDeps): Promise<OpenSupplierOrder[]> {
  return deps.db
    .select({
      id: supplierOrders.id,
      orderId: supplierOrders.orderId,
      rosskoOrderIds: supplierOrders.rosskoOrderIds,
    })
    .from(supplierOrders)
    .where(
      and(
        eq(supplierOrders.status, 'created'),
        sql`cardinality(${supplierOrders.rosskoOrderIds}) > 0`,
        sql`exists (select 1 from supplier_order_items soi join order_items oi on oi.id = soi.order_item_id where soi.supplier_order_id = ${supplierOrders.id} and oi.state = 'ordered')`,
      ),
    )
    .orderBy(
      sql`${supplierOrders.statusCheckedAt} asc nulls first`,
      asc(supplierOrders.createdAt),
      asc(supplierOrders.id),
    )
    .limit(POLL_ORDERS_LIMIT);
}

/**
 * The status code of a Rossko order: the order's own, else the one code all its lines share.
 * VERIFY (R11): whether GetOrders gives the status per order, per line or both.
 */
export function rosskoOrderCode(order: Pick<RosskoOrder, 'statusCode' | 'items'>): number | null {
  if (order.statusCode !== null) return order.statusCode;
  const codes = new Set(order.items.map((line) => line.statusCode));
  if (codes.size !== 1) return null;
  const [only] = [...codes];
  return only ?? null;
}

/** GetOrders of the ids in batches of 20; failures are counted and logged, never thrown. */
async function fetchStatuses(
  deps: WorkerDeps,
  ids: readonly string[],
): Promise<{ seen: Map<string, RosskoOrder>; calls: number; failedCalls: number }> {
  const seen = new Map<string, RosskoOrder>();
  let calls = 0;
  let failedCalls = 0;
  for (let i = 0; i < ids.length; i += ORDERS_BATCH_SIZE) {
    const batch = ids.slice(i, i + ORDERS_BATCH_SIZE);
    calls += 1;
    try {
      const result = await deps.rossko.orders(batch, { priority: 'search' });
      if (!result.success) {
        failedCalls += 1;
        deps.logger.warn(
          { job: 'rossko/poll-orders', ids: batch.length, orders: result.orders.length },
          'GetOrders answered success=false',
        );
      }
      const wanted = new Set(batch);
      for (const order of result.orders) if (wanted.has(order.id)) seen.set(order.id, order);
    } catch (error) {
      failedCalls += 1;
      deps.logger.warn(
        { job: 'rossko/poll-orders', ids: batch.length, err: errorText(error) },
        'GetOrders failed, the next run retries',
      );
      // The window or the quota is used up: the next run (20 minutes later) goes on.
      if (error instanceof RosskoRateLimitError || error instanceof QuotaBreakerError) break;
    }
  }
  return { seen, calls, failedCalls };
}

/** Items of the poll's earlier refusals (payload itemId and refusedItemIds). */
async function refusedBefore(tx: Tx, orderId: string): Promise<Set<string>> {
  const rows = await tx
    .select({ payload: orderEvents.payload })
    .from(orderEvents)
    .where(
      and(
        eq(orderEvents.orderId, orderId),
        eq(orderEvents.type, 'item_problem'),
        sql`${orderEvents.payload}->>'via' = ${POLL_VIA}`,
      ),
    );
  const ids = new Set<string>();
  for (const { payload } of rows) {
    if (typeof payload.itemId === 'string') ids.add(payload.itemId);
    if (Array.isArray(payload.refusedItemIds)) {
      for (const id of payload.refusedItemIds) if (typeof id === 'string') ids.add(id);
    }
  }
  return ids;
}

/**
 * The live items of the supplier order a Rossko order is about: all of them when the attempt
 * has one Rossko order; else those whose part GetOrders lists for it (empty when it lists none).
 */
function itemsOfRosskoOrder(
  items: readonly OrderItemRow[],
  rosskoOrder: RosskoOrder,
  rosskoOrderCount: number,
): OrderItemRow[] {
  if (rosskoOrderCount === 1) return [...items];
  return items.filter((item) =>
    rosskoOrder.items.some((line) => samePart({ brand: line.brand, article: line.article }, item)),
  );
}

interface PendingAction {
  rosskoOrder: RosskoOrder;
  code: number;
  name: string | null;
  previousCode: number | null;
  changed: boolean;
  action: RosskoStatusAction | null;
}

interface ApplyContext {
  deps: WorkerDeps;
  tx: Tx;
  snapshot: OrderSnapshot;
  supplierOrderId: string;
  /** Live items of the supplier order still on their way (pending / ordered). */
  items: OrderItemRow[];
  rosskoOrderCount: number;
  at: Date;
  count: (action: string) => void;
}

async function queueAlert(tx: Tx, data: NotifyAlertJobData): Promise<boolean> {
  return enqueueOutbox(tx, {
    queue: 'notify',
    name: NOTIFY_JOBS.alert,
    key: `alert:${data.dedupeKey}`,
    data: { ...data },
  });
}

/** Applies the mapped action of one new (or newly mapped) code; true when it is handled. */
async function applyAction(ctx: ApplyContext, pending: PendingAction): Promise<boolean> {
  const { deps, tx, snapshot, at } = ctx;
  const { rosskoOrder, code, name, action } = pending;
  // The status now: an earlier action of this run (a refusal) may have moved the order.
  const [current] = await tx
    .select({ status: orders.status })
    .from(orders)
    .where(eq(orders.id, snapshot.order.id));
  const order = { ...snapshot.order, status: current?.status ?? snapshot.order.status };
  const journal = async (applied: string) =>
    (
      await recordJournalEvent(tx, {
        orderId: order.id,
        type: 'rossko_status',
        actor: SYSTEM_ACTOR,
        payload: {
          supplierOrderId: ctx.supplierOrderId,
          rosskoOrderId: rosskoOrder.id,
          code,
          name,
          previousCode: pending.previousCode,
          action: applied,
          ...(pending.changed ? {} : { mappedLater: true }),
        },
        at,
      })
    ).orderEventId;

  if (action === null) {
    // Not in the map: nothing is done. One alert per supplier order and code; the state stays
    // unhandled, so the action of a code mapped later is applied by a later run.
    if (pending.changed) await journal('unmapped');
    const queued = await queueAlert(tx, {
      audience: 'sellers',
      text: unmappedStatusText({
        code,
        name,
        orderNumber: order.number,
        rosskoOrderId: rosskoOrder.id,
        adminUrl: `${baseUrl(deps.env)}/admin/rossko`,
      }),
      dedupeKey: `rossko-status:${ctx.supplierOrderId}:${code}`,
    });
    if (queued) ctx.count('unmapped');
    return false;
  }

  const targets = itemsOfRosskoOrder(ctx.items, rosskoOrder, ctx.rosskoOrderCount);
  if (action === 'shipped_to_point') {
    const eventId = await journal(action);
    if (order.status === 'ordered_at_supplier' && targets.some((i) => i.state === 'ordered')) {
      await enqueueNotify(tx, {
        orderId: order.id,
        orderEventId: eventId,
        audience: 'sellers',
        template: 'staff_supplier_shipped',
        note: supplierShippedNote({
          orderNumber: order.number,
          rosskoOrderId: rosskoOrder.id,
          statusName: name,
        }),
      });
      ctx.count('shipped');
    } else {
      ctx.count('none');
    }
    return true;
  }

  if (action === 'refused') {
    await journal(action);
    const flagged = await refusedBefore(tx, order.id);
    const eligible = targets.filter((item) => !flagged.has(item.id));
    if (targets.length > 0 && eligible.length === 0) {
      ctx.count('none'); // every part was flagged by an earlier refusal
      return true;
    }
    const first = eligible[0];
    if (first !== undefined && order.status === 'ordered_at_supplier') {
      const applied = await applyTransition(deps.engine, {
        orderId: order.id,
        event: 'item_problem',
        actor: SYSTEM_ACTOR,
        itemId: first.id,
        facts: { problem: 'declined', reason: 'item_problem:declined' },
        payload: {
          problem: 'declined',
          via: POLL_VIA,
          supplierOrderId: ctx.supplierOrderId,
          rosskoOrderId: rosskoOrder.id,
          code,
          refusedItemIds: eligible.map((item) => item.id),
        },
        tx,
      });
      if (applied.ok) {
        ctx.count('refused');
        return true;
      }
      deps.logger.warn(
        { job: 'rossko/poll-orders', orderId: order.id, reason: applied.reason },
        'poll: the refusal was not taken by the engine, staff alert instead',
      );
    }
    const queued = await queueAlert(tx, {
      audience: 'sellers',
      text: supplierRefusedText({
        code,
        name,
        orderNumber: order.number,
        rosskoOrderId: rosskoOrder.id,
        parts: eligible.map((item) => `${item.brand} ${item.article}`).join(', '),
        statusLabel: ORDER_STATUS_LABELS[order.status],
        adminUrl: adminUrl(deps.env, order.id),
      }),
      dedupeKey: `rossko-refused:${ctx.supplierOrderId}:${rosskoOrder.id}:${code}`,
    });
    if (queued) ctx.count('refused_alert');
    return true;
  }

  // in_progress, ignore: nothing to do.
  if (pending.changed) await journal(action);
  ctx.count('none');
  return true;
}

/** One supplier order: compare, store, act (one transaction, the order row locked first). */
async function applyObserved(
  deps: WorkerDeps,
  open: OpenSupplierOrder,
  observed: readonly RosskoOrder[],
  map: RosskoStatusMap,
  at: Date,
  count: (action: string) => void,
): Promise<number> {
  return deps.db.transaction(async (tx) => {
    const snapshot = await loadOrderSnapshot(tx, open.orderId, { lock: true });
    if (snapshot === null) return 0;
    const [row] = await tx
      .select({
        rosskoStatuses: supplierOrders.rosskoStatuses,
        rosskoOrderIds: supplierOrders.rosskoOrderIds,
      })
      .from(supplierOrders)
      .where(eq(supplierOrders.id, open.id))
      .for('update');
    if (!row) return 0;
    const itemIds = (
      await tx
        .select({ id: supplierOrderItems.orderItemId })
        .from(supplierOrderItems)
        .where(eq(supplierOrderItems.supplierOrderId, open.id))
    ).map((item) => item.id);
    const items = snapshot.items.filter(
      (item) => itemIds.includes(item.id) && (item.state === 'ordered' || item.state === 'pending'),
    );

    const states: Record<string, RosskoOrderStatusState> = { ...row.rosskoStatuses };
    const pending: PendingAction[] = [];
    let latest: { code: number; name: string | null } | null = null;
    let changed = 0;
    for (const rosskoOrder of observed) {
      const code = rosskoOrderCode(rosskoOrder);
      // No code at all: nothing to compare and nothing to act on (VERIFY: R11).
      if (code === null) continue;
      const name = cleanRosskoStatusName(rosskoOrder.statusText);
      const before = states[rosskoOrder.id];
      if (before === undefined || before.code !== code) {
        states[rosskoOrder.id] = { code, name, changedAt: at.toISOString(), handled: false };
        latest = { code, name };
        changed += 1;
        pending.push({
          rosskoOrder,
          code,
          name,
          previousCode: before?.code ?? null,
          changed: true,
          action: rosskoStatusAction(map, code),
        });
        continue;
      }
      if (name !== null && before.name !== name) states[rosskoOrder.id] = { ...before, name };
      if (!before.handled) {
        // Seen before while it was not mapped: act once the map has it.
        const action = rosskoStatusAction(map, code);
        if (action !== null) {
          pending.push({ rosskoOrder, code, name, previousCode: code, changed: false, action });
        }
      }
    }

    const ctx: ApplyContext = {
      deps,
      tx,
      snapshot,
      supplierOrderId: open.id,
      items,
      rosskoOrderCount: row.rosskoOrderIds.length,
      at,
      count,
    };
    for (const action of pending) {
      const handled = await applyAction(ctx, action);
      const state = states[action.rosskoOrder.id];
      if (handled && state !== undefined) states[action.rosskoOrder.id] = { ...state, handled };
    }

    await tx
      .update(supplierOrders)
      .set({
        rosskoStatuses: states,
        statusCheckedAt: at,
        ...(latest === null
          ? {}
          : { statusCode: latest.code, statusName: latest.name, statusChangedAt: at }),
        updatedAt: at,
      })
      .where(eq(supplierOrders.id, open.id));
    return changed;
  });
}

export async function processPollOrders(job: Job, deps: WorkerDeps): Promise<PollOrdersResult> {
  const log = deps.logger.child({ job: 'rossko/poll-orders', jobId: job.id });
  if (deps.env.ROSSKO_MODE !== 'live') return { outcome: 'off', reason: 'not_live' };
  const settings = await loadRosskoSettings(deps.db);
  if (!settings.pollEnabled) return { outcome: 'off', reason: 'disabled' };

  const open = await loadOpenSupplierOrders(deps);
  const ids = [...new Set(open.flatMap((so) => so.rosskoOrderIds))];
  const { seen, calls, failedCalls } = await fetchStatuses(deps, ids);
  const at = deps.now();
  const actions: Record<string, number> = {};
  const count = (action: string) => {
    actions[action] = (actions[action] ?? 0) + 1;
  };
  let changed = 0;
  let errors = 0;
  for (const so of open) {
    const observed = so.rosskoOrderIds.flatMap((id) => {
      const order = seen.get(id);
      return order === undefined ? [] : [order];
    });
    if (observed.length === 0) continue;
    try {
      changed += await applyObserved(deps, so, observed, settings.statusMap, at, count);
    } catch (error) {
      errors += 1;
      log.error({ supplierOrderId: so.id, err: errorText(error) }, 'poll: status not applied');
    }
  }
  if (changed > 0 || Object.keys(actions).length > 0) nudge(deps);
  const result: PollOrdersResult = {
    outcome: 'polled',
    supplierOrders: open.length,
    calls,
    failedCalls,
    changed,
    actions,
    errors,
  };
  log.info({ ...result }, 'rossko poll finished');
  return result;
}
