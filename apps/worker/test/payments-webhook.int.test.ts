// payments/webhook and receipts/payment-receipt on the msw emulation of YooKassa and the
// `_worker` database: Verification «Фаза 1B» steps 1, 2, 3, 14, 16 and the late payment of a
// refunded order (orphan refund). The webhook body is never trusted: the worker re-reads the
// object, so a notification that disagrees with GET changes nothing.
import { and, eq, payments, receipts, refunds, webhookEvents } from '@detaly/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { processPayments } from '../src/jobs/payments';
import { processReceipts } from '../src/jobs/receipts';
import { runSweep } from '../src/jobs/reconciliation/sweep';
import {
  createOnlinePayment,
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
  storeWebhook,
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

async function receiptsOf(orderId: string) {
  return t.deps.db.select().from(receipts).where(eq(receipts.orderId, orderId));
}

describe('payments/webhook: prepay paid online (Verification 1)', () => {
  it('payment.succeeded → GET → confirmed, the prepayment receipt succeeds via receipt_registration', async () => {
    const seeded = await seedOrder(t.deps.db);
    const { paymentRowId, providerPaymentId } = await createOnlinePayment(t, seeded.orderId);

    // The payment carries the receipt (full_prepayment) and metadata of decision Б7.
    const post = mock.requests.find((r) => r.method === 'POST' && r.path === '/payments');
    const body = post?.body as {
      receipt: { items: { payment_mode: string }[] };
      metadata: Record<string, string>;
    };
    expect(body.receipt.items.every((i) => i.payment_mode === 'full_prepayment')).toBe(true);
    expect(body.metadata.payment_row_id).toBe(paymentRowId);

    mock.setPaymentStatus(providerPaymentId, 'succeeded');
    const { webhookEventId, result } = await deliverWebhook(
      t,
      mock,
      'payment.succeeded',
      providerPaymentId,
    );
    expect(result).toEqual({ result: 'processed', objectType: 'payment' });
    expect((await orderRow(t.deps.db, seeded.orderId)).status).toBe('confirmed');
    const [hook] = await t.deps.db
      .select()
      .from(webhookEvents)
      .where(eq(webhookEvents.id, webhookEventId));
    expect(hook?.processedAt).not.toBeNull();
    expect(hook?.result).toBe('processed');
    // GET /payments/{id} was the source of truth.
    expect(
      mock.requests.some((r) => r.method === 'GET' && r.path === `/payments/${providerPaymentId}`),
    ).toBe(true);

    const [receiptJob] = await runOutbox(t, seeded.orderId, {
      queue: 'receipts',
      name: 'payment-receipt',
    });
    expect(receiptJob).toEqual({ status: 'succeeded' });
    const [prepayment] = await receiptsOf(seeded.orderId);
    expect(prepayment?.kind).toBe('prepayment');
    expect(prepayment?.status).toBe('succeeded');
    expect(prepayment?.providerReceiptId).not.toBeNull();

    const types = (await eventsOf(t.deps.db, seeded.orderId)).map((e) => e.type);
    expect(types).toEqual(['payment_created', 'payment_succeeded', 'receipt_succeeded']);
    // A prepayment receipt does not unlock anything: no card refresh.
    expect(t.fakes.sellerCards.calls).toEqual([]);
    expectNoPhone(await eventsOf(t.deps.db, seeded.orderId), seeded.phone);
    expectNoPhone(await outboxOf(t.deps.db, seeded.orderId), seeded.phone);
  });

  it('receipt still pending → polls every 2 minutes, then succeeds via GET /receipts?payment_id=', async () => {
    mock.configure({ receiptRegistration: 'pending' });
    const paid = await paidPrepayOrder(t, mock);
    const [first] = await runOutbox(t, paid.orderId, {
      queue: 'receipts',
      name: 'payment-receipt',
    });
    expect(first).toMatchObject({ status: 'pending' });
    const poll = (await outboxOf(t.deps.db, paid.orderId)).filter(
      (row) => row.name === 'payment-receipt' && row.dispatchedAt === null,
    );
    expect(poll).toHaveLength(1);
    expect(poll[0]?.availableAt.getTime()).toBe(clock.now.getTime() + 2 * 60_000);

    // Too early: nothing runs.
    expect(await runOutbox(t, paid.orderId, { queue: 'receipts' })).toEqual([]);
    mock.setReceiptRegistration(paid.providerPaymentId, 'succeeded');
    clock.advance(2 * 60_000);
    expect(await runOutbox(t, paid.orderId, { queue: 'receipts' })).toEqual([
      { status: 'succeeded' },
    ]);
    const [row] = await receiptsOf(paid.orderId);
    expect(row?.status).toBe('succeeded');
    expect(row?.attempts).toBe(2);
    expect(mock.requests.some((r) => r.path === '/receipts' && r.method === 'GET')).toBe(true);
  });

  it('receipt_registration canceled → receipt canceled, staff_receipt_failed to sellers and owner', async () => {
    mock.configure({ receiptRegistration: 'canceled' });
    const paid = await paidPrepayOrder(t, mock);
    const [result] = await runOutbox(t, paid.orderId, {
      queue: 'receipts',
      name: 'payment-receipt',
    });
    expect(result).toEqual({ status: 'canceled', alerted: true });
    const [row] = await receiptsOf(paid.orderId);
    expect(row?.status).toBe('canceled');
    expect(row?.alertedAt).not.toBeNull();
    const alerts = (await outboxOf(t.deps.db, paid.orderId)).filter(
      (o) => o.data.template === 'staff_receipt_failed',
    );
    expect(alerts.map((o) => o.data.audience).sort()).toEqual(['owner', 'sellers']);
  });
});

describe('payments/webhook: failure and 3-D Secure (Verification 2)', () => {
  it('payment.canceled → cancelled', async () => {
    const seeded = await seedOrder(t.deps.db);
    const { providerPaymentId } = await createOnlinePayment(t, seeded.orderId);
    mock.setPaymentStatus(providerPaymentId, 'canceled', { reason: 'insufficient_funds' });
    const { result } = await deliverWebhook(t, mock, 'payment.canceled', providerPaymentId);
    expect(result).toEqual({ result: 'processed', objectType: 'payment' });
    expect((await orderRow(t.deps.db, seeded.orderId)).status).toBe('cancelled');
    const [payment] = await t.deps.db
      .select()
      .from(payments)
      .where(eq(payments.orderId, seeded.orderId));
    expect(payment?.status).toBe('canceled');
    expect(payment?.cancellationReason).toBe('insufficient_funds');
  });

  it('a webhook says succeeded while GET answers pending (3-D Secure): no transition, then confirmed', async () => {
    const seeded = await seedOrder(t.deps.db);
    const { providerPaymentId } = await createOnlinePayment(t, seeded.orderId);
    mock.startThreeDSecure(providerPaymentId);
    // An early (or forged) notification: the body says succeeded, the provider says pending.
    const early = await deliverWebhook(t, mock, 'payment.succeeded', providerPaymentId);
    expect(early.result).toEqual({ result: 'pending', objectType: 'payment' });
    expect((await orderRow(t.deps.db, seeded.orderId)).status).toBe('awaiting_payment');
    expect((await eventsOf(t.deps.db, seeded.orderId)).map((e) => e.type)).toEqual([
      'payment_created',
    ]);

    // The genuine payment.succeeded is deduplicated by the web route (same event and object id
    // as the stored early one), so the reconciliation sweep closes it 10 minutes later.
    mock.setPaymentStatus(providerPaymentId, 'succeeded');
    const [stored] = await t.deps.db
      .select()
      .from(webhookEvents)
      .where(eq(webhookEvents.id, early.webhookEventId));
    expect(stored?.result).toBe('pending');
    clock.advance(11 * MINUTE);
    const report = await runSweep(t.deps, { orderIds: [seeded.orderId] });
    expect(report.payments).toEqual({ applied: 1 });
    expect((await orderRow(t.deps.db, seeded.orderId)).status).toBe('confirmed');
  });
});

describe('payments/webhook: the same job twice (Verification 3)', () => {
  it('one transition, one receipt, one notification per template', async () => {
    const seeded = await seedOrder(t.deps.db);
    const { providerPaymentId } = await createOnlinePayment(t, seeded.orderId);
    mock.setPaymentStatus(providerPaymentId, 'succeeded');
    const webhookEventId = await storeWebhook(
      t.deps.db,
      mock.notification('payment.succeeded', providerPaymentId),
    );
    const first = await processPayments(job('webhook', { webhookEventId }), t.deps);
    const second = await processPayments(job('webhook', { webhookEventId }), t.deps);
    expect(first).toEqual({ result: 'processed', objectType: 'payment' });
    expect(second).toEqual({ skipped: 'already_processed' });

    // Even a re-delivery stored under a fresh row (another event type of the same payment)
    // is applied as a duplicate: the payment row is already settled.
    const again = await deliverWebhook(t, mock, 'payment.waiting_for_capture', providerPaymentId);
    expect(again.result).toEqual({ result: 'duplicate', objectType: 'payment' });

    const events = await eventsOf(t.deps.db, seeded.orderId);
    expect(events.filter((e) => e.type === 'payment_succeeded')).toHaveLength(1);
    expect(await receiptsOf(seeded.orderId)).toHaveLength(1);
    const outbox = await outboxOf(t.deps.db, seeded.orderId);
    const notify = outbox.filter((o) => o.queue === 'notify');
    expect(notify.map((o) => o.data.template).sort()).toEqual(['paid', 'staff_new_order']);
    expect(outbox.filter((o) => o.name === 'payment-receipt')).toHaveLength(1);

    // The receipt job twice: one check, the second leaves at once.
    await runOutbox(t, seeded.orderId, { queue: 'receipts', name: 'payment-receipt' });
    const receiptId = (await receiptsOf(seeded.orderId))[0]?.id;
    expect(await processReceipts(job('payment-receipt', { receiptId }), t.deps)).toEqual({
      skipped: 'succeeded',
    });
    expect(
      (await eventsOf(t.deps.db, seeded.orderId)).filter((e) => e.type === 'receipt_succeeded'),
    ).toHaveLength(1);
  });

  it('a notification about an object the provider does not know is ignored, never retried', async () => {
    const webhookEventId = await storeWebhook(t.deps.db, {
      type: 'notification',
      event: 'payment.succeeded',
      object: { id: 'forged-payment-id', status: 'succeeded' },
    });
    const result = await processPayments(job('webhook', { webhookEventId }), t.deps);
    expect(result).toEqual({ result: 'ignored', objectType: 'payment' });
    const [row] = await t.deps.db
      .select()
      .from(webhookEvents)
      .where(eq(webhookEvents.id, webhookEventId));
    expect(row?.result).toBe('ignored');
  });

  it('a provider error that may pass is rethrown for the queue retry; the row stays unprocessed', async () => {
    const seeded = await seedOrder(t.deps.db);
    const { providerPaymentId } = await createOnlinePayment(t, seeded.orderId);
    mock.setPaymentStatus(providerPaymentId, 'succeeded');
    const webhookEventId = await storeWebhook(
      t.deps.db,
      mock.notification('payment.succeeded', providerPaymentId),
    );
    mock.failNext(`GET /payments/${providerPaymentId}`, 503);
    await expect(processPayments(job('webhook', { webhookEventId }), t.deps)).rejects.toMatchObject(
      { name: 'PaymentProviderError' },
    );
    expect((await orderRow(t.deps.db, seeded.orderId)).status).toBe('awaiting_payment');
    expect(await processPayments(job('webhook', { webhookEventId }), t.deps)).toEqual({
      result: 'processed',
      objectType: 'payment',
    });
    expect((await orderRow(t.deps.db, seeded.orderId)).status).toBe('confirmed');
  });

  it('bad job data fails without retries', async () => {
    await expect(
      processPayments(job('webhook', { webhookEventId: 'nope' }), t.deps),
    ).rejects.toMatchObject({ name: 'UnrecoverableError' });
  });
});

describe('payments/webhook: amount and late payments', () => {
  it('paid amount ≠ total → needs_attention (amount_mismatch) and the owner is alerted (Verification 16)', async () => {
    const seeded = await seedOrder(t.deps.db);
    const { providerPaymentId } = await createOnlinePayment(t, seeded.orderId);
    mock.setPaymentStatus(providerPaymentId, 'succeeded', { amountKop: seeded.totalKop - 100 });
    const { result } = await deliverWebhook(t, mock, 'payment.succeeded', providerPaymentId);
    expect(result).toEqual({ result: 'amount_mismatch', objectType: 'payment' });
    const order = await orderRow(t.deps.db, seeded.orderId);
    expect(order.status).toBe('needs_attention');
    expect(order.attentionReason).toBe('amount_mismatch');
    const owner = (await outboxOf(t.deps.db, seeded.orderId)).filter(
      (o) => o.queue === 'notify' && o.data.audience === 'owner',
    );
    expect(owner.map((o) => o.data.template)).toEqual(['staff_amount_mismatch']);
  });

  it('payment of an order cancelled by TTL → refund_pending, refund job → refunded (Verification 14)', async () => {
    const seeded = await seedOrder(t.deps.db);
    const { providerPaymentId } = await createOnlinePayment(t, seeded.orderId);
    // housekeeping cancelled the order while the client was still on the bank page.
    await forceState(t.deps.db, seeded.orderId, { status: 'cancelled' });
    mock.setPaymentStatus(providerPaymentId, 'succeeded');
    await deliverWebhook(t, mock, 'payment.succeeded', providerPaymentId);
    expect((await orderRow(t.deps.db, seeded.orderId)).status).toBe('refund_pending');
    const notify = (await outboxOf(t.deps.db, seeded.orderId)).filter((o) => o.queue === 'notify');
    expect(notify.map((o) => o.data.template)).toContain('late_payment_refund');

    const [refundResult] = await runOutbox(t, seeded.orderId, {
      queue: 'payments',
      name: 'refund-create',
    });
    expect(refundResult).toMatchObject({ outcome: 'applied', providerStatus: 'succeeded' });
    expect((await orderRow(t.deps.db, seeded.orderId)).status).toBe('refunded');
    const [refund] = await t.deps.db
      .select()
      .from(refunds)
      .where(eq(refunds.orderId, seeded.orderId));
    expect(refund?.reason).toBe('late_payment');
    expect(refund?.status).toBe('succeeded');
    expect(refund?.amountKop).toBe(seeded.totalKop);
    const [refundReceipt] = await t.deps.db
      .select()
      .from(receipts)
      .where(and(eq(receipts.orderId, seeded.orderId), eq(receipts.kind, 'refund_prepayment')));
    expect(refundReceipt?.status).toBe('succeeded');
    expect(mock.refunds.size).toBe(1);
  });

  it('late payment of a refunded order → orphan refund, the status stays refunded, owner alerted', async () => {
    const seeded = await seedOrder(t.deps.db);
    const { providerPaymentId } = await createOnlinePayment(t, seeded.orderId);
    await forceState(t.deps.db, seeded.orderId, { status: 'refunded' });
    mock.setPaymentStatus(providerPaymentId, 'succeeded');
    const { result } = await deliverWebhook(t, mock, 'payment.succeeded', providerPaymentId);
    expect(result).toEqual({ result: 'orphan_payment', objectType: 'payment' });
    expect((await orderRow(t.deps.db, seeded.orderId)).status).toBe('refunded');
    const owner = (await outboxOf(t.deps.db, seeded.orderId)).filter(
      (o) => o.queue === 'notify' && o.data.audience === 'owner',
    );
    expect(owner.map((o) => o.data.template)).toEqual(['staff_orphan_payment']);

    await runOutbox(t, seeded.orderId, { queue: 'payments', name: 'refund-create' });
    const [refund] = await t.deps.db
      .select()
      .from(refunds)
      .where(eq(refunds.orderId, seeded.orderId));
    expect(refund?.scope).toBe('orphan');
    expect(refund?.status).toBe('succeeded');
    expect((await orderRow(t.deps.db, seeded.orderId)).status).toBe('refunded');
    const types = (await eventsOf(t.deps.db, seeded.orderId)).map((e) => e.type);
    expect(types.filter((type) => type === 'orphan_payment')).toHaveLength(2);
    expect(types).not.toContain('refund_succeeded');
  });
});
