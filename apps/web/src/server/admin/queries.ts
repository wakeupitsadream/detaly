/**
 * Read models of the mini admin (docs/phase-1b-implementation.md section 15): the order list
 * with its filters and the full order card. The card is the only place on the site that shows
 * the client's full phone and name; nothing here is logged.
 */
import {
  and,
  asc,
  claims,
  clientApprovals,
  desc,
  eq,
  inArray,
  installBookings,
  orderEvents,
  orderItems,
  orders,
  payments,
  receipts,
  refunds,
  sql,
  stockItems,
  supplierOrderItems,
  supplierOrders,
  supplierReturns,
  users,
  type Executor,
  type SQL,
} from '@detaly/db';
import {
  isOneOf,
  ORDER_STATUSES,
  type OrderStatus,
  type PaymentScheme,
  type RecheckAlternative,
  type RecheckItemResult,
} from '@detaly/domain';
import {
  loadUserVehicles,
  refundablePayment,
  type OrderSnapshot,
  type VehicleRow,
} from '@detaly/orders';

/** Orders per list page. */
export const ADMIN_PAGE_SIZE = 50;

/** «Требуют внимания» (section 15.2). */
export const ATTENTION_FILTER = 'attention';
/** Phase 1C (decision С26): «Претензии открыты» — a claim with closed_at null. */
export const CLAIMS_OPEN_FILTER = 'claims_open';
/** Phase 1C (decision С26): «Запись ждёт подтверждения» — a booking in `requested`. */
export const BOOKING_REQUESTED_FILTER = 'install_requested';

/** Filters of the list besides an order status. */
export const ADMIN_EXTRA_FILTERS = [
  ATTENTION_FILTER,
  CLAIMS_OPEN_FILTER,
  BOOKING_REQUESTED_FILTER,
] as const;
export type AdminExtraFilter = (typeof ADMIN_EXTRA_FILTERS)[number];

export const ADMIN_EXTRA_FILTER_LABELS: Record<AdminExtraFilter, string> = {
  attention: 'Требуют внимания',
  claims_open: 'Претензии открыты',
  install_requested: 'Запись ждёт подтверждения',
};

export type AdminStatusFilter = OrderStatus | AdminExtraFilter | null;

export interface AdminListQuery {
  status: AdminStatusFilter;
  /** Raw search text: a DT number or the last 4 phone digits. */
  q: string;
  /** 1-based. */
  page: number;
}

/** Longest search text looked at. */
const MAX_QUERY_LENGTH = 32;
const MAX_PAGE = 10_000;

function first(value: string | string[] | undefined): string {
  return (Array.isArray(value) ? value[0] : value) ?? '';
}

/** Filters from the list page's search params; anything unknown is ignored. */
export function parseAdminListQuery(
  params: Record<string, string | string[] | undefined>,
): AdminListQuery {
  const statusRaw = first(params.status);
  const status: AdminStatusFilter = isOneOf(ADMIN_EXTRA_FILTERS, statusRaw)
    ? statusRaw
    : isOneOf(ORDER_STATUSES, statusRaw)
      ? statusRaw
      : null;
  const q = first(params.q).trim().slice(0, MAX_QUERY_LENGTH);
  const pageRaw = Number.parseInt(first(params.page), 10);
  const page = Number.isSafeInteger(pageRaw) && pageRaw >= 1 ? Math.min(pageRaw, MAX_PAGE) : 1;
  return { status, q, page };
}

/**
 * What the search text means:
 * - `DT-000123`, `dt123`, `000123`: the order number;
 * - exactly 4 digits: the last 4 phone digits, or the order number DT-00XXXX;
 * - anything else: nothing matches (no free-text search over PD).
 */
export type AdminSearch =
  | { kind: 'none' }
  | { kind: 'number'; number: string }
  | { kind: 'last4'; last4: string; number: string }
  | { kind: 'invalid' };

export function parseAdminSearch(raw: string): AdminSearch {
  const q = raw.trim().replace(/\s+/g, '');
  if (q === '') return { kind: 'none' };
  const dt = /^(?:DT-?)(\d{1,6})$/i.exec(q);
  if (dt?.[1]) return { kind: 'number', number: `DT-${dt[1].padStart(6, '0')}` };
  if (/^\d{4}$/.test(q)) return { kind: 'last4', last4: q, number: `DT-${q.padStart(6, '0')}` };
  if (/^\d{1,6}$/.test(q)) return { kind: 'number', number: `DT-${q.padStart(6, '0')}` };
  return { kind: 'invalid' };
}

/**
 * «Требуют внимания»: needs_attention, awaiting_supplier_invoice, a receipt that did not go
 * through (the 15-minute alert fired, or the provider finally rejected it) and has no
 * succeeded receipt of the same kind, a failed refund (or a refund task for the owner) that no
 * later refund took over («Повторить возврат», «Вернуть платёж») or outran.
 */
export function attentionCondition(): SQL {
  return sql`(
    ${orders.status} in ('needs_attention', 'awaiting_supplier_invoice')
    or exists (
      select 1 from ${receipts} r
      where r.order_id = ${orders.id}
        and r.status <> 'succeeded'
        and (r.alerted_at is not null or (r.status = 'canceled' and r.error is not null))
        and not exists (
          select 1 from ${receipts} r2
          where r2.order_id = r.order_id and r2.kind = r.kind and r2.status = 'succeeded'
        )
    )
    or exists (
      select 1 from ${refunds} f
      where f.order_id = ${orders.id}
        and f.status = 'failed'
        and not exists (
          select 1 from ${refunds} f2
          where f2.order_id = f.order_id and f2.payment_id = f.payment_id
            and f2.status = 'succeeded' and f2.created_at > f.created_at
        )
        and not exists (select 1 from ${refunds} f3 where f3.retry_of_refund_id = f.id)
    )
  )`;
}

/** «Претензии открыты»: the order has a claim that is not closed (decided replace included). */
export function openClaimsCondition(): SQL {
  return sql`exists (
    select 1 from ${claims} c where c.order_id = ${orders.id} and c.closed_at is null
  )`;
}

/** «Запись ждёт подтверждения»: a booking the sellers have not confirmed or declined yet. */
export function requestedBookingCondition(): SQL {
  return sql`exists (
    select 1 from ${installBookings} b where b.order_id = ${orders.id} and b.status = 'requested'
  )`;
}

export interface AdminOrderRow {
  id: string;
  number: string;
  status: OrderStatus;
  scheme: PaymentScheme;
  totalKop: number;
  promisedDate: string | null;
  createdAt: Date;
  attentionReason: string | null;
}

export interface AdminOrderList {
  rows: AdminOrderRow[];
  hasNext: boolean;
  /** The search text was not understood (nothing searched). */
  invalidSearch: boolean;
}

export async function listAdminOrders(
  db: Executor,
  query: AdminListQuery,
): Promise<AdminOrderList> {
  const search = parseAdminSearch(query.q);
  if (search.kind === 'invalid') return { rows: [], hasNext: false, invalidSearch: true };
  const conditions: SQL[] = [];
  if (query.status === ATTENTION_FILTER) conditions.push(attentionCondition());
  else if (query.status === CLAIMS_OPEN_FILTER) conditions.push(openClaimsCondition());
  else if (query.status === BOOKING_REQUESTED_FILTER) conditions.push(requestedBookingCondition());
  else if (query.status !== null) conditions.push(eq(orders.status, query.status));
  if (search.kind === 'number') conditions.push(eq(orders.number, search.number));
  if (search.kind === 'last4') {
    // `right(phone, 4)`: the digits are a parameter, never part of a LIKE pattern.
    conditions.push(
      sql`(right(${users.phone}, 4) = ${search.last4} or ${orders.number} = ${search.number})`,
    );
  }
  const rows = await db
    .select({
      id: orders.id,
      number: orders.number,
      status: orders.status,
      scheme: orders.paymentScheme,
      totalKop: orders.totalKop,
      promisedDate: orders.promisedDate,
      createdAt: orders.createdAt,
      attentionReason: orders.attentionReason,
    })
    .from(orders)
    .innerJoin(users, eq(users.id, orders.userId))
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(orders.createdAt), desc(orders.id))
    .limit(ADMIN_PAGE_SIZE + 1)
    .offset((query.page - 1) * ADMIN_PAGE_SIZE);
  return {
    rows: rows.slice(0, ADMIN_PAGE_SIZE),
    hasNext: rows.length > ADMIN_PAGE_SIZE,
    invalidSearch: false,
  };
}

// ---------------------------------------------------------------------------------------------
// Order card
// ---------------------------------------------------------------------------------------------

type Row<T extends { $inferSelect: unknown }> = T['$inferSelect'];

export interface AdminSupplierOrder extends Row<typeof supplierOrders> {
  itemIds: string[];
}

export interface AdminOrderCard {
  order: Row<typeof orders>;
  /** The only place with the full phone and name (PLAN section 4, PD minimisation). */
  client: { phone: string; name: string | null; noShowCount: number; anonymized: boolean };
  items: Row<typeof orderItems>[];
  payments: Row<typeof payments>[];
  receipts: Row<typeof receipts>[];
  refunds: Row<typeof refunds>[];
  supplierOrders: AdminSupplierOrder[];
  approvals: Row<typeof clientApprovals>[];
  supplierReturns: Row<typeof supplierReturns>[];
  stockItems: Row<typeof stockItems>[];
  /** Oldest first. */
  events: Row<typeof orderEvents>[];
  /** Alternatives of the latest recheck_result by order item id («Аналог» form). */
  alternatives: Record<string, RecheckAlternative[]>;
  /**
   * payments.id the order's refunds are taken from (refundablePayment): after handover
   * «Вернуть платёж» of it returns the whole order instead of the bare payment.
   */
  orderPaymentId: string | null;
  /**
   * Step 6 (docs/garage.md): the order's car and every car of the client (the client block
   * lists them); null without GARAGE_ENABLED (nothing about a car is shown).
   */
  garage: { vehicle: VehicleRow | null; clientVehicles: VehicleRow[] } | null;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}

/** Items of the latest recheck_result journal event of the order. */
export function recheckItemsOf(payload: unknown): RecheckItemResult[] {
  const items = (payload as { items?: unknown } | null | undefined)?.items;
  return Array.isArray(items) ? (items as RecheckItemResult[]) : [];
}

export async function latestRecheckItems(
  db: Executor,
  orderId: string,
): Promise<RecheckItemResult[]> {
  const [row] = await db
    .select({ payload: orderEvents.payload })
    .from(orderEvents)
    .where(and(eq(orderEvents.orderId, orderId), eq(orderEvents.type, 'recheck_result')))
    .orderBy(desc(orderEvents.createdAt), desc(orderEvents.id))
    .limit(1);
  return recheckItemsOf(row?.payload);
}

export async function loadAdminOrder(
  db: Executor,
  orderId: string,
  options: { garage?: boolean } = {},
): Promise<AdminOrderCard | null> {
  if (!isUuid(orderId)) return null;
  const [found] = await db
    .select({ order: orders, user: users })
    .from(orders)
    .innerJoin(users, eq(users.id, orders.userId))
    .where(eq(orders.id, orderId));
  if (!found) return null;
  const { order, user } = found;

  const [items, paymentRows, receiptRows, refundRows, supplierRows, approvals, events, recheck] =
    await Promise.all([
      db
        .select()
        .from(orderItems)
        .where(eq(orderItems.orderId, orderId))
        .orderBy(asc(orderItems.createdAt), asc(orderItems.id)),
      db
        .select()
        .from(payments)
        .where(eq(payments.orderId, orderId))
        .orderBy(asc(payments.createdAt), asc(payments.id)),
      db
        .select()
        .from(receipts)
        .where(eq(receipts.orderId, orderId))
        .orderBy(asc(receipts.createdAt), asc(receipts.id)),
      db
        .select()
        .from(refunds)
        .where(eq(refunds.orderId, orderId))
        .orderBy(asc(refunds.createdAt), asc(refunds.id)),
      db
        .select()
        .from(supplierOrders)
        .where(eq(supplierOrders.orderId, orderId))
        .orderBy(asc(supplierOrders.attemptNo)),
      db
        .select()
        .from(clientApprovals)
        .where(eq(clientApprovals.orderId, orderId))
        .orderBy(asc(clientApprovals.createdAt), asc(clientApprovals.id)),
      db
        .select()
        .from(orderEvents)
        .where(eq(orderEvents.orderId, orderId))
        .orderBy(asc(orderEvents.createdAt), asc(orderEvents.id)),
      latestRecheckItems(db, orderId),
    ]);

  const itemIds = items.map((item) => item.id);
  const [links, returns, stock] = await Promise.all([
    supplierRows.length === 0
      ? Promise.resolve([])
      : db
          .select()
          .from(supplierOrderItems)
          .where(
            inArray(
              supplierOrderItems.supplierOrderId,
              supplierRows.map((row) => row.id),
            ),
          ),
    itemIds.length === 0
      ? Promise.resolve([])
      : db
          .select()
          .from(supplierReturns)
          .where(inArray(supplierReturns.orderItemId, itemIds))
          .orderBy(asc(supplierReturns.createdAt), asc(supplierReturns.id)),
    itemIds.length === 0
      ? Promise.resolve([])
      : db
          .select()
          .from(stockItems)
          .where(inArray(stockItems.orderItemId, itemIds))
          .orderBy(asc(stockItems.createdAt), asc(stockItems.id)),
  ]);

  // Step 6: the client's cars (the order's own among them) only with GARAGE_ENABLED.
  const clientVehicles = options.garage ? await loadUserVehicles(db, order.userId) : [];
  const garage = options.garage
    ? {
        vehicle: clientVehicles.find((vehicle) => vehicle.id === order.vehicleId) ?? null,
        clientVehicles,
      }
    : null;

  const alternatives: Record<string, RecheckAlternative[]> = {};
  for (const result of recheck) {
    if (isUuid(result.orderItemId) && Array.isArray(result.alternatives)) {
      alternatives[result.orderItemId] = result.alternatives;
    }
  }

  return {
    order,
    client: {
      phone: user.phone,
      name: user.name,
      noShowCount: user.noShowCount,
      anonymized: user.anonymizedAt !== null,
    },
    items,
    payments: paymentRows,
    receipts: receiptRows,
    refunds: refundRows,
    supplierOrders: supplierRows.map((row) => ({
      ...row,
      itemIds: links.filter((l) => l.supplierOrderId === row.id).map((l) => l.orderItemId),
    })),
    approvals,
    supplierReturns: returns,
    stockItems: stock,
    events,
    orderPaymentId:
      refundablePayment({
        order,
        payments: paymentRows,
        refunds: refundRows,
      } as Pick<OrderSnapshot, 'order' | 'payments' | 'refunds'> as OrderSnapshot)?.id ?? null,
    alternatives,
    garage,
  };
}
