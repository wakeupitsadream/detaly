// The worker is down while the world goes on (docs/phase-1b-implementation.md section 16.2;
// Verification «Фаза 1B» step 12, PLAN «остановка worker на 10 минут не теряет и не дублирует
// задачи»): while the BullMQ workers are closed an admin presses «Проверить и заказать», YooKassa
// notifies web about a payment (twice) and a QR on the counter expires. Web and the engine only
// write rows (outbox, webhook_events, order_events). After the start every event happens exactly
// once and in order; a second start adds nothing.
//
// Then the "crash right after YooKassa answered, before the row was written" (a hook in the
// test fetch): the payment-create job and the offset receipt are repeated with the same
// Idempotence-Key, so there is still one payment and one offset receipt at YooKassa.
import { createRedis, QUEUE, type Redis } from '@detaly/config';
import { testRedisUrl } from '@detaly/config/testing';
import { eq, orders, outbox, sql, webhookEvents } from '@detaly/db';
import { Queue } from 'bullmq';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hasTestDatabase } from '../fixtures/databases';
import {
  adminAction,
  cardActions,
  checkout,
  clientAction,
  clientPays,
  createFlowHarness,
  deliverWebhook,
  expectNoSecrets,
  expectNotificationsOnce,
  fastForward,
  journal,
  OK_LINES,
  orderStatus,
  payOnline,
  paymentsOf,
  press,
  providerPaymentOf,
  receiptsOf,
  settled,
  supplierOrdersOf,
  waitFor,
  waitForStatus,
  type FlowHarness,
  type FlowOrder,
} from './harness';

let h: FlowHarness;
let queueRedis: Redis;

/** Rows of every table the flow writes (and the calls to the outside world). */
async function footprint() {
  const count = async (table: string, where = 'true') => {
    const [row] = await h.db.$client.unsafe<{ n: number }[]>(
      `select count(*)::int as n from ${table} where ${where}`,
    );
    return row?.n ?? 0;
  };
  return {
    orderEvents: await count('order_events'),
    outbox: await count('outbox'),
    undispatched: await count('outbox', 'dispatched_at is null'),
    notifications: await count('notifications'),
    payments: await count('payments'),
    receipts: await count('receipts'),
    refunds: await count('refunds'),
    supplierOrders: await count('supplier_orders'),
    sellerCards: await count('seller_cards'),
    webhookEvents: await count('webhook_events'),
    smsCalls: await count('api_calls', "source = 'sms'"),
    yookassaPosts: h.apis.mock.requests.filter((r) => r.method === 'POST').length,
    getCheckout: h.rossko.count('GetCheckout'),
    telegramSends: h.tg.calls.filter((c) => c.method === 'sendMessage' || c.method === 'sendPhoto')
      .length,
    sms: h.apis.sms.length,
  };
}

/** A pay-on-handover order at `ready` with «Клиент пришёл» pressed. */
async function readyAndArrived(): Promise<FlowOrder> {
  const order = await checkout(h, OK_LINES);
  expect(await clientAction(h, order, 'confirm')).toBe(200);
  await waitForStatus(h, order.orderId, 'confirmed');
  await press(h, order.orderId, 'recheck');
  await waitForStatus(h, order.orderId, 'ordered_at_supplier');
  await settled(h);
  for (const itemId of order.itemIds) await press(h, order.orderId, 'iarr', itemId);
  await waitForStatus(h, order.orderId, 'ready');
  await settled(h);
  await press(h, order.orderId, 'came');
  await settled(h);
  return order;
}

/** A prepay order, paid online and confirmed. */
async function paidPrepay(): Promise<FlowOrder & { providerPaymentId: string }> {
  const order = await checkout(h, OK_LINES, { noShowCount: 2 });
  await payOnline(h, order);
  const providerPaymentId = await providerPaymentOf(h, order.orderId);
  await clientPays(h, providerPaymentId);
  await waitForStatus(h, order.orderId, 'confirmed');
  await settled(h);
  return { ...order, providerPaymentId };
}

describe.skipIf(!hasTestDatabase)('worker restart: nothing lost, nothing doubled', () => {
  beforeAll(async () => {
    h = await createFlowHarness('flow_restart');
    queueRedis = createRedis(testRedisUrl());
  });
  afterAll(async () => {
    await queueRedis?.quit();
    await h?.close();
  });

  it('events that arrive while the worker is down are applied once, in order, after the start', async () => {
    await h.start();
    // A: waits for its online payment. B: QR shown on the counter. C: paid, waits for the order.
    const a = await checkout(h, OK_LINES, { noShowCount: 2 });
    await payOnline(h, a);
    const aPayment = await providerPaymentOf(h, a.orderId);
    const b = await readyAndArrived();
    await press(h, b.orderId, 'qr');
    await waitForStatus(h, b.orderId, 'awaiting_handover_payment');
    await providerPaymentOf(h, b.orderId);
    await settled(h);
    const c = await paidPrepay();
    const before = { a: await journal(h, a.orderId), b: await journal(h, b.orderId) };
    const checkoutsBefore = h.rossko.count('GetCheckout');

    // --- the worker is down -------------------------------------------------------------
    await h.stop();

    // The owner presses «Проверить и заказать» in the admin: journal + outbox only.
    expect(await adminAction(h, c.orderId, 'recheck')).toBe(303);
    // YooKassa: A is paid; the notification comes twice (a retry after a slow 200).
    h.apis.mock.setPaymentStatus(aPayment, 'succeeded');
    expect(await deliverWebhook(h, 'payment.succeeded', aPayment)).toBe(200);
    expect(await deliverWebhook(h, 'payment.succeeded', aPayment)).toBe(200);
    // The QR of B expires (15 minutes pass) and the timers tick comes due meanwhile.
    await h.db
      .update(orders)
      .set({ expiresAt: sql`now() - interval '1 minute'` })
      .where(eq(orders.id, b.orderId));
    const housekeeping = new Queue(QUEUE.housekeeping, {
      connection: queueRedis,
      prefix: `${h.prefix}bull`,
    });
    await housekeeping.add('timers', {}, { removeOnComplete: true });
    await housekeeping.close();

    // Nothing happened yet: the rows wait in the outbox.
    expect(await orderStatus(h, a.orderId)).toBe('awaiting_payment');
    expect(await orderStatus(h, b.orderId)).toBe('awaiting_handover_payment');
    expect(await orderStatus(h, c.orderId)).toBe('confirmed');
    const waiting = await h.db
      .select({ queue: outbox.queue, name: outbox.name })
      .from(outbox)
      .where(sql`${outbox.dispatchedAt} is null`);
    expect(waiting).toEqual(
      expect.arrayContaining([
        { queue: 'rossko', name: 'recheck' },
        { queue: 'payments', name: 'webhook' },
      ]),
    );
    expect(waiting.filter((r) => r.name === 'webhook')).toHaveLength(1);

    // --- the worker starts again ----------------------------------------------------------
    await h.start();
    await waitForStatus(h, a.orderId, 'confirmed');
    await waitForStatus(h, b.orderId, 'ready');
    await waitForStatus(h, c.orderId, 'ordered_at_supplier');
    await settled(h);

    expect(await journal(h, a.orderId)).toEqual([
      ...before.a,
      'payment_succeeded:awaiting_payment->confirmed',
      'receipt_succeeded',
    ]);
    expect(await journal(h, b.orderId)).toEqual([
      ...before.b,
      'payment_ttl_expired:awaiting_handover_payment->ready',
    ]);
    expect((await journal(h, c.orderId)).slice(-4)).toEqual([
      'recheck_requested',
      'recheck_result',
      'supplier_order_requested:confirmed->ordering',
      'supplier_checkout_succeeded:ordering->ordered_at_supplier',
    ]);
    expect(h.rossko.count('GetCheckout')).toBe(checkoutsBefore + 1);
    expect(await supplierOrdersOf(h, c.orderId)).toHaveLength(1);
    const hooks = await h.db
      .select()
      .from(webhookEvents)
      .where(eq(webhookEvents.externalId, aPayment));
    expect(hooks.map((w) => w.result)).toEqual(['processed']);
    expect((await receiptsOf(h, a.orderId)).map((r) => [r.kind, r.status])).toEqual([
      ['prepayment', 'succeeded'],
    ]);
    for (const order of [a, b, c]) await expectNotificationsOnce(h, order.orderId);

    // --- a second start adds nothing ----------------------------------------------------
    const settledFootprint = await footprint();
    expect(settledFootprint.undispatched).toBe(0);
    await h.stop();
    await h.start();
    // Two dispatcher polls and the processing of whatever they would find.
    await new Promise((resolve) => setTimeout(resolve, 5_000));
    await settled(h);
    expect(await footprint()).toEqual(settledFootprint);
    expect(await orderStatus(h, a.orderId)).toBe('confirmed');
    expect(await orderStatus(h, b.orderId)).toBe('ready');
    expect(await orderStatus(h, c.orderId)).toBe('ordered_at_supplier');
  }, 120_000);

  it('a crash after YooKassa answered: the retry reuses the Idempotence-Key, one QR payment', async () => {
    if (!h.worker) await h.start();
    const order = await readyAndArrived();
    const photosBefore = h.tg.calls.filter((c) => c.method === 'sendPhoto').length;
    h.apis.crashAfterAnswer({
      path: 'POST /payments',
      when: (body) =>
        (body?.metadata as Record<string, string> | undefined)?.order_id === order.orderId,
      times: 1,
    });
    await press(h, order.orderId, 'qr');
    await waitForStatus(h, order.orderId, 'awaiting_handover_payment');
    // The first attempt dies with the payment created at YooKassa; the queue retries (10 s).
    const [row] = await waitFor(
      'the QR payment recorded after the retry',
      async () => {
        const rows = await paymentsOf(h, order.orderId);
        return rows[0]?.providerPaymentId ? rows : null;
      },
      40_000,
    );
    await settled(h, 30_000);
    const posts = h.apis.mock.requests.filter(
      (r) =>
        r.method === 'POST' &&
        r.path === '/payments' &&
        (r.body?.metadata as Record<string, string> | undefined)?.order_id === order.orderId,
    );
    expect(posts).toHaveLength(2);
    expect(new Set(posts.map((p) => p.idempotenceKey)).size).toBe(1);
    const atYooKassa = [...h.apis.mock.payments.values()].filter(
      (p) => (p.metadata as Record<string, string>).order_id === order.orderId,
    );
    expect(atYooKassa.map((p) => p.id)).toEqual([row?.providerPaymentId]);
    expect(await paymentsOf(h, order.orderId)).toHaveLength(1);
    const photos = h.tg.calls.filter((c) => c.method === 'sendPhoto').slice(photosBefore);
    expect(photos).toHaveLength(1);

    // The client pays and gets the goods: still one payment, one receipt.
    await clientPays(h, row?.providerPaymentId ?? '');
    await waitFor('«Выдал» on the card', async () =>
      (await cardActions(h, order.orderId)).includes('handed'),
    );
    await press(h, order.orderId, 'handed');
    await waitForStatus(h, order.orderId, 'handed');
    expect((await receiptsOf(h, order.orderId)).map((r) => r.kind)).toEqual(['full']);
  }, 120_000);

  it('a crash after YooKassa registered the offset receipt: the poll repeats the same POST, one receipt', async () => {
    if (!h.worker) await h.start();
    const order = await paidPrepay();
    await press(h, order.orderId, 'recheck');
    await waitForStatus(h, order.orderId, 'ordered_at_supplier');
    await settled(h);
    for (const itemId of order.itemIds) await press(h, order.orderId, 'iarr', itemId);
    await waitForStatus(h, order.orderId, 'ready');
    await settled(h);

    h.apis.crashAfterAnswer({
      path: 'POST /receipts',
      when: (body) => body?.payment_id === order.providerPaymentId,
      times: 1,
    });
    await press(h, order.orderId, 'came');
    await settled(h);
    const [offset] = (await receiptsOf(h, order.orderId)).filter((r) => r.kind === 'offset');
    expect(offset?.status).toBe('pending');
    expect(offset?.providerReceiptId).toBeNull();
    expect(await cardActions(h, order.orderId)).not.toContain('handed');

    // The 2-minute poll repeats the POST with the same key; YooKassa answers with the receipt
    // it already registered.
    await fastForward(h, order.orderId, 'offset-poll');
    await waitFor('«Выдал» on the card', async () =>
      (await cardActions(h, order.orderId)).includes('handed'),
    );
    const posts = h.apis.mock.requests.filter(
      (r) =>
        r.method === 'POST' &&
        r.path === '/receipts' &&
        r.body?.payment_id === order.providerPaymentId,
    );
    expect(posts).toHaveLength(2);
    expect(new Set(posts.map((p) => p.idempotenceKey)).size).toBe(1);
    const atYooKassa = [...h.apis.mock.receipts.values()].filter(
      (r) => r.payment_id === order.providerPaymentId,
    );
    // The receipt sent with the payment and one offset receipt.
    expect(atYooKassa).toHaveLength(2);
    await press(h, order.orderId, 'handed');
    await waitForStatus(h, order.orderId, 'handed');
    expect((await receiptsOf(h, order.orderId)).map((r) => [r.kind, r.status])).toEqual([
      ['prepayment', 'succeeded'],
      ['offset', 'succeeded'],
    ]);
    expectNoSecrets(h);
  }, 120_000);
});
