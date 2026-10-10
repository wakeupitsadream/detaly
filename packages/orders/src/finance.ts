/**
 * Step 7 (docs/month-close.md, roadmap r10 «Деньги под контролем»): the read model of the month
 * close, shared by /admin/month (web) and the monthly message to the owner (worker), and the
 * YooKassa reconciliation of a month with its stored snapshot.
 *
 * Every sum comes from stored rows, as recorded: receipts with their payments and refunds, order
 * items at the prices of the order (price_client, price_supplier_at_order), supplier orders'
 * delivery costs, supplier returns. Nothing is repriced, nothing here computes a tax.
 *
 * Sources of the month (bounds: monthBounds, Asia/Yekaterinburg):
 * - «Выручка по чекам»: receipts in status succeeded whose success fell in the month — the time
 *   of their journal event receipt_succeeded (receipts.updated_at for a row without one). The
 *   amount of a prepayment or full receipt is its payment (the receipt went inside the payment for
 *   exactly that amount), of an offset receipt its prepaymentKop, of a refund receipt its refund.
 *   Total = prepayment + full − refund receipts: the offset receipt at the handover brings no new
 *   money. Refunds that succeeded in the month (refunds.succeeded_at) are shown as a cross-check,
 *   and so are the orders handed in the month (orders.handed_at).
 * - «Маржа»: order items in state `handed` of the orders handed in the month; the delivery_cost of
 *   their (created) supplier orders split over the supplier order's items by purchase value.
 * - «Акт» (one fact per operation, CSV rows):
 *   receive — order_events `item_arrived` («Приехало», one per item);
 *   store_day — the calendar days from orders.received_at to orders.handed_at, or to the first
 *     journal transition out of ready / awaiting_handover_payment (a no-show, a refusal), or to
 *     today while the order is still at the point (storageDays);
 *   handover — order_events `handed_over` into `handed` (one per order);
 *   return_accept — claims.return_accepted_at («Принял возврат» with the photo);
 *   vin_selection — vin_requests.answered_at (the master's proposal sent; one per request);
 *   fit_check — fit_checks.answered_at of an answered line (one per checked cart line);
 *   claim_diagnostics — claims of kinds defect and not_fit decided in the month (claims.decided_at);
 *   the turnover rate applies to the revenue of the margin section (the orders handed).
 * - «Не доход»: supplier_returns refunded in the month (refunded_at, amount_received_kop).
 */
import { settingsDefaultsFromEnv, type Env } from '@detaly/config';
import {
  and,
  asc,
  claims,
  desc,
  eq,
  financeReconciliations,
  fitChecks,
  gte,
  inArray,
  isNotNull,
  lt,
  orderEvents,
  orderItems,
  orders,
  payments,
  readSnapshot,
  receipts,
  refunds,
  settings,
  sql,
  supplierOrderItems,
  supplierOrders,
  supplierReturns,
  vinRequests,
  type Database,
  type Executor,
} from '@detaly/db';
import {
  buildAct,
  CONTRACT_RATES_KEY,
  countActFacts,
  DEFAULT_ACQUIRING_BP,
  DEFAULT_CONTRACT_RATES,
  DEFAULT_FINANCE_REMINDER_DAYS,
  diffByIds,
  FINANCE_ACQUIRING_KEY,
  FINANCE_REMINDER_DAYS_KEY,
  FIT_CHECK_ANSWERS,
  inMonth,
  localDate,
  marginReport,
  monthBounds,
  parseAcquiringBp,
  parseContractRates,
  parseFinanceReminderDays,
  priceGroupOf,
  splitProportionally,
  storageDays,
  zonedDayStart,
  type ActCounts,
  type ActFact,
  type ActSummary,
  type ContractRates,
  type FinanceReminderDays,
  type MarginLine,
  type MarginReport,
  type MonthBounds,
  type MonthKey,
  type ReconDiffResult,
  type ReconItem,
} from '@detaly/domain';
import {
  PaymentProviderError,
  type PaymentProvider,
  type ProviderPayment,
  type ProviderRefund,
} from '@detaly/payments';
import type { SupplierReturnView } from './supplier-returns';

// ---------------------------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------------------------

export interface FinanceSettings {
  /** finance.acquiring_bp: the acquiring estimate of the margin (an estimate, see the docs). */
  acquiringBp: number;
  /** finance.reminder_days */
  reminderDays: FinanceReminderDays;
  /** contract.rates */
  rates: ContractRates;
  /** settings.updated_at of contract.rates ('none' without a row): the editor's version. */
  ratesVersion: string;
  ratesUpdatedAt: Date | null;
  ratesUpdatedBy: string | null;
}

const FINANCE_KEYS = [FINANCE_ACQUIRING_KEY, FINANCE_REMINDER_DAYS_KEY, CONTRACT_RATES_KEY];

/** The finance settings over the env defaults; a malformed value falls back to its default. */
export async function loadFinanceSettings(db: Executor, env: Env): Promise<FinanceSettings> {
  const rows = await db
    .select({
      key: settings.key,
      value: settings.value,
      updatedAt: settings.updatedAt,
      updatedBy: settings.updatedBy,
    })
    .from(settings)
    .where(inArray(settings.key, FINANCE_KEYS));
  const byKey = new Map(rows.map((row) => [row.key, row]));
  const defaults = settingsDefaultsFromEnv(env);
  const ratesRow = byKey.get(CONTRACT_RATES_KEY);
  return {
    acquiringBp:
      parseAcquiringBp(byKey.get(FINANCE_ACQUIRING_KEY)?.value) ??
      parseAcquiringBp(defaults['finance.acquiring_bp']) ??
      DEFAULT_ACQUIRING_BP,
    reminderDays:
      parseFinanceReminderDays(byKey.get(FINANCE_REMINDER_DAYS_KEY)?.value) ??
      parseFinanceReminderDays(defaults['finance.reminder_days']) ??
      DEFAULT_FINANCE_REMINDER_DAYS,
    rates:
      parseContractRates(ratesRow?.value) ??
      parseContractRates(defaults['contract.rates']) ??
      DEFAULT_CONTRACT_RATES,
    ratesVersion: ratesRow ? ratesRow.updatedAt.toISOString() : 'none',
    ratesUpdatedAt: ratesRow?.updatedAt ?? null,
    ratesUpdatedBy: ratesRow?.updatedBy ?? null,
  };
}

// ---------------------------------------------------------------------------------------------
// The month report
// ---------------------------------------------------------------------------------------------

export interface MoneyGroup {
  count: number;
  amountKop: number;
}

export interface MonthRevenue {
  /** Receipts «предоплата 100%» of prepay orders: the moment of the money for them. */
  prepayment: MoneyGroup;
  /** Receipts of payment at the point (full settlement inside the handover payment). */
  full: MoneyGroup;
  /** Offset receipts at the handover: no new money (counted in their prepayment receipt). */
  offset: MoneyGroup;
  /** Refund receipts (refund_prepayment, refund_full). */
  refunds: MoneyGroup;
  /** Correction receipts, counted only. */
  corrections: number;
  /** prepayment + full − refunds. */
  totalKop: number;
  /** Refunds that succeeded in the month (refunds rows): the money that went back to clients. */
  refundsSucceeded: MoneyGroup;
  /** Orders handed in the month. */
  handedOrders: number;
}

export interface MonthAct {
  facts: ActFact[];
  counts: ActCounts;
  summary: ActSummary;
}

export interface MonthReport {
  month: MonthKey;
  bounds: MonthBounds;
  settings: FinanceSettings;
  revenue: MonthRevenue;
  margin: MarginReport;
  act: MonthAct;
  /** Rossko's money for returned parts: not income (the bank checklist of /admin/month). */
  supplierRefunds: { rows: SupplierReturnView[]; totalKop: number };
}

/** Postgres timestamptz of a raw select: postgres-js gives a Date, a string after JSON. */
function toDate(value: Date | string | null | undefined): Date | null {
  if (value === null || value === undefined) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

const isKopValue = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

/** Sum of the request lines of a receipt row (quantity × unitPriceKop), null when unreadable. */
function linesSumKop(request: unknown): number | null {
  const lines = (request as { lines?: unknown } | null)?.lines;
  if (!Array.isArray(lines) || lines.length === 0) return null;
  let sum = 0;
  for (const line of lines) {
    const { quantity, unitPriceKop } = (line ?? {}) as {
      quantity?: unknown;
      unitPriceKop?: unknown;
    };
    if (!isKopValue(quantity) || !isKopValue(unitPriceKop)) return null;
    sum += quantity * unitPriceKop;
  }
  return Number.isSafeInteger(sum) ? sum : null;
}

function offsetAmountKop(request: unknown): number | null {
  const prepayment = (request as { prepaymentKop?: unknown } | null)?.prepaymentKop;
  return isKopValue(prepayment) ? prepayment : linesSumKop(request);
}

async function loadRevenue(db: Executor, bounds: MonthBounds): Promise<MonthRevenue> {
  // Correlated subqueries name the outer table explicitly: drizzle leaves the columns of a
  // single-table select unqualified, and an inner table with the same column would capture them.
  const succeededAt = sql<Date | string | null>`(
    select min(e.created_at) from order_events e
    where e.order_id = "receipts"."order_id" and e.type = 'receipt_succeeded'
      and e.payload->>'receiptId' = "receipts"."id"::text)`;
  // A receipt that succeeded in the month was last updated at that moment or later.
  const rows = await db
    .select({
      kind: receipts.kind,
      request: receipts.request,
      updatedAt: receipts.updatedAt,
      succeededAt,
      paymentAmountKop: payments.amountKop,
      refundAmountKop: refunds.amountKop,
    })
    .from(receipts)
    .leftJoin(payments, eq(payments.id, receipts.paymentId))
    .leftJoin(refunds, eq(refunds.id, receipts.refundId))
    .where(and(eq(receipts.status, 'succeeded'), gte(receipts.updatedAt, bounds.start)));
  const group = (): MoneyGroup => ({ count: 0, amountKop: 0 });
  const revenue: MonthRevenue = {
    prepayment: group(),
    full: group(),
    offset: group(),
    refunds: group(),
    corrections: 0,
    totalKop: 0,
    refundsSucceeded: group(),
    handedOrders: 0,
  };
  for (const row of rows) {
    const at = toDate(row.succeededAt) ?? row.updatedAt;
    if (!inMonth(at, bounds)) continue;
    let target: MoneyGroup | null = null;
    let amount: number | null = null;
    switch (row.kind) {
      case 'prepayment':
      case 'full':
        target = revenue[row.kind];
        amount = row.paymentAmountKop ?? linesSumKop(row.request);
        break;
      case 'offset':
        target = revenue.offset;
        amount = offsetAmountKop(row.request);
        break;
      case 'refund_prepayment':
      case 'refund_full':
        target = revenue.refunds;
        amount = row.refundAmountKop ?? linesSumKop(row.request);
        break;
      case 'correction':
        revenue.corrections += 1;
        break;
    }
    if (target === null) continue;
    target.count += 1;
    target.amountKop += amount ?? 0;
  }
  revenue.totalKop =
    revenue.prepayment.amountKop + revenue.full.amountKop - revenue.refunds.amountKop;

  const [refunded] = await db
    .select({
      count: sql<number>`count(*)::int`,
      amountKop: sql<number>`coalesce(sum(${refunds.amountKop}), 0)::bigint`,
    })
    .from(refunds)
    .where(
      and(
        eq(refunds.status, 'succeeded'),
        gte(refunds.succeededAt, bounds.start),
        lt(refunds.succeededAt, bounds.end),
      ),
    );
  revenue.refundsSucceeded = {
    count: Number(refunded?.count ?? 0),
    amountKop: Number(refunded?.amountKop ?? 0),
  };
  const [handed] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(orders)
    .where(and(gte(orders.handedAt, bounds.start), lt(orders.handedAt, bounds.end)));
  revenue.handedOrders = Number(handed?.count ?? 0);
  return revenue;
}

async function loadMarginLines(db: Executor, bounds: MonthBounds): Promise<MarginLine[]> {
  const items = await db
    .select({
      id: orderItems.id,
      orderId: orders.id,
      orderNumber: orders.number,
      name: orderItems.name,
      offerSnapshot: orderItems.offerSnapshot,
      qty: orderItems.qty,
      priceClientKop: orderItems.priceClientKop,
      priceSupplierAtOrderKop: orderItems.priceSupplierAtOrderKop,
    })
    .from(orderItems)
    .innerJoin(orders, eq(orders.id, orderItems.orderId))
    .where(
      and(
        gte(orders.handedAt, bounds.start),
        lt(orders.handedAt, bounds.end),
        eq(orderItems.state, 'handed'),
      ),
    )
    .orderBy(asc(orders.number), asc(orderItems.createdAt), asc(orderItems.id));
  if (items.length === 0) return [];

  // Delivery costs of the supplier orders these items came with, split by purchase value over
  // every item of the supplier order.
  const delivery = new Map<string, number>();
  const costly = await db
    .selectDistinct({ id: supplierOrders.id, costKop: supplierOrders.deliveryCostKop })
    .from(supplierOrders)
    .innerJoin(supplierOrderItems, eq(supplierOrderItems.supplierOrderId, supplierOrders.id))
    .where(
      and(
        eq(supplierOrders.status, 'created'),
        isNotNull(supplierOrders.deliveryCostKop),
        inArray(
          supplierOrderItems.orderItemId,
          items.map((item) => item.id),
        ),
      ),
    );
  const withCost = costly.filter((row) => (row.costKop ?? 0) > 0);
  if (withCost.length > 0) {
    const links = await db
      .select({
        supplierOrderId: supplierOrderItems.supplierOrderId,
        orderItemId: orderItems.id,
        weight: sql<number>`(${orderItems.priceSupplierAtOrderKop}::bigint * ${orderItems.qty})`,
      })
      .from(supplierOrderItems)
      .innerJoin(orderItems, eq(orderItems.id, supplierOrderItems.orderItemId))
      .where(
        inArray(
          supplierOrderItems.supplierOrderId,
          withCost.map((row) => row.id),
        ),
      )
      .orderBy(asc(supplierOrderItems.orderItemId));
    for (const order of withCost) {
      const parts = links.filter((link) => link.supplierOrderId === order.id);
      const shares = splitProportionally(
        order.costKop ?? 0,
        parts.map((part) => Number(part.weight)),
      );
      parts.forEach((part, index) => {
        delivery.set(
          part.orderItemId,
          (delivery.get(part.orderItemId) ?? 0) + (shares[index] ?? 0),
        );
      });
    }
  }
  return items.map((item) => ({
    orderId: item.orderId,
    orderNumber: item.orderNumber,
    group: priceGroupOf({ productGroup: item.offerSnapshot?.group ?? null, name: item.name }),
    revenueKop: item.priceClientKop * item.qty,
    purchaseKop: item.priceSupplierAtOrderKop * item.qty,
    deliveryKop: delivery.get(item.id) ?? 0,
  }));
}

const STORAGE_STATUSES = ['ready', 'awaiting_handover_payment'] as const;

async function loadActFacts(db: Executor, bounds: MonthBounds, now: Date): Promise<ActFact[]> {
  const between = (column: Parameters<typeof gte>[0]) =>
    and(gte(column, bounds.start), lt(column, bounds.end));
  const facts: ActFact[] = [];

  // receive, handover: the journal.
  const events = await db
    .select({ type: orderEvents.type, at: orderEvents.createdAt, orderNumber: orders.number })
    .from(orderEvents)
    .innerJoin(orders, eq(orders.id, orderEvents.orderId))
    .where(
      and(
        inArray(orderEvents.type, ['item_arrived', 'handed_over']),
        between(orderEvents.createdAt),
      ),
    );
  for (const event of events) {
    facts.push({
      operation: event.type === 'item_arrived' ? 'receive' : 'handover',
      at: event.at,
      orderNumber: event.orderNumber,
      ref: null,
    });
  }

  // store_day: the calendar days at the point.
  const leftAt = sql<Date | string | null>`(
    select min(e.created_at) from order_events e
    where e.order_id = "orders"."id"
      and e.from_status in ('ready', 'awaiting_handover_payment')
      and e.to_status not in ('ready', 'awaiting_handover_payment')
      and e.created_at >= "orders"."received_at")`;
  const stored = await db
    .select({
      number: orders.number,
      status: orders.status,
      receivedAt: orders.receivedAt,
      handedAt: orders.handedAt,
      leftAt,
    })
    .from(orders)
    .where(
      and(
        isNotNull(orders.receivedAt),
        lt(orders.receivedAt, bounds.end),
        sql`(${orders.handedAt} is null or ${orders.handedAt} >= ${bounds.start.toISOString()}::timestamptz)`,
      ),
    );
  const today = localDate(now);
  for (const order of stored) {
    if (order.receivedAt === null) continue;
    const end =
      order.handedAt ??
      toDate(order.leftAt) ??
      ((STORAGE_STATUSES as readonly string[]).includes(order.status) ? null : order.receivedAt);
    const to = end === null ? today : localDate(end);
    for (const day of storageDays(localDate(order.receivedAt), to, bounds.month)) {
      facts.push({
        operation: 'store_day',
        at: zonedDayStart(day),
        orderNumber: order.number,
        ref: null,
      });
    }
  }

  // return_accept, claim_diagnostics: the claims.
  const accepted = await db
    .select({ at: claims.returnAcceptedAt, orderNumber: orders.number })
    .from(claims)
    .innerJoin(orders, eq(orders.id, claims.orderId))
    .where(between(claims.returnAcceptedAt));
  for (const claim of accepted) {
    if (claim.at === null) continue;
    facts.push({
      operation: 'return_accept',
      at: claim.at,
      orderNumber: claim.orderNumber,
      ref: null,
    });
  }
  const diagnosed = await db
    .select({ at: claims.decidedAt, orderNumber: orders.number })
    .from(claims)
    .innerJoin(orders, eq(orders.id, claims.orderId))
    .where(
      and(
        inArray(claims.kind, ['defect', 'not_fit']),
        isNotNull(claims.decision),
        between(claims.decidedAt),
      ),
    );
  for (const claim of diagnosed) {
    if (claim.at === null) continue;
    facts.push({
      operation: 'claim_diagnostics',
      at: claim.at,
      orderNumber: claim.orderNumber,
      ref: null,
    });
  }

  // vin_selection: the master's proposal sent (the order checked out from it, if any).
  const vin = await db
    .select({
      id: vinRequests.id,
      at: vinRequests.answeredAt,
      orderNumber: sql<
        string | null
      >`(select min(o.number) from orders o where o.vin_request_id = "vin_requests"."id")`,
    })
    .from(vinRequests)
    .where(between(vinRequests.answeredAt));
  for (const request of vin) {
    if (request.at === null) continue;
    facts.push({
      operation: 'vin_selection',
      at: request.at,
      orderNumber: request.orderNumber,
      ref: request.orderNumber === null ? `VIN ${request.id.slice(0, 8)}` : null,
    });
  }

  // fit_check: an answered line (the order of the checked line, if it was bought).
  const fit = await db
    .select({
      requestId: fitChecks.requestId,
      at: fitChecks.answeredAt,
      orderNumber: sql<string | null>`(
        select min(o.number) from order_items i join orders o on o.id = i.order_id
        where i.fit_check_id = "fit_checks"."id")`,
    })
    .from(fitChecks)
    .where(and(inArray(fitChecks.status, [...FIT_CHECK_ANSWERS]), between(fitChecks.answeredAt)));
  for (const check of fit) {
    if (check.at === null) continue;
    facts.push({
      operation: 'fit_check',
      at: check.at,
      orderNumber: check.orderNumber,
      ref: check.orderNumber === null ? `проверка ${check.requestId.slice(0, 8)}` : null,
    });
  }
  return facts;
}

async function loadSupplierRefunds(
  db: Executor,
  bounds: MonthBounds,
): Promise<MonthReport['supplierRefunds']> {
  const rows = await db
    .select({
      id: supplierReturns.id,
      orderId: orders.id,
      orderNumber: orders.number,
      orderItemId: orderItems.id,
      brand: orderItems.brand,
      article: orderItems.article,
      name: orderItems.name,
      qty: orderItems.qty,
      kind: supplierReturns.kind,
      status: supplierReturns.status,
      amountExpectedKop: supplierReturns.amountExpectedKop,
      amountReceivedKop: supplierReturns.amountReceivedKop,
      note: supplierReturns.note,
      createdAt: supplierReturns.createdAt,
      shippedAt: supplierReturns.shippedAt,
      refundedAt: supplierReturns.refundedAt,
      updatedAt: supplierReturns.updatedAt,
      deadlineAt: orders.supplierReturnDeadlineAt,
    })
    .from(supplierReturns)
    .innerJoin(orderItems, eq(orderItems.id, supplierReturns.orderItemId))
    .innerJoin(orders, eq(orders.id, orderItems.orderId))
    .where(
      and(
        eq(supplierReturns.status, 'refunded'),
        gte(supplierReturns.refundedAt, bounds.start),
        lt(supplierReturns.refundedAt, bounds.end),
      ),
    )
    .orderBy(asc(supplierReturns.refundedAt), asc(supplierReturns.id));
  return {
    rows,
    totalKop: rows.reduce((sum, row) => sum + (row.amountReceivedKop ?? 0), 0),
  };
}

/**
 * Everything /admin/month shows except the reconciliation (loadLatestReconciliation), read in one
 * consistent snapshot. `now` bounds the storage of orders still at the point.
 */
export async function loadMonthReport(
  db: Executor,
  env: Env,
  month: MonthKey,
  now: Date,
): Promise<MonthReport> {
  const bounds = monthBounds(month);
  return readSnapshot(db, async (tx) => {
    const finance = await loadFinanceSettings(tx, env);
    const revenue = await loadRevenue(tx, bounds);
    const margin = marginReport(await loadMarginLines(tx, bounds), finance.acquiringBp);
    const facts = await loadActFacts(tx, bounds, now);
    const counts = countActFacts(facts);
    return {
      month,
      bounds,
      settings: finance,
      revenue,
      margin,
      act: {
        facts,
        counts,
        summary: buildAct(counts, finance.rates, margin.totals.revenueKop),
      },
      supplierRefunds: await loadSupplierRefunds(tx, bounds),
    };
  });
}

// ---------------------------------------------------------------------------------------------
// The YooKassa reconciliation of a month
// ---------------------------------------------------------------------------------------------

export interface ReconciliationResult {
  month: MonthKey;
  /** The provider window [from, to) as ISO timestamps. */
  window: { from: string; to: string };
  /** null when the payment list could not be read (see errors). */
  payments: ReconDiffResult | null;
  refunds: ReconDiffResult | null;
  /** Provider errors in the staff's words (no personal data). */
  errors: string[];
  /** Objects re-read one by one at the month's edges. */
  lookups: number;
}

export interface ReconciliationSnapshot {
  id: string;
  month: MonthKey;
  createdAt: Date;
  createdBy: string;
  result: ReconciliationResult;
}

/** Page guard: 50 × 100 objects a month is far beyond the expected volume. */
const MAX_PAGES = 50;
/** Objects missing from the other side re-read one by one, at most this many per kind. */
const MAX_LOOKUPS = 50;

/**
 * The PaymentProviderError of an error, also of another bundle's copy of the class: web's Next
 * build may hold two copies of @detaly/payments (the provider singleton and this module), so the
 * name decides as well (like isNamedError of web).
 */
function providerError(error: unknown): PaymentProviderError | null {
  if (error instanceof PaymentProviderError) return error;
  if (
    error instanceof Error &&
    error.name === 'PaymentProviderError' &&
    typeof (error as { details?: unknown }).details === 'object' &&
    (error as { details?: unknown }).details !== null
  ) {
    return error as PaymentProviderError;
  }
  return null;
}

/** A provider failure in the staff's words, without personal data. */
export function providerErrorText(error: unknown): string {
  const known = providerError(error);
  if (known !== null) {
    const { status, code } = known.details;
    if (code === 'network') return 'ЮKassa не ответила (сеть или таймаут)';
    if (code === 'bad_response') return 'ЮKassa прислала непонятный ответ';
    if (status !== null) return `ЮKassa ответила ошибкой HTTP ${status}${code ? ` (${code})` : ''}`;
    return `Ошибка ЮKassa${code ? ` (${code})` : ''}`;
  }
  return 'Ошибка при запросе к ЮKassa';
}

function isNotFound(error: unknown): boolean {
  return providerError(error)?.details.status === 404;
}

async function listAll<T>(
  page: (cursor: string | null) => Promise<{ items: T[]; nextCursor: string | null }>,
): Promise<T[]> {
  const items: T[] = [];
  let cursor: string | null = null;
  for (let index = 0; index < MAX_PAGES; index += 1) {
    const result = await page(cursor);
    items.push(...result.items);
    if (result.nextCursor === null) return items;
    cursor = result.nextCursor;
  }
  throw new RangeError('provider list longer than the page guard');
}

/** The provider's refund statuses in the database's words (a canceled refund is `failed`). */
function refundStatusOf(status: ProviderRefund['status']): string {
  return status === 'canceled' ? 'failed' : status;
}

const paymentItem = (p: ProviderPayment): ReconItem => ({
  id: p.id,
  amountKop: p.amountKop,
  status: p.status,
  label: p.metadata.order_number ?? null,
});

const refundItem = (r: ProviderRefund): ReconItem => ({
  id: r.id,
  amountKop: r.amountKop,
  status: refundStatusOf(r.status),
  label: null,
});

/**
 * «Сверить» of /admin/month: the month's payments and refunds listed by the provider (cursor
 * paging) against the rows with a provider id created in the month. Objects missing on one side
 * are looked up once more (the provider by id, the database without the date window) so that a
 * payment created at 23:59:59 on our side and at 00:00:01 at YooKassa is not a difference. A
 * provider failure is recorded as text in the result (and that list is not compared), never
 * thrown. The result is stored as a finance_reconciliations row and returned.
 */
export async function runMonthReconciliation(input: {
  db: Database;
  provider: PaymentProvider;
  month: MonthKey;
  createdBy: string;
}): Promise<ReconciliationSnapshot> {
  const { db, provider, month } = input;
  const bounds = monthBounds(month);
  const window = { createdGte: bounds.start.toISOString(), createdLt: bounds.end.toISOString() };
  const result: ReconciliationResult = {
    month,
    window: { from: window.createdGte, to: window.createdLt },
    payments: null,
    refunds: null,
    errors: [],
    lookups: 0,
  };

  // --- payments ---------------------------------------------------------------------------
  let listedPayments: ProviderPayment[] | null = null;
  try {
    listedPayments = await listAll((cursor) => provider.listPayments({ ...window, cursor }));
  } catch (error) {
    result.errors.push(`Платежи: ${providerErrorText(error)}`);
  }
  if (listedPayments !== null) {
    const ours = await db
      .select({
        id: payments.providerPaymentId,
        amountKop: payments.amountKop,
        status: payments.status,
        label: orders.number,
      })
      .from(payments)
      .innerJoin(orders, eq(orders.id, payments.orderId))
      .where(
        and(
          eq(payments.provider, 'yookassa'),
          isNotNull(payments.providerPaymentId),
          gte(payments.createdAt, bounds.start),
          lt(payments.createdAt, bounds.end),
        ),
      );
    const dbItems: ReconItem[] = ours.map((row) => ({ ...row, id: row.id as string }));
    const providerItems = listedPayments.map(paymentItem);
    const listedIds = new Set(providerItems.map((item) => item.id));
    const ourIds = new Set(dbItems.map((item) => item.id));
    // Ours the list did not show: the provider by id (a payment at the edge of the month).
    for (const item of dbItems.filter((row) => !listedIds.has(row.id)).slice(0, MAX_LOOKUPS)) {
      result.lookups += 1;
      try {
        providerItems.push(paymentItem(await provider.getPayment(item.id)));
      } catch (error) {
        if (!isNotFound(error))
          result.errors.push(`Платёж ${item.label ?? ''}: ${providerErrorText(error)}`.trim());
      }
    }
    // Theirs we did not select: our rows of any date with these ids.
    const unknown = providerItems.filter((item) => !ourIds.has(item.id)).map((item) => item.id);
    if (unknown.length > 0) {
      const found = await db
        .select({
          id: payments.providerPaymentId,
          amountKop: payments.amountKop,
          status: payments.status,
          label: orders.number,
        })
        .from(payments)
        .innerJoin(orders, eq(orders.id, payments.orderId))
        .where(
          and(eq(payments.provider, 'yookassa'), inArray(payments.providerPaymentId, unknown)),
        );
      dbItems.push(...found.map((row) => ({ ...row, id: row.id as string })));
    }
    result.payments = diffByIds(dbItems, providerItems);
  }

  // --- refunds ----------------------------------------------------------------------------
  let listedRefunds: ProviderRefund[] | null = null;
  try {
    listedRefunds = await listAll((cursor) => provider.listRefunds({ ...window, cursor }));
  } catch (error) {
    result.errors.push(`Возвраты: ${providerErrorText(error)}`);
  }
  if (listedRefunds !== null) {
    const refundRow = {
      id: refunds.providerRefundId,
      amountKop: refunds.amountKop,
      status: refunds.status,
      label: orders.number,
    };
    const ours = await db
      .select(refundRow)
      .from(refunds)
      .innerJoin(orders, eq(orders.id, refunds.orderId))
      .where(
        and(
          isNotNull(refunds.providerRefundId),
          gte(refunds.createdAt, bounds.start),
          lt(refunds.createdAt, bounds.end),
        ),
      );
    const dbItems: ReconItem[] = ours.map((row) => ({ ...row, id: row.id as string }));
    const providerItems = listedRefunds.map(refundItem);
    const listedIds = new Set(providerItems.map((item) => item.id));
    const ourIds = new Set(dbItems.map((item) => item.id));
    for (const item of dbItems.filter((row) => !listedIds.has(row.id)).slice(0, MAX_LOOKUPS)) {
      result.lookups += 1;
      try {
        providerItems.push(refundItem(await provider.getRefund(item.id)));
      } catch (error) {
        if (!isNotFound(error))
          result.errors.push(`Возврат ${item.label ?? ''}: ${providerErrorText(error)}`.trim());
      }
    }
    const unknown = providerItems.filter((item) => !ourIds.has(item.id)).map((item) => item.id);
    if (unknown.length > 0) {
      const found = await db
        .select(refundRow)
        .from(refunds)
        .innerJoin(orders, eq(orders.id, refunds.orderId))
        .where(inArray(refunds.providerRefundId, unknown));
      dbItems.push(...found.map((row) => ({ ...row, id: row.id as string })));
    }
    // A refund's order number is the label on both sides once matched.
    const labels = new Map(dbItems.map((item) => [item.id, item.label ?? null]));
    result.refunds = diffByIds(
      dbItems,
      providerItems.map((item) => ({ ...item, label: labels.get(item.id) ?? null })),
    );
  }

  const [row] = await db
    .insert(financeReconciliations)
    .values({
      month,
      createdBy: input.createdBy,
      result: result as unknown as Record<string, unknown>,
    })
    .returning();
  if (!row) throw new Error('finance reconciliation not stored');
  return { id: row.id, month, createdAt: row.createdAt, createdBy: row.createdBy, result };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function parseDiffResult(raw: unknown): ReconDiffResult | null {
  if (!isRecord(raw) || !Array.isArray(raw.differences)) return null;
  const count = (value: unknown) => (typeof value === 'number' ? value : 0);
  return {
    dbCount: count(raw.dbCount),
    providerCount: count(raw.providerCount),
    matched: count(raw.matched),
    differences: raw.differences.filter(isRecord) as unknown as ReconDiffResult['differences'],
  };
}

/** A stored result read back defensively (the page never trusts jsonb blindly). */
export function parseReconciliationResult(raw: unknown): ReconciliationResult | null {
  if (!isRecord(raw) || typeof raw.month !== 'string' || !isRecord(raw.window)) return null;
  return {
    month: raw.month,
    window: {
      from: typeof raw.window.from === 'string' ? raw.window.from : '',
      to: typeof raw.window.to === 'string' ? raw.window.to : '',
    },
    payments: parseDiffResult(raw.payments),
    refunds: parseDiffResult(raw.refunds),
    errors: Array.isArray(raw.errors)
      ? raw.errors.filter((e): e is string => typeof e === 'string')
      : [],
    lookups: typeof raw.lookups === 'number' ? raw.lookups : 0,
  };
}

/** The last «Сверить» of a month, or null. */
export async function loadLatestReconciliation(
  db: Executor,
  month: MonthKey,
): Promise<ReconciliationSnapshot | null> {
  const [row] = await db
    .select()
    .from(financeReconciliations)
    .where(eq(financeReconciliations.month, month))
    .orderBy(desc(financeReconciliations.createdAt), desc(financeReconciliations.id))
    .limit(1);
  if (!row) return null;
  const result = parseReconciliationResult(row.result);
  if (result === null) return null;
  return {
    id: row.id,
    month: row.month,
    createdAt: row.createdAt,
    createdBy: row.createdBy,
    result,
  };
}

/** Differences of a stored result (payments and refunds), 0 without lists. */
export function reconciliationDifferenceCount(result: ReconciliationResult): number {
  return (result.payments?.differences.length ?? 0) + (result.refunds?.differences.length ?? 0);
}
