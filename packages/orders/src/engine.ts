/**
 * applyTransition / persistTransition: the only code that changes orders.status
 * (docs/phase-1b-implementation.md sections 5.1–5.3).
 *
 * applyTransition: one transaction (or the caller's), `select … for update` of the order row,
 * the snapshot, item changes, the context, resolveTransition. When the rule applies, a savepoint
 * holds every write: item states, the order row (status, timestamps, expires_at by the target
 * status, attention_reason, promised_date), effects (table 5.2) as database rows and outbox
 * rows, notifications (outbox notify), the order_events row. A precondition of an effect that
 * does not hold (no payment to refund, no phone for a receipt, payments not configured) rolls the
 * savepoint back and answers guard_failed with its code. After commit: deps.nudge().
 *
 * order_events payloads carry ids, codes and amounts only: never a phone, a name or a token.
 */
import {
  and,
  clientApprovals,
  eq,
  orderEvents,
  orderItems,
  orders,
  sql,
  supplierOrderItems,
  supplierOrders,
  supplierReturns,
  users,
} from '@detaly/db';
import {
  amountMatches,
  amountMismatch,
  effectsFor,
  isIsoDate,
  promisedDate,
  ReceiptLinesError,
  receiptFor,
  RefundPlanError,
  refundReasonFor,
  resolveTransition,
  type ApprovalDecision,
  type OrderEvent,
  type OrderItemState,
  type OrderStatus,
  type PaymentScheme,
  type TransitionContext,
} from '@detaly/domain';
import { v7 as uuidv7 } from 'uuid';
import {
  buildTransitionContext,
  eventItemId,
  eventScope,
  isLiveState,
  itemsAfterChanges,
  planItemChanges,
  refundablePayment,
} from './context';
import { canReachClient, enqueueNotify, enqueueOutbox, recordJournalEvent } from './journal';
import {
  createPaymentRows,
  createRefund,
  EngineError,
  ensureOffsetReceipt,
  type RefundTarget,
} from './rows';
import { loadOrderSettings } from './settings';
import { isUuid, loadOrderSnapshot } from './snapshot';
import type {
  AppliedTransition,
  ApplyInput,
  ApplyResult,
  AttentionReason,
  EngineDeps,
  ItemChange,
  OrderRow,
  OrderSettings,
  OrderSnapshot,
  TransitionDecision,
  TransitionFacts,
  Tx,
} from './types';

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

export function clock(deps: Pick<EngineDeps, 'now'>): Date {
  return deps.now ? deps.now() : new Date();
}

/** deps.nudge after a commit; a failing nudge never fails the transition. */
export function nudge(deps: Pick<EngineDeps, 'nudge'>): void {
  try {
    deps.nudge?.();
  } catch {
    // best effort (decision Б1): the dispatcher polls anyway
  }
}

/** Item states an item event accepts (the item must also be live). */
const ITEM_EVENT_STATES: Partial<Record<OrderEvent, readonly OrderItemState[]>> = {
  item_arrived: ['ordered'],
  item_problem: ['pending', 'ordered'],
  item_damaged_on_receipt: ['ordered', 'arrived'],
  item_cancelled: ['pending', 'ordered'],
  alternative_proposed: ['pending', 'ordered'],
  new_eta_proposed: ['pending', 'ordered'],
};

/** Events that need an item (alternative proposals are always about one item). */
const ITEM_REQUIRED_EVENTS: readonly OrderEvent[] = [
  'item_arrived',
  'item_problem',
  'item_damaged_on_receipt',
  'item_cancelled',
  'alternative_proposed',
];

const PROPOSAL_EVENTS = {
  alternative_proposed: 'alternative',
  new_eta_proposed: 'new_eta',
} as const satisfies Partial<Record<OrderEvent, 'alternative' | 'new_eta'>>;

function isProposalEvent(event: OrderEvent): event is keyof typeof PROPOSAL_EVENTS {
  return event in PROPOSAL_EVENTS;
}

function failure(
  status: OrderStatus | null,
  failed: string[],
  reason: 'guard_failed' | 'no_rule' | 'not_found' = 'guard_failed',
): ApplyResult {
  return { ok: false, reason, failed, status };
}

/** Code of an error that means "an effect precondition does not hold" (savepoint rolled back). */
function refusalCode(error: unknown): string | null {
  if (error instanceof EngineError) return error.code;
  if (error instanceof RefundPlanError) return 'refund_plan';
  if (error instanceof ReceiptLinesError) return 'receipt_lines';
  return null;
}

/**
 * applyTransition inside a transaction the caller opened (the order row is locked here).
 * `preloaded` lets callers that already locked and loaded the order skip the reload.
 */
export async function applyTransitionInTx(
  tx: Tx,
  deps: EngineDeps,
  input: ApplyInput,
  preloaded?: { snapshot: OrderSnapshot; settings?: OrderSettings },
): Promise<ApplyResult> {
  const snapshot =
    preloaded?.snapshot ?? (await loadOrderSnapshot(tx, input.orderId, { lock: true }));
  if (snapshot === null) return failure(null, [], 'not_found');
  const settings = preloaded?.settings ?? (await loadOrderSettings(tx, deps.env));
  const now = clock(deps);
  const { event } = input;
  const status = snapshot.order.status;

  const facts: TransitionFacts = { ...input.facts };
  facts.scope ??= eventScope(event, snapshot, { ...facts, itemId: input.itemId });
  const itemId = eventItemId(event, snapshot, { itemId: input.itemId });

  // The item must belong to the order and be in a state the event accepts.
  if (itemId !== null) {
    const item = snapshot.items.find((i) => i.id === itemId);
    if (item === undefined) return failure(status, ['item']);
    const states = ITEM_EVENT_STATES[event];
    if (states !== undefined && (!isLiveState(item.state) || !states.includes(item.state))) {
      return failure(status, ['item_state']);
    }
  } else if (ITEM_REQUIRED_EVENTS.includes(event)) {
    return failure(status, ['item']);
  }

  if (isProposalEvent(event)) {
    if (facts.proposal?.kind !== PROPOSAL_EVENTS[event]) return failure(status, ['proposal']);
    facts.clientReachable ??= await canReachClient(tx, snapshot.order.id, {
      smsEnabled: deps.env.SMS_PROVIDER !== 'none',
      template: 'decision_needed',
    });
  }
  if (
    (event === 'client_approved' ||
      event === 'client_refund_requested' ||
      event === 'approval_timeout') &&
    snapshot.openApproval === null
  ) {
    return failure(status, ['approval']);
  }

  const changes = planItemChanges(event, snapshot, { ...facts, itemId });
  const ctx = buildTransitionContext(snapshot, input.actor, facts, settings, now, changes);
  const resolved = resolveTransition(status, event, ctx);
  if (!resolved.ok) return failure(status, resolved.failed, resolved.reason);

  try {
    return await tx.transaction((sp) =>
      persistDecision(
        sp,
        snapshot,
        { rule: resolved.rule, ctx, changes },
        { ...input, facts, itemId },
        deps,
        settings,
        now,
      ),
    );
  } catch (error) {
    const code = refusalCode(error);
    if (code === null) throw error;
    return failure(status, [code]);
  }
}

/** Locks the order, resolves the transition and persists it with its effects; nudges after commit. */
export async function applyTransition(deps: EngineDeps, input: ApplyInput): Promise<ApplyResult> {
  if (input.tx) return applyTransitionInTx(input.tx, deps, input);
  const result = await deps.db.transaction((tx) => applyTransitionInTx(tx, deps, input));
  if (result.ok) nudge(deps);
  return result;
}

/**
 * The persisting half of applyTransition for callers that already hold the transaction and
 * the snapshot (checkout inserts the order and then persists `checkout`).
 */
export async function persistTransition(
  tx: Tx,
  snapshot: OrderSnapshot,
  decision: TransitionDecision,
  input: Omit<ApplyInput, 'tx'> & { deps: EngineDeps },
): Promise<AppliedTransition> {
  const { deps, ...rest } = input;
  const settings = await loadOrderSettings(tx, deps.env);
  return persistDecision(tx, snapshot, decision, rest, deps, settings, clock(deps));
}

// ---------------------------------------------------------------------------------------------
// Persisting a decision
// ---------------------------------------------------------------------------------------------

function windowDays(scheme: PaymentScheme, settings: OrderSettings): number {
  return scheme === 'prepay' ? settings.pickupWindowPrepaidDays : settings.pickupWindowCodDays;
}

/** expires_at of a status entered now (section 5.2); null for statuses without a deadline. */
function expiresFor(
  to: OrderStatus,
  order: OrderRow,
  scheme: PaymentScheme,
  settings: OrderSettings,
  at: Date,
): Date | null {
  const t = at.getTime();
  if (to === 'awaiting_confirmation') return new Date(t + settings.onPickupConfirmTtlH * HOUR_MS);
  if (to === 'awaiting_payment') return new Date(t + settings.paymentTtlMin * MINUTE_MS);
  if (to === 'awaiting_handover_payment') {
    return new Date(t + settings.handoverQrTtlMin * MINUTE_MS);
  }
  if (to === 'ready') {
    // The storage window keeps running from the arrival (a QR TTL or a canceled prepay link
    // brings the order back to ready without extending it).
    return new Date((order.receivedAt ?? at).getTime() + windowDays(scheme, settings) * DAY_MS);
  }
  if (to === 'handed') return new Date(t + settings.handedCompleteDays * DAY_MS);
  return null;
}

function attentionReasonFor(
  event: OrderEvent,
  ctx: TransitionContext,
  facts: TransitionFacts,
): AttentionReason | null {
  if (facts.reason) return facts.reason;
  if (event === 'payment_succeeded') {
    return amountMismatch.test(ctx) ? 'amount_mismatch' : 'unexpected_payment';
  }
  if (event === 'supplier_order_requested') {
    return ctx.allAvailable === false ? 'unavailable' : 'price_drift';
  }
  if (event === 'supplier_checkout_succeeded') return 'item_errors';
  if (event === 'supplier_checkout_failed') return 'checkout_failed';
  if (event === 'item_problem') return `item_problem:${facts.problem ?? 'declined'}`;
  return null;
}

function approvalDecisionFor(event: OrderEvent): ApprovalDecision {
  if (event === 'client_approved') return 'approved';
  if (event === 'approval_timeout') return 'timeout';
  return 'refund';
}

/** Events whose create_refund returns one item (scope item). */
const ITEM_REFUND_EVENTS: readonly OrderEvent[] = [
  'item_cancelled',
  'client_refund_requested',
  'approval_timeout',
  'claim_refund_approved',
];

/** The refund an event creates: the event's payment for a late payment, else the held one. */
function refundTargetFor(
  snapshot: OrderSnapshot,
  event: OrderEvent,
  ctx: TransitionContext,
  facts: TransitionFacts,
  itemId: string | null,
): RefundTarget {
  const paymentId =
    event === 'payment_succeeded'
      ? (facts.paymentId ?? null)
      : (refundablePayment(snapshot)?.id ?? null);
  if (paymentId === null) throw new EngineError('no_refundable_payment');
  if (ITEM_REFUND_EVENTS.includes(event) && ctx.scope === 'item') {
    if (itemId === null) throw new EngineError('item');
    return { scope: 'item', paymentId, itemIds: [itemId] };
  }
  return { scope: 'order', paymentId };
}

/** Writes item changes; returns ids of inserted replacement items. */
export async function writeItemChanges(
  tx: Tx,
  orderId: string,
  changes: readonly ItemChange[],
  at: Date,
): Promise<string[]> {
  const inserted: string[] = [];
  for (const change of changes) {
    const where = and(eq(orderItems.id, change.itemId), eq(orderItems.orderId, orderId));
    switch (change.kind) {
      case 'state':
        await tx
          .update(orderItems)
          .set({
            state: change.to,
            updatedAt: at,
            ...(change.to === 'arrived' ? { arrivedAt: change.arrivedAt ?? at } : {}),
            ...('supplierItemError' in change
              ? { supplierItemError: change.supplierItemError ?? null }
              : {}),
          })
          .where(where);
        break;
      case 'eta':
        await tx.update(orderItems).set({ etaDate: change.etaDate, updatedAt: at }).where(where);
        break;
      case 'refunded':
        await tx
          .update(orderItems)
          .set({
            state: 'refunded',
            refundedAmountKop: sql`${orderItems.refundedAmountKop} + ${change.amountKop}`,
            updatedAt: at,
          })
          .where(where);
        break;
      case 'replace': {
        const id = uuidv7();
        await tx.insert(orderItems).values({ ...change.replacement, id, orderId });
        await tx
          .update(orderItems)
          .set({ state: 'replaced', replacedByItemId: id, updatedAt: at })
          .where(where);
        inserted.push(id);
        break;
      }
    }
  }
  return inserted;
}

/**
 * Effect supplier_checkout (decision Б13): one `sending` supplier order with the live pending
 * items and exactly one rossko/checkout job (`checkout:<supplier_order_id>`). An attempt still
 * in flight is kept (the partial unique index allows one `sending` row per order).
 */
async function startSupplierCheckout(
  tx: Tx,
  orderId: string,
): Promise<{ supplierOrderId: string; created: boolean } | null> {
  const [sending] = await tx
    .select({ id: supplierOrders.id })
    .from(supplierOrders)
    .where(and(eq(supplierOrders.orderId, orderId), eq(supplierOrders.status, 'sending')))
    .limit(1);
  if (sending) return { supplierOrderId: sending.id, created: false };
  const pending = await tx
    .select({ id: orderItems.id })
    .from(orderItems)
    .where(and(eq(orderItems.orderId, orderId), eq(orderItems.state, 'pending')));
  if (pending.length === 0) return null;
  const [last] = await tx
    .select({ max: sql<number>`coalesce(max(${supplierOrders.attemptNo}), 0)` })
    .from(supplierOrders)
    .where(eq(supplierOrders.orderId, orderId));
  const supplierOrderId = uuidv7();
  await tx.insert(supplierOrders).values({
    id: supplierOrderId,
    orderId,
    attemptNo: Number(last?.max ?? 0) + 1,
    status: 'sending',
  });
  await tx
    .insert(supplierOrderItems)
    .values(pending.map((item) => ({ supplierOrderId, orderItemId: item.id })));
  await enqueueOutbox(tx, {
    queue: 'rossko',
    name: 'checkout',
    key: `checkout:${supplierOrderId}`,
    data: { supplierOrderId, orderId },
  });
  return { supplierOrderId, created: true };
}

/** promised_date from the live items after the change; null when no item has a date. */
function promisedAfter(
  snapshot: OrderSnapshot,
  changes: readonly ItemChange[],
  settings: OrderSettings,
): string | null {
  const dates = itemsAfterChanges(snapshot.items, changes)
    .filter((item) => isLiveState(item.state) && isIsoDate(item.etaDate))
    .map((item) => item.etaDate as string);
  return dates.length === 0 ? null : promisedDate(dates, settings.eta);
}

async function persistDecision(
  tx: Tx,
  snapshot: OrderSnapshot,
  decision: TransitionDecision,
  input: Omit<ApplyInput, 'tx'>,
  deps: EngineDeps,
  settings: OrderSettings,
  at: Date,
): Promise<AppliedTransition> {
  const { order } = snapshot;
  const { rule, ctx, changes } = decision;
  const { event, actor } = input;
  const facts = input.facts ?? {};
  const from = order.status;
  const to = rule.to;
  const effects = effectsFor(rule, ctx);
  const receiptKind = receiptFor(rule, ctx);
  const itemId = eventItemId(event, snapshot, { itemId: input.itemId });
  const eventId = uuidv7();
  const payload: Record<string, unknown> = { ...(input.payload ?? {}) };
  if (itemId !== null) payload.itemId = itemId;

  // 1. Items.
  const newItemIds = await writeItemChanges(tx, order.id, changes, at);
  if (newItemIds.length > 0) payload.newItemIds = newItemIds;

  // 2. The order row.
  let scheme: PaymentScheme = order.paymentScheme;
  if (effects.includes('set_scheme_prepay')) scheme = 'prepay';
  if (effects.includes('set_scheme_pay_on_handover')) scheme = 'pay_on_handover';
  const patch: Partial<typeof orders.$inferInsert> = { status: to, updatedAt: at };
  if (scheme !== order.paymentScheme) patch.paymentScheme = scheme;
  if (to !== from) {
    patch.expiresAt = expiresFor(to, order, scheme, settings, at);
    if (to === 'confirmed') patch.confirmedAt = order.confirmedAt ?? at;
    if (to === 'ordered_at_supplier') patch.orderedAt = order.orderedAt ?? at;
    if (to === 'completed') patch.completedAt = at;
    if (to === 'cancelled') patch.cancelledAt = at;
    if (from === 'needs_attention') patch.attentionReason = null;
    if (to === 'needs_attention') {
      const reason = attentionReasonFor(event, ctx, facts);
      patch.attentionReason = reason;
      if (reason !== null) payload.reason = reason;
    }
  }
  if (event === 'payment_succeeded') {
    if (amountMatches.test(ctx)) patch.paidAt = order.paidAt ?? at;
    if (facts.paymentId) payload.paymentId = facts.paymentId;
    // The handover payment is in: the QR deadline no longer applies.
    if (to === 'awaiting_handover_payment') patch.expiresAt = null;
  }
  if (changes.some((c) => c.kind === 'state' && c.to === 'failed')) {
    // Nothing was paid for a failed item (pay_on_handover): the amount to pay shrinks with it,
    // so the handover payment and its receipt still equal orders.total_kop.
    const live = itemsAfterChanges(snapshot.items, changes).filter((i) => isLiveState(i.state));
    const subtotal = live.reduce((sum, item) => sum + item.priceClientKop * item.qty, 0);
    patch.subtotalKop = subtotal;
    patch.totalKop = subtotal + order.courierFeeKop;
  }
  if (
    (event === 'supplier_checkout_succeeded' && to !== 'needs_attention') ||
    event === 'client_approved'
  ) {
    const promised = promisedAfter(snapshot, changes, settings);
    if (promised !== null) patch.promisedDate = promised;
  }

  // 3. Effects (table 5.2).
  for (const effect of effects) {
    switch (effect) {
      case 'set_scheme_prepay':
      case 'set_scheme_pay_on_handover':
      case 'create_payment':
        // Scheme and expires_at are in the patch; the payment itself is lazy (decision Б5).
        break;
      case 'create_handover_payment': {
        const created = await createPaymentRows(tx, snapshot, {
          kind: 'full',
          confirmation: 'qr',
          returnUrl: `${deps.env.APP_BASE_URL}/o/${order.accessToken}`,
          env: deps.env,
        });
        await enqueueOutbox(tx, {
          queue: 'payments',
          name: 'payment-create',
          key: `payment-create:${created.paymentRowId}`,
          data: { paymentId: created.paymentRowId, orderId: order.id },
        });
        payload.paymentId = created.paymentRowId;
        break;
      }
      case 'create_refund': {
        const target = refundTargetFor(snapshot, event, ctx, facts, itemId);
        const refund = await createRefund(tx, snapshot, {
          ...target,
          reason: refundReasonFor(event, { amountMismatch: amountMismatch.test(ctx) }),
          requestedAt: at,
          actor,
          env: deps.env,
        });
        payload.refundId = refund.refundId;
        payload.refundKop = refund.amountKop;
        break;
      }
      case 'start_approval_timer': {
        const proposal = facts.proposal;
        if (proposal === undefined) throw new EngineError('proposal');
        const scope = ctx.scope === 'item' && itemId !== null ? 'item' : 'order';
        const [approval] = await tx
          .insert(clientApprovals)
          .values({
            orderId: order.id,
            orderItemId: scope === 'item' ? itemId : null,
            kind: proposal.kind,
            scope,
            proposal,
            // A staff id only when the actor is a staff row (the admin acts as 'admin').
            createdByStaffId: actor.type === 'staff' && isUuid(actor.id) ? actor.id : null,
          })
          .returning({ id: clientApprovals.id });
        payload.approvalId = approval?.id;
        break;
      }
      case 'start_pickup_window':
        patch.receivedAt = at;
        patch.expiresAt = new Date(at.getTime() + windowDays(scheme, settings) * DAY_MS);
        patch.supplierReturnDeadlineAt = new Date(
          at.getTime() + settings.supplierReturnDays * DAY_MS,
        );
        break;
      case 'start_completion_timer':
        patch.handedAt = at;
        patch.expiresAt = new Date(at.getTime() + settings.handedCompleteDays * DAY_MS);
        break;
      case 'mark_client_arrived':
        patch.clientArrivedAt = order.clientArrivedAt ?? at;
        break;
      case 'no_show_increment':
        await tx
          .update(users)
          .set({ noShowCount: sql`${users.noShowCount} + 1`, updatedAt: at })
          .where(eq(users.id, order.userId));
        break;
      case 'supplier_checkout': {
        const started = await startSupplierCheckout(tx, order.id);
        if (started) payload.supplierOrderId = started.supplierOrderId;
        break;
      }
      case 'supplier_claim_and_reorder': {
        const old = snapshot.items.find((i) => i.id === itemId);
        if (old === undefined) throw new EngineError('item');
        const [claim] = await tx
          .insert(supplierReturns)
          .values({
            orderItemId: old.id,
            kind: 'claim',
            status: 'requested',
            amountExpectedKop: old.priceSupplierAtOrderKop * old.qty,
            note: 'damaged_on_receipt',
          })
          .returning({ id: supplierReturns.id });
        await recordJournalEvent(tx, {
          orderId: order.id,
          type: 'supplier_return_created',
          actor,
          payload: { supplierReturnIds: [claim?.id], kind: 'claim', itemIds: [old.id] },
          at,
        });
        const started = await startSupplierCheckout(tx, order.id);
        if (started) payload.supplierOrderId = started.supplierOrderId;
        break;
      }
      case 'supplier_return_task': {
        const arrived = snapshot.items.filter((i) => i.state === 'arrived');
        if (arrived.length === 0) break;
        const rows = await tx
          .insert(supplierReturns)
          .values(
            arrived.map((item) => ({
              orderItemId: item.id,
              kind: 'return' as const,
              status: 'requested' as const,
              amountExpectedKop: item.priceSupplierAtOrderKop * item.qty,
            })),
          )
          .returning({ id: supplierReturns.id });
        await recordJournalEvent(tx, {
          orderId: order.id,
          type: 'supplier_return_created',
          actor,
          payload: {
            supplierReturnIds: rows.map((r) => r.id),
            kind: 'return',
            itemIds: arrived.map((i) => i.id),
          },
          at,
        });
        break;
      }
      case 'cancel_at_supplier_task':
        // The task itself is the sellers' notification (staff_cancel_at_supplier_task).
        payload.tasks = ['cancel_at_supplier'];
        break;
      case 'open_claim':
        // Claims arrive in phase 1C: the request is kept in the journal.
        await recordJournalEvent(tx, {
          orderId: order.id,
          type: 'claim_deferred',
          actor,
          payload: { orderEventId: eventId },
          at,
        });
        break;
    }
  }

  // 4. Receipt of the rule (prepayment/full: the payment's own row; refund_*: createRefund).
  if (receiptKind === 'offset') {
    const offset = await ensureOffsetReceipt(tx, snapshot, {
      env: deps.env,
      retryKey: event === 'offset_receipt_requested' ? eventId : null,
    });
    payload.receiptId = offset.receiptId;
  }
  if (receiptKind !== null) payload.receipt = receiptKind;

  // 5. Event-specific rows.
  if (event === 'supplier_invoice_paid') {
    const ref = typeof payload.paymentRef === 'string' ? payload.paymentRef : null;
    await tx
      .update(supplierOrders)
      .set({ invoicePaidAt: at, invoicePaymentRef: ref, updatedAt: at })
      .where(
        and(
          eq(supplierOrders.orderId, order.id),
          eq(supplierOrders.status, 'created'),
          sql`${supplierOrders.invoicePaidAt} is null`,
        ),
      );
  }
  if (from === 'awaiting_client_approval' && to !== from && snapshot.openApproval !== null) {
    await tx
      .update(clientApprovals)
      .set({ decidedAt: at, decision: approvalDecisionFor(event), updatedAt: at })
      .where(eq(clientApprovals.id, snapshot.openApproval.id));
    payload.approvalId = snapshot.openApproval.id;
  }

  await tx.update(orders).set(patch).where(eq(orders.id, order.id));

  // 6. The journal row of the transition, then its notifications.
  await tx.insert(orderEvents).values({
    id: eventId,
    orderId: order.id,
    type: event,
    fromStatus: from,
    toStatus: to,
    actorType: actor.type,
    actorId: actor.id,
    payload: { ...payload, rule: rule.label, ...(effects.length > 0 ? { effects } : {}) },
    createdAt: at,
  });
  for (const spec of rule.notify) {
    await enqueueNotify(tx, {
      orderId: order.id,
      orderEventId: eventId,
      audience: spec.audience,
      template: spec.template,
    });
  }

  return { ok: true, orderEventId: eventId, from, to, rule, effects };
}
