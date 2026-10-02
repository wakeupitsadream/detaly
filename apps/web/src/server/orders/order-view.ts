/**
 * Read model of /o/<token> (docs/phase-1a-implementation.md 7.1). One relational query: the
 * order with its items, events and latest payment status. The client's phone is never loaded
 * here: the page does not show it, and the cancellation reads it under a row lock itself.
 */
import type { Executor } from '@detaly/db';
import {
  availableEvents,
  formatPromise,
  isIsoDate,
  safeMul,
  type Fulfillment,
  type IsoDate,
  type Kop,
  type NotificationChannel,
  type OrderStatus,
  type PaymentScheme,
} from '@detaly/domain';
import { clientCancelContext, isOrderToken } from './access';
import {
  CLOSED_STATUSES,
  orderStatusLabel,
  orderStatusTone,
  PICKUP_CODE_STATUSES,
  type StatusTone,
} from './status-labels';
import { buildTimeline, type TimelineEntry } from './timeline';

export interface OrderItemView {
  id: string;
  brand: string;
  article: string;
  name: string;
  qty: number;
  isLocal: boolean;
  priceClientKop: Kop;
  lineTotalKop: Kop;
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
  /** availableEvents(status, client ctx) contains client_cancelled. */
  canCancel: boolean;
  /** The order is over for the client (cancelled, refunded, handed, completed). */
  closed: boolean;
}

const PICKUP_CODE_SET: ReadonlySet<OrderStatus> = new Set(PICKUP_CODE_STATUSES);
const CLOSED_SET: ReadonlySet<OrderStatus> = new Set(CLOSED_STATUSES);

/** Just the number, for the page title. Null for a malformed or unknown token. */
export async function findOrderNumber(db: Executor, token: string): Promise<string | null> {
  if (!isOrderToken(token)) return null;
  const row = await db.query.orders.findFirst({
    where: (t, ops) => ops.eq(t.accessToken, token),
    columns: { number: true },
  });
  return row?.number ?? null;
}

/** The order of this link token, or null for a malformed or unknown token. */
export async function loadOrderView(db: Executor, token: string): Promise<OrderView | null> {
  if (!isOrderToken(token)) return null;
  const order = await db.query.orders.findFirst({
    where: (t, ops) => ops.eq(t.accessToken, token),
    columns: {
      id: true,
      number: true,
      accessToken: true,
      status: true,
      paymentScheme: true,
      fulfillment: true,
      promisedDate: true,
      subtotalKop: true,
      courierFeeKop: true,
      totalKop: true,
      preferredChannel: true,
      pickupCode: true,
    },
    with: {
      items: {
        columns: {
          id: true,
          brand: true,
          article: true,
          name: true,
          qty: true,
          isLocal: true,
          priceClientKop: true,
          state: true,
        },
        orderBy: (t, ops) => [ops.asc(t.createdAt), ops.asc(t.id)],
      },
      events: {
        columns: { id: true, type: true, fromStatus: true, toStatus: true, createdAt: true },
        orderBy: (t, ops) => [ops.asc(t.createdAt), ops.asc(t.id)],
      },
      payments: {
        columns: { status: true },
        orderBy: (t, ops) => [ops.desc(t.createdAt), ops.desc(t.id)],
        limit: 1,
      },
    },
  });
  if (!order) return null;

  const status = order.status;
  const closed = CLOSED_SET.has(status);
  const promisedDate = isIsoDate(order.promisedDate) ? order.promisedDate : null;
  const ctx = clientCancelContext({
    scheme: order.paymentScheme,
    latestPaymentStatus: order.payments[0]?.status ?? null,
    itemStates: order.items.map((item) => item.state),
  });
  const items = order.items.map((item): OrderItemView => ({
    id: item.id,
    brand: item.brand,
    article: item.article,
    name: item.name,
    qty: item.qty,
    isLocal: item.isLocal,
    priceClientKop: item.priceClientKop,
    lineTotalKop: safeMul(item.priceClientKop, item.qty),
  }));
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
    timeline: buildTimeline(order.events),
    preferredChannel: order.preferredChannel,
    pickupCode: PICKUP_CODE_SET.has(status) ? order.pickupCode : null,
    canCancel: availableEvents(status, ctx).includes('client_cancelled'),
    closed,
  };
}
