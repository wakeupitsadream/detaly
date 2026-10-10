// Step 7 (docs/month-close.md): the month report from stored rows and the YooKassa
// reconciliation snapshot. Its own database (`${ordersDatabaseUrl}_month`): the report sums every
// row of a month, so no other test may write into it. September 2026 in Asia/Yekaterinburg is
// [2026-08-31T19:00Z, 2026-09-30T19:00Z).
import { randomBytes } from 'node:crypto';
import {
  claims,
  createDb,
  eq,
  financeReconciliations,
  fitChecks,
  cartItems,
  carts,
  orderEvents,
  orderItems,
  orders,
  payments,
  receipts,
  refunds,
  settings,
  supplierOrderItems,
  supplierOrders,
  supplierReturns,
  users,
  vinRequests,
  type Db,
} from '@detaly/db';
import { prepareTestDb, testEnv } from '@detaly/db/testing';
import {
  actCsv,
  CONTRACT_RATES_KEY,
  type ContractRates,
  type OrderEvent,
  type OrderStatus,
} from '@detaly/domain';
import {
  PaymentProviderError,
  type PaymentProvider,
  type ProviderPayment,
  type ProviderRefund,
} from '@detaly/payments';
import { v7 as uuidv7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  loadLatestReconciliation,
  loadMonthReport,
  reconciliationDifferenceCount,
  runMonthReconciliation,
} from '../src';
import { DB_URL, offer, randomPhone } from './helpers';

const MONTH = '2026-09';
const NOW = new Date('2026-10-01T04:00:00.000Z'); // 1 October 09:00 in Orenburg
const ENV = testEnv({});
const at = (iso: string) => new Date(iso);

interface Line {
  brand: string;
  article: string;
  name: string;
  qty: number;
  clientKop: number;
  supplierKop: number;
  state?: 'handed' | 'arrived' | 'refunded';
}

describe.skipIf(!DB_URL)('the month report and the reconciliation', () => {
  let db: Db;
  const ids: Record<string, { orderId: string; number: string; itemIds: string[] }> = {};

  async function order(
    key: string,
    input: {
      scheme?: 'prepay' | 'pay_on_handover';
      status?: OrderStatus;
      lines: Line[];
      receivedAt?: Date | null;
      handedAt?: Date | null;
    },
  ) {
    const [user] = await db.insert(users).values({ phone: randomPhone() }).returning();
    const total = input.lines.reduce((sum, l) => sum + l.clientKop * l.qty, 0);
    const [row] = await db
      .insert(orders)
      .values({
        userId: user!.id,
        accessToken: randomBytes(24).toString('base64url'),
        status: input.status ?? 'handed',
        paymentScheme: input.scheme ?? 'prepay',
        subtotalKop: total,
        totalKop: total,
        itemsHash: 'test',
        receivedAt: input.receivedAt ?? null,
        handedAt: input.handedAt ?? null,
      })
      .returning();
    const itemIds: string[] = [];
    for (const line of input.lines) {
      const [item] = await db
        .insert(orderItems)
        .values({
          orderId: row!.id,
          offerKey: `${line.article}:${line.brand}:ORB1`,
          searchArticleNorm: line.article.toUpperCase().replace(/[^A-Z0-9]/g, ''),
          brand: line.brand,
          article: line.article,
          name: line.name,
          qty: line.qty,
          stockId: 'ORB1',
          isLocal: true,
          priceSupplierAtOrderKop: line.supplierKop,
          priceClientKop: line.clientKop,
          markupBp: 2800,
          offerSnapshot: offer({ brand: line.brand, article: line.article, name: line.name }),
          state: line.state ?? 'handed',
        })
        .returning();
      itemIds.push(item!.id);
    }
    ids[key] = { orderId: row!.id, number: row!.number, itemIds };
    return ids[key]!;
  }

  async function event(
    orderId: string,
    type: OrderEvent | 'receipt_succeeded',
    when: Date,
    extra: {
      from?: OrderStatus;
      to?: OrderStatus;
      payload?: Record<string, unknown>;
    } = {},
  ) {
    await db.insert(orderEvents).values({
      orderId,
      type,
      fromStatus: extra.from ?? null,
      toStatus: extra.to ?? null,
      actorType: 'staff',
      actorId: 'admin',
      payload: extra.payload ?? {},
      createdAt: when,
    });
  }

  async function payment(
    orderId: string,
    input: {
      kind: 'prepayment' | 'full';
      amountKop: number;
      status?: 'pending' | 'succeeded' | 'canceled';
      providerId: string | null;
      createdAt: Date;
      receipt?: { succeededAt: Date | null; updatedAt?: Date } | null;
    },
  ) {
    const [row] = await db
      .insert(payments)
      .values({
        orderId,
        kind: input.kind,
        status: input.status ?? 'succeeded',
        amountKop: input.amountKop,
        idempotenceKey: uuidv7(),
        providerPaymentId: input.providerId,
        confirmationType: 'redirect',
        createdAt: input.createdAt,
        updatedAt: input.createdAt,
      })
      .returning();
    if (input.receipt) {
      const receiptId = uuidv7();
      const when = input.receipt.updatedAt ?? input.receipt.succeededAt ?? input.createdAt;
      await db.insert(receipts).values({
        id: receiptId,
        orderId,
        paymentId: row!.id,
        kind: input.kind,
        idempotenceKey: uuidv7(),
        status: 'succeeded',
        request: { customer: {}, lines: [{ quantity: 1, unitPriceKop: input.amountKop }] },
        createdAt: input.createdAt,
        updatedAt: when,
      });
      if (input.receipt.succeededAt) {
        await event(orderId, 'receipt_succeeded', input.receipt.succeededAt, {
          payload: { receiptId, kind: input.kind },
        });
      }
    }
    return row!;
  }

  beforeAll(async () => {
    const { url } = await prepareTestDb({ url: `${DB_URL}_month` });
    db = createDb(url, { max: 4 });

    // A: prepay, two lines, handed 10 September; arrived on the 8th (two nights at the point).
    const a = await order('A', {
      lines: [
        {
          brand: 'MANN',
          article: 'W 914/2',
          name: 'Фильтр масляный',
          qty: 2,
          clientKop: 52_800,
          supplierKop: 41_250,
        },
        {
          brand: 'TRW',
          article: 'GDB1330',
          name: 'Колодки тормозные',
          qty: 1,
          clientKop: 234_800,
          supplierKop: 183_400,
        },
      ],
      receivedAt: at('2026-09-08T04:00:00Z'),
      handedAt: at('2026-09-10T09:05:00Z'),
    });
    const payA = await payment(a.orderId, {
      kind: 'prepayment',
      amountKop: 340_400,
      providerId: 'p-A',
      createdAt: at('2026-09-05T05:55:00Z'),
      receipt: { succeededAt: at('2026-09-05T06:00:00Z') },
    });
    const offsetId = uuidv7();
    await db.insert(receipts).values({
      id: offsetId,
      orderId: a.orderId,
      paymentId: payA.id,
      kind: 'offset',
      idempotenceKey: uuidv7(),
      status: 'succeeded',
      request: { prepaymentKop: 340_400, lines: [] },
      updatedAt: at('2026-09-10T09:00:00Z'),
    });
    await event(a.orderId, 'receipt_succeeded', at('2026-09-10T09:00:00Z'), {
      payload: { receiptId: offsetId, kind: 'offset' },
    });
    await event(a.orderId, 'item_arrived', at('2026-09-08T03:00:00Z'), {
      from: 'ordered_at_supplier',
      to: 'ordered_at_supplier',
    });
    await event(a.orderId, 'item_arrived', at('2026-09-08T04:00:00Z'), {
      from: 'ordered_at_supplier',
      to: 'ready',
    });
    await event(a.orderId, 'handed_over', at('2026-09-10T09:05:00Z'), {
      from: 'ready',
      to: 'handed',
    });
    const [so] = await db
      .insert(supplierOrders)
      .values({ orderId: a.orderId, attemptNo: 1, status: 'created', deliveryCostKop: 30_000 })
      .returning();
    await db
      .insert(supplierOrderItems)
      .values(a.itemIds.map((orderItemId) => ({ supplierOrderId: so!.id, orderItemId })));
    // A claim on A: the part accepted back on the 14th, the defect decided on the 16th; and a
    // refusal decided too (no diagnostics for a refusal).
    const opened = at('2026-09-12T06:00:00Z');
    await db.insert(claims).values({
      orderId: a.orderId,
      orderItemId: a.itemIds[1]!,
      kind: 'defect',
      openedAt: opened,
      deadlineAt: new Date(opened.getTime() + 240 * 3_600_000),
      returnAcceptedAt: at('2026-09-14T07:00:00Z'),
      decision: 'reject',
      decisionText: 'Деталь исправна',
      decidedAt: at('2026-09-16T08:00:00Z'),
      decidedVia: 'admin',
      closedAt: at('2026-09-16T08:00:00Z'),
      openedVia: 'web',
    });
    await db.insert(claims).values({
      orderId: a.orderId,
      orderItemId: a.itemIds[0]!,
      kind: 'refusal',
      openedAt: opened,
      deadlineAt: new Date(opened.getTime() + 240 * 3_600_000),
      decision: 'reject',
      decisionText: 'Срок отказа прошёл',
      decidedAt: at('2026-09-16T09:00:00Z'),
      decidedVia: 'admin',
      closedAt: at('2026-09-16T09:00:00Z'),
      openedVia: 'web',
    });

    // B: pay on handover, sold below cost; arrived the 19th, handed the 20th.
    const b = await order('B', {
      scheme: 'pay_on_handover',
      lines: [
        {
          brand: 'Knecht',
          article: 'OC 90',
          name: 'Фильтр масляный',
          qty: 1,
          clientKop: 52_800,
          supplierKop: 60_000,
        },
      ],
      receivedAt: at('2026-09-19T05:00:00Z'),
      handedAt: at('2026-09-20T10:05:00Z'),
    });
    await payment(b.orderId, {
      kind: 'full',
      amountKop: 52_800,
      status: 'pending',
      providerId: 'p-B',
      createdAt: at('2026-09-20T09:58:00Z'),
      receipt: { succeededAt: at('2026-09-20T10:00:00Z') },
    });
    await event(b.orderId, 'item_arrived', at('2026-09-19T05:00:00Z'), {
      from: 'ordered_at_supplier',
      to: 'ready',
    });
    await event(b.orderId, 'handed_over', at('2026-09-20T10:05:00Z'), {
      from: 'awaiting_handover_payment',
      to: 'handed',
    });

    // C: a prepayment receipt of 31 August, 23:30 in Orenburg — August.
    const c = await order('C', {
      status: 'ordered_at_supplier',
      lines: [
        {
          brand: 'NGK',
          article: 'BKR6E',
          name: 'Свеча',
          qty: 1,
          clientKop: 50_000,
          supplierKop: 40_000,
          state: 'arrived',
        },
      ],
    });
    await payment(c.orderId, {
      kind: 'prepayment',
      amountKop: 50_000,
      providerId: 'p-C',
      createdAt: at('2026-08-31T18:29:00Z'),
      receipt: { succeededAt: at('2026-08-31T18:30:00Z') },
    });
    // D: a prepayment receipt of 1 October, 00:30 in Orenburg — October.
    const d = await order('D', {
      status: 'confirmed',
      lines: [
        {
          brand: 'NGK',
          article: 'BKR6E',
          name: 'Свеча',
          qty: 1,
          clientKop: 70_000,
          supplierKop: 50_000,
          state: 'arrived',
        },
      ],
    });
    await payment(d.orderId, {
      kind: 'prepayment',
      amountKop: 70_000,
      providerId: 'p-D',
      createdAt: at('2026-09-30T19:29:00Z'),
      receipt: { succeededAt: at('2026-09-30T19:30:00Z') },
    });
    // E: a full receipt without its journal event (an old row): updated_at counts; the provider
    // will report another amount.
    const e = await order('E', {
      scheme: 'pay_on_handover',
      status: 'awaiting_handover_payment',
      lines: [
        {
          brand: 'MANN',
          article: 'C 26003',
          name: 'Фильтр воздушный',
          qty: 1,
          clientKop: 10_000,
          supplierKop: 7_000,
          state: 'arrived',
        },
      ],
    });
    await payment(e.orderId, {
      kind: 'full',
      amountKop: 10_000,
      providerId: 'p-E',
      createdAt: at('2026-09-15T11:59:00Z'),
      receipt: { succeededAt: null, updatedAt: at('2026-09-15T12:00:00Z') },
    });
    // F: paid in August, refunded in full on 25 September (refund receipt).
    const f = await order('F', {
      status: 'refunded',
      lines: [
        {
          brand: 'MANN',
          article: 'W 712/75',
          name: 'Фильтр',
          qty: 1,
          clientKop: 64_000,
          supplierKop: 50_000,
          state: 'refunded',
        },
      ],
    });
    const payF = await payment(f.orderId, {
      kind: 'prepayment',
      amountKop: 64_000,
      providerId: 'p-F',
      createdAt: at('2026-08-20T10:00:00Z'),
      receipt: { succeededAt: at('2026-08-20T10:01:00Z') },
    });
    const [refundF] = await db
      .insert(refunds)
      .values({
        orderId: f.orderId,
        paymentId: payF.id,
        providerRefundId: 'r-F',
        amountKop: 64_000,
        reason: 'refusal',
        status: 'succeeded',
        idempotenceKey: uuidv7(),
        requestedAt: at('2026-09-25T07:00:00Z'),
        deadlineAt: at('2026-10-05T07:00:00Z'),
        succeededAt: at('2026-09-25T08:00:00Z'),
        createdAt: at('2026-09-25T07:00:00Z'),
      })
      .returning();
    const refundReceipt = uuidv7();
    await db.insert(receipts).values({
      id: refundReceipt,
      orderId: f.orderId,
      paymentId: payF.id,
      refundId: refundF!.id,
      kind: 'refund_prepayment',
      idempotenceKey: uuidv7(),
      status: 'succeeded',
      request: { lines: [{ quantity: 1, unitPriceKop: 64_000 }] },
      updatedAt: at('2026-09-25T08:01:00Z'),
    });
    await event(f.orderId, 'receipt_succeeded', at('2026-09-25T08:01:00Z'), {
      payload: { receiptId: refundReceipt, kind: 'refund_prepayment', refundId: refundF!.id },
    });

    // G: arrivals on both edges of the month.
    const g = await order('G', {
      status: 'ordered_at_supplier',
      lines: [
        {
          brand: 'BOSCH',
          article: 'FR7DCX+',
          name: 'Свеча',
          qty: 1,
          clientKop: 30_000,
          supplierKop: 20_000,
          state: 'arrived',
        },
      ],
    });
    await event(g.orderId, 'item_arrived', at('2026-08-31T19:10:00Z'), {
      from: 'ordered_at_supplier',
      to: 'ordered_at_supplier',
    });
    await event(g.orderId, 'item_arrived', at('2026-09-30T19:05:00Z'), {
      from: 'ordered_at_supplier',
      to: 'ordered_at_supplier',
    });

    // The money of returned parts: B's filter came back from Rossko on the 27th; another one in
    // October (not this month).
    await db.insert(supplierReturns).values([
      {
        orderItemId: b.itemIds[0]!,
        kind: 'return',
        status: 'refunded',
        amountExpectedKop: 60_000,
        amountReceivedKop: 41_000,
        shippedAt: at('2026-09-21T06:00:00Z'),
        refundedAt: at('2026-09-27T09:00:00Z'),
      },
      {
        orderItemId: c.itemIds[0]!,
        kind: 'return',
        status: 'refunded',
        amountExpectedKop: 40_000,
        amountReceivedKop: 40_000,
        shippedAt: at('2026-09-29T06:00:00Z'),
        refundedAt: at('2026-10-02T06:00:00Z'),
      },
    ]);

    // A VIN proposal sent on the 3rd (no order yet) and a fit check answered on the 4th.
    const [vin] = await db
      .insert(vinRequests)
      .values({
        phone: randomPhone(),
        needText: 'Колодки передние',
        status: 'offered',
        answeredAt: at('2026-09-03T06:30:00Z'),
      })
      .returning();
    expect(vin).toBeDefined();
    const [cart] = await db
      .insert(carts)
      .values({ anonToken: randomBytes(16).toString('base64url') })
      .returning();
    const [line] = await db
      .insert(cartItems)
      .values({
        cartId: cart!.id,
        offerKey: 'W9142:MANN:ORB1',
        searchArticleNorm: 'W9142',
        brand: 'MANN',
        article: 'W 914/2',
        name: 'Фильтр масляный',
        qty: 1,
        stockId: 'ORB1',
        isLocal: true,
        priceSupplierKop: 41_250,
        priceClientKop: 52_800,
        markupBp: 2800,
        offerSnapshot: offer(),
        fetchedAt: at('2026-09-04T06:00:00Z'),
      })
      .returning();
    await db.insert(fitChecks).values({
      cartId: cart!.id,
      cartItemId: line!.id,
      requestId: uuidv7(),
      brand: 'MANN',
      article: 'W 914/2',
      name: 'Фильтр масляный',
      status: 'fits',
      answeredAt: at('2026-09-04T07:00:00Z'),
      createdAt: at('2026-09-04T06:30:00Z'),
      expiresAt: at('2026-09-05T06:30:00Z'),
    });
  });

  afterAll(async () => {
    await db?.close();
  });

  it('«Выручка по чекам»: receipts by kind inside the month in Orenburg time, refunds subtract', async () => {
    const report = await loadMonthReport(db, ENV, MONTH, NOW);
    expect(report.bounds.start.toISOString()).toBe('2026-08-31T19:00:00.000Z');
    expect(report.revenue).toEqual({
      prepayment: { count: 1, amountKop: 340_400 },
      full: { count: 2, amountKop: 62_800 },
      offset: { count: 1, amountKop: 340_400 },
      refunds: { count: 1, amountKop: 64_000 },
      corrections: 0,
      totalKop: 340_400 + 62_800 - 64_000,
      refundsSucceeded: { count: 1, amountKop: 64_000 },
      handedOrders: 2,
    });
  });

  it('«Маржа»: order prices, the acquiring estimate, the delivery share; B below zero', async () => {
    const report = await loadMonthReport(db, ENV, MONTH, NOW);
    const { totals } = report.margin;
    // A: 340 400 − 265 900 − (2 957 + 6 574) − 30 000; B: 52 800 − 60 000 − 1 478.
    expect(totals).toMatchObject({
      items: 3,
      revenueKop: 393_200,
      purchaseKop: 325_900,
      acquiringKop: 2_957 + 6_574 + 1_478,
      deliveryKop: 30_000,
      marginKop: 393_200 - 325_900 - 11_009 - 30_000,
    });
    expect(report.margin.acquiringBp).toBe(280);
    expect(report.margin.groups.map((g) => [g.group, g.items, g.revenueKop])).toEqual([
      ['filters', 2, 105_600 + 52_800],
      ['brakes', 1, 234_800],
    ]);
    expect(report.margin.negativeOrders).toEqual([
      expect.objectContaining({ orderNumber: ids.B!.number, marginKop: 52_800 - 60_000 - 1_478 }),
    ]);
  });

  it('the act: operations counted from the journal and the tables, zero rates', async () => {
    const report = await loadMonthReport(db, ENV, MONTH, NOW);
    expect(report.act.counts).toEqual({
      receive: 4, // A × 2, B, G at 00:10 of 1 September (not G of 1 October)
      store_day: 3, // A: 8 and 9 September; B: 19 September
      handover: 2,
      return_accept: 1,
      vin_selection: 1,
      fit_check: 1,
      claim_diagnostics: 1, // the defect, not the refusal
    });
    expect(report.act.summary.ratesSet).toBe(false);
    expect(report.act.summary.totalKop).toBe(0);
    expect(report.act.summary.turnoverBaseKop).toBe(393_200);
    const storage = report.act.facts
      .filter((f) => f.operation === 'store_day')
      .map((f) => [f.orderNumber, f.at.toISOString()]);
    expect(storage).toEqual(
      expect.arrayContaining([
        [ids.A!.number, '2026-09-07T19:00:00.000Z'],
        [ids.A!.number, '2026-09-08T19:00:00.000Z'],
        [ids.B!.number, '2026-09-18T19:00:00.000Z'],
      ]),
    );
    const vin = report.act.facts.find((f) => f.operation === 'vin_selection');
    expect(vin).toMatchObject({
      orderNumber: null,
      ref: expect.stringMatching(/^VIN [0-9a-f]{8}$/),
    });
    const csv = actCsv(report.act.facts, report.settings.rates);
    expect(csv.trim().split('\r\n')).toHaveLength(1 + 13);
  });

  it('the act with the contract rates from settings: count × rate and the turnover fee', async () => {
    const rates: ContractRates = {
      perOperationKop: {
        receive: 5_000,
        store_day: 1_000,
        handover: 10_000,
        return_accept: 15_000,
        vin_selection: 20_000,
        fit_check: 7_500,
        claim_diagnostics: 30_000,
      },
      turnoverBp: 250,
    };
    await db
      .update(settings)
      .set({ value: rates, updatedBy: 'test' })
      .where(eq(settings.key, CONTRACT_RATES_KEY));
    try {
      const report = await loadMonthReport(db, ENV, MONTH, NOW);
      expect(report.settings.rates).toEqual(rates);
      expect(report.act.summary.ratesSet).toBe(true);
      const sums = Object.fromEntries(report.act.summary.lines.map((l) => [l.key, l.sumKop]));
      expect(sums).toEqual({
        receive: 20_000,
        store_day: 3_000,
        handover: 20_000,
        return_accept: 15_000,
        vin_selection: 20_000,
        fit_check: 7_500,
        claim_diagnostics: 30_000,
        turnover: 9_830, // 3 932 ₽ × 2.5 %
      });
      expect(report.act.summary.totalKop).toBe(125_330);
    } finally {
      await db
        .update(settings)
        .set({
          value: {
            perOperationKop: {
              receive: 0,
              store_day: 0,
              handover: 0,
              return_accept: 0,
              vin_selection: 0,
              fit_check: 0,
              claim_diagnostics: 0,
            },
            turnoverBp: 0,
          },
        })
        .where(eq(settings.key, CONTRACT_RATES_KEY));
    }
  });

  it('«Не доход»: Rossko money of the month with the order and the date', async () => {
    const report = await loadMonthReport(db, ENV, MONTH, NOW);
    expect(report.supplierRefunds.totalKop).toBe(41_000);
    expect(report.supplierRefunds.rows).toEqual([
      expect.objectContaining({
        orderNumber: ids.B!.number,
        brand: 'Knecht',
        amountReceivedKop: 41_000,
        refundedAt: at('2026-09-27T09:00:00Z'),
      }),
    ]);
  });

  /** An in-memory provider: lists in pages of 2, objects by id, optional list failures. */
  /** The error class as another bundle's copy of @detaly/payments has it (web's Next build). */
  class ForeignProviderError extends Error {
    constructor(
      message: string,
      readonly details: PaymentProviderError['details'],
    ) {
      super(message);
      this.name = 'PaymentProviderError';
    }
  }

  function fakeProvider(input: {
    payments: ProviderPayment[];
    refunds: ProviderRefund[];
    failPayments?: boolean;
    /** Throw the errors as another bundle's copy of the class. */
    foreign?: boolean;
  }): PaymentProvider {
    const providerError = (message: string, details: PaymentProviderError['details']) =>
      input.foreign
        ? new ForeignProviderError(message, details)
        : new PaymentProviderError(message, details);
    const page = <T extends { createdAt: string }>(
      all: T[],
      request: { createdGte: string; createdLt: string; cursor?: string | null },
    ) => {
      const inWindow = all.filter(
        (item) =>
          Date.parse(item.createdAt) >= Date.parse(request.createdGte) &&
          Date.parse(item.createdAt) < Date.parse(request.createdLt),
      );
      const offset = request.cursor ? Number(request.cursor) : 0;
      const items = inWindow.slice(offset, offset + 2);
      return { items, nextCursor: offset + 2 < inWindow.length ? String(offset + 2) : null };
    };
    const notFound = () =>
      providerError('not found', { status: 404, code: 'not_found', retryable: false });
    const unsupported = () => {
      throw new Error('not used');
    };
    return {
      name: 'yookassa',
      createPayment: unsupported,
      createRefund: unsupported,
      parseWebhook: unsupported,
      async getPayment(id) {
        const found = input.payments.find((p) => p.id === id);
        if (!found) throw notFound();
        return found;
      },
      async getRefund(id) {
        const found = input.refunds.find((r) => r.id === id);
        if (!found) throw notFound();
        return found;
      },
      async listPayments(request) {
        if (input.failPayments) {
          throw providerError('boom', {
            status: 500,
            code: 'internal_server_error',
            retryable: true,
          });
        }
        return page(input.payments, request);
      },
      async listRefunds(request) {
        return page(input.refunds, request);
      },
    };
  }

  const providerPayment = (
    id: string,
    amountKop: number,
    createdAt: string,
    over: Partial<ProviderPayment> = {},
  ): ProviderPayment => ({
    id,
    status: 'succeeded',
    paid: true,
    amountKop,
    confirmationUrl: null,
    confirmationData: null,
    createdAt,
    expiresAt: null,
    method: 'bank_card',
    metadata: {},
    test: true,
    currency: 'RUB',
    receiptRegistration: 'succeeded',
    cancellationReason: null,
    cancellationParty: null,
    paidAt: createdAt,
    refundedAmountKop: 0,
    raw: {},
    ...over,
  });

  const providerRefund = (
    id: string,
    amountKop: number,
    createdAt: string,
    status: ProviderRefund['status'] = 'succeeded',
  ): ProviderRefund => ({
    id,
    paymentId: 'p-F',
    status,
    amountKop,
    createdAt,
    receiptRegistration: 'succeeded',
    cancellationReason: null,
    raw: {},
  });

  it('«Сверить»: differences on both sides, edges looked up, a stored snapshot', async () => {
    // A payment created by us at 23:59 of 30 September, at YooKassa a minute later (October).
    const edge = await order('EDGE', {
      status: 'confirmed',
      lines: [
        {
          brand: 'MANN',
          article: 'W 914/2',
          name: 'Фильтр',
          qty: 1,
          clientKop: 52_800,
          supplierKop: 41_250,
          state: 'arrived',
        },
      ],
    });
    await payment(edge.orderId, {
      kind: 'prepayment',
      amountKop: 52_800,
      providerId: 'p-EDGE',
      createdAt: at('2026-09-30T18:59:30Z'),
    });
    // Ours only (YooKassa does not know it).
    const gone = await order('GONE', {
      status: 'confirmed',
      lines: [
        {
          brand: 'MANN',
          article: 'W 914/2',
          name: 'Фильтр',
          qty: 1,
          clientKop: 52_800,
          supplierKop: 41_250,
          state: 'arrived',
        },
      ],
    });
    await payment(gone.orderId, {
      kind: 'prepayment',
      amountKop: 52_800,
      providerId: 'p-GONE',
      createdAt: at('2026-09-12T10:00:00Z'),
    });

    const provider = fakeProvider({
      payments: [
        providerPayment('p-A', 340_400, '2026-09-05T05:55:01Z'),
        providerPayment('p-B', 52_800, '2026-09-20T09:58:01Z'),
        providerPayment('p-E', 11_000, '2026-09-15T11:59:01Z'),
        providerPayment('p-X', 5_000, '2026-09-18T08:00:00Z', {
          metadata: { order_number: 'DT-999999' },
        }),
        providerPayment('p-EDGE', 52_800, '2026-09-30T19:00:30Z', {
          status: 'pending',
          paid: false,
        }),
        providerPayment('p-C', 50_000, '2026-08-31T18:29:01Z'),
      ],
      refunds: [
        providerRefund('r-F', 64_000, '2026-09-25T07:00:01Z'),
        providerRefund('r-Y', 1_000, '2026-09-26T07:00:00Z', 'canceled'),
      ],
    });
    // the edge payment is pending in our database too
    await db
      .update(payments)
      .set({ status: 'pending' })
      .where(eq(payments.providerPaymentId, 'p-EDGE'));

    const snapshot = await runMonthReconciliation({
      db,
      provider,
      month: MONTH,
      createdBy: 'admin',
    });
    const { result } = snapshot;
    expect(result.errors).toEqual([]);
    expect(result.window).toEqual({
      from: '2026-08-31T19:00:00.000Z',
      to: '2026-09-30T19:00:00.000Z',
    });
    expect(result.payments?.differences.map((d) => [d.kind, d.id, d.label])).toEqual([
      ['missing_in_db', 'p-X', 'DT-999999'],
      ['missing_at_provider', 'p-GONE', ids.GONE!.number],
      ['amount', 'p-E', ids.E!.number],
      ['status', 'p-B', ids.B!.number],
    ]);
    expect(result.payments?.differences[3]).toMatchObject({
      dbStatus: 'pending',
      providerStatus: 'succeeded',
    });
    expect(result.payments?.matched).toBe(2); // A and the edge payment
    expect(result.refunds?.differences.map((d) => [d.kind, d.id, d.providerStatus])).toEqual([
      ['missing_in_db', 'r-Y', 'failed'],
    ]);
    expect(result.refunds?.matched).toBe(1);
    expect(result.lookups).toBe(2); // p-EDGE found, p-GONE 404
    expect(reconciliationDifferenceCount(result)).toBe(5);
    const stored = await loadLatestReconciliation(db, MONTH);
    expect(stored).toMatchObject({ id: snapshot.id, createdBy: 'admin', month: MONTH });
    expect(stored?.result).toEqual(result);
    // No personal data in the snapshot.
    expect(JSON.stringify(stored?.result)).not.toMatch(/\+7\d{10}/);
  });

  it('a provider failure is stored as text, never thrown; the other list still compares', async () => {
    const provider = fakeProvider({
      payments: [],
      refunds: [providerRefund('r-F', 64_000, '2026-09-25T07:00:01Z')],
      failPayments: true,
    });
    const snapshot = await runMonthReconciliation({
      db,
      provider,
      month: MONTH,
      createdBy: 'admin',
    });
    expect(snapshot.result.errors).toEqual([
      'Платежи: ЮKassa ответила ошибкой HTTP 500 (internal_server_error)',
    ]);
    expect(snapshot.result.payments).toBeNull();
    expect(snapshot.result.refunds?.matched).toBe(1);
    const rows = await db.select().from(financeReconciliations);
    expect(rows.length).toBeGreaterThanOrEqual(2);
    expect((await loadLatestReconciliation(db, MONTH))?.id).toBe(snapshot.id);
    expect(await loadLatestReconciliation(db, '2026-08')).toBeNull();
  });

  it('provider errors of another bundle copy of the class are read by name (web build)', async () => {
    const provider = fakeProvider({ payments: [], refunds: [], failPayments: true, foreign: true });
    const snapshot = await runMonthReconciliation({
      db,
      provider,
      month: MONTH,
      createdBy: 'admin',
    });
    // The list failure in the staff's words; the refund the provider does not know is a 404 of
    // its lookup — a difference, not an error.
    expect(snapshot.result.errors).toEqual([
      'Платежи: ЮKassa ответила ошибкой HTTP 500 (internal_server_error)',
    ]);
    expect(snapshot.result.refunds?.differences.map((d) => [d.kind, d.id])).toEqual([
      ['missing_at_provider', 'r-F'],
    ]);
  });
});
