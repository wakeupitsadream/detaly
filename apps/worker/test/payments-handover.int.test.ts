// payments/payment-create (QR at the pickup point) and the `full` receipt: the worker half of
// Verification «Фаза 1B» step 10 (pay_on_handover), the job run twice and a crash between the
// provider answer and recordPaymentCreated.
import { eq, payments, receipts } from '@detaly/db';
import { loadStaffActions, performStaffAction } from '@detaly/orders';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { processPayments } from '../src/jobs/payments';
import {
  deliverWebhook,
  eventsOf,
  forceState,
  job,
  orderRow,
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

/** A pay_on_handover order at the point, the client came, «Выставить оплату» pressed. */
async function handoverRequested() {
  const seeded = await seedOrder(t.deps.db, {
    scheme: 'pay_on_handover',
    status: 'ready',
    itemState: 'arrived',
    clientArrived: true,
  });
  const result = await performStaffAction(t.deps.engine, {
    staff: SELLER,
    action: 'qr',
    targetId: seeded.orderId,
  });
  expect(result.ok).toBe(true);
  expect((await orderRow(t.deps.db, seeded.orderId)).status).toBe('awaiting_handover_payment');
  const [payment] = await t.deps.db
    .select()
    .from(payments)
    .where(eq(payments.orderId, seeded.orderId));
  return { ...seeded, paymentId: payment?.id as string };
}

async function handedEnabled(orderId: string): Promise<boolean | undefined> {
  const actions = await loadStaffActions(t.deps.engine, orderId, 'seller');
  return actions?.find((a) => a.code === 'handed')?.enabled;
}

describe('payments/payment-create: QR at the pickup point (Verification 10)', () => {
  it('POST /payments with qr → recorded → QR photo to the sellers; paid → full receipt → «Выдал»', async () => {
    const order = await handoverRequested();
    const [created] = await runOutbox(t, order.orderId, {
      queue: 'payments',
      name: 'payment-create',
    });
    expect(created).toEqual({ providerStatus: 'pending', qr: 'sent' });

    const post = mock.requests.find((r) => r.method === 'POST' && r.path === '/payments');
    expect(post?.body?.confirmation).toEqual({ type: 'qr' });
    const items = (post?.body?.receipt as { items: { payment_mode: string }[] }).items;
    expect(items.every((i) => i.payment_mode === 'full_payment')).toBe(true);

    const [row] = await t.deps.db.select().from(payments).where(eq(payments.id, order.paymentId));
    expect(row?.providerPaymentId).not.toBeNull();
    expect(row?.confirmationData).toMatch(/^https:\/\/qr\.nspk\.ru\/mock\//u);
    const qr = t.fakes.sellerCards.calls.filter((c) => c.method === 'sendHandoverQr');
    expect(qr).toEqual([
      {
        method: 'sendHandoverQr',
        input: {
          orderId: order.orderId,
          paymentId: order.paymentId,
          confirmationData: row?.confirmationData,
          expiresAt: expect.any(Date),
        },
      },
    ]);

    // «Выдал» is not available before the full receipt.
    expect(await handedEnabled(order.orderId)).not.toBe(true);

    mock.setPaymentStatus(row?.providerPaymentId as string, 'succeeded', { method: 'sbp' });
    await deliverWebhook(t, mock, 'payment.succeeded', row?.providerPaymentId as string);
    expect((await orderRow(t.deps.db, order.orderId)).status).toBe('awaiting_handover_payment');
    const [receiptResult] = await runOutbox(t, order.orderId, {
      queue: 'receipts',
      name: 'payment-receipt',
    });
    expect(receiptResult).toEqual({ status: 'succeeded' });
    const [full] = await t.deps.db
      .select()
      .from(receipts)
      .where(eq(receipts.orderId, order.orderId));
    expect(full?.kind).toBe('full');
    expect(full?.status).toBe('succeeded');
    expect(t.fakes.sellerCards.calls.at(-1)).toEqual({
      method: 'refresh',
      orderId: order.orderId,
    });
    expect(await handedEnabled(order.orderId)).toBe(true);
    const handed = await performStaffAction(t.deps.engine, {
      staff: SELLER,
      action: 'handed',
      targetId: order.orderId,
    });
    expect(handed.ok).toBe(true);
    expect((await orderRow(t.deps.db, order.orderId)).status).toBe('handed');
  });

  it('the same job twice: one payment at the provider, one QR photo', async () => {
    const order = await handoverRequested();
    const data = { paymentId: order.paymentId, orderId: order.orderId };
    expect(await processPayments(job('payment-create', data), t.deps)).toEqual({
      providerStatus: 'pending',
      qr: 'sent',
    });
    expect(await processPayments(job('payment-create', data), t.deps)).toEqual({
      providerStatus: 'pending',
      qr: 'already_sent',
    });
    expect(mock.payments.size).toBe(1);
    expect(mock.requests.filter((r) => r.method === 'POST')).toHaveLength(1);
    expect(t.fakes.sellerCards.calls.filter((c) => c.method === 'sendHandoverQr')).toHaveLength(1);
    expect(
      (await eventsOf(t.deps.db, order.orderId)).filter((e) => e.type === 'payment_created'),
    ).toHaveLength(1);
  });

  it('a crash between the provider answer and our write: the retry gets the same payment', async () => {
    const order = await handoverRequested();
    const data = { paymentId: order.paymentId };
    mock.failNext('POST /payments', 'network', { afterProcessing: true });
    await expect(processPayments(job('payment-create', data), t.deps)).rejects.toMatchObject({
      name: 'PaymentProviderError',
    });
    expect(mock.payments.size).toBe(1);
    expect(t.fakes.sellerCards.calls).toEqual([]);

    expect(await processPayments(job('payment-create', data), t.deps)).toEqual({
      providerStatus: 'pending',
      qr: 'sent',
    });
    expect(mock.payments.size).toBe(1);
    const posts = mock.requests.filter((r) => r.method === 'POST' && r.path === '/payments');
    expect(posts).toHaveLength(2);
    expect(new Set(posts.map((p) => p.idempotenceKey)).size).toBe(1);
    const [row] = await t.deps.db.select().from(payments).where(eq(payments.id, order.paymentId));
    expect(row?.providerPaymentId).toBe([...mock.payments.keys()][0]);
  });

  it('the order no longer waits for the payment (QR TTL passed): nothing is created', async () => {
    const order = await handoverRequested();
    await forceState(t.deps.db, order.orderId, { status: 'ready' });
    expect(
      await processPayments(job('payment-create', { paymentId: order.paymentId }), t.deps),
    ).toEqual({ skipped: 'order_status' });
    expect(mock.requests).toEqual([]);
  });

  it('a failed QR photo is sent again on the retry', async () => {
    const order = await handoverRequested();
    let failures = 1;
    t.deps.sellerCards = {
      ...t.fakes.sellerCards,
      async sendHandoverQr(input) {
        if (failures-- > 0) throw new Error('telegram is down');
        await t.fakes.sellerCards.sendHandoverQr(input);
      },
    };
    const data = { paymentId: order.paymentId };
    await expect(processPayments(job('payment-create', data), t.deps)).rejects.toThrow(
      'telegram is down',
    );
    expect(await processPayments(job('payment-create', data), t.deps)).toMatchObject({
      qr: 'sent',
    });
    expect(mock.payments.size).toBe(1);
  });
});
