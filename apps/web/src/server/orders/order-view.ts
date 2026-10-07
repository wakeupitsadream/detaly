/**
 * Read model of /o/<token> (docs/phase-1a-implementation.md 7.1, phase 1B section 14.4). The
 * order snapshot of the engine (@detaly/orders, read without a lock), its journal and settings.
 * The client's phone is never loaded here: the page does not show it, and the digit check reads
 * it under a row lock itself.
 *
 * Which client buttons are shown is decided by the state machine itself: every action is
 * resolved as a dry run with the engine's context (the same buildTransitionContext and item
 * changes applyTransition uses), so the page never offers what the server would refuse.
 */
import type { Env } from '@detaly/config';
import { asc, eq, orderEvents, type Executor } from '@detaly/db';
import {
  formatDayMonth,
  formatPromise,
  isIsoDate,
  localDate,
  resolveTransition,
  safeMul,
  weekdayShort,
  type ApprovalKind,
  type Fulfillment,
  type IsoDate,
  type Kop,
  type NotificationChannel,
  type OrderEvent,
  type OrderItemState,
  type OrderStatus,
  type PaymentScheme,
  type PaymentStatus,
} from '@detaly/domain';
import {
  buildTransitionContext,
  isLiveState,
  loadOrderSettings,
  loadOrderSnapshot,
  moneyHeldOf,
  planItemChanges,
  type OrderSettings,
  type OrderSnapshot,
  type TransitionFacts,
} from '@detaly/orders';
import { isOrderToken } from './access';
import {
  CLOSED_STATUSES,
  orderStatusLabel,
  orderStatusTone,
  PICKUP_CODE_STATUSES,
  type StatusTone,
} from './status-labels';
import { buildTimeline, formatEventTime, type TimelineEntry } from './timeline';

export interface OrderItemView {
  id: string;
  brand: string;
  article: string;
  name: string;
  qty: number;
  isLocal: boolean;
  priceClientKop: Kop;
  lineTotalKop: Kop;
  state: OrderItemState;
  /** Client wording of the item state; null before the order is confirmed. */
  stateLabel: string | null;
  /** Live item that has not arrived yet (pending / ordered). */
  waiting: boolean;
  /** Not part of the order any more (cancelled, replaced, money returned). */
  inactive: boolean;
  /** «Отменить позицию» is allowed for this item (4 digits). */
  canCancel: boolean;
}

/** The proposal the client decides on (awaiting_client_approval). */
export interface ApprovalView {
  kind: ApprovalKind;
  scope: 'order' | 'item';
  /** The item concerned (brand, article, name) when the approval is about one item. */
  item: { brand: string; article: string; name: string } | null;
  /** alternative: the replacement offer. */
  alternative: { brand: string; article: string; name: string; etaText: string | null } | null;
  /** new_eta: the new date 'к чт 9 октября'. */
  etaText: string | null;
  /** Answer by '3 октября, 14:05' (Asia/Yekaterinburg); null until the client is notified. */
  deadlineText: string | null;
  /** Answering «Вернуть деньги» returns the whole order (true) or one item. */
  refundsWholeOrder: boolean;
}

/** Money going back to the client (refunds rows, orphan payments included). */
export interface RefundView {
  /** Pending (and failed, retried by the sellers) refunds, kop. */
  pendingKop: Kop;
  /** Deadline of the pending refunds: '12 октября' (10 days from the request, ЗоЗПП). */
  deadlineText: string | null;
  /** Succeeded refunds, kop. */
  sentKop: Kop;
}

/** The order's latest payment. */
export interface PaymentView {
  status: PaymentStatus;
  kind: 'prepayment' | 'full';
}

export interface OrderActionsView {
  /** «Оплатить N ₽»: awaiting_payment, payments enabled, not paid. */
  pay: boolean;
  /** «Подтверждаю» (pay_on_handover awaiting_confirmation). */
  confirm: boolean;
  /** «Согласен» on an open approval. */
  approve: boolean;
  /** «Вернуть деньги» on an open approval (4 digits). */
  refundRequest: boolean;
  /** «Отказаться от заказа» (REFUSABLE statuses, 4 digits). */
  refuse: boolean;
  /** «Оплатить заранее» (ready, pay_on_handover). */
  prepayNow: boolean;
}

export interface OrderView {
  id: string;
  /** 'DT-000123'. */
  number: string;
  token: string;
  status: OrderStatus;
  statusLabel: string;
  statusTone: StatusTone;
  scheme: PaymentScheme;
  fulfillment: Fulfillment;
  /** 'к чт 8 октября'; null when there is no date or the order is over. */
  promiseText: string | null;
  promisedDate: IsoDate | null;
  subtotalKop: Kop;
  courierFeeKop: Kop;
  totalKop: Kop;
  items: OrderItemView[];
  timeline: TimelineEntry[];
  preferredChannel: NotificationChannel | null;
  /** Only from `ready` on (decision Д13), otherwise null even when it exists. */
  pickupCode: string | null;
  /** The 1A cancellation (client_cancelled) applies: before payment / confirmation. */
  canCancel: boolean;
  /** The order is over for the client (cancelled, refunded, handed, completed). */
  closed: boolean;
  /** Online payment is configured (decision Б6). */
  paymentsEnabled: boolean;
  payment: PaymentView | null;
  actions: OrderActionsView;
  /** A refusal now returns money (prepay or paid) rather than just cancelling. */
  moneyHeld: boolean;
  approval: ApprovalView | null;
  /** Part of the order arrived, the rest is awaited: «Жду до <дата>». */
  partialArrival: { waitUntilText: string | null } | null;
  refund: RefundView | null;
}

const PICKUP_CODE_SET: ReadonlySet<OrderStatus> = new Set(PICKUP_CODE_STATUSES);
const CLOSED_SET: ReadonlySet<OrderStatus> = new Set(CLOSED_STATUSES);
const CONFIRMED_SET: ReadonlySet<OrderStatus> = new Set([
  'draft',
  'awaiting_payment',
  'awaiting_confirmation',
]);

const ITEM_STATE_LABELS: Record<OrderItemState, string> = {
  pending: 'Заказываем у поставщика',
  ordered: 'Заказана у поставщика',
  failed: 'Отменена',
  replaced: 'Заменена',
  arrived: 'Приехала',
  handed: 'Выдана',
  return_requested: 'Оформляется возврат',
  returned: 'Возвращена',
  refund_pending: 'Возвращаем деньги',
  refunded: 'Деньги возвращены',
};

const INACTIVE_STATES: ReadonlySet<OrderItemState> = new Set([
  'failed',
  'replaced',
  'refund_pending',
  'refunded',
  'returned',
]);

/** Item states «Отменить позицию» accepts (the engine checks the same). */
const CANCELLABLE_ITEM_STATES: ReadonlySet<OrderItemState> = new Set(['pending', 'ordered']);

/** 'чт 9 октября' */
export function formatDayWithWeekday(date: IsoDate): string {
  return `${weekdayShort(date)} ${formatDayMonth(date)}`;
}

/** Just the number, for the page title. Null for a malformed or unknown token. */
export async function findOrderNumber(db: Executor, token: string): Promise<string | null> {
  if (!isOrderToken(token)) return null;
  const row = await db.query.orders.findFirst({
    where: (t, ops) => ops.eq(t.accessToken, token),
    columns: { number: true },
  });
  return row?.number ?? null;
}

/**
 * Dry run of a client event with the engine's context: true when applyTransition would accept
 * it now (the engine's own preconditions on the item and the approval included).
 */
export function clientEventAllowed(
  snapshot: OrderSnapshot,
  settings: OrderSettings,
  now: Date,
  event: OrderEvent,
  itemId: string | null = null,
): boolean {
  const approval = snapshot.openApproval;
  const approvalEvent = event === 'client_approved' || event === 'client_refund_requested';
  if (approvalEvent && approval === null) return false;
  const facts: TransitionFacts = {};
  let eventItemId = itemId;
  if (itemId !== null) {
    const item = snapshot.items.find((i) => i.id === itemId);
    if (
      item === undefined ||
      !isLiveState(item.state) ||
      !CANCELLABLE_ITEM_STATES.has(item.state)
    ) {
      return false;
    }
    facts.scope = 'item';
  } else if (approvalEvent && approval !== null) {
    facts.scope = approval.scope === 'item' ? 'item' : 'order';
    eventItemId = approval.orderItemId;
  }
  const changes = planItemChanges(event, snapshot, { ...facts, itemId: eventItemId });
  const ctx = buildTransitionContext(
    snapshot,
    { type: 'client', id: snapshot.order.userId },
    facts,
    settings,
    now,
    changes,
  );
  return resolveTransition(snapshot.order.status, event, ctx).ok;
}

function approvalView(snapshot: OrderSnapshot): ApprovalView | null {
  const approval = snapshot.openApproval;
  if (approval === null || snapshot.order.status !== 'awaiting_client_approval') return null;
  const item =
    approval.orderItemId === null
      ? null
      : (snapshot.items.find((i) => i.id === approval.orderItemId) ?? null);
  const proposal = approval.proposal;
  const scope = approval.scope === 'item' ? 'item' : 'order';
  const deadlineText = approval.expiresAt === null ? null : formatEventTime(approval.expiresAt);
  const itemView = item ? { brand: item.brand, article: item.article, name: item.name } : null;
  if (proposal.kind === 'alternative') {
    return {
      kind: 'alternative',
      scope,
      item: itemView,
      alternative: {
        brand: proposal.offer.brand,
        article: proposal.offer.article,
        name: proposal.offer.name,
        etaText: isIsoDate(proposal.etaDate) ? formatPromise(proposal.etaDate) : null,
      },
      etaText: null,
      deadlineText,
      refundsWholeOrder: scope === 'order',
    };
  }
  return {
    kind: 'new_eta',
    scope,
    item: itemView,
    alternative: null,
    etaText: isIsoDate(proposal.etaDate) ? formatPromise(proposal.etaDate) : null,
    deadlineText,
    refundsWholeOrder: scope === 'order',
  };
}

function refundView(snapshot: OrderSnapshot): RefundView | null {
  if (snapshot.refunds.length === 0) return null;
  let pendingKop = 0;
  let sentKop = 0;
  let deadline: Date | null = null;
  for (const refund of snapshot.refunds) {
    if (refund.status === 'succeeded') {
      sentKop += refund.amountKop;
      continue;
    }
    pendingKop += refund.amountKop;
    if (deadline === null || refund.deadlineAt.getTime() > deadline.getTime()) {
      deadline = refund.deadlineAt;
    }
  }
  return {
    pendingKop,
    sentKop,
    deadlineText: pendingKop > 0 && deadline !== null ? formatDayMonth(localDate(deadline)) : null,
  };
}

function partialArrival(snapshot: OrderSnapshot): OrderView['partialArrival'] {
  if (snapshot.order.status !== 'ordered_at_supplier') return null;
  const live = snapshot.items.filter((i) => isLiveState(i.state));
  const arrived = live.filter((i) => i.state === 'arrived');
  const waiting = live.filter((i) => CANCELLABLE_ITEM_STATES.has(i.state));
  if (arrived.length === 0 || waiting.length === 0) return null;
  const dates = waiting.map((i) => i.etaDate).filter((d): d is IsoDate => isIsoDate(d));
  const latest = dates.sort().at(-1) ?? null;
  const promised = isIsoDate(snapshot.order.promisedDate) ? snapshot.order.promisedDate : null;
  const date = promised !== null && (latest === null || promised > latest) ? promised : latest;
  return { waitUntilText: date === null ? null : formatDayWithWeekday(date) };
}

export interface LoadOrderViewOptions {
  /** Full env: settings defaults for the engine context. */
  env: Env;
  /** Online payment is configured (decision Б6). */
  paymentsEnabled?: boolean;
  now?: Date;
}

/** The order of this link token, or null for a malformed or unknown token. */
export async function loadOrderView(
  db: Executor,
  token: string,
  options: LoadOrderViewOptions,
): Promise<OrderView | null> {
  if (!isOrderToken(token)) return null;
  const found = await db.query.orders.findFirst({
    where: (t, ops) => ops.eq(t.accessToken, token),
    columns: { id: true },
  });
  if (!found) return null;
  const [snapshot, events, settings] = await Promise.all([
    loadOrderSnapshot(db, found.id, { lock: false }),
    db
      .select({
        id: orderEvents.id,
        type: orderEvents.type,
        fromStatus: orderEvents.fromStatus,
        toStatus: orderEvents.toStatus,
        actorType: orderEvents.actorType,
        payload: orderEvents.payload,
        createdAt: orderEvents.createdAt,
      })
      .from(orderEvents)
      .where(eq(orderEvents.orderId, found.id))
      .orderBy(asc(orderEvents.createdAt), asc(orderEvents.id)),
    loadOrderSettings(db, options.env),
  ]);
  if (snapshot === null) return null;
  const now = options.now ?? new Date();
  const { order } = snapshot;
  const status = order.status;
  const closed = CLOSED_SET.has(status);
  const confirmed = !CONFIRMED_SET.has(status);
  const promisedDate = isIsoDate(order.promisedDate) ? order.promisedDate : null;
  const allowed = (event: OrderEvent, itemId: string | null = null) =>
    clientEventAllowed(snapshot, settings, now, event, itemId);

  const itemCancelAllowed = status === 'ordered_at_supplier';
  const items = snapshot.items.map((item): OrderItemView => ({
    id: item.id,
    brand: item.brand,
    article: item.article,
    name: item.name,
    qty: item.qty,
    isLocal: item.isLocal,
    priceClientKop: item.priceClientKop,
    lineTotalKop: safeMul(item.priceClientKop, item.qty),
    state: item.state,
    stateLabel: confirmed ? ITEM_STATE_LABELS[item.state] : null,
    waiting: isLiveState(item.state) && CANCELLABLE_ITEM_STATES.has(item.state),
    inactive: INACTIVE_STATES.has(item.state),
    canCancel: itemCancelAllowed && allowed('item_cancelled', item.id),
  }));

  const last = snapshot.payments.at(-1) ?? null;
  const payment: PaymentView | null =
    last === null
      ? null
      : { status: last.status, kind: last.kind === 'full' ? 'full' : 'prepayment' };
  const paymentsEnabled = options.paymentsEnabled ?? false;
  const approval = approvalView(snapshot);
  const itemTitles = new Map(
    snapshot.items.map((item) => [item.id, { brand: item.brand, article: item.article }]),
  );

  return {
    id: order.id,
    number: order.number,
    token: order.accessToken,
    status,
    statusLabel: orderStatusLabel(status),
    statusTone: orderStatusTone(status),
    scheme: order.paymentScheme,
    fulfillment: order.fulfillment,
    promisedDate,
    promiseText: promisedDate !== null && !closed ? formatPromise(promisedDate) : null,
    subtotalKop: order.subtotalKop,
    courierFeeKop: order.courierFeeKop,
    totalKop: order.totalKop,
    items,
    timeline: buildTimeline(events, undefined, itemTitles),
    preferredChannel: order.preferredChannel,
    pickupCode: PICKUP_CODE_SET.has(status) ? order.pickupCode : null,
    canCancel: allowed('client_cancelled'),
    closed,
    paymentsEnabled,
    payment,
    actions: {
      pay:
        paymentsEnabled &&
        status === 'awaiting_payment' &&
        order.paymentScheme === 'prepay' &&
        last?.status !== 'succeeded',
      confirm: allowed('client_confirmed'),
      approve: approval !== null && allowed('client_approved'),
      refundRequest: approval !== null && allowed('client_refund_requested'),
      refuse: allowed('client_refused'),
      prepayNow: paymentsEnabled && allowed('switch_to_prepay'),
    },
    moneyHeld: moneyHeldOf(snapshot),
    approval,
    partialArrival: partialArrival(snapshot),
    refund: refundView(snapshot),
  };
}
