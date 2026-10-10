// Full order cycles on the queues (docs/phase-1b-implementation.md section 16.1 and 16.3;
// Verification «Фаза 1B» steps 1, 6, 8, 9, 10, 18): the real worker (runWorker) on PostgreSQL and
// Redis, the web handlers in-process, YooKassa and SMS Aero on msw, Rossko on fixtures and the
// seller bot with a recording Telegram transport (see harness.ts). Each scenario runs from the
// checkout to «Выдал» with only client clicks, YooKassa answers and seller presses as input.
//
// - prepay: two receipts (prepayment inside the payment, offset at «Клиент пришёл», registered
//   by polling), no refunds, «Выдал» only after the offset receipt;
// - pay on handover: «Подтверждаю» -> «Клиент пришёл» -> «Выставить оплату» -> the QR photo
//   in the sellers chat only -> paid -> one receipt (full) -> «Выдал»;
// - partial: GetCheckout itemErrors -> «Отменить позицию» -> a refund with a receipt of that
//   line only -> the rest arrives -> the offset receipt for what is left;
// - «Оплатить заранее»: a ready pay-on-handover order switches to prepay, is paid online and
//   is then handed as prepay (prepayment + offset receipts).
import { Buffer } from 'node:buffer';
import { CALLBACK_DATA_MAX_BYTES } from '@detaly/notify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hasTestDatabase } from '../fixtures/databases';
import {
  allCallbackData,
  cardActions,
  checkout,
  clientAction,
  clientPays,
  createFlowHarness,
  expectNoSecrets,
  expectNotificationsOnce,
  fastForward,
  ITEM_ERROR_LINES,
  itemsOf,
  journal,
  OK_LINES,
  orderStatus,
  payloadText,
  payOnline,
  paymentsOf,
  press,
  providerPaymentOf,
  receiptsOf,
  refundsOf,
  settled,
  supplierOrdersOf,
  waitFor,
  waitForStatus,
  type FlowHarness,
} from './harness';

let h: FlowHarness;

type Json = Record<string, unknown>;

/** Receipt records of the YooKassa emulation that belong to one payment. */
function mockReceiptsOf(paymentId: string): Json[] {
  return [...h.apis.mock.receipts.values()].filter((r) => r.payment_id === paymentId);
}

function mockPaymentsOf(orderId: string): Json[] {
  return [...h.apis.mock.payments.values()].filter(
    (p) => (p.metadata as Record<string, string> | undefined)?.order_id === orderId,
  );
}

function rub(kop: number): string {
  return `${Math.floor(kop / 100)}.${String(kop % 100).padStart(2, '0')}`;
}

describe.skipIf(!hasTestDatabase)('full order cycle on the queues', () => {
  beforeAll(async () => {
    h = await createFlowHarness('flow');
    await h.start();
  });
  afterAll(async () => {
    await h?.close();
  });

  it('prepay: paid online -> ordered -> arrived -> offset receipt -> handed, two receipts', async () => {
    // A client with two no-shows pays in advance even for Orenburg stock (PLAN round 4).
    const order = await checkout(h, OK_LINES, { noShowCount: 2 });
    expect(await orderStatus(h, order.orderId)).toBe('awaiting_payment');

    // «Оплатить N ₽» on /o/<token>: web creates the payment and redirects to YooKassa.
    const location = await payOnline(h, order);
    expect(location).toContain('yoomoney.ru/checkout');
    const providerPaymentId = await providerPaymentOf(h, order.orderId);
    const created = h.apis.mock.requests.find((r) => r.method === 'POST' && r.path === '/payments');
    const receipt = (created?.body as { receipt: { items: { payment_mode: string }[] } }).receipt;
    expect(receipt.items.every((i) => i.payment_mode === 'full_prepayment')).toBe(true);

    // The client pays; YooKassa notifies web; the worker re-reads the payment.
    await clientPays(h, providerPaymentId);
    await waitForStatus(h, order.orderId, 'confirmed');
    await settled(h);

    // The seller card of the new order: «Проверить и заказать».
    expect(await cardActions(h, order.orderId)).toContain('recheck');
    await press(h, order.orderId, 'recheck');
    await waitForStatus(h, order.orderId, 'ordered_at_supplier');
    await settled(h);
    const [supplierOrder, ...moreSupplierOrders] = await supplierOrdersOf(h, order.orderId);
    expect(moreSupplierOrders).toEqual([]);
    expect(supplierOrder?.status).toBe('created');

    // «Приехало» item by item: ready only when both arrived.
    const [first, second] = order.itemIds as [string, string];
    await press(h, order.orderId, 'iarr', first);
    await settled(h);
    expect(await orderStatus(h, order.orderId)).toBe('ordered_at_supplier');
    await press(h, order.orderId, 'iarr', second);
    await waitForStatus(h, order.orderId, 'ready');
    await settled(h);

    // «Клиент пришёл»: the offset receipt. YooKassa registers it a little later: the first
    // answer is pending and the 2-minute poll (fast-forwarded here) finds it succeeded.
    expect(await cardActions(h, order.orderId)).not.toContain('handed');
    h.apis.mock.configure({ receiptStatus: 'pending' });
    await press(h, order.orderId, 'came');
    const offsetReceipt = await waitFor('the offset receipt at the provider', async () => {
      const found = mockReceiptsOf(providerPaymentId).find((r) =>
        (r.settlements as { type: string }[]).some((s) => s.type === 'prepayment'),
      );
      return found ?? null;
    });
    expect(offsetReceipt.status).toBe('pending');
    await settled(h);
    // «Выдал» stays unavailable while the receipt is pending.
    const pendingCard = await cardActions(h, order.orderId);
    expect(pendingCard).not.toContain('handed');
    h.apis.mock.setReceiptStatus(String(offsetReceipt.id), 'succeeded');
    await fastForward(h, order.orderId, 'offset-poll');
    await waitFor('«Выдал» on the card', async () =>
      (await cardActions(h, order.orderId)).includes('handed'),
    );
    h.apis.mock.configure({ receiptStatus: 'succeeded' });

    await press(h, order.orderId, 'handed');
    await waitForStatus(h, order.orderId, 'handed');
    await settled(h);

    expect(await journal(h, order.orderId)).toEqual([
      'checkout:draft->awaiting_payment',
      'payment_created',
      'payment_succeeded:awaiting_payment->confirmed',
      'receipt_succeeded',
      'recheck_requested',
      'recheck_result',
      'supplier_order_requested:confirmed->ordering',
      // step 8: the shadow auto-order of the press (docs/rossko-automation.md)
      'auto_order_shadow',
      'supplier_checkout_succeeded:ordering->ordered_at_supplier',
      'item_arrived',
      'item_arrived:ordered_at_supplier->ready',
      'client_arrived',
      'receipt_succeeded',
      'handed_over:ready->handed',
    ]);

    // Exactly two receipts (prepayment, offset), both registered; no refunds; one payment.
    const rows = await receiptsOf(h, order.orderId);
    expect(rows.map((r) => [r.kind, r.status])).toEqual([
      ['prepayment', 'succeeded'],
      ['offset', 'succeeded'],
    ]);
    expect(rows[1]?.attempts).toBe(2);
    expect(await refundsOf(h, order.orderId)).toEqual([]);
    expect((await paymentsOf(h, order.orderId)).map((p) => p.status)).toEqual(['succeeded']);
    expect(mockPaymentsOf(order.orderId)).toHaveLength(1);
    const offsetPosts = h.apis.mock.requests.filter(
      (r) =>
        r.method === 'POST' && r.path === '/receipts' && r.body?.payment_id === providerPaymentId,
    );
    expect(offsetPosts).toHaveLength(1);
    expect(offsetPosts[0]?.body?.settlements).toEqual([
      { type: 'prepayment', amount: { value: rub(order.totalKop), currency: 'RUB' } },
    ]);
    expect(mockReceiptsOf(providerPaymentId)).toHaveLength(2);
    expect((await itemsOf(h, order.orderId)).map((i) => i.state)).toEqual(['handed', 'handed']);
    expect(h.rossko.count('GetCheckout')).toBe(1);

    // Notifications: one row per notify job; the client hears by SMS only for the allowlisted
    // templates (no messenger bound in 1B), the sellers got the card.
    const notes = await expectNotificationsOnce(h, order.orderId);
    const templates = notes.map((n) => `${n.dedupeKey.split(':')[1]}:${n.status}`);
    expect(templates).toEqual(
      expect.arrayContaining([
        'payment_link:skipped',
        'paid:skipped',
        'staff_new_order:sent',
        'ordered:skipped',
        // Verification 8: the first «Приехало» tells the client the rest is awaited (on /o/<token>
        // «Жду до» and «Отменить позицию»); not an SMS template, so skipped without a messenger.
        'partial_arrival:skipped',
        'arrived:sent',
      ]),
    );
    expect(h.apis.sms.filter((m) => m.number === order.phone.slice(1))).toHaveLength(1);
  }, 90_000);

  it('pay on handover: confirmed -> «Клиент пришёл» -> QR to the sellers only -> paid -> one receipt -> handed', async () => {
    const order = await checkout(h, OK_LINES);
    expect(await orderStatus(h, order.orderId)).toBe('awaiting_confirmation');
    await settled(h);
    // confirm_request goes by SMS (allowlist) with the order link.
    const confirmSms = h.apis.sms.filter((m) => m.number === order.phone.slice(1));
    expect(confirmSms).toHaveLength(1);
    expect(confirmSms[0]?.text).toContain(`/o/${order.token}`);

    // «Подтверждаю» on /o/<token>.
    expect(await clientAction(h, order, 'confirm')).toBe(200);
    await waitForStatus(h, order.orderId, 'confirmed');
    await settled(h);

    await press(h, order.orderId, 'recheck');
    await waitForStatus(h, order.orderId, 'ordered_at_supplier');
    await settled(h);
    for (const itemId of order.itemIds) await press(h, order.orderId, 'iarr', itemId);
    await waitForStatus(h, order.orderId, 'ready');
    await settled(h);

    // «Выставить оплату» only after «Клиент пришёл»; «Выдал» only after the money.
    let actions = await cardActions(h, order.orderId);
    expect(actions).not.toContain('qr');
    expect(actions).not.toContain('handed');
    await press(h, order.orderId, 'came');
    await settled(h);
    actions = await cardActions(h, order.orderId);
    expect(actions).toContain('qr');
    expect(actions).not.toContain('handed');

    const photosBefore = h.tg.calls.filter((c) => c.method === 'sendPhoto').length;
    await press(h, order.orderId, 'qr');
    await waitForStatus(h, order.orderId, 'awaiting_handover_payment');
    await settled(h);

    // The QR payment: confirmation qr, full_payment receipt; its photo only in the sellers chat.
    const [payment] = await paymentsOf(h, order.orderId);
    expect(payment?.confirmationType).toBe('qr');
    const qrPost = h.apis.mock.requests.find(
      (r) =>
        r.method === 'POST' &&
        r.path === '/payments' &&
        (r.body?.metadata as Record<string, string> | undefined)?.order_id === order.orderId,
    );
    const qrBody = qrPost?.body as {
      confirmation: { type: string };
      receipt: { items: { payment_mode: string }[] };
    };
    expect(qrBody.confirmation.type).toBe('qr');
    expect(qrBody.receipt.items.every((i) => i.payment_mode === 'full_payment')).toBe(true);
    const photos = h.tg.calls.filter((c) => c.method === 'sendPhoto').slice(photosBefore);
    expect(photos).toHaveLength(1);
    expect(photos[0]?.payload.chat_id).toBe(String(h.sellerChatId));
    expect(String(photos[0]?.payload.caption)).toContain(order.number);
    const qrData = payment?.confirmationData ?? '';
    expect(qrData).not.toBe('');
    // Never to the client: no SMS and no other Telegram chat carries the QR payload.
    expect(h.apis.sms.some((m) => m.text.includes(qrData))).toBe(false);
    const elsewhere = h.tg.calls.filter(
      (c) =>
        payloadText(c.payload).includes(qrData) &&
        String(c.payload.chat_id) !== String(h.sellerChatId),
    );
    expect(elsewhere).toEqual([]);

    // The client pays the QR at the counter.
    await clientPays(h, payment?.providerPaymentId ?? '');
    await waitFor('«Выдал» on the card', async () =>
      (await cardActions(h, order.orderId)).includes('handed'),
    );
    await press(h, order.orderId, 'handed');
    await waitForStatus(h, order.orderId, 'handed');
    await settled(h);

    const rows = await receiptsOf(h, order.orderId);
    expect(rows.map((r) => [r.kind, r.status])).toEqual([['full', 'succeeded']]);
    expect(mockReceiptsOf(payment?.providerPaymentId ?? '')).toHaveLength(1);
    expect(
      h.apis.mock.requests.some(
        (r) =>
          r.method === 'POST' &&
          r.path === '/receipts' &&
          r.body?.payment_id === payment?.providerPaymentId,
      ),
    ).toBe(false);
    expect(await refundsOf(h, order.orderId)).toEqual([]);
    expect(await journal(h, order.orderId)).toEqual([
      'checkout:draft->awaiting_confirmation',
      'client_confirmed:awaiting_confirmation->confirmed',
      'recheck_requested',
      'recheck_result',
      'supplier_order_requested:confirmed->ordering',
      // step 8: the shadow auto-order of the press (docs/rossko-automation.md)
      'auto_order_shadow',
      'supplier_checkout_succeeded:ordering->ordered_at_supplier',
      'item_arrived',
      'item_arrived:ordered_at_supplier->ready',
      'client_arrived',
      'handover_payment_requested:ready->awaiting_handover_payment',
      'payment_created',
      'payment_succeeded',
      'receipt_succeeded',
      'handed_over:awaiting_handover_payment->handed',
    ]);
    await expectNotificationsOnce(h, order.orderId);
  }, 90_000);

  it('partial: itemErrors -> «Отменить позицию» -> refund of that line only -> offset on the rest', async () => {
    const order = await checkout(h, ITEM_ERROR_LINES);
    expect(await orderStatus(h, order.orderId)).toBe('awaiting_payment');
    await payOnline(h, order);
    const providerPaymentId = await providerPaymentOf(h, order.orderId);
    await clientPays(h, providerPaymentId);
    await waitForStatus(h, order.orderId, 'confirmed');
    await settled(h);

    // Rossko orders OC 90 and refuses W 914/2.
    await press(h, order.orderId, 'recheck');
    await waitForStatus(h, order.orderId, 'needs_attention');
    await settled(h);
    const [kept, refused] = order.itemIds as [string, string];
    let items = await itemsOf(h, order.orderId);
    expect(items.map((i) => i.state)).toEqual(['ordered', 'pending']);
    expect(items[1]?.supplierItemError).not.toBeNull();

    // «Отменить позицию» on the refused one: a refund of that line, the rest goes on.
    await press(h, order.orderId, 'icancel', refused);
    await waitForStatus(h, order.orderId, 'ordered_at_supplier');
    await waitFor('the refunded line', async () => {
      const [, line] = await itemsOf(h, order.orderId);
      return line?.state === 'refunded';
    });
    await settled(h);
    items = await itemsOf(h, order.orderId);
    const refusedPrice = (items[1]?.priceClientKop ?? 0) * (items[1]?.qty ?? 0);
    const keptPrice = (items[0]?.priceClientKop ?? 0) * (items[0]?.qty ?? 0);
    const [refund, ...moreRefunds] = await refundsOf(h, order.orderId);
    expect(moreRefunds).toEqual([]);
    expect(refund).toMatchObject({ scope: 'item', status: 'succeeded', amountKop: refusedPrice });
    const refundPost = h.apis.mock.requests.find(
      (r) => r.method === 'POST' && r.path === '/refunds',
    );
    const refundBody = refundPost?.body as {
      amount: { value: string };
      receipt: { items: { description: string; payment_mode: string }[] };
    };
    expect(refundBody.amount.value).toBe(rub(refusedPrice));
    expect(refundBody.receipt.items).toHaveLength(1);
    expect(refundBody.receipt.items[0]?.description).toContain('W 914/2');
    expect(refundBody.receipt.items[0]?.payment_mode).toBe('full_prepayment');

    // The rest arrives; «Клиент пришёл» issues the offset receipt for what is left.
    await press(h, order.orderId, 'iarr', kept);
    await waitForStatus(h, order.orderId, 'ready');
    await settled(h);
    await press(h, order.orderId, 'came');
    await waitFor('«Выдал» on the card', async () =>
      (await cardActions(h, order.orderId)).includes('handed'),
    );
    await press(h, order.orderId, 'handed');
    await waitForStatus(h, order.orderId, 'handed');
    await settled(h);

    const rows = await receiptsOf(h, order.orderId);
    expect(rows.map((r) => [r.kind, r.status]).sort()).toEqual(
      [
        ['offset', 'succeeded'],
        ['prepayment', 'succeeded'],
        ['refund_prepayment', 'succeeded'],
      ].sort(),
    );
    const offsetPost = h.apis.mock.requests.find(
      (r) =>
        r.method === 'POST' && r.path === '/receipts' && r.body?.payment_id === providerPaymentId,
    );
    expect(offsetPost?.body?.settlements).toEqual([
      { type: 'prepayment', amount: { value: rub(keptPrice), currency: 'RUB' } },
    ]);
    expect((offsetPost?.body?.items as unknown[]).length).toBe(1);
    expect(keptPrice + refusedPrice).toBe(order.totalKop);
    expect((await itemsOf(h, order.orderId)).map((i) => i.state)).toEqual(['handed', 'refunded']);
    expect(await journal(h, order.orderId)).toEqual([
      'checkout:draft->awaiting_payment',
      'payment_created',
      'payment_succeeded:awaiting_payment->confirmed',
      'receipt_succeeded',
      'recheck_requested',
      'recheck_result',
      'supplier_order_requested:confirmed->ordering',
      // step 8: the shadow auto-order of the press (docs/rossko-automation.md)
      'auto_order_shadow',
      'supplier_checkout_succeeded:ordering->needs_attention',
      'item_cancelled:needs_attention->ordered_at_supplier',
      'refund_created',
      // The refund object already says receipt_registration = succeeded: the refund receipt.
      'receipt_succeeded',
      'partial_refund_succeeded',
      'item_arrived:ordered_at_supplier->ready',
      'client_arrived',
      'receipt_succeeded',
      'handed_over:ready->handed',
    ]);
    await expectNotificationsOnce(h, order.orderId);
  }, 90_000);

  it('«Оплатить заранее» (Verification 18): ready pay on handover -> prepay -> two receipts as prepay', async () => {
    const order = await checkout(h, OK_LINES);
    expect(await orderStatus(h, order.orderId)).toBe('awaiting_confirmation');
    expect(await clientAction(h, order, 'confirm')).toBe(200);
    await waitForStatus(h, order.orderId, 'confirmed');
    await settled(h);
    await press(h, order.orderId, 'recheck');
    await waitForStatus(h, order.orderId, 'ordered_at_supplier');
    await settled(h);
    for (const itemId of order.itemIds) await press(h, order.orderId, 'iarr', itemId);
    await waitForStatus(h, order.orderId, 'ready');
    await settled(h);

    // The client wants to pay remotely: the order switches to prepay and waits for the money.
    expect(await clientAction(h, order, 'prepay_now')).toBe(200);
    await waitForStatus(h, order.orderId, 'awaiting_payment');
    await settled(h);
    await payOnline(h, order);
    const providerPaymentId = await providerPaymentOf(h, order.orderId);
    const created = h.apis.mock.requests.find(
      (r) =>
        r.method === 'POST' &&
        r.path === '/payments' &&
        (r.body?.metadata as Record<string, string> | undefined)?.order_id === order.orderId,
    );
    const body = created?.body as {
      confirmation: { type: string };
      receipt: { items: { payment_mode: string }[] };
    };
    expect(body.confirmation.type).toBe('redirect');
    expect(body.receipt.items.every((i) => i.payment_mode === 'full_prepayment')).toBe(true);
    await clientPays(h, providerPaymentId);
    // The parts are already here: paid -> back to ready, now as a prepaid order.
    await waitForStatus(h, order.orderId, 'ready');
    await settled(h);

    // From here on as prepay: «Клиент пришёл» -> offset receipt -> «Выдал».
    expect(await cardActions(h, order.orderId)).not.toContain('qr');
    await press(h, order.orderId, 'came');
    await waitFor('«Выдал» on the card', async () =>
      (await cardActions(h, order.orderId)).includes('handed'),
    );
    await press(h, order.orderId, 'handed');
    await waitForStatus(h, order.orderId, 'handed');
    await settled(h);

    const rows = await receiptsOf(h, order.orderId);
    expect(rows.map((r) => [r.kind, r.status])).toEqual([
      ['prepayment', 'succeeded'],
      ['offset', 'succeeded'],
    ]);
    expect(await refundsOf(h, order.orderId)).toEqual([]);
    expect((await paymentsOf(h, order.orderId)).map((p) => p.status)).toEqual(['succeeded']);
    expect(mockReceiptsOf(providerPaymentId)).toHaveLength(2);
    const offsetPost = h.apis.mock.requests.find(
      (r) =>
        r.method === 'POST' && r.path === '/receipts' && r.body?.payment_id === providerPaymentId,
    );
    expect(offsetPost?.body?.settlements).toEqual([
      { type: 'prepayment', amount: { value: rub(order.totalKop), currency: 'RUB' } },
    ]);
    const steps = await journal(h, order.orderId);
    expect(steps).toEqual(
      expect.arrayContaining([
        'switch_to_prepay:ready->awaiting_payment',
        'payment_succeeded:awaiting_payment->ready',
        'handed_over:ready->handed',
      ]),
    );
    await expectNotificationsOnce(h, order.orderId);
  }, 90_000);

  it('every button fits callback_data in 64 bytes; no phone or order token in logs or Telegram', () => {
    const data = allCallbackData(h.tg);
    expect(data.length).toBeGreaterThan(10);
    for (const value of data) {
      expect(Buffer.byteLength(value, 'utf8')).toBeLessThanOrEqual(CALLBACK_DATA_MAX_BYTES);
    }
    expectNoSecrets(h);
  });
});
