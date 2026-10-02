// Fixes of the phase 1B audit on the msw emulation of YooKassa and the `_worker` database:
// a refund rejected by the provider is sent again by «Повторить возврат» and the order follows
// the money; a POST /payments the provider refuses closes its row (sweep, QR job); the receipt
// of a paid QR is polled after the 15-minute alert and «Повторить чек» opens a new window; a
// superseded QR is re-read until the provider settles it; the refund receipt is polled.
import { and, eq, payments, receipts, refunds } from '@detaly/db';
import { loadStaffActions, performStaffAction, preparePayment } from '@detaly/orders';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { processPayments } from '../src/jobs/payments';
import { runSweep } from '../src/jobs/reconciliation/sweep';
import {
  deliverWebhook,
  eventsOf,
  expectNoPhone,
  forceState,
  job,
  MINUTE,
  orderRow,
  outboxOf,
  paidPrepayOrder,
  paymentTestDeps,
  runOutbox,
  seedOrder,
  testClock,
  yooKassa,
  type PaymentTestDeps,
} from './payments-helpers';

let clock = testClock();
const { mock, fetch } = yooKassa(() => clock);
let t: PaymentTestDeps;

beforeEach(async () => {
  clock = testClock();
  t = await paymentTestDeps({ clock, fetch });
});
afterEach(async () => {
  await t.close();
  mock.reset();
});

const SELLER = { id: null, role: 'seller', via: 'admin' } as const;
const OWNER = { id: null, role: 'owner', via: 'admin' } as const;

async function notifyTemplates(orderId: string) {
  return (await outboxOf(t.deps.db, orderId))
    .filter((r) => r.queue === 'notify')
    .map(
      (r) =>
        `${(r.data as { audience: string }).audience}:${(r.data as { template: string }).template}`,
    );
}

/** A pay_on_handover order at the point with «Выставить оплату» pressed (QR row written). */
async function handoverRequested() {
  const seeded = await seedOrder(t.deps.db, {
    scheme: 'pay_on_handover',
    status: 'ready',
    itemState: 'arrived',
    clientArrived: true,
  });
  const qr = await performStaffAction(t.deps.engine, {
    staff: SELLER,
    action: 'qr',
    targetId: seeded.orderId,
  });
  expect(qr.ok).toBe(true);
  const rows = await t.deps.db
    .select()
    .from(payments)
    .where(eq(payments.orderId, seeded.orderId))
    .orderBy(payments.createdAt, payments.id);
  return { ...seeded, paymentId: rows.at(-1)?.id as string };
}

async function sellerAction(orderId: string, code: string) {
  return (await loadStaffActions(t.deps.engine, orderId, 'seller'))?.find((a) => a.code === code);
}

describe('«Повторить возврат» (refund rejected with 4xx)', () => {
  it('the owner sends the refund again; its success refunds the order and tells the client', async () => {
    const paid = await paidPrepayOrder(t, mock);
    expect(
      (
        await performStaffAction(t.deps.engine, {
          staff: SELLER,
          action: 'refused',
          targetId: paid.orderId,
        })
      ).ok,
    ).toBe(true);
    mock.failNext('POST /refunds', 400);
    const [rejected] = await runOutbox(t, paid.orderId, {
      queue: 'payments',
      name: 'refund-create',
    });
    expect(rejected).toMatchObject({ outcome: 'rejected' });
    expect((await orderRow(t.deps.db, paid.orderId)).status).toBe('refund_pending');
    expect(await notifyTemplates(paid.orderId)).toContain('owner:staff_refund_failed');
    const [failed] = await t.deps.db
      .select()
      .from(refunds)
      .where(eq(refunds.orderId, paid.orderId));
    expect(failed?.status).toBe('failed');

    // The sweep never touches a failed refund: only the button moves it on.
    clock.advance(11 * MINUTE);
    expect((await runSweep(t.deps, { orderIds: [paid.orderId] })).refunds).toEqual({});
    const owner = await loadStaffActions(t.deps.engine, paid.orderId, 'owner');
    expect(owner?.map((a) => a.code)).toContain('retry_refund');

    const retry = await performStaffAction(t.deps.engine, {
      staff: OWNER,
      action: 'retry_refund',
      targetId: paid.orderId,
    });
    expect(retry).toMatchObject({ ok: true });
    const [applied] = await runOutbox(t, paid.orderId, {
      queue: 'payments',
      name: 'refund-create',
    });
    expect(applied).toMatchObject({ outcome: 'applied', providerStatus: 'succeeded' });
    expect((await orderRow(t.deps.db, paid.orderId)).status).toBe('refunded');
    const rows = await t.deps.db
      .select()
      .from(refunds)
      .where(eq(refunds.orderId, paid.orderId))
      .orderBy(refunds.createdAt, refunds.id);
    expect(rows.map((r) => [r.status, r.retryOfRefundId])).toEqual([
      ['failed', null],
      ['succeeded', failed!.id],
    ]);
    expect(rows[1]!.deadlineAt.getTime()).toBe(failed!.deadlineAt.getTime());
    const posts = mock.requests.filter((r) => r.method === 'POST' && r.path === '/refunds');
    expect(posts).toHaveLength(2);
    expect(new Set(posts.map((p) => p.idempotenceKey)).size).toBe(2);
    expect(await notifyTemplates(paid.orderId)).toContain('client:money_sent');
    expectNoPhone(await eventsOf(t.deps.db, paid.orderId), paid.phone);
  });
});

describe('a POST /payments the provider refuses', () => {
  it('the sweep closes the row instead of repeating the refused body for a day', async () => {
    const seeded = await seedOrder(t.deps.db);
    const prepared = await preparePayment(t.deps.engine, {
      orderId: seeded.orderId,
      kind: 'prepayment',
      confirmation: 'redirect',
      returnUrl: 'https://detaly.test/o/token?paid=1',
    });
    if (prepared.kind !== 'create') throw new Error(prepared.kind);
    // The web's POST timed out; the sweep's repeat is answered with 400.
    clock.advance(11 * MINUTE);
    mock.failNext('POST /payments', 400);
    const report = await runSweep(t.deps, { orderIds: [seeded.orderId] });
    expect(report.payments).toEqual({ rejected: 1 });
    const [row] = await t.deps.db
      .select()
      .from(payments)
      .where(eq(payments.orderId, seeded.orderId));
    expect(row?.status).toBe('canceled');
    expect(row?.cancellationReason).toMatch(/^rejected:/u);
    expect(await notifyTemplates(seeded.orderId)).toEqual(['owner:staff_payment_rejected']);
    // Closed: the next pass leaves it alone.
    clock.advance(10 * MINUTE);
    expect(await runSweep(t.deps, { orderIds: [seeded.orderId] })).toEqual({
      payments: {},
      refunds: {},
    });
    expect(mock.requests.filter((r) => r.method === 'POST')).toHaveLength(1);
  });

  it('a refused QR payment closes its row; no QR photo, no dead letter', async () => {
    const order = await handoverRequested();
    mock.failNext('POST /payments', 400);
    expect(
      await processPayments(job('payment-create', { paymentId: order.paymentId }), t.deps),
    ).toEqual({ skipped: 'rejected' });
    const [row] = await t.deps.db.select().from(payments).where(eq(payments.id, order.paymentId));
    expect(row?.status).toBe('canceled');
    expect(t.fakes.sellerCards.calls.filter((c) => c.method === 'sendHandoverQr')).toEqual([]);
    expect(await notifyTemplates(order.orderId)).toEqual(['owner:staff_payment_rejected']);
    // The job again: nothing to create.
    expect(
      await processPayments(job('payment-create', { paymentId: order.paymentId }), t.deps),
    ).toEqual({ skipped: 'settled' });
  });
});

describe('the receipt of a paid QR', () => {
  it('is polled after the 15-minute alert; «Повторить чек» opens a new window; «Выдал» unlocks', async () => {
    const order = await handoverRequested();
    await runOutbox(t, order.orderId, { queue: 'payments', name: 'payment-create' });
    const [row] = await t.deps.db.select().from(payments).where(eq(payments.id, order.paymentId));
    const providerPaymentId = row?.providerPaymentId as string;
    // Paid, but the receipt stays in the provider's queue.
    mock.setPaymentStatus(providerPaymentId, 'succeeded', { receiptRegistration: 'pending' });
    await deliverWebhook(t, mock, 'payment.succeeded', providerPaymentId);
    expect((await orderRow(t.deps.db, order.orderId)).status).toBe('awaiting_handover_payment');

    let alerted = false;
    for (let i = 0; i < 10 && !alerted; i += 1) {
      const results = (await runOutbox(t, order.orderId, {
        queue: 'receipts',
        name: 'payment-receipt',
      })) as { alerted?: boolean }[];
      alerted = results.some((r) => r.alerted === true);
      clock.advance(2 * MINUTE);
    }
    expect(alerted).toBe(true);
    expect(await notifyTemplates(order.orderId)).toEqual(
      expect.arrayContaining(['sellers:staff_receipt_failed', 'owner:staff_receipt_failed']),
    );
    // Polling goes on, rarely: one row 10 minutes ahead.
    const slow = (await outboxOf(t.deps.db, order.orderId)).filter(
      (r) => r.name === 'payment-receipt' && r.dispatchedAt === null,
    );
    expect(slow).toHaveLength(1);
    expect(slow[0]?.jobId).toMatch(/^payment-receipt-poll-slow:/u);
    expect(await sellerAction(order.orderId, 'handed')).toMatchObject({ enabled: false });
    expect(await sellerAction(order.orderId, 'rcpt')).toMatchObject({ enabled: true });

    // «Повторить чек»: a new window (alerted_at cleared), the receipt is still pending.
    const retry = await performStaffAction(t.deps.engine, {
      staff: SELLER,
      action: 'rcpt',
      targetId: order.orderId,
    });
    expect(retry.ok).toBe(true);
    const [restarted] = (await runOutbox(t, order.orderId, {
      queue: 'receipts',
      name: 'payment-receipt',
    })) as { status: string; nextPollAt?: string }[];
    expect(restarted).toMatchObject({ status: 'pending' });
    const [receipt] = await t.deps.db
      .select()
      .from(receipts)
      .where(and(eq(receipts.orderId, order.orderId), eq(receipts.kind, 'full')));
    expect(receipt?.alertedAt).toBeNull();

    // Registered late: the next poll unlocks «Выдал».
    mock.setReceiptRegistration(providerPaymentId, 'succeeded');
    clock.advance(10 * MINUTE);
    const results = (await runOutbox(t, order.orderId, {
      queue: 'receipts',
      name: 'payment-receipt',
    })) as { status: string }[];
    expect(results.map((r) => r.status)).toContain('succeeded');
    expect(await sellerAction(order.orderId, 'handed')).toMatchObject({ enabled: true });
  });
});

describe('two QR on the screen', () => {
  it('the newer QR is superseded and re-read by the sweep until the provider settles it', async () => {
    const order = await handoverRequested();
    await runOutbox(t, order.orderId, { queue: 'payments', name: 'payment-create' });
    // The QR TTL passed; the seller shows a new QR.
    await forceState(t.deps.db, order.orderId, { status: 'ready' });
    const second = await performStaffAction(t.deps.engine, {
      staff: SELLER,
      action: 'qr',
      targetId: order.orderId,
    });
    expect(second.ok).toBe(true);
    await runOutbox(t, order.orderId, { queue: 'payments', name: 'payment-create' });
    const rows = await t.deps.db
      .select()
      .from(payments)
      .where(eq(payments.orderId, order.orderId))
      .orderBy(payments.createdAt, payments.id);
    expect(rows).toHaveLength(2);
    const [qr1, qr2] = rows as [(typeof rows)[number], (typeof rows)[number]];

    // The client pays the first QR.
    mock.setPaymentStatus(qr1.providerPaymentId as string, 'succeeded');
    await deliverWebhook(t, mock, 'payment.succeeded', qr1.providerPaymentId as string);
    expect((await orderRow(t.deps.db, order.orderId)).status).toBe('awaiting_handover_payment');
    await runOutbox(t, order.orderId, { queue: 'receipts', name: 'payment-receipt' });
    expect(await sellerAction(order.orderId, 'handed')).toMatchObject({ enabled: true });
    const [closed] = await t.deps.db.select().from(payments).where(eq(payments.id, qr2.id));
    expect(closed).toMatchObject({ status: 'canceled', cancellationReason: 'superseded' });

    // The sweep keeps asking about the superseded QR until the provider cancels it.
    clock.advance(11 * MINUTE);
    expect((await runSweep(t.deps, { orderIds: [order.orderId] })).payments).toEqual({
      applied: 1,
    });
    mock.setPaymentStatus(qr2.providerPaymentId as string, 'canceled');
    clock.advance(10 * MINUTE);
    expect((await runSweep(t.deps, { orderIds: [order.orderId] })).payments).toEqual({
      applied: 1,
    });
    clock.advance(10 * MINUTE);
    expect(await runSweep(t.deps, { orderIds: [order.orderId] })).toEqual({
      payments: {},
      refunds: {},
    });
    expect((await orderRow(t.deps.db, order.orderId)).status).toBe('awaiting_handover_payment');
  });
});

describe('the refund receipt', () => {
  it('is polled after the refund and alerts the owner when it does not come', async () => {
    const paid = await paidPrepayOrder(t, mock);
    await performStaffAction(t.deps.engine, {
      staff: SELLER,
      action: 'refused',
      targetId: paid.orderId,
    });
    mock.configure({ receiptRegistration: 'pending' });
    await runOutbox(t, paid.orderId, { queue: 'payments', name: 'refund-create' });
    expect((await orderRow(t.deps.db, paid.orderId)).status).toBe('refunded');
    const refundReceipt = async () =>
      (
        await t.deps.db
          .select()
          .from(receipts)
          .where(and(eq(receipts.orderId, paid.orderId), eq(receipts.kind, 'refund_prepayment')))
      )[0];
    expect((await refundReceipt())?.status).toBe('pending');

    let alerted = false;
    for (let i = 0; i < 10 && !alerted; i += 1) {
      const results = (await runOutbox(t, paid.orderId, {
        queue: 'receipts',
        name: 'refund-receipt',
      })) as { alerted?: boolean }[];
      alerted = results.some((r) => r.alerted === true);
      clock.advance(2 * MINUTE);
    }
    expect(alerted).toBe(true);
    expect(await notifyTemplates(paid.orderId)).toContain('owner:staff_refund_receipt_failed');
    expect(await notifyTemplates(paid.orderId)).not.toContain(
      'sellers:staff_refund_receipt_failed',
    );

    // Registered late: a slow poll records it.
    const [providerReceipt] = [...mock.receipts.values()].filter((r) => r.type === 'refund');
    mock.setReceiptStatus(String(providerReceipt?.id), 'succeeded');
    clock.advance(10 * MINUTE);
    const results = (await runOutbox(t, paid.orderId, {
      queue: 'receipts',
      name: 'refund-receipt',
    })) as { status: string }[];
    expect(results.map((r) => r.status)).toContain('succeeded');
    expect((await refundReceipt())?.status).toBe('succeeded');
  });
});
