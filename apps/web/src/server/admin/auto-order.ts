/**
 * Read model of /admin/auto-order (step 8, docs/rossko-automation.md): the shadow auto-order of the
 * last 30 and 90 days from the journal `auto_order_shadow` — how many decisions, how often the
 * master did the same as the shadow, why the shadow said «НЕТ», and the plain-language verdict
 * (autoOrderVerdict). «Мастер заказал»: the press sent the order to the supplier, or he pressed
 * «Заказать всё равно» (order_anyway) after it and before the next press (shadowMasterOrdered).
 * Read-only: there is no switch of the real auto-order (PLAN decision 7).
 */
import { and, asc, eq, gte, inArray, orderEvents, orders, type Executor } from '@detaly/db';
import {
  autoOrderStats,
  autoOrderVerdict,
  parseAutoOrderShadow,
  shadowMasterOrdered,
  type AutoOrderReason,
  type AutoOrderStats,
  type AutoOrderVerdictKind,
} from '@detaly/domain';
import { loadRosskoSettings } from '@detaly/orders';

/** Periods of the page, days. */
export const AUTO_ORDER_PERIODS = [30, 90] as const;
/** The latest decisions listed under the statistics. */
export const AUTO_ORDER_RECENT = 30;

const DAY_MS = 86_400_000;

export interface AutoOrderDecisionRow {
  eventId: string;
  orderId: string;
  orderNumber: string;
  at: Date;
  decision: 'yes' | 'no';
  reasons: AutoOrderReason[];
  maxTotalKop: number | null;
  masterOrdered: boolean;
}

export interface AutoOrderPeriod {
  days: number;
  stats: AutoOrderStats;
  verdict: { kind: AutoOrderVerdictKind; text: string };
}

export interface AdminAutoOrderData {
  periods: AutoOrderPeriod[];
  /** The newest first. */
  recent: AutoOrderDecisionRow[];
  /** settings rossko.auto_order_max_total_kop now. */
  maxTotalKop: number;
}

export async function loadAdminAutoOrder(db: Executor, now: Date): Promise<AdminAutoOrderData> {
  const longest = Math.max(...AUTO_ORDER_PERIODS);
  const from = new Date(now.getTime() - longest * DAY_MS);
  const events = await db
    .select({
      id: orderEvents.id,
      orderId: orderEvents.orderId,
      orderNumber: orders.number,
      at: orderEvents.createdAt,
      payload: orderEvents.payload,
    })
    .from(orderEvents)
    .innerJoin(orders, eq(orders.id, orderEvents.orderId))
    .where(and(eq(orderEvents.type, 'auto_order_shadow'), gte(orderEvents.createdAt, from)))
    .orderBy(asc(orderEvents.createdAt), asc(orderEvents.id));
  const orderIds = [...new Set(events.map((event) => event.orderId))];
  const anyway =
    orderIds.length === 0
      ? []
      : await db
          .select({ orderId: orderEvents.orderId, at: orderEvents.createdAt })
          .from(orderEvents)
          .where(
            and(
              eq(orderEvents.type, 'order_anyway'),
              inArray(orderEvents.orderId, orderIds),
              gte(orderEvents.createdAt, from),
            ),
          );

  // The next decision of the same order closes the window of «Заказать всё равно».
  const nextAt = new Map<string, Date | null>();
  const later = new Map<string, Date>();
  for (const event of [...events].reverse()) {
    nextAt.set(event.id, later.get(event.orderId) ?? null);
    later.set(event.orderId, event.at);
  }

  const rows: AutoOrderDecisionRow[] = [];
  for (const event of events) {
    const shadow = parseAutoOrderShadow(event.payload);
    if (shadow === null) continue;
    rows.push({
      eventId: event.id,
      orderId: event.orderId,
      orderNumber: event.orderNumber,
      at: event.at,
      decision: shadow.decision,
      reasons: shadow.reasons,
      maxTotalKop: shadow.maxTotalKop,
      masterOrdered: shadowMasterOrdered(
        {
          orderId: event.orderId,
          at: event.at,
          masterOrdered: shadow.masterOrdered,
          nextAt: nextAt.get(event.id) ?? null,
        },
        anyway,
      ),
    });
  }

  const periods = AUTO_ORDER_PERIODS.map((days): AutoOrderPeriod => {
    const since = now.getTime() - days * DAY_MS;
    const stats = autoOrderStats(rows.filter((row) => row.at.getTime() >= since));
    return { days, stats, verdict: autoOrderVerdict(stats) };
  });
  const { autoOrderMaxTotalKop } = await loadRosskoSettings(db);
  return {
    periods,
    recent: rows.slice(-AUTO_ORDER_RECENT).reverse(),
    maxTotalKop: autoOrderMaxTotalKop,
  };
}
