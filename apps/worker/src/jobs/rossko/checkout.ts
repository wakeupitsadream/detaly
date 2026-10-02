/**
 * rossko/checkout {supplierOrderId} and rossko/recover {supplierOrderId} (decisions Б13–Б15,
 * docs/phase-1b-implementation.md section 11).
 *
 * Double-submit protection: the `sending` supplier_orders row exists before the job (effect
 * supplier_checkout). The job claims it by setting `called_at` in its own committed statement
 * (`... where status = 'sending' and called_at is null`) and only then calls GetCheckout. A job
 * that finds `called_at` already set never calls GetCheckout: it queues the recovery instead.
 * GetCheckout is never repeated automatically; the queue policy gives checkout one attempt.
 *
 * Outcomes:
 * - an answer (or an order found again by its comment) -> the row becomes `created` (or `failed`
 *   when Rossko created nothing), `supplier_checkout_succeeded` with the covered items and the
 *   item errors (order -> ordered_at_supplier / awaiting_supplier_invoice / needs_attention);
 * - CheckoutDisabledError (ROSSKO_ALLOW_CHECKOUT=false) -> `failed`, `supplier_checkout_failed`
 *   with reason `checkout_disabled`, no GetCheckout call;
 * - an error raised before the request left the process (config, limiter, quota) -> `failed`,
 *   `supplier_checkout_failed` with reason `checkout_failed`;
 * - an ambiguous error (timeout, connection reset, 5xx, unparsable reply) -> the row stays
 *   `sending` and rossko/recover is queued: GetOrders without ids, the order is looked up by the
 *   comment `DT-000123/<attempt>`; found -> as a successful GetCheckout, not found or the list is
 *   not supported -> `failed`, `supplier_checkout_failed` with `unknown_after_timeout` and an alert
 *   «Проверьте ЛК Rossko: заказ мог создаться».
 *
 * Every row update and its transition run in one transaction under the order row lock (the order
 * first, then the supplier_orders row, like the engine).
 */
import { and, eq, isNull, orders, supplierOrders } from '@detaly/db';
import type { Kop } from '@detaly/domain';
import {
  applyTransition,
  enqueueOutbox,
  loadOrderSettings,
  ORDER_STATUS_LABELS,
  loadOrderSnapshot,
  type ApplyResult,
  type AttentionReason,
  type OrderItemRow,
  type OrderSnapshot,
  type SupplierOrderRow,
  type Tx,
} from '@detaly/orders';
import {
  CheckoutDisabledError,
  CheckoutMatchError,
  checkoutComment,
  checkoutMayHaveExecuted,
  checkoutResultFromOrders,
  findOrdersByComment,
  matchCheckoutResult,
  UNSUPPORTED_CODE,
  RosskoCallError,
  type CheckoutMatch,
  type CheckoutMatchRequest,
  type CheckoutRequest,
  type CheckoutResult,
} from '@detaly/rossko';
import type { Job } from 'bullmq';
import type { WorkerDeps } from '../../deps';
import {
  SYSTEM_ACTOR,
  errorText,
  isFinalAttempt,
  nudge,
  recoverDelayMs,
  uuidField,
} from './shared';

/** Order statuses in which a supplier order attempt may be sent. */
const CHECKOUT_STATUSES = ['ordering', 'ordered_at_supplier'] as const;

/** supplier_checkout_failed reasons (orders.attention_reason). */
export type CheckoutFailureReason = Extract<
  AttentionReason,
  'checkout_disabled' | 'checkout_failed' | 'unknown_after_timeout'
>;

/** supplier_item_error of an item the answer does not mention (its fate is unknown). */
export const UNMATCHED_ITEM_ERROR = {
  code: 'unmatched',
  message: 'Позиции нет в ответе Rossko: проверьте ЛК Rossko, прежде чем заказывать снова',
} as const;

export type CheckoutJobResult =
  | {
      outcome: 'skipped';
      reason: 'not_found' | 'not_sending' | 'claimed' | 'not_called';
    }
  | { outcome: 'recover_queued'; reason: 'called_before' | 'ambiguous_error' | 'claimed' }
  | { outcome: 'cancelled'; status: string }
  | SettleResult;

export type SettleResult =
  | {
      outcome: 'created' | 'failed';
      supplierOrderId: string;
      transition: ApplyResult;
      reason?: CheckoutFailureReason;
      itemErrors?: number;
    }
  | { outcome: 'stale'; supplierOrderId: string };

type Outcome =
  | { kind: 'result'; result: CheckoutResult; source: 'checkout' | 'recover' }
  | { kind: 'failed'; reason: CheckoutFailureReason; error: string; recovered: boolean };

// ---------------------------------------------------------------------------------------------
// Reading the attempt
// ---------------------------------------------------------------------------------------------

async function supplierOrderRow(
  deps: WorkerDeps,
  supplierOrderId: string,
): Promise<SupplierOrderRow | null> {
  const [row] = await deps.db
    .select()
    .from(supplierOrders)
    .where(eq(supplierOrders.id, supplierOrderId));
  return row ?? null;
}

/** The order items of the attempt (supplier_order_items) as GetCheckout lines. */
function requestedItems(snapshot: OrderSnapshot, supplierOrderId: string): OrderItemRow[] {
  const view = snapshot.supplierOrders.find((row) => row.id === supplierOrderId);
  const ids = new Set(view?.itemIds ?? []);
  return snapshot.items.filter((item) => ids.has(item.id));
}

function matchRequest(items: readonly OrderItemRow[]): CheckoutMatchRequest[] {
  return items.map((item) => ({
    id: item.id,
    brand: item.brand,
    article: item.article,
    stockId: item.stockId,
    count: item.qty,
  }));
}

async function queueRecover(
  deps: Pick<WorkerDeps, 'db' | 'env' | 'now' | 'engine'>,
  row: Pick<SupplierOrderRow, 'id' | 'orderId'>,
): Promise<void> {
  await enqueueOutbox(deps.db, {
    queue: 'rossko',
    name: 'recover',
    key: `recover:${row.id}`,
    data: { supplierOrderId: row.id, orderId: row.orderId },
    availableAt: new Date(deps.now().getTime() + recoverDelayMs(deps.env)),
  });
  nudge(deps);
}

// ---------------------------------------------------------------------------------------------
// rossko/checkout
// ---------------------------------------------------------------------------------------------

export async function processCheckout(job: Job, deps: WorkerDeps): Promise<CheckoutJobResult> {
  const supplierOrderId = uuidField(job, 'supplierOrderId');
  const log = deps.logger.child({ job: 'rossko/checkout', supplierOrderId, jobId: job.id });

  const row = await supplierOrderRow(deps, supplierOrderId);
  if (row === null) return { outcome: 'skipped', reason: 'not_found' };
  if (row.status !== 'sending') return { outcome: 'skipped', reason: 'not_sending' };
  if (row.calledAt !== null) {
    // A previous run may have reached Rossko: never call GetCheckout again (decision Б13).
    log.warn('checkout: called_at already set, queueing recovery');
    await queueRecover(deps, row);
    return { outcome: 'recover_queued', reason: 'called_before' };
  }

  const snapshot = await loadOrderSnapshot(deps.db, row.orderId, { lock: false });
  if (snapshot === null) return { outcome: 'skipped', reason: 'not_found' };
  const status = snapshot.order.status;
  if (!(CHECKOUT_STATUSES as readonly string[]).includes(status)) {
    // The order moved on (cancelled, refunded) before the call: nothing is sent to Rossko.
    await deps.db
      .update(supplierOrders)
      .set({ status: 'failed', error: `order_status:${status}`, updatedAt: deps.now() })
      .where(and(eq(supplierOrders.id, row.id), eq(supplierOrders.status, 'sending')));
    log.info({ status }, 'checkout cancelled: order is no longer ordering');
    return { outcome: 'cancelled', status };
  }

  const items = requestedItems(snapshot, row.id);
  if (items.length === 0) {
    return settle(deps, row.id, {
      kind: 'failed',
      reason: 'checkout_failed',
      error: 'no_items',
      recovered: false,
    });
  }
  if (!deps.env.ROSSKO_ALLOW_CHECKOUT) {
    // Technical ban (PLAN section 8.4): the client would refuse anyway; do not even claim.
    return settle(deps, row.id, {
      kind: 'failed',
      reason: 'checkout_disabled',
      error: new CheckoutDisabledError().message,
      recovered: false,
    });
  }

  const comment = checkoutComment(snapshot.order.number, row.attemptNo);
  const request: CheckoutRequest = {
    comment,
    items: items.map((item) => ({
      brand: item.brand,
      article: item.article,
      stockId: item.stockId,
      count: item.qty,
    })),
  };

  // The claim is its own committed transaction: from here on a retry must not call GetCheckout.
  // It holds the order row lock (as every transition does), so a cancellation either lands
  // before the claim (nothing is sent) or after it (the result is reported as late).
  const now = deps.now();
  const claim = await deps.db.transaction(async (tx: Tx) => {
    const [locked] = await tx
      .select({ status: orders.status })
      .from(orders)
      .where(eq(orders.id, row.orderId))
      .for('update');
    const current = locked?.status ?? null;
    if (current === null || !(CHECKOUT_STATUSES as readonly string[]).includes(current)) {
      await tx
        .update(supplierOrders)
        .set({ status: 'failed', error: `order_status:${current ?? 'missing'}`, updatedAt: now })
        .where(and(eq(supplierOrders.id, row.id), eq(supplierOrders.status, 'sending')));
      return { claimed: false as const, cancelled: current ?? 'missing' };
    }
    const updated = await tx
      .update(supplierOrders)
      .set({
        calledAt: now,
        request: {
          comment,
          items: items.map((item, i) => ({ orderItemId: item.id, ...request.items[i] })),
        },
        updatedAt: now,
      })
      .where(
        and(
          eq(supplierOrders.id, row.id),
          eq(supplierOrders.status, 'sending'),
          isNull(supplierOrders.calledAt),
        ),
      )
      .returning({ id: supplierOrders.id });
    return { claimed: updated.length > 0, cancelled: null };
  });
  if (claim.cancelled !== null) {
    log.info({ status: claim.cancelled }, 'checkout cancelled: order is no longer ordering');
    return { outcome: 'cancelled', status: claim.cancelled };
  }
  if (!claim.claimed) {
    // Another run claimed the attempt meanwhile; whatever it did, recovery decides.
    await queueRecover(deps, row);
    return { outcome: 'recover_queued', reason: 'claimed' };
  }

  let result: CheckoutResult;
  try {
    result = await deps.rossko.checkout(request);
  } catch (error) {
    if (error instanceof CheckoutDisabledError) {
      return settle(deps, row.id, {
        kind: 'failed',
        reason: 'checkout_disabled',
        error: error.message,
        recovered: false,
      });
    }
    if (checkoutMayHaveExecuted(error)) {
      log.warn({ err: errorText(error) }, 'checkout: outcome unknown, queueing recovery');
      await deps.db
        .update(supplierOrders)
        .set({ error: errorText(error), updatedAt: deps.now() })
        .where(eq(supplierOrders.id, row.id));
      await queueRecover(deps, row);
      return { outcome: 'recover_queued', reason: 'ambiguous_error' };
    }
    log.warn({ err: errorText(error) }, 'checkout failed before sending');
    return settle(deps, row.id, {
      kind: 'failed',
      reason: 'checkout_failed',
      error: errorText(error),
      recovered: false,
    });
  }
  return settle(deps, row.id, { kind: 'result', result, source: 'checkout' });
}

// ---------------------------------------------------------------------------------------------
// rossko/recover
// ---------------------------------------------------------------------------------------------

export async function processRecover(job: Job, deps: WorkerDeps): Promise<CheckoutJobResult> {
  const supplierOrderId = uuidField(job, 'supplierOrderId');
  const log = deps.logger.child({ job: 'rossko/recover', supplierOrderId, jobId: job.id });

  const row = await supplierOrderRow(deps, supplierOrderId);
  if (row === null) return { outcome: 'skipped', reason: 'not_found' };
  if (row.status !== 'sending') return { outcome: 'skipped', reason: 'not_sending' };
  // Nothing was sent: the checkout job owns the attempt.
  if (row.calledAt === null) return { outcome: 'skipped', reason: 'not_called' };

  const snapshot = await loadOrderSnapshot(deps.db, row.orderId, { lock: false });
  if (snapshot === null) return { outcome: 'skipped', reason: 'not_found' };
  const comment = checkoutComment(snapshot.order.number, row.attemptNo);

  let found: CheckoutResult | null;
  try {
    // VERIFY: GetOrders without order_ids lists recent account orders and echoes the comment
    // (docs/external.md R11, R16).
    const recent = await deps.rossko.recentOrders({ since: row.calledAt });
    const orders = findOrdersByComment(recent.orders, comment);
    found = orders.length > 0 ? checkoutResultFromOrders(orders) : null;
  } catch (error) {
    const unsupported = error instanceof RosskoCallError && error.code === UNSUPPORTED_CODE;
    if (!unsupported && !isFinalAttempt(job)) {
      log.warn({ err: errorText(error), attemptsMade: job.attemptsMade }, 'recover: retry');
      throw error;
    }
    return settle(deps, row.id, {
      kind: 'failed',
      reason: 'unknown_after_timeout',
      error: unsupported ? 'orders_list_unsupported' : errorText(error),
      recovered: true,
    });
  }
  if (found === null) {
    return settle(deps, row.id, {
      kind: 'failed',
      reason: 'unknown_after_timeout',
      error: 'not_found_by_comment',
      recovered: true,
    });
  }
  log.info({ rosskoOrders: found.orderIds.length }, 'recover: order found by comment');
  return settle(deps, row.id, { kind: 'result', result: found, source: 'recover' });
}

// ---------------------------------------------------------------------------------------------
// Settling the attempt: supplier_orders row + transition in one transaction
// ---------------------------------------------------------------------------------------------

interface ResultPlan {
  created: boolean;
  /** Our lines Rossko refused explicitly (ItemsErrorList). */
  refused: number;
  coveredItemIds: string[];
  itemErrors: { orderItemId: string; error: unknown }[];
  match: CheckoutMatch | null;
  matchError: string | null;
}

/**
 * Splits the answer over the requested items. Lines Rossko does not mention (or that cannot be
 * told apart) are reported as item errors `unmatched`: the order goes to needs_attention and the
 * seller checks the Rossko account before ordering them again.
 */
function planResult(items: readonly OrderItemRow[], result: CheckoutResult): ResultPlan {
  const requested = matchRequest(items);
  const created = result.orderIds.length > 0 || result.items.length > 0;
  if (created && result.items.length === 0 && result.itemErrors.length === 0) {
    // VERIFY (docs/external.md R20, R10, R16): an order id without ItemsList/ItemsErrorList
    // means every line was accepted (also a recovered order whose GetOrders lines are missing).
    return {
      created,
      refused: 0,
      coveredItemIds: items.map((item) => item.id),
      itemErrors: [],
      match: null,
      matchError: null,
    };
  }
  let match: CheckoutMatch;
  try {
    match = matchCheckoutResult(requested, result);
  } catch (error) {
    if (!(error instanceof CheckoutMatchError)) throw error;
    return {
      created,
      refused: 0,
      coveredItemIds: [],
      itemErrors: items.map((item) => ({ orderItemId: item.id, error: UNMATCHED_ITEM_ERROR })),
      match: null,
      matchError: `${error.code}: ${error.message}`,
    };
  }
  return {
    created,
    refused: match.failed.length,
    coveredItemIds: match.covered.map((entry) => entry.id),
    itemErrors: [
      ...match.failed.map((entry) => ({ orderItemId: entry.id, error: entry.error })),
      ...match.unmatched.map((id) => ({ orderItemId: id, error: UNMATCHED_ITEM_ERROR })),
    ],
    match,
    matchError: null,
  };
}

/**
 * Rossko invoice of the attempt (settings rossko.prepay_invoice): the Rossko order numbers and
 * Σ ordered lines + delivery. The lines are Rossko's own ItemsList (it bills what it ordered,
 * including a line we cannot match); only without ItemsList the covered items count.
 * VERIFY (docs/external.md R19, R7): the invoice number equals the Rossko order id and its
 * amount equals the lines plus DeliveryCost; a line without a price counts at our supplier price.
 */
function invoiceOf(
  items: readonly OrderItemRow[],
  plan: ResultPlan,
  result: CheckoutResult,
): { invoiceNumber: string | null; invoiceAmountKop: Kop } {
  const byId = new Map(items.map((item) => [item.id, item]));
  let linesKop = 0;
  if (result.items.length > 0) {
    const coveredBy = new Map((plan.match?.covered ?? []).map(({ id, line }) => [line, id]));
    for (const line of result.items) {
      const id = coveredBy.get(line);
      const item = id === undefined ? undefined : byId.get(id);
      const unitKop = line.priceKop ?? item?.priceSupplierAtOrderKop ?? 0;
      linesKop += unitKop * line.count;
    }
  } else {
    for (const id of plan.coveredItemIds) {
      const item = byId.get(id);
      if (item) linesKop += item.priceSupplierAtOrderKop * item.qty;
    }
  }
  return {
    invoiceNumber: result.orderIds.length > 0 ? result.orderIds.join(', ') : null,
    invoiceAmountKop: linesKop + (result.deliveryCostKop ?? 0),
  };
}

/** Alert text without PD: the order number and the Rossko numbers only. */
function lateResultAlert(orderNumber: string, situation: string, rosskoIds: string[]): string {
  const ids = rosskoIds.length > 0 ? ` (№ ${rosskoIds.join(', ')})` : '';
  return (
    `Заказ ${orderNumber}: Rossko принял заказ${ids}, но ${situation}. ` +
    'Проверьте ЛК Rossko и при необходимости отмените заказ у поставщика.'
  );
}

/** «заказ уже в статусе «отменён»» for a refused transition. */
function orderStatusSituation(status: string): string {
  const label = (ORDER_STATUS_LABELS as Record<string, string>)[status] ?? status;
  return `заказ уже в статусе «${label}»`;
}

/**
 * A result that arrives after the attempt was settled by another run. null when that run
 * recorded the very same Rossko orders (recovery found what this GetCheckout created): nothing
 * to report, an alert would make the seller cancel a correct supplier order.
 */
function staleSituation(
  row: SupplierOrderRow | undefined,
  rosskoIds: readonly string[],
): string | null {
  if (row?.status === 'created') {
    const known = new Set(row.rosskoOrderIds ?? []);
    if (rosskoIds.every((id) => known.has(id))) return null;
    return 'эта попытка уже отмечена с другими номерами Rossko';
  }
  if (row?.status === 'failed') return 'эта попытка уже закрыта как несостоявшаяся';
  return 'эта попытка уже закрыта';
}

async function settle(
  deps: WorkerDeps,
  supplierOrderId: string,
  outcome: Outcome,
): Promise<SettleResult> {
  const log = deps.logger.child({ job: 'rossko/settle', supplierOrderId });
  const head = await supplierOrderRow(deps, supplierOrderId);
  if (head === null) return { outcome: 'stale', supplierOrderId };
  const at = deps.now();

  const settled = await deps.db.transaction(async (tx: Tx) => {
    // Lock order: the order row first, then the attempt (as the engine does).
    const snapshot = await loadOrderSnapshot(tx, head.orderId, { lock: true });
    const [row] = await tx
      .select()
      .from(supplierOrders)
      .where(eq(supplierOrders.id, supplierOrderId))
      .for('update');
    if (snapshot === null || row === undefined || row.status !== 'sending') {
      return { stale: true as const, orderNumber: snapshot?.order.number ?? null, row };
    }

    if (outcome.kind === 'failed') {
      await tx
        .update(supplierOrders)
        .set({
          status: 'failed',
          error: outcome.error,
          ...(outcome.recovered ? { recoveredAt: at } : {}),
          updatedAt: at,
        })
        .where(eq(supplierOrders.id, row.id));
      const transition = await applyTransition(deps.engine, {
        orderId: row.orderId,
        event: 'supplier_checkout_failed',
        actor: SYSTEM_ACTOR,
        facts: { reason: outcome.reason },
        payload: { supplierOrderId: row.id, attemptNo: row.attemptNo, error: outcome.reason },
        tx,
      });
      return {
        stale: false as const,
        orderNumber: snapshot.order.number,
        status: snapshot.order.status,
        transition,
        result: null,
        plan: null,
      };
    }

    const { result } = outcome;
    const items = requestedItems(snapshot, row.id);
    const plan = planResult(items, result);
    const settings = await loadOrderSettings(tx, deps.env);
    const invoice =
      plan.created && settings.eta.prepayInvoice ? invoiceOf(items, plan, result) : null;
    await tx
      .update(supplierOrders)
      .set({
        status: plan.created ? 'created' : 'failed',
        rosskoOrderIds: result.orderIds,
        response: {
          ...result,
          source: outcome.source,
          match: {
            covered: plan.coveredItemIds,
            itemErrors: plan.itemErrors.map((entry) => entry.orderItemId),
            unexpectedItems: plan.match?.unexpectedItems ?? [],
            unexpectedErrors: plan.match?.unexpectedErrors ?? [],
          },
        },
        itemErrors: result.itemErrors.length > 0 ? result.itemErrors : null,
        deliveryCostKop: result.deliveryCostKop,
        error: plan.matchError ?? (plan.created ? null : (result.message ?? 'nothing_created')),
        ...(outcome.source === 'recover' ? { recoveredAt: at } : {}),
        ...(invoice ?? {}),
        updatedAt: at,
      })
      .where(eq(supplierOrders.id, row.id));

    // An answer that ordered nothing and refused none of our lines is a failed checkout.
    const answered = plan.created || plan.refused > 0;
    const transition = answered
      ? await applyTransition(deps.engine, {
          orderId: row.orderId,
          event: 'supplier_checkout_succeeded',
          actor: SYSTEM_ACTOR,
          facts: {
            supplierItemErrors: plan.itemErrors.length,
            coveredItemIds: plan.coveredItemIds,
            itemErrors: plan.itemErrors,
            ...(plan.itemErrors.length > 0 ? { reason: 'item_errors' as const } : {}),
          },
          payload: {
            supplierOrderId: row.id,
            attemptNo: row.attemptNo,
            rosskoOrderIds: result.orderIds,
            source: outcome.source,
            itemErrors: plan.itemErrors.length,
          },
          tx,
        })
      : await applyTransition(deps.engine, {
          orderId: row.orderId,
          event: 'supplier_checkout_failed',
          actor: SYSTEM_ACTOR,
          facts: { reason: 'checkout_failed' },
          payload: {
            supplierOrderId: row.id,
            attemptNo: row.attemptNo,
            source: outcome.source,
            error: 'checkout_failed',
          },
          tx,
        });
    return {
      stale: false as const,
      orderNumber: snapshot.order.number,
      status: snapshot.order.status,
      transition,
      result,
      plan,
    };
  });

  if (settled.stale) {
    // Recovery (or another run) settled the attempt first. A real answer is still reported.
    const situation =
      outcome.kind === 'result' && outcome.result.orderIds.length > 0
        ? staleSituation(settled.row, outcome.result.orderIds)
        : null;
    if (outcome.kind === 'result' && situation !== null) {
      await deps.alerts.send({
        audience: 'sellers',
        text: lateResultAlert(settled.orderNumber ?? '—', situation, outcome.result.orderIds),
        dedupeKey: `rossko-late:${supplierOrderId}`,
      });
    }
    log.warn({ status: settled.row?.status }, 'settle: attempt is no longer sending');
    return { outcome: 'stale', supplierOrderId };
  }

  nudge(deps);
  const { transition, orderNumber } = settled;
  if (!transition.ok) {
    log.warn(
      { reason: transition.reason, failed: transition.failed, status: transition.status },
      'settle: transition refused',
    );
    if (settled.result !== null && settled.plan?.created) {
      await deps.alerts.send({
        audience: 'sellers',
        text: lateResultAlert(
          orderNumber,
          orderStatusSituation(settled.status),
          settled.result.orderIds,
        ),
        dedupeKey: `rossko-late:${supplierOrderId}`,
      });
    }
  }

  if (outcome.kind === 'failed') {
    if (outcome.reason === 'unknown_after_timeout') {
      await deps.alerts.send({
        audience: 'sellers',
        text:
          `Заказ ${orderNumber}: Rossko не подтвердил заказ после сбоя связи. ` +
          'Проверьте ЛК Rossko: заказ мог создаться. Не заказывайте повторно, пока не проверите; ' +
          'если заказ есть — отметьте его в админке «Заказано вручную в ЛК Rossko».',
        dedupeKey: `rossko-unknown:${supplierOrderId}`,
      });
    }
    log.info({ reason: outcome.reason }, 'supplier order failed');
    return {
      outcome: 'failed',
      supplierOrderId,
      transition,
      reason: outcome.reason,
    };
  }

  const plan = settled.plan as ResultPlan;
  const unexpected = plan.match?.unexpectedItems.length ?? 0;
  if (unexpected > 0) {
    await deps.alerts.send({
      audience: 'sellers',
      text:
        `Заказ ${orderNumber}: в ответе Rossko есть позиции, которых мы не заказывали ` +
        `(${unexpected}). Проверьте ЛК Rossko.`,
      dedupeKey: `rossko-unexpected:${supplierOrderId}`,
    });
  }
  log.info(
    {
      created: plan.created,
      itemErrors: plan.itemErrors.length,
      to: transition.ok ? transition.to : null,
    },
    'supplier order settled',
  );
  return {
    outcome: plan.created ? 'created' : 'failed',
    supplierOrderId,
    transition,
    itemErrors: plan.itemErrors.length,
    ...(plan.created || plan.refused > 0 ? {} : { reason: 'checkout_failed' as const }),
  };
}
