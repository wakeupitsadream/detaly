/**
 * Pure part of the engine: the transition context derived from a snapshot (buildTransitionContext)
 * and the item changes of an event (planItemChanges, docs/phase-1b-implementation.md section 5.3).
 * No I/O and no clock: `now` is passed in.
 */
import {
  DROPPED_ORDER_ITEM_STATES,
  liveItemsAllArrived,
  marginBp,
  type OrderEvent,
  type OrderItemState,
  type TransitionContext,
} from '@detaly/domain';
import type {
  ActorRef,
  ItemChange,
  OrderItemRow,
  OrderSettings,
  OrderSnapshot,
  PaymentRow,
  TransitionFacts,
} from './types';

const DROPPED: readonly OrderItemState[] = DROPPED_ORDER_ITEM_STATES;

/** A live item belongs to the order: not failed, replaced, refund_pending or refunded. */
export function isLiveState(state: OrderItemState): boolean {
  return !DROPPED.includes(state);
}

/** Items reduced to what the context needs after the planned changes. */
export interface VirtualItem {
  id: string;
  state: OrderItemState;
  qty: number;
  priceClientKop: number;
  priceSupplierAtOrderKop: number;
  etaDate: string | null;
}

function toVirtual(item: OrderItemRow): VirtualItem {
  return {
    id: item.id,
    state: item.state,
    qty: item.qty,
    priceClientKop: item.priceClientKop,
    priceSupplierAtOrderKop: item.priceSupplierAtOrderKop,
    etaDate: item.etaDate,
  };
}

/** The items as they will be after `changes` (replacements get the id `new:<n>`). */
export function itemsAfterChanges(
  items: readonly OrderItemRow[],
  changes: readonly ItemChange[],
): VirtualItem[] {
  const result = items.map(toVirtual);
  const byId = new Map(result.map((item) => [item.id, item]));
  let n = 0;
  for (const change of changes) {
    const item = byId.get(change.itemId);
    if (item === undefined) continue;
    switch (change.kind) {
      case 'state':
        item.state = change.to;
        break;
      case 'eta':
        item.etaDate = change.etaDate;
        break;
      case 'refunded':
        item.state = 'refunded';
        break;
      case 'replace': {
        item.state = 'replaced';
        const r = change.replacement;
        n += 1;
        result.push({
          id: `new:${n}`,
          state: r.state ?? 'pending',
          qty: r.qty,
          priceClientKop: r.priceClientKop,
          priceSupplierAtOrderKop: r.priceSupplierAtOrderKop,
          etaDate: r.etaDate ?? null,
        });
        break;
      }
    }
  }
  return result;
}

/** Sum of non-failed refunds of a payment by status. */
function refundSums(snapshot: OrderSnapshot, paymentId: string) {
  let succeeded = 0;
  let pending = 0;
  let orphan = false;
  for (const refund of snapshot.refunds) {
    if (refund.paymentId !== paymentId || refund.status === 'failed') continue;
    if (refund.scope === 'orphan') orphan = true;
    if (refund.status === 'succeeded') succeeded += refund.amountKop;
    else pending += refund.amountKop;
  }
  return { succeeded, pending, orphan };
}

/** What is left of a payment: amount - succeeded - pending refunds (failed ones returned nothing). */
export function paymentRestKop(snapshot: OrderSnapshot, paymentId: string): number {
  const payment = snapshot.payments.find((p) => p.id === paymentId);
  if (payment === undefined) return 0;
  const sums = refundSums(snapshot, paymentId);
  return Math.max(0, payment.amountKop - sums.succeeded - sums.pending);
}

/**
 * Succeeded payments of the order that are the order's money: not refunded back as orphans and
 * not fully refunded yet. Oldest first.
 */
export function heldPayments(snapshot: OrderSnapshot): PaymentRow[] {
  return snapshot.payments.filter((payment) => {
    if (payment.status !== 'succeeded') return false;
    const sums = refundSums(snapshot, payment.id);
    return !sums.orphan && sums.succeeded < payment.amountKop;
  });
}

/**
 * The payment a refund of the order is taken from: the oldest held one with money left. The
 * oldest is the order's own payment (earlier partial refunds were taken from it); a later
 * succeeded payment is a duplicate that a whole-order refund returns separately.
 */
export function refundablePayment(snapshot: OrderSnapshot): PaymentRow | null {
  const held = heldPayments(snapshot).filter((payment) => {
    const sums = refundSums(snapshot, payment.id);
    return sums.succeeded + sums.pending < payment.amountKop;
  });
  return held[0] ?? null;
}

/**
 * Held payments other than `paymentId` with no refund at all (pending or succeeded): duplicates
 * (two tabs, an old QR) that a whole-order refund returns whole.
 */
export function untouchedDuplicatePayments(
  snapshot: OrderSnapshot,
  paymentId: string,
): PaymentRow[] {
  return heldPayments(snapshot).filter((payment) => {
    if (payment.id === paymentId) return false;
    const sums = refundSums(snapshot, payment.id);
    return sums.succeeded + sums.pending === 0;
  });
}

/** TransitionContext.paymentHeld: a succeeded payment exists and is not fully refunded. */
export function paymentHeldOf(snapshot: OrderSnapshot): boolean {
  return heldPayments(snapshot).length > 0;
}

/**
 * Same as the moneyHeld guard with the context's explicit paymentHeld: money is held when a
 * succeeded payment of the order is not refunded (a prepay order whose wrong-amount payment was
 * returned by «Вернуть платёж» holds nothing).
 */
export function moneyHeldOf(snapshot: OrderSnapshot): boolean {
  return paymentHeldOf(snapshot);
}

/**
 * Held handover (QR) payments of exactly the order total, oldest first: whichever QR the
 * client paid (an old one after a newer was shown included) pays for the order.
 */
export function handoverPaymentsHeld(snapshot: OrderSnapshot): PaymentRow[] {
  return heldPayments(snapshot).filter(
    (payment) => payment.kind === 'full' && payment.amountKop === snapshot.order.totalKop,
  );
}

/** TransitionContext.handoverPaymentHeld. */
export function handoverPaymentHeldOf(snapshot: OrderSnapshot): boolean {
  return handoverPaymentsHeld(snapshot).length > 0;
}

/**
 * The settlement receipt: offset for prepay; for pay_on_handover the `full` receipt sent inside
 * a held handover payment (the receipt of the very payment that pays for the order, not of a
 * stale QR that was never paid or was refunded).
 */
export function settlementReceiptSucceededOf(snapshot: OrderSnapshot): boolean {
  if (snapshot.order.paymentScheme === 'prepay') {
    return snapshot.receipts.some((r) => r.kind === 'offset' && r.status === 'succeeded');
  }
  const held = new Set(handoverPaymentsHeld(snapshot).map((payment) => payment.id));
  return snapshot.receipts.some(
    (r) =>
      r.kind === 'full' &&
      r.status === 'succeeded' &&
      r.paymentId !== null &&
      held.has(r.paymentId),
  );
}

/** Every created supplier order has its Rossko invoice marked paid. */
export function supplierInvoicePaidOf(snapshot: OrderSnapshot): boolean {
  const created = snapshot.supplierOrders.filter((s) => s.status === 'created');
  return created.length > 0 && created.every((s) => s.invoicePaidAt !== null);
}

/** Margin of the live items (client price vs supplier price at order), null without items. */
export function liveMarginBp(
  items: readonly VirtualItem[],
  supplierPriceOf: (item: VirtualItem) => number = (item) => item.priceSupplierAtOrderKop,
): number | null {
  let client = 0;
  let supplier = 0;
  for (const item of items) {
    if (!isLiveState(item.state)) continue;
    client += item.priceClientKop * item.qty;
    supplier += supplierPriceOf(item) * item.qty;
  }
  return client > 0 ? marginBp(client, supplier) : null;
}

/** Drops undefined values so that facts override only what they set. */
function defined<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as Partial<T>;
}

/**
 * Pure. Derives TransitionContext from the snapshot after `changes`; `facts` override.
 * - providerPaymentStatus: the order's latest payment (null without payments);
 * - eventPaymentIsCurrent / eventPaymentKind: about facts.paymentId when given, otherwise the
 *   event is about the current (latest) payment, or "no payment" when there is none;
 * - allLiveItemsArrived, liveItemsAfter, pendingSupplierItems: after the item changes;
 * - pickupWindowElapsed: a ready order whose expires_at (storage window) has passed.
 */
export function buildTransitionContext(
  snapshot: OrderSnapshot,
  actor: ActorRef,
  facts: TransitionFacts,
  settings: OrderSettings,
  now: Date,
  changes: readonly ItemChange[] = [],
): TransitionContext {
  const { order } = snapshot;
  const virtual = itemsAfterChanges(snapshot.items, changes);
  const live = virtual.filter((item) => isLiveState(item.state));
  const lastPayment = snapshot.payments.at(-1) ?? null;
  const factPaymentId = facts.paymentId ?? null;
  const eventPayment =
    factPaymentId === null
      ? lastPayment
      : (snapshot.payments.find((p) => p.id === factPaymentId) ?? null);
  const margin = liveMarginBp(virtual);

  const derived: TransitionContext = {
    actor: actor.type,
    staffRole: actor.staffRole ?? null,
    scheme: order.paymentScheme,
    fulfillment: order.fulfillment,
    totalKop: order.totalKop,
    minOrderTotalKop: settings.minOrderTotalKop,
    minMarginKop: settings.minMarginKop,
    onPickupMaxTotalKop: settings.onPickupMaxTotalKop,
    noShowCount: snapshot.noShowCount,
    noShowLimit: settings.noShowLimit,
    providerPaymentStatus: lastPayment?.status ?? null,
    eventPaymentIsCurrent:
      factPaymentId === null ? true : eventPayment !== null && eventPayment.id === lastPayment?.id,
    eventPaymentKind: eventPayment?.kind ?? null,
    allLiveItemsArrived: liveItemsAllArrived(virtual.map((item) => item.state)),
    paymentHeld: paymentHeldOf(snapshot),
    handoverPaymentHeld: handoverPaymentHeldOf(snapshot),
    driftToleranceBp: settings.driftToleranceBp,
    prepayInvoice: settings.eta.prepayInvoice,
    supplierInvoicePaid: supplierInvoicePaidOf(snapshot),
    pendingSupplierItems: live.filter((item) => item.state === 'pending').length,
    ...(margin === null ? {} : { marginBp: margin }),
    marginFloorBp: settings.marginFloorBp,
    liveItemsAfter: live.length,
    clientArrived: order.clientArrivedAt !== null,
    settlementReceiptSucceeded: settlementReceiptSucceededOf(snapshot),
    pickupWindowElapsed:
      order.status === 'ready' &&
      order.expiresAt !== null &&
      order.expiresAt.getTime() <= now.getTime(),
    // Decision С11: completion_timeout waits until every claim is closed (a replacement keeps
    // the order handed).
    openClaims: snapshot.claims.filter((claim) => claim.closedAt === null).length,
  };

  const {
    reason: _reason,
    coveredItemIds: _covered,
    itemErrors: _errors,
    paymentId: _paymentId,
    refundId: _refundId,
    proposal: _proposal,
    problem: _problem,
    claimId: _claimId,
    claimOpenedAt: _claimOpenedAt,
    claim: _claim,
    ...overrides
  } = facts;
  return { ...derived, ...defined(overrides) };
}

/** Events that change items (section 5.3); every other event leaves them as they are. */
const ITEM_CHANGING_EVENTS = [
  'supplier_checkout_succeeded',
  'item_arrived',
  'item_cancelled',
  'client_refund_requested',
  'approval_timeout',
  'claim_refund_approved',
  'client_approved',
  'item_damaged_on_receipt',
  'payment_succeeded',
  'handed_over',
  'refund_succeeded',
  'partial_refund_succeeded',
  // the whole order is refunded (or cancelled): live items -> refund_pending when paid
  'client_refused',
  'order_cancelled',
  'storage_expired',
] as const satisfies readonly OrderEvent[];
type ItemChangingEvent = (typeof ITEM_CHANGING_EVENTS)[number];

function changesItems(event: OrderEvent): event is ItemChangingEvent {
  return (ITEM_CHANGING_EVENTS as readonly OrderEvent[]).includes(event);
}

/** Approval events whose scope comes from the open approval. */
const APPROVAL_DECISION_EVENTS: readonly OrderEvent[] = [
  'client_refund_requested',
  'approval_timeout',
];

/** The scope of an event: facts, then the open approval, then the item argument. */
export function eventScope(
  event: OrderEvent,
  snapshot: OrderSnapshot,
  facts: TransitionFacts & { itemId?: string | null },
): 'order' | 'item' {
  if (facts.scope !== undefined) return facts.scope;
  if (
    (APPROVAL_DECISION_EVENTS.includes(event) || event === 'client_approved') &&
    snapshot.openApproval !== null
  ) {
    return snapshot.openApproval.scope === 'item' ? 'item' : 'order';
  }
  return facts.itemId ? 'item' : 'order';
}

/** The item an event is about: the argument, or the open approval's item. */
export function eventItemId(
  event: OrderEvent,
  snapshot: OrderSnapshot,
  facts: { itemId?: string | null },
): string | null {
  if (facts.itemId) return facts.itemId;
  if (
    (APPROVAL_DECISION_EVENTS.includes(event) || event === 'client_approved') &&
    snapshot.openApproval?.orderItemId
  ) {
    return snapshot.openApproval.orderItemId;
  }
  return null;
}

function liveItems(snapshot: OrderSnapshot): OrderItemRow[] {
  return snapshot.items.filter((item) => isLiveState(item.state));
}

/** A cancelled item: refund_pending when money was taken, failed when nothing was paid. */
function cancelChange(snapshot: OrderSnapshot, itemId: string): ItemChange[] {
  const item = snapshot.items.find((i) => i.id === itemId);
  if (item === undefined || !isLiveState(item.state)) return [];
  return [{ kind: 'state', itemId, to: moneyHeldOf(snapshot) ? 'refund_pending' : 'failed' }];
}

function wholeOrderRefund(snapshot: OrderSnapshot): ItemChange[] {
  if (!moneyHeldOf(snapshot)) return [];
  return liveItems(snapshot)
    .filter((item) => item.state !== 'refund_pending')
    .map((item) => ({ kind: 'state', itemId: item.id, to: 'refund_pending' }) as const);
}

/** A copy of an item for a reorder (damaged on receipt): pending, nothing refunded. */
function copyOf(item: OrderItemRow): Extract<ItemChange, { kind: 'replace' }>['replacement'] {
  return {
    offerKey: item.offerKey,
    searchArticleNorm: item.searchArticleNorm,
    brand: item.brand,
    article: item.article,
    name: item.name,
    qty: item.qty,
    stockId: item.stockId,
    isLocal: item.isLocal,
    priceSupplierAtOrderKop: item.priceSupplierAtOrderKop,
    priceClientKop: item.priceClientKop,
    markupBp: item.markupBp,
    etaDate: item.etaDate,
    offerSnapshot: item.offerSnapshot,
    state: 'pending',
  };
}

/** Pure. Item changes of an event (section 5.3). */
export function planItemChanges(
  event: OrderEvent,
  snapshot: OrderSnapshot,
  facts: TransitionFacts & { itemId?: string | null },
): ItemChange[] {
  if (!changesItems(event)) return [];
  const itemId = eventItemId(event, snapshot, facts);
  switch (event) {
    case 'client_refused':
    case 'order_cancelled':
    case 'storage_expired':
      return wholeOrderRefund(snapshot);
    case 'supplier_checkout_succeeded': {
      const errors = new Map((facts.itemErrors ?? []).map((e) => [e.orderItemId, e.error]));
      const covered = facts.coveredItemIds ? new Set(facts.coveredItemIds) : null;
      const changes: ItemChange[] = [];
      for (const item of liveItems(snapshot)) {
        if (item.state !== 'pending') continue;
        if (errors.has(item.id)) {
          changes.push({
            kind: 'state',
            itemId: item.id,
            to: 'pending',
            supplierItemError: errors.get(item.id) ?? null,
          });
        } else if (covered === null || covered.has(item.id)) {
          changes.push({ kind: 'state', itemId: item.id, to: 'ordered', supplierItemError: null });
        }
      }
      return changes;
    }
    case 'item_arrived':
      return itemId === null ? [] : [{ kind: 'state', itemId, to: 'arrived' }];
    case 'item_cancelled':
      return itemId === null ? [] : cancelChange(snapshot, itemId);
    case 'client_refund_requested':
    case 'approval_timeout':
      if (eventScope(event, snapshot, facts) === 'item') {
        return itemId === null ? [] : cancelChange(snapshot, itemId);
      }
      return wholeOrderRefund(snapshot);
    case 'claim_refund_approved':
      if (eventScope(event, snapshot, facts) === 'item') {
        return itemId === null ? [] : [{ kind: 'state', itemId, to: 'refund_pending' }];
      }
      return wholeOrderRefund(snapshot);
    case 'client_approved': {
      const approval = snapshot.openApproval;
      if (approval === null) return [];
      const proposal = approval.proposal;
      if (proposal.kind === 'alternative') {
        const old = snapshot.items.find((i) => i.id === approval.orderItemId);
        if (old === undefined) return [];
        return [
          {
            kind: 'replace',
            itemId: old.id,
            replacement: {
              offerKey: proposal.offerKey,
              searchArticleNorm: proposal.searchArticleNorm,
              brand: proposal.offer.brand,
              article: proposal.offer.article,
              name: proposal.offer.name,
              qty: old.qty,
              stockId: proposal.offer.stock.stockId,
              isLocal: proposal.offer.stock.isLocal,
              priceSupplierAtOrderKop: proposal.priceSupplierKop,
              priceClientKop: proposal.priceClientKop,
              markupBp: proposal.markupBp,
              etaDate: proposal.etaDate,
              offerSnapshot: proposal.offer,
              state: 'pending',
            },
          },
        ];
      }
      const targets =
        approval.orderItemId !== null
          ? snapshot.items.filter((i) => i.id === approval.orderItemId)
          : liveItems(snapshot).filter((i) => i.state !== 'arrived' && i.state !== 'handed');
      return targets.map((i) => ({ kind: 'eta', itemId: i.id, etaDate: proposal.etaDate }));
    }
    case 'item_damaged_on_receipt': {
      const old = snapshot.items.find((i) => i.id === itemId);
      if (old === undefined) return [];
      return [{ kind: 'replace', itemId: old.id, replacement: copyOf(old) }];
    }
    case 'payment_succeeded':
      // A late payment of a cancelled order is returned: the items wait for the refund.
      return snapshot.order.status === 'cancelled' ? wholeOrderRefund(snapshot) : [];
    case 'handed_over':
      return liveItems(snapshot)
        .filter((item) => item.state !== 'handed')
        .map((item) => ({ kind: 'state', itemId: item.id, to: 'handed' }) as const);
    case 'refund_succeeded':
    case 'partial_refund_succeeded': {
      const refund = snapshot.refunds.find((r) => r.id === facts.refundId);
      if (refund === undefined) return [];
      const amounts = new Map<string, number>();
      for (const line of refund.items) {
        if (line.orderItemId === null) continue;
        amounts.set(line.orderItemId, (amounts.get(line.orderItemId) ?? 0) + line.amountKop);
      }
      const changes: ItemChange[] = [...amounts].map(([id, amountKop]) => ({
        kind: 'refunded',
        itemId: id,
        amountKop,
      }));
      if (event === 'refund_succeeded') {
        // The whole order is refunded: items still waiting (e.g. a late payment refunded with
        // the lines of its own receipt) are refunded too.
        for (const item of snapshot.items) {
          if (item.state === 'refund_pending' && !amounts.has(item.id)) {
            changes.push({ kind: 'state', itemId: item.id, to: 'refunded' });
          }
        }
      }
      return changes;
    }
  }
}
