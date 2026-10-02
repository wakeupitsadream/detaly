// reconciliation/nightly (decision Б29): the shop's payments created during the last day,
// as listed by the provider, against the database. Payments we do not have, a different status
// or amount, and our payments the provider does not know go to the owner in one alert. No
// transitions here: the sweep and the owner act on what the alert shows.
import { and, eq, inArray, isNotNull, isNull, lt, orders, payments, sql } from '@detaly/db';
import { TIMERS } from '@detaly/domain';
import { isUuid } from '@detaly/orders';
import type { PaymentProvider, ProviderPayment } from '@detaly/payments';
import type { WorkerDeps } from '../../deps';
import { classifyProviderError, isNotFound } from '../payments/shared';
import { errorInfo } from './sweep';

const DAY_MS = 24 * 60 * 60 * 1000;
/** Page guard: 50 × 100 payments a night is far beyond the expected volume. */
const MAX_PAGES = 50;
/** Our payments missing from the list are re-read one by one, at most this many. */
const MAX_LOOKUPS = 50;
/** Lines of the alert; the rest is counted. */
const MAX_ALERT_LINES = 20;
const ALERT_TZ = 'Asia/Yekaterinburg';

export type Discrepancy =
  | { kind: 'missing_in_db'; providerPaymentId: string; providerStatus: string; amountKop: number }
  | {
      kind: 'unrecorded';
      orderNumber: string;
      providerPaymentId: string;
      providerStatus: string;
    }
  | {
      kind: 'status';
      orderNumber: string;
      providerPaymentId: string;
      providerStatus: string;
      dbStatus: string;
    }
  | {
      kind: 'amount';
      orderNumber: string;
      providerPaymentId: string;
      providerAmountKop: number;
      dbAmountKop: number;
    }
  | {
      kind: 'missing_at_provider';
      orderNumber: string;
      providerPaymentId: string;
      dbStatus: string;
    };

export interface NightlyReport {
  skipped?: 'payments_disabled';
  window: { createdGte: string; createdLt: string };
  providerPayments: number;
  discrepancies: Discrepancy[];
  /** The listing stopped early (page guard or a provider error): the check is partial. */
  partial: boolean;
  alerted: boolean;
}

interface DbPayment {
  id: string;
  providerPaymentId: string | null;
  status: string;
  amountKop: number;
  orderNumber: string;
}

const selectDbPayment = {
  id: payments.id,
  providerPaymentId: payments.providerPaymentId,
  status: payments.status,
  amountKop: payments.amountKop,
  orderNumber: orders.number,
};

/**
 * Every page of GET /payments for the window. VERIFY: Ю15, Б29 — the list filters
 * (created_at.gte / created_at.lt), cursor paging and that the list holds every payment of the
 * shop, test and live alike (packages/payments/src/yookassa.ts listPayments).
 */
async function listWindow(
  deps: WorkerDeps,
  provider: PaymentProvider,
  window: { createdGte: string; createdLt: string },
): Promise<{ items: ProviderPayment[]; partial: boolean }> {
  const items: ProviderPayment[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    try {
      const result = await provider.listPayments({ ...window, cursor });
      items.push(...result.items);
      if (result.nextCursor === null) return { items, partial: false };
      cursor = result.nextCursor;
    } catch (error) {
      deps.logger.error({ ...errorInfo(error), page }, 'nightly: payment list failed');
      return { items, partial: true };
    }
  }
  return { items, partial: true };
}

function compare(provider: ProviderPayment, row: DbPayment): Discrepancy[] {
  const out: Discrepancy[] = [];
  if (provider.status !== row.status) {
    out.push({
      kind: 'status',
      orderNumber: row.orderNumber,
      providerPaymentId: provider.id,
      providerStatus: provider.status,
      dbStatus: row.status,
    });
  }
  if (provider.amountKop !== row.amountKop) {
    out.push({
      kind: 'amount',
      orderNumber: row.orderNumber,
      providerPaymentId: provider.id,
      providerAmountKop: provider.amountKop,
      dbAmountKop: row.amountKop,
    });
  }
  return out;
}

export interface NightlyOptions {
  /** Only these orders on the database side (tests share one database). */
  orderIds?: readonly string[];
}

export async function runNightly(
  deps: WorkerDeps,
  options: NightlyOptions = {},
): Promise<NightlyReport> {
  // Payments younger than the sweep age are still settling: the sweep looks at them.
  const createdLt = new Date(deps.now().getTime() - TIMERS.reconcilePendingAgeMs);
  const createdGte = new Date(createdLt.getTime() - DAY_MS);
  const window = { createdGte: createdGte.toISOString(), createdLt: createdLt.toISOString() };
  const report: NightlyReport = {
    window,
    providerPayments: 0,
    discrepancies: [],
    partial: false,
    alerted: false,
  };
  const provider = deps.payments;
  if (provider === null) return { ...report, skipped: 'payments_disabled' };

  const listed = await listWindow(deps, provider, window);
  report.providerPayments = listed.items.length;
  report.partial = listed.partial;
  const byId = new Map(listed.items.map((p) => [p.id, p]));

  const known: DbPayment[] =
    byId.size === 0
      ? []
      : await deps.db
          .select(selectDbPayment)
          .from(payments)
          .innerJoin(orders, eq(orders.id, payments.orderId))
          .where(
            and(
              eq(payments.provider, 'yookassa'),
              inArray(payments.providerPaymentId, [...byId.keys()]),
            ),
          );
  const knownByProviderId = new Map(known.map((row) => [row.providerPaymentId, row]));

  // Rows without a provider id that the provider names in metadata (Б7: the POST answer was lost).
  const rowIds = listed.items
    .filter((p) => !knownByProviderId.has(p.id))
    .map((p) => p.metadata.payment_row_id)
    .filter(isUuid);
  const unrecorded: DbPayment[] =
    rowIds.length === 0
      ? []
      : await deps.db
          .select(selectDbPayment)
          .from(payments)
          .innerJoin(orders, eq(orders.id, payments.orderId))
          .where(and(inArray(payments.id, rowIds), isNull(payments.providerPaymentId)));
  const unrecordedById = new Map(unrecorded.map((row) => [row.id, row]));

  for (const p of listed.items) {
    const row = knownByProviderId.get(p.id);
    if (row !== undefined) {
      report.discrepancies.push(...compare(p, row));
      continue;
    }
    const lost = unrecordedById.get(p.metadata.payment_row_id ?? '');
    if (lost !== undefined) {
      report.discrepancies.push({
        kind: 'unrecorded',
        orderNumber: lost.orderNumber,
        providerPaymentId: p.id,
        providerStatus: p.status,
      });
    } else {
      report.discrepancies.push({
        kind: 'missing_in_db',
        providerPaymentId: p.id,
        providerStatus: p.status,
        amountKop: p.amountKop,
      });
    }
  }

  // Our payments of the window the list did not show (only when the list is complete).
  if (!listed.partial) {
    const ours = await deps.db
      .select(selectDbPayment)
      .from(payments)
      .innerJoin(orders, eq(orders.id, payments.orderId))
      .where(
        and(
          eq(payments.provider, 'yookassa'),
          isNotNull(payments.providerPaymentId),
          sql`${payments.createdAt} >= ${createdGte.toISOString()}::timestamptz`,
          lt(payments.createdAt, createdLt),
          options.orderIds ? inArray(payments.orderId, [...options.orderIds]) : undefined,
        ),
      );
    const missing = ours.filter((row) => !byId.has(row.providerPaymentId as string));
    for (const row of missing.slice(0, MAX_LOOKUPS)) {
      // Our row may be a few seconds older than the provider's created_at at the window edge.
      try {
        const p = await provider.getPayment(row.providerPaymentId as string);
        report.discrepancies.push(...compare(p, row));
      } catch (error) {
        if (isNotFound(classifyProviderError(error))) {
          report.discrepancies.push({
            kind: 'missing_at_provider',
            orderNumber: row.orderNumber,
            providerPaymentId: row.providerPaymentId as string,
            dbStatus: row.status,
          });
        } else {
          deps.logger.warn({ paymentId: row.id, ...errorInfo(error) }, 'nightly: lookup failed');
          report.partial = true;
        }
      }
    }
    if (missing.length > MAX_LOOKUPS) report.partial = true;
  }

  if (report.discrepancies.length > 0 || report.partial) {
    await deps.alerts.send({
      audience: 'owner',
      text: alertText(report),
      dedupeKey: `reconciliation:nightly:${localDate(createdLt)}`,
    });
    report.alerted = true;
  }
  deps.logger.info(
    {
      providerPayments: report.providerPayments,
      discrepancies: report.discrepancies.length,
      partial: report.partial,
    },
    'nightly reconciliation done',
  );
  return report;
}

function localDate(at: Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: ALERT_TZ }).format(at);
}

function localTime(iso: string): string {
  return new Intl.DateTimeFormat('ru-RU', {
    timeZone: ALERT_TZ,
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(iso));
}

function rub(kop: number): string {
  const value = new Intl.NumberFormat('ru-RU', { minimumFractionDigits: 2 }).format(kop / 100);
  return `${value} ₽`;
}

function line(d: Discrepancy): string {
  switch (d.kind) {
    case 'missing_in_db':
      return `• Платёж ${d.providerPaymentId} (${rub(d.amountKop)}, ${d.providerStatus}) есть в ЮKassa, но не найден в базе.`;
    case 'unrecorded':
      return `• ${d.orderNumber}: платёж ${d.providerPaymentId} (${d.providerStatus}) не записан в базе: ответ ЮKassa на создание потерян. Сверка запишет его, только пока заказ ждёт эту оплату, иначе проверьте в ЛК.`;
    case 'status':
      return `• ${d.orderNumber}: в ЮKassa статус ${d.providerStatus}, в базе ${d.dbStatus}.`;
    case 'amount':
      return `• ${d.orderNumber}: в ЮKassa ${rub(d.providerAmountKop)}, в базе ${rub(d.dbAmountKop)}.`;
    case 'missing_at_provider':
      return `• ${d.orderNumber}: платёж ${d.providerPaymentId} (${d.dbStatus}) не найден в ЮKassa.`;
  }
}

/** Russian alert without PD: order numbers, provider payment ids, statuses and amounts only. */
export function alertText(report: NightlyReport): string {
  const head = `Ночная сверка ЮKassa за ${localTime(report.window.createdGte)} — ${localTime(report.window.createdLt)} (Екатеринбург)`;
  const count = report.discrepancies.length;
  const lines = [
    head,
    count === 0 ? 'Расхождений не найдено.' : `Расхождений: ${count}.`,
    ...report.discrepancies.slice(0, MAX_ALERT_LINES).map(line),
  ];
  if (count > MAX_ALERT_LINES) lines.push(`…и ещё ${count - MAX_ALERT_LINES}.`);
  if (report.partial)
    lines.push('Сверка неполная: список ЮKassa прочитан не целиком, повторите проверку в ЛК.');
  return lines.join('\n');
}
