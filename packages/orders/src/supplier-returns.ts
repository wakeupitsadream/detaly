/**
 * Step 7 (docs/month-close.md, roadmap r10): supplier returns to the end. The rows are created
 * where they always were — the engine (supplier_return_task of a no-show or a refusal at the
 * point, supplier_claim_and_reorder of a part damaged on receipt) and the claims (decideClaim:
 * a part accepted back, a replacement); here they go on:
 *
 * - «Сдал водителю» (srship, any staff member, the bot or the admin): requested -> shipped with
 *   shipped_at; the deadline reminders stop, the 10-day wait for the money starts;
 * - «Не берут» (srrej, any staff member): requested -> rejected, and the part stays with us as a
 *   stock_items row at the cost of the order (price_supplier_at_order × qty) with the reason
 *   «Не принят поставщиком»; the owner's «Rossko не принял» of the admin (performStaffAction
 *   supplier_return_reject) goes through the same function, also after «Сдал водителю»;
 * - «Деньги вернулись» (the admin): requested | shipped | accepted -> refunded with the amount
 *   received and refunded_at — the month's list of money that is not income (/admin/month);
 * - «Списать» (the admin): stock_items.written_off_at.
 *
 * Every change runs under the order row lock (the lock order of every order action) and is
 * idempotent: a second press finds the state already there and answers «Уже отмечено» without a
 * second row. Journal payloads carry ids, codes and amounts only. Phase 4 (GetSettlements, with the
 * Rossko keys) may mark «Деньги вернулись» by itself: see the TODO in the reminders job.
 */
import {
  and,
  asc,
  desc,
  eq,
  gte,
  inArray,
  isNull,
  orderItems,
  orders,
  or,
  stockItems,
  supplierReturns,
  type Executor,
} from '@detaly/db';
import {
  formatDayMonth,
  formatRub,
  localDate,
  SUPPLIER_RETURN_OPEN_STATUSES,
  type Kop,
  type SupplierReturnKind,
  type SupplierReturnStatus,
} from '@detaly/domain';
import { clock, nudge } from './engine';
import { recordJournalEvent } from './journal';
import { isUuid } from './snapshot';
import type {
  ActorRef,
  EngineDeps,
  StaffActionResult,
  StaffRef,
  SupplierReturnActionView,
  Tx,
} from './types';

/** stock_items.reason of «Не берут» (the spec's words, shown on /admin/stock). */
export const STOCK_REASON_NOT_ACCEPTED = 'Не принят поставщиком';

/** Statuses after which nothing more happens to a return. */
const CLOSED: readonly SupplierReturnStatus[] = ['rejected', 'refunded'];

/** The largest amount «Деньги вернулись» accepts: 1 000 000 ₽ (a typo guard). */
export const SUPPLIER_REFUND_MAX_KOP = 100_000_000;

export const SUPPLIER_RETURN_STATUS_LABELS: Readonly<Record<SupplierReturnStatus, string>> = {
  requested: 'ждёт сдачи водителю',
  shipped: 'сдан водителю, ждём деньги',
  accepted: 'принят поставщиком, ждём деньги',
  rejected: 'не принят — на складе',
  refunded: 'деньги вернулись',
};

export const SUPPLIER_RETURN_KIND_LABELS: Readonly<Record<SupplierReturnKind, string>> = {
  return: 'возврат',
  claim: 'рекламация',
};

/** A supplier return with its part and order, for the bot card and the admin pages. */
export interface SupplierReturnView {
  id: string;
  orderId: string;
  orderNumber: string;
  orderItemId: string;
  brand: string;
  article: string;
  name: string;
  qty: number;
  kind: SupplierReturnKind;
  status: SupplierReturnStatus;
  amountExpectedKop: Kop | null;
  amountReceivedKop: Kop | null;
  note: string | null;
  createdAt: Date;
  shippedAt: Date | null;
  refundedAt: Date | null;
  updatedAt: Date;
  /** orders.supplier_return_deadline_at: the part must be with Rossko by then. */
  deadlineAt: Date | null;
}

const viewColumns = {
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
};

/** «MANN W 914/2» */
export function supplierReturnTitle(view: Pick<SupplierReturnView, 'brand' | 'article'>): string {
  return `${view.brand} ${view.article}`;
}

/** The supplier returns of one order, oldest first (the bot card, the admin order card). */
export async function loadOrderSupplierReturns(
  db: Executor,
  orderId: string,
): Promise<SupplierReturnView[]> {
  if (!isUuid(orderId)) return [];
  return db
    .select(viewColumns)
    .from(supplierReturns)
    .innerJoin(orderItems, eq(orderItems.id, supplierReturns.orderItemId))
    .innerJoin(orders, eq(orders.id, orderItems.orderId))
    .where(eq(orders.id, orderId))
    .orderBy(asc(supplierReturns.createdAt), asc(supplierReturns.id));
}

/**
 * /admin/returns: every open return (waiting to leave or waiting for the money) and the ones
 * closed since `closedSince` (refunded or rejected), most urgent first (sortSupplierReturns).
 */
export async function listSupplierReturns(
  db: Executor,
  input: { now: Date; closedSince: Date },
): Promise<SupplierReturnView[]> {
  const rows = await db
    .select(viewColumns)
    .from(supplierReturns)
    .innerJoin(orderItems, eq(orderItems.id, supplierReturns.orderItemId))
    .innerJoin(orders, eq(orders.id, orderItems.orderId))
    .where(
      or(
        inArray(supplierReturns.status, [...SUPPLIER_RETURN_OPEN_STATUSES]),
        and(
          inArray(supplierReturns.status, [...CLOSED]),
          gte(supplierReturns.updatedAt, input.closedSince),
        ),
      ),
    )
    .orderBy(asc(supplierReturns.createdAt), asc(supplierReturns.id))
    .limit(500);
  return sortSupplierReturns(rows, input.now);
}

/** Urgency of a return on /admin/returns and in the bot card. */
export type SupplierReturnUrgency = 'overdue' | 'due_soon' | 'waiting_money' | 'open' | 'closed';

/** Two days before the deadline a waiting part is «due soon». */
const DUE_SOON_MS = 2 * 24 * 60 * 60 * 1000;

export function supplierReturnUrgency(
  view: Pick<SupplierReturnView, 'status' | 'deadlineAt'>,
  now: Date,
): SupplierReturnUrgency {
  if (CLOSED.includes(view.status)) return 'closed';
  if (view.status !== 'requested') return 'waiting_money';
  if (view.deadlineAt === null) return 'open';
  const left = view.deadlineAt.getTime() - now.getTime();
  if (left <= 0) return 'overdue';
  return left <= DUE_SOON_MS ? 'due_soon' : 'open';
}

const URGENCY_ORDER: readonly SupplierReturnUrgency[] = [
  'overdue',
  'due_soon',
  'open',
  'waiting_money',
  'closed',
];

/**
 * Overdue first, then due soon, other waiting parts by deadline, then the parts that left (the
 * longest wait for the money first), then the closed ones (the latest first).
 */
export function sortSupplierReturns<T extends SupplierReturnView>(
  views: readonly T[],
  now: Date,
): T[] {
  const time = (date: Date | null) => (date === null ? Number.POSITIVE_INFINITY : date.getTime());
  return [...views].sort((a, b) => {
    const ua = URGENCY_ORDER.indexOf(supplierReturnUrgency(a, now));
    const ub = URGENCY_ORDER.indexOf(supplierReturnUrgency(b, now));
    if (ua !== ub) return ua - ub;
    const urgency = URGENCY_ORDER[ua];
    if (urgency === 'waiting_money') {
      return time(a.shippedAt ?? a.createdAt) - time(b.shippedAt ?? b.createdAt);
    }
    if (urgency === 'closed') return b.updatedAt.getTime() - a.updatedAt.getTime();
    return (
      time(a.deadlineAt) - time(b.deadlineAt) ||
      a.createdAt.getTime() - b.createdAt.getTime() ||
      a.id.localeCompare(b.id)
    );
  });
}

/**
 * The bot card's buttons: «Сдал водителю» and «Не берут» per return still at the point. A part
 * that left is not pressed again in the bot: the owner records the outcome in the admin.
 */
export function supplierReturnActions(
  returns: readonly Pick<SupplierReturnView, 'id' | 'status' | 'brand' | 'article'>[],
): SupplierReturnActionView[] {
  const views: SupplierReturnActionView[] = [];
  for (const ret of returns) {
    if (ret.status !== 'requested') continue;
    const title = supplierReturnTitle(ret);
    views.push(
      {
        code: 'srship',
        label: `Сдал водителю: ${title}`,
        supplierReturnId: ret.id,
        enabled: true,
        disabledReason: null,
      },
      {
        code: 'srrej',
        label: `Не берут: ${title}`,
        supplierReturnId: ret.id,
        enabled: true,
        disabledReason: null,
      },
    );
  }
  return views;
}

/** The buttons of an order's returns for the staff member pressing them (both roles alike). */
export async function loadSupplierReturnActions(
  db: Executor,
  orderId: string,
): Promise<SupplierReturnActionView[]> {
  return supplierReturnActions(await loadOrderSupplierReturns(db, orderId));
}

/** The order of a supplier return (resolveTarget of performStaffAction). */
export async function supplierReturnOrderId(db: Executor, supplierReturnId: string) {
  if (!isUuid(supplierReturnId)) return null;
  const [row] = await db
    .select({ orderId: orderItems.orderId })
    .from(supplierReturns)
    .innerJoin(orderItems, eq(orderItems.id, supplierReturns.orderItemId))
    .where(eq(supplierReturns.id, supplierReturnId));
  return row?.orderId ?? null;
}

export function staffActorOf(staff: StaffRef): ActorRef {
  return {
    type: 'staff',
    id: staff.id ?? (staff.via === 'admin' ? 'admin' : null),
    staffRole: staff.role,
  };
}

class Refused extends Error {
  constructor(readonly result: StaffActionResult) {
    super(result.message);
  }
}

interface LockedReturn {
  tx: Tx;
  ret: typeof supplierReturns.$inferSelect;
  item: typeof orderItems.$inferSelect;
  order: { id: string; number: string };
  at: Date;
}

/** Runs `run` under the order row lock of the return; a refusal writes nothing. */
async function withLockedReturn(
  deps: EngineDeps,
  supplierReturnId: string,
  run: (locked: LockedReturn) => Promise<StaffActionResult>,
): Promise<StaffActionResult> {
  const missing: StaffActionResult = {
    ok: false,
    message: 'Возврат поставщику не найден',
    orderId: supplierReturnId,
  };
  if (!isUuid(supplierReturnId)) return missing;
  try {
    const result = await deps.db.transaction(async (tx) => {
      const orderId = await supplierReturnOrderId(tx, supplierReturnId);
      if (orderId === null) return missing;
      const [order] = await tx
        .select({ id: orders.id, number: orders.number })
        .from(orders)
        .where(eq(orders.id, orderId))
        .for('update');
      if (!order) return missing;
      const [found] = await tx
        .select({ ret: supplierReturns, item: orderItems })
        .from(supplierReturns)
        .innerJoin(orderItems, eq(orderItems.id, supplierReturns.orderItemId))
        .where(eq(supplierReturns.id, supplierReturnId));
      if (!found) return missing;
      const out = await run({ tx, ret: found.ret, item: found.item, order, at: clock(deps) });
      if (!out.ok) throw new Refused(out);
      return out;
    });
    if (result.ok) nudge(deps);
    return result;
  } catch (error) {
    if (error instanceof Refused) return error.result;
    throw error;
  }
}

function dayText(at: Date | null): string {
  return at === null ? '' : ` ${formatDayMonth(localDate(at))}`;
}

/** «Сдал водителю»: requested -> shipped (shipped_at); a second press changes nothing. */
export async function shipSupplierReturn(
  deps: EngineDeps,
  input: { supplierReturnId: string; staff: StaffRef },
): Promise<StaffActionResult> {
  return withLockedReturn(deps, input.supplierReturnId, async ({ tx, ret, item, order, at }) => {
    const done = (message: string): StaffActionResult => ({ ok: true, message, orderId: order.id });
    const refuse = (message: string): StaffActionResult => ({
      ok: false,
      message,
      orderId: order.id,
    });
    const title = supplierReturnTitle(item);
    if (ret.status === 'shipped' || ret.status === 'accepted' || ret.status === 'refunded') {
      return done(`Уже отмечено: ${title} сдан водителю${dayText(ret.shippedAt)}`);
    }
    if (ret.status === 'rejected') return refuse(`${title}: уже отмечено «Не берут»`);
    await tx
      .update(supplierReturns)
      .set({ status: 'shipped', shippedAt: at, updatedAt: at })
      .where(and(eq(supplierReturns.id, ret.id), eq(supplierReturns.status, 'requested')));
    await recordJournalEvent(tx, {
      orderId: order.id,
      type: 'supplier_return_shipped',
      actor: staffActorOf(input.staff),
      payload: { supplierReturnId: ret.id, itemId: item.id, via: input.staff.via },
      at,
    });
    return done(`Сдано водителю: ${title}. Ждём деньги от Rossko`);
  });
}

/**
 * «Не берут» (bot, any staff) and «Rossko не принял» (admin): requested | shipped -> rejected and
 * one stock_items row at the cost of the order. `reason` defaults to STOCK_REASON_NOT_ACCEPTED.
 * `strict`: the admin's 1B action refuses a decided return instead of answering «Уже отмечено».
 */
export async function rejectSupplierReturn(
  deps: EngineDeps,
  input: {
    supplierReturnId: string;
    staff: StaffRef;
    reason?: string | null;
    note?: string | null;
    strict?: boolean;
    message?: string;
  },
): Promise<StaffActionResult> {
  return withLockedReturn(deps, input.supplierReturnId, async ({ tx, ret, item, order, at }) => {
    const done = (message: string): StaffActionResult => ({ ok: true, message, orderId: order.id });
    const refuse = (message: string): StaffActionResult => ({
      ok: false,
      message,
      orderId: order.id,
    });
    const title = supplierReturnTitle(item);
    if (ret.status !== 'requested' && ret.status !== 'shipped') {
      if (input.strict) return refuse('Решение по возврату уже записано');
      if (ret.status === 'rejected')
        return done(`Уже отмечено: ${title} не берут, деталь на складе`);
      return refuse(
        ret.status === 'refunded'
          ? `${title}: деньги от Rossko уже вернулись`
          : `${title}: Rossko уже принял возврат`,
      );
    }
    const updated = await tx
      .update(supplierReturns)
      .set({
        status: 'rejected',
        ...(input.note ? { note: input.note.slice(0, 500) } : {}),
        updatedAt: at,
      })
      .where(
        and(
          eq(supplierReturns.id, ret.id),
          inArray(supplierReturns.status, ['requested', 'shipped']),
        ),
      )
      .returning({ id: supplierReturns.id });
    if (updated.length === 0) return refuse('Решение по возврату уже записано');
    const costKop = item.priceSupplierAtOrderKop * item.qty;
    const reason = input.reason?.trim().slice(0, 200) || STOCK_REASON_NOT_ACCEPTED;
    const [stock] = await tx
      .insert(stockItems)
      .values({ orderItemId: item.id, costKop, reason, createdAt: at, updatedAt: at })
      .returning({ id: stockItems.id });
    await recordJournalEvent(tx, {
      orderId: order.id,
      type: 'stock_item_created',
      actor: staffActorOf(input.staff),
      payload: {
        stockItemId: stock?.id,
        itemId: item.id,
        supplierReturnId: ret.id,
        costKop,
        via: input.staff.via,
      },
      at,
    });
    return done(input.message ?? `Не берут: ${title} — деталь на складе (${formatRub(costKop)})`);
  });
}

/**
 * «Деньги вернулись» (admin): requested | shipped | accepted -> refunded with the amount received
 * (positive kopecks) and refunded_at. The money is Rossko's refund for a part, not income: the
 * month's «не доход» list reads these rows.
 */
export async function markSupplierReturnRefunded(
  deps: EngineDeps,
  input: { supplierReturnId: string; amountKop: number; staff: StaffRef },
): Promise<StaffActionResult> {
  const { amountKop } = input;
  if (!Number.isSafeInteger(amountKop) || amountKop <= 0 || amountKop > SUPPLIER_REFUND_MAX_KOP) {
    return {
      ok: false,
      message: 'Сумма — больше нуля, например 1234,50',
      orderId: input.supplierReturnId,
    };
  }
  return withLockedReturn(deps, input.supplierReturnId, async ({ tx, ret, item, order, at }) => {
    const done = (message: string): StaffActionResult => ({ ok: true, message, orderId: order.id });
    const refuse = (message: string): StaffActionResult => ({
      ok: false,
      message,
      orderId: order.id,
    });
    const title = supplierReturnTitle(item);
    if (ret.status === 'refunded') {
      return done(
        `Уже отмечено: за ${title} вернулось ${formatRub(ret.amountReceivedKop ?? 0)}${dayText(ret.refundedAt)}`,
      );
    }
    if (ret.status === 'rejected')
      return refuse(`${title}: отмечено «Не берут» — деталь на складе`);
    await tx
      .update(supplierReturns)
      .set({ status: 'refunded', amountReceivedKop: amountKop, refundedAt: at, updatedAt: at })
      .where(eq(supplierReturns.id, ret.id));
    await recordJournalEvent(tx, {
      orderId: order.id,
      type: 'supplier_return_refunded',
      actor: staffActorOf(input.staff),
      payload: {
        supplierReturnId: ret.id,
        itemId: item.id,
        amountKop,
        ...(ret.amountExpectedKop !== null ? { expectedKop: ret.amountExpectedKop } : {}),
        via: input.staff.via,
      },
      at,
    });
    return done(`Деньги вернулись: ${title}, ${formatRub(amountKop)}`);
  });
}

// ---------------------------------------------------------------------------------------------
// Stock: parts Rossko did not take back
// ---------------------------------------------------------------------------------------------

export interface StockItemView {
  id: string;
  orderId: string;
  orderNumber: string;
  orderItemId: string;
  brand: string;
  article: string;
  name: string;
  qty: number;
  costKop: Kop;
  reason: string;
  createdAt: Date;
  writtenOffAt: Date | null;
}

/** Reasons stored by earlier versions (codes) in the staff's words. */
const STOCK_REASON_LABELS: Readonly<Record<string, string>> = {
  rossko_rejected_return: STOCK_REASON_NOT_ACCEPTED,
  not_returned: 'Не возвращён поставщику',
};

export function stockReasonLabel(reason: string): string {
  return STOCK_REASON_LABELS[reason] ?? reason;
}

/** /admin/stock: parts in stock first (the newest first), then the written off ones. */
export async function listStockItems(
  db: Executor,
  input: { includeWrittenOff: boolean },
): Promise<StockItemView[]> {
  return db
    .select({
      id: stockItems.id,
      orderId: orders.id,
      orderNumber: orders.number,
      orderItemId: orderItems.id,
      brand: orderItems.brand,
      article: orderItems.article,
      name: orderItems.name,
      qty: orderItems.qty,
      costKop: stockItems.costKop,
      reason: stockItems.reason,
      createdAt: stockItems.createdAt,
      writtenOffAt: stockItems.writtenOffAt,
    })
    .from(stockItems)
    .innerJoin(orderItems, eq(orderItems.id, stockItems.orderItemId))
    .innerJoin(orders, eq(orders.id, orderItems.orderId))
    .where(input.includeWrittenOff ? undefined : isNull(stockItems.writtenOffAt))
    .orderBy(asc(stockItems.writtenOffAt), desc(stockItems.createdAt), desc(stockItems.id))
    .limit(500);
}

/** «Списать» (admin): written_off_at once; a second press changes nothing. */
export async function writeOffStockItem(
  deps: EngineDeps,
  input: { stockItemId: string; staff: StaffRef },
): Promise<StaffActionResult> {
  const missing: StaffActionResult = {
    ok: false,
    message: 'Деталь на складе не найдена',
    orderId: input.stockItemId,
  };
  if (!isUuid(input.stockItemId)) return missing;
  const result = await deps.db.transaction(async (tx): Promise<StaffActionResult> => {
    const [head] = await tx
      .select({ orderId: orderItems.orderId })
      .from(stockItems)
      .innerJoin(orderItems, eq(orderItems.id, stockItems.orderItemId))
      .where(eq(stockItems.id, input.stockItemId));
    if (!head) return missing;
    await tx
      .select({ id: orders.id })
      .from(orders)
      .where(eq(orders.id, head.orderId))
      .for('update');
    const [row] = await tx
      .select({ stock: stockItems, item: orderItems })
      .from(stockItems)
      .innerJoin(orderItems, eq(orderItems.id, stockItems.orderItemId))
      .where(eq(stockItems.id, input.stockItemId));
    if (!row) return missing;
    const title = supplierReturnTitle(row.item);
    if (row.stock.writtenOffAt !== null) {
      return {
        ok: true,
        message: `Уже списано: ${title}${dayText(row.stock.writtenOffAt)}`,
        orderId: head.orderId,
      };
    }
    const at = clock(deps);
    await tx
      .update(stockItems)
      .set({ writtenOffAt: at, updatedAt: at })
      .where(and(eq(stockItems.id, row.stock.id), isNull(stockItems.writtenOffAt)));
    await recordJournalEvent(tx, {
      orderId: head.orderId,
      type: 'stock_item_written_off',
      actor: staffActorOf(input.staff),
      payload: { stockItemId: row.stock.id, itemId: row.item.id, costKop: row.stock.costKop },
      at,
    });
    return {
      ok: true,
      message: `Списано: ${title} (${formatRub(row.stock.costKop)})`,
      orderId: head.orderId,
    };
  });
  if (result.ok) nudge(deps);
  return result;
}
