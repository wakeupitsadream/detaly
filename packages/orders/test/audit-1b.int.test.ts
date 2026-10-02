// Fixes of the phase 1B audit on the real database: a failed refund is retried («Повторить
// возврат») and moves the order; a refused POST /payments closes its row; «Повторить чек» of a
// paid QR; two QR on the screen; the refund receipt mirrors the offset receipt and «Вернуть
// платёж» after handover refunds the whole order; the offset receipt binds to the order's own
// prepayment; the refund receipt is polled; money arriving after handover or during a refund
// keeps the 10-day deadline.
import { and, eq, payments, receipts, refunds, type Db } from '@detaly/db';
import { v7 as uuidv7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  applyPaymentObject,
  applyReceiptObject,
  applyRefundObject,
  applyTransition,
  availableStaffActions,
  loadOrderSettings,
  loadOrderSnapshot,
  performStaffAction,
  planRefund,
  preparePayment,
  recordPaymentRejected,
  type EngineDeps,
  type OrderSettings,
  type StaffActionCode,
  type StaffActionInput,
} from '../src';
import {
  assertNoPhone,
  DB_URL,
  eventsOf,
  itemRows,
  makeDeps,
  openDb,
  orderRow,
  outboxOf,
  providerPayment,
  providerReceipt,
  providerRefund,
  seedOrder,
  T0,
  testClock,
  type TestClock,
} from './helpers';

const DAY = 86_400_000;
const owner = { id: null, role: 'owner' as const, via: 'admin' as const };
const seller = { id: null, role: 'seller' as const, via: 'bot' as const };
type StaffRef = typeof owner | typeof seller;

/** One more payment of the order, a copy of `firstPaymentId` with its own receipt row. */
async function addPayment(
  db: Db,
  orderId: string,
  firstPaymentId: string,
  status: 'succeeded' | 'pending',
): Promise<{ id: string; providerPaymentId: string; receiptId: string }> {
  const [first] = await db.select().from(payments).where(eq(payments.id, firstPaymentId));
  const id = uuidv7();
  const providerPaymentId = `pay-more-${id}`;
  const idempotenceKey = uuidv7();
  await db.insert(payments).values({
    id,
    orderId,
    kind: first!.kind,
    status,
    amountKop: first!.amountKop,
    idempotenceKey,
    providerPaymentId,
    confirmationType: first!.confirmationType,
    request: first!.request,
    paidAt: status === 'succeeded' ? T0 : null,
  });
  const [receipt] = await db.select().from(receipts).where(eq(receipts.paymentId, firstPaymentId));
  const receiptId = uuidv7();
  await db.insert(receipts).values({
    id: receiptId,
    orderId,
    paymentId: id,
    kind: first!.kind,
    idempotenceKey: `${idempotenceKey}:receipt`,
    status: status === 'succeeded' ? 'succeeded' : 'pending',
    request: receipt!.request,
  });
  return { id, providerPaymentId, receiptId };
}

describe.skipIf(!DB_URL)('phase 1B audit fixes', () => {
  let db: Db;
  let deps: EngineDeps;
  let clock: TestClock;
  let settings: OrderSettings;

  beforeAll(async () => {
    db = openDb();
    clock = testClock();
    deps = makeDeps(db, { clock });
    settings = await loadOrderSettings(db, deps.env);
  });
  afterAll(async () => {
    await db?.close();
  });

  async function actionsOf(orderId: string, role: 'owner' | 'seller' = 'owner') {
    const snapshot = await loadOrderSnapshot(db, orderId, { lock: false });
    return availableStaffActions(snapshot!, role, settings, clock.now);
  }
  async function codesOf(orderId: string, role: 'owner' | 'seller' = 'owner') {
    return (await actionsOf(orderId, role)).map((a) => a.code);
  }
  async function refundsOf(orderId: string) {
    return db
      .select()
      .from(refunds)
      .where(eq(refunds.orderId, orderId))
      .orderBy(refunds.createdAt, refunds.id);
  }
  async function act(
    orderId: string,
    action: StaffActionCode,
    input: StaffActionInput = {},
    staff: StaffRef = owner,
  ) {
    return performStaffAction(deps, { staff, action, targetId: orderId, input });
  }
  /** The provider rejected POST /refunds (rejectRefund of the worker, here by hand). */
  async function failRefund(
    refundId: string,
    orderId: string,
    event: 'refund_failed' | 'partial_refund_failed',
  ) {
    await db
      .update(refunds)
      .set({ status: 'failed', error: 'invalid_request (HTTP 400)' })
      .where(eq(refunds.id, refundId));
    const out = await applyTransition(deps, {
      orderId,
      event,
      actor: { type: 'system', id: 'yookassa' },
      facts: { refundId, refundConfirmed: false },
    });
    expect(out.ok).toBe(true);
  }

  describe('«Повторить возврат»', () => {
    it('a rejected order refund is retried with its deadline and moves the order to refunded', async () => {
      clock.now = T0;
      const seeded = await seedOrder(db, { status: 'ordered_at_supplier' });
      expect((await act(seeded.orderId, 'refused', {}, seller)).ok).toBe(true);
      const [first] = await refundsOf(seeded.orderId);
      expect(first).toMatchObject({ scope: 'order', reason: 'refusal', status: 'pending' });
      await failRefund(first!.id, seeded.orderId, 'refund_failed');
      expect((await orderRow(db, seeded.orderId)).status).toBe('refund_pending');

      // Only the owner gets the button; the seller's press is refused.
      expect(await codesOf(seeded.orderId)).toContain('retry_refund');
      expect(await codesOf(seeded.orderId, 'seller')).not.toContain('retry_refund');
      expect((await act(seeded.orderId, 'retry_refund', {}, seller)).ok).toBe(false);
      // «Вернуть платёж» would leave the order behind: it points to the retry.
      const orphan = await act(seeded.orderId, 'refund_payment', {
        paymentId: seeded.paymentId!,
        reason: 'клиент ждёт',
      });
      expect(orphan).toMatchObject({ ok: false });
      expect(orphan.message).toContain('Повторить возврат');

      clock.now = new Date(T0.getTime() + 3 * DAY);
      const retried = await act(seeded.orderId, 'retry_refund');
      expect(retried).toMatchObject({ ok: true, message: 'Возврат отправлен повторно' });
      const [, second] = await refundsOf(seeded.orderId);
      expect(second).toMatchObject({
        scope: 'order',
        reason: 'refusal',
        status: 'pending',
        amountKop: first!.amountKop,
        retryOfRefundId: first!.id,
      });
      // Ст. 22: the 10 days run from the first request, not from the retry.
      expect(second!.deadlineAt.getTime()).toBe(first!.deadlineAt.getTime());
      expect(second!.idempotenceKey).not.toBe(first!.idempotenceKey);
      expect((await outboxOf(db, seeded.orderId)).map((r) => r.jobId)).toContain(
        `refund-create:${second!.id}`,
      );
      const journal = (await eventsOf(db, seeded.orderId)).filter(
        (e) => e.type === 'refund_created',
      );
      expect(journal.at(-1)?.payload).toMatchObject({ refundId: second!.id, retryOf: first!.id });
      assertNoPhone(journal, seeded.phone);
      // Retried once: the button is gone, a second press creates nothing.
      expect(await codesOf(seeded.orderId)).not.toContain('retry_refund');
      expect((await act(seeded.orderId, 'retry_refund')).ok).toBe(false);

      // The retry succeeds: the order and the items follow the money, the client is told.
      const out = await applyRefundObject(
        deps,
        providerRefund(`rf-${second!.id}`, {
          paymentId: seeded.providerPaymentId!,
          amountKop: second!.amountKop,
        }),
        { source: 'webhook' },
      );
      expect(out.transition).toMatchObject({ ok: true, from: 'refund_pending', to: 'refunded' });
      expect((await itemRows(db, seeded.orderId)).map((i) => i.state)).toEqual([
        'refunded',
        'refunded',
      ]);
      const templates = (await outboxOf(db, seeded.orderId))
        .filter((r) => r.queue === 'notify')
        .map((r) => (r.data as { template: string }).template);
      expect(templates).toContain('money_sent');
    });

    it('a canceled item refund is retried in the order status it happened in', async () => {
      clock.now = T0;
      const seeded = await seedOrder(db, { status: 'ordered_at_supplier' });
      const [kept, cancelled] = seeded.itemIds as [string, string];
      expect((await act(cancelled, 'icancel', {}, seller)).ok).toBe(true);
      const [first] = await refundsOf(seeded.orderId);
      expect(first).toMatchObject({ scope: 'item', amountKop: 64_000 });
      // canceled by the provider (refund.canceled)
      await applyRefundObject(
        deps,
        providerRefund('rf-item-canceled', {
          status: 'canceled',
          paymentId: seeded.providerPaymentId!,
          amountKop: 64_000,
        }),
        { source: 'webhook' },
      );
      expect((await refundsOf(seeded.orderId))[0]?.status).toBe('failed');
      expect((await itemRows(db, seeded.orderId)).map((i) => i.state)).toEqual([
        'ordered',
        'refund_pending',
      ]);
      const view = (await actionsOf(seeded.orderId)).find((a) => a.code === 'retry_refund');
      expect(view).toMatchObject({ label: 'Повторить возврат', enabled: true });

      expect((await act(seeded.orderId, 'retry_refund', { refundId: first!.id })).ok).toBe(true);
      const [, second] = await refundsOf(seeded.orderId);
      expect(second).toMatchObject({
        scope: 'item',
        amountKop: 64_000,
        retryOfRefundId: first!.id,
      });
      expect(second!.items.map((line) => line.orderItemId)).toEqual([cancelled]);
      const out = await applyRefundObject(
        deps,
        providerRefund(`rf-${second!.id}`, {
          paymentId: seeded.providerPaymentId!,
          amountKop: 64_000,
        }),
        { source: 'webhook' },
      );
      expect(out.transition).toMatchObject({
        ok: true,
        from: 'ordered_at_supplier',
        to: 'ordered_at_supplier',
      });
      const items = await itemRows(db, seeded.orderId);
      expect(items.find((i) => i.id === kept)?.state).toBe('ordered');
      expect(items.find((i) => i.id === cancelled)).toMatchObject({
        state: 'refunded',
        refundedAmountKop: 64_000,
      });
    });
  });

  describe('a refused POST /payments', () => {
    it('closes the row once, alerts the owner once and lets the next click take a new key', async () => {
      clock.now = T0;
      const seeded = await seedOrder(db, { status: 'awaiting_payment', payment: null });
      const input = {
        orderId: seeded.orderId,
        kind: 'prepayment' as const,
        confirmation: 'redirect' as const,
        returnUrl: 'https://detaly.test/o/x?paid=1',
      };
      const first = await preparePayment(deps, input);
      if (first.kind !== 'create') throw new Error(`expected create, got ${first.kind}`);
      expect(
        await recordPaymentRejected(deps, first.paymentRowId, 'invalid_request (HTTP 400)'),
      ).toBe(true);
      // A second report of the same refusal changes nothing.
      expect(
        await recordPaymentRejected(deps, first.paymentRowId, 'invalid_request (HTTP 400)'),
      ).toBe(false);
      const [row] = await db.select().from(payments).where(eq(payments.id, first.paymentRowId));
      expect(row).toMatchObject({
        status: 'canceled',
        cancellationReason: 'rejected:invalid_request (HTTP 400)',
        providerPaymentId: null,
      });
      const [receipt] = await db
        .select()
        .from(receipts)
        .where(eq(receipts.paymentId, first.paymentRowId));
      expect(receipt?.status).toBe('canceled');
      expect((await orderRow(db, seeded.orderId)).status).toBe('awaiting_payment');

      const second = await preparePayment(deps, input);
      if (second.kind !== 'create') throw new Error(`expected create, got ${second.kind}`);
      expect(second.paymentRowId).not.toBe(first.paymentRowId);
      expect(second.request.idempotenceKey).not.toBe(first.request.idempotenceKey);
      expect(await recordPaymentRejected(deps, second.paymentRowId, 'forbidden (HTTP 403)')).toBe(
        true,
      );
      const alerts = (await outboxOf(db, seeded.orderId)).filter(
        (r) =>
          r.queue === 'notify' &&
          (r.data as { template: string }).template === 'staff_payment_rejected',
      );
      expect(alerts).toHaveLength(1);
      expect(alerts[0]?.data).toMatchObject({
        audience: 'owner',
        note: 'Ответ ЮKassa: invalid_request (HTTP 400).',
      });
      const journal = (await eventsOf(db, seeded.orderId)).filter(
        (e) => e.type === 'payment_status',
      );
      expect(journal.map((e) => e.payload)).toEqual([
        expect.objectContaining({ paymentId: first.paymentRowId, note: 'rejected' }),
        expect.objectContaining({ paymentId: second.paymentRowId, note: 'rejected' }),
      ]);
      assertNoPhone(journal, seeded.phone);

      // The TTL now ends the order: its latest payment is canceled.
      const expired = await applyTransition(deps, {
        orderId: seeded.orderId,
        event: 'payment_ttl_expired',
        actor: { type: 'system', id: 'housekeeping' },
      });
      expect(expired).toMatchObject({ ok: true, to: 'cancelled' });
    });

    it('never closes a row the provider answered', async () => {
      const seeded = await seedOrder(db, {
        status: 'awaiting_payment',
        payment: { status: 'pending' },
      });
      expect(
        await recordPaymentRejected(deps, seeded.paymentId!, 'invalid_request (HTTP 400)'),
      ).toBe(false);
      const [row] = await db.select().from(payments).where(eq(payments.id, seeded.paymentId!));
      expect(row?.status).toBe('pending');
    });
  });

  describe('two QR on the screen', () => {
    it('an old QR paid after a new one was shown: the new one is superseded, «Выдал» works', async () => {
      clock.now = T0;
      const seeded = await seedOrder(db, {
        scheme: 'pay_on_handover',
        status: 'awaiting_handover_payment',
        clientArrived: true,
        receivedAt: T0,
        expiresAt: new Date(T0.getTime() + 15 * 60_000),
        payment: { kind: 'full', status: 'pending' },
      });
      const qr2 = await addPayment(db, seeded.orderId, seeded.paymentId!, 'pending');

      // The client pays the first QR, still alive at the provider.
      const paid = await applyPaymentObject(
        deps,
        providerPayment(seeded.providerPaymentId!, { amountKop: seeded.totalKop }),
        { source: 'webhook' },
      );
      expect(paid.result).toBe('processed');
      expect((await orderRow(db, seeded.orderId)).status).toBe('awaiting_handover_payment');
      const [second] = await db.select().from(payments).where(eq(payments.id, qr2.id));
      expect(second).toMatchObject({ status: 'canceled', cancellationReason: 'superseded' });

      // Waiting for the receipt of the paid QR; «Повторить чек» opens a new polling window.
      let handed = (await actionsOf(seeded.orderId, 'seller')).find((a) => a.code === 'handed');
      expect(handed).toMatchObject({ enabled: false, disabledReason: 'Ждём чек' });
      expect(await codesOf(seeded.orderId, 'seller')).toContain('rcpt');
      const retry = await act(seeded.orderId, 'rcpt', {}, seller);
      expect(retry).toMatchObject({ ok: true });
      const [qr1Receipt] = await db
        .select()
        .from(receipts)
        .where(and(eq(receipts.paymentId, seeded.paymentId!), eq(receipts.kind, 'full')));
      const retryJob = (await outboxOf(db, seeded.orderId)).find((r) =>
        r.jobId.startsWith(`payment-receipt:${qr1Receipt!.id}:retry:`),
      );
      expect(retryJob).toMatchObject({
        queue: 'receipts',
        name: 'payment-receipt',
        data: { receiptId: qr1Receipt!.id, restart: true },
      });
      expect(
        (await eventsOf(db, seeded.orderId)).filter((e) => e.type === 'receipt_retry_requested'),
      ).toHaveLength(1);

      // The receipt of the paid QR is registered: «Выдал» although the latest QR is not paid.
      await applyReceiptObject(deps, qr1Receipt!.id, providerReceipt('rc-qr1'));
      handed = (await actionsOf(seeded.orderId, 'seller')).find((a) => a.code === 'handed');
      expect(handed).toMatchObject({ enabled: true });
      expect(await codesOf(seeded.orderId, 'seller')).not.toContain('rcpt');
      expect((await act(seeded.orderId, 'handed', {}, seller)).ok).toBe(true);
      expect((await orderRow(db, seeded.orderId)).status).toBe('handed');

      // The superseded QR is paid after all: money to return, with the 10-day task.
      const late = await applyPaymentObject(
        deps,
        providerPayment(qr2.providerPaymentId, { amountKop: seeded.totalKop }),
        { source: 'reconciliation' },
      );
      expect(late.result).toBe('processed');
      expect((await orderRow(db, seeded.orderId)).status).toBe('handed');
      const [task] = await refundsOf(seeded.orderId);
      expect(task).toMatchObject({
        paymentId: qr2.id,
        status: 'failed',
        error: 'needs_owner',
        scope: 'orphan',
        amountKop: seeded.totalKop,
      });
    });

    it('the receipt of a QR that is not the held payment does not unlock «Выдал»', async () => {
      const seeded = await seedOrder(db, {
        scheme: 'pay_on_handover',
        status: 'awaiting_handover_payment',
        clientArrived: true,
        receivedAt: T0,
        payment: { kind: 'full', status: 'pending', receiptStatus: 'succeeded' },
      });
      const handed = (await actionsOf(seeded.orderId, 'seller')).find((a) => a.code === 'handed');
      expect(handed).toMatchObject({ enabled: false, disabledReason: 'Ждём оплату' });
    });
  });

  describe('refund receipts mirror the receipt that took the money', () => {
    it('after the offset the whole payment goes back as refund_full with the offset lines', async () => {
      const seeded = await seedOrder(db, { status: 'ready', clientArrived: true });
      const lines = [
        {
          description: 'MANN W 914/2 Фильтр масляный',
          quantity: 1,
          unitPriceKop: 128_000,
          vatCode: 1,
          paymentSubject: 'commodity',
          paymentMode: 'full_payment',
        },
        {
          description: 'BOSCH F 026 Фильтр масляный',
          quantity: 1,
          unitPriceKop: 64_000,
          vatCode: 1,
          paymentSubject: 'commodity',
          paymentMode: 'full_payment',
        },
      ];
      await db.insert(receipts).values({
        orderId: seeded.orderId,
        paymentId: seeded.paymentId!,
        kind: 'offset',
        idempotenceKey: uuidv7(),
        status: 'succeeded',
        request: { lines, prepaymentKop: seeded.totalKop },
      });
      const snapshot = await loadOrderSnapshot(db, seeded.orderId, { lock: false });
      const plan = planRefund(snapshot!, { scope: 'orphan', paymentId: seeded.paymentId! });
      expect(plan.receiptKind).toBe('refund_full');
      expect(plan.plan.amountKop).toBe(seeded.totalKop);
      expect(plan.plan.lines.map((l) => [l.description, l.amountKop])).toEqual([
        ['MANN W 914/2 Фильтр масляный', 128_000],
        ['BOSCH F 026 Фильтр масляный', 64_000],
      ]);
      // Before the offset the same payment is a prepayment refund.
      const before = await seedOrder(db, { status: 'ready', clientArrived: true });
      const beforeSnapshot = await loadOrderSnapshot(db, before.orderId, { lock: false });
      expect(
        planRefund(beforeSnapshot!, { scope: 'orphan', paymentId: before.paymentId! }).receiptKind,
      ).toBe('refund_prepayment');
    });

    it('«Вернуть платёж» after handover refunds the whole order with refund_full', async () => {
      clock.now = T0;
      const seeded = await seedOrder(db, {
        status: 'handed',
        clientArrived: true,
        offset: 'succeeded',
      });
      const out = await act(seeded.orderId, 'refund_payment', {
        paymentId: seeded.paymentId!,
        reason: 'отказ в течение 7 дней',
      });
      expect(out).toMatchObject({ ok: true, message: 'Возврат всего заказа создан' });
      expect((await orderRow(db, seeded.orderId)).status).toBe('refund_pending');
      const [refund] = await refundsOf(seeded.orderId);
      expect(refund).toMatchObject({ scope: 'order', amountKop: seeded.totalKop });
      const [refundReceipt] = await db
        .select()
        .from(receipts)
        .where(eq(receipts.refundId, refund!.id));
      expect(refundReceipt?.kind).toBe('refund_full');
      const lines = (refundReceipt?.request as { lines: { paymentMode: string }[] }).lines;
      expect(lines.every((l) => l.paymentMode === 'full_payment')).toBe(true);
      expect((await itemRows(db, seeded.orderId)).map((i) => i.state)).toEqual([
        'refund_pending',
        'refund_pending',
      ]);
      const claim = (await eventsOf(db, seeded.orderId)).find(
        (e) => e.type === 'claim_refund_approved',
      );
      expect(claim).toMatchObject({ fromStatus: 'handed', toStatus: 'refund_pending' });
    });

    it('«Вернуть платёж» of a duplicate after handover stays an orphan refund and takes over its task', async () => {
      clock.now = T0;
      const seeded = await seedOrder(db, {
        status: 'handed',
        clientArrived: true,
        offset: 'succeeded',
      });
      const duplicate = await addPayment(db, seeded.orderId, seeded.paymentId!, 'pending');
      const paid = await applyPaymentObject(
        deps,
        providerPayment(duplicate.providerPaymentId, { amountKop: seeded.totalKop }),
        { source: 'webhook' },
      );
      expect(paid.transition).toMatchObject({ ok: true, from: 'handed', to: 'handed' });
      const [task] = await refundsOf(seeded.orderId);
      expect(task).toMatchObject({ paymentId: duplicate.id, error: 'needs_owner' });
      expect(task!.deadlineAt.getTime()).toBe(T0.getTime() + 10 * DAY);

      clock.now = new Date(T0.getTime() + 2 * DAY);
      const out = await act(seeded.orderId, 'refund_payment', {
        paymentId: duplicate.id,
        reason: 'дубль оплаты',
      });
      expect(out).toMatchObject({ ok: true, message: 'Возврат платежа создан' });
      expect((await orderRow(db, seeded.orderId)).status).toBe('handed');
      const [, refund] = await refundsOf(seeded.orderId);
      expect(refund).toMatchObject({
        scope: 'orphan',
        paymentId: duplicate.id,
        status: 'pending',
        retryOfRefundId: task!.id,
      });
      expect(refund!.deadlineAt.getTime()).toBe(task!.deadlineAt.getTime());
      // The duplicate never went through an offset: its own (prepayment) receipt is mirrored.
      const [refundReceipt] = await db
        .select()
        .from(receipts)
        .where(eq(receipts.refundId, refund!.id));
      expect(refundReceipt?.kind).toBe('refund_prepayment');
    });
  });

  describe('the offset receipt', () => {
    it('is registered against the order’s own (oldest) prepayment, not a duplicate', async () => {
      const seeded = await seedOrder(db, { status: 'ready' });
      await addPayment(db, seeded.orderId, seeded.paymentId!, 'succeeded');
      const came = await act(seeded.orderId, 'came', {}, seller);
      expect(came.ok).toBe(true);
      const [offset] = await db
        .select()
        .from(receipts)
        .where(and(eq(receipts.orderId, seeded.orderId), eq(receipts.kind, 'offset')));
      expect(offset?.paymentId).toBe(seeded.paymentId);
      expect(offset?.request).toMatchObject({ paymentId: seeded.providerPaymentId });
    });

    it('never offsets more than the prepayment still holds', async () => {
      const seeded = await seedOrder(db, { status: 'ready' });
      // A refund of 1000 ₽ is pending on the payment while every item is still live.
      await db.insert(refunds).values({
        orderId: seeded.orderId,
        paymentId: seeded.paymentId!,
        amountKop: 100_000,
        reason: 'other',
        status: 'pending',
        scope: 'item',
        idempotenceKey: uuidv7(),
        requestedAt: T0,
        deadlineAt: new Date(T0.getTime() + 10 * DAY),
      });
      const came = await act(seeded.orderId, 'came', {}, seller);
      expect(came).toMatchObject({
        ok: false,
        message: 'Чек зачёта больше остатка предоплаты — проверьте возвраты в админке',
      });
      expect(
        await db
          .select()
          .from(receipts)
          .where(and(eq(receipts.orderId, seeded.orderId), eq(receipts.kind, 'offset'))),
      ).toEqual([]);
    });
  });

  describe('the refund receipt', () => {
    it('is polled when refund.succeeded does not yet say receipt_registration = succeeded', async () => {
      const seeded = await seedOrder(db, { status: 'needs_attention' });
      expect((await act(seeded.orderId, 'cancel', {}, seller)).ok).toBe(true);
      const [refund] = await refundsOf(seeded.orderId);
      await applyRefundObject(
        deps,
        providerRefund(`rf-${refund!.id}`, {
          paymentId: seeded.providerPaymentId!,
          amountKop: refund!.amountKop,
          receiptRegistration: 'pending',
          raw: { id: `rf-${refund!.id}`, status: 'succeeded', receipt_registration: 'pending' },
        }),
        { source: 'webhook' },
      );
      expect((await orderRow(db, seeded.orderId)).status).toBe('refunded');
      const [refundReceipt] = await db
        .select()
        .from(receipts)
        .where(eq(receipts.refundId, refund!.id));
      expect(refundReceipt?.status).toBe('pending');
      const job = (await outboxOf(db, seeded.orderId)).find(
        (r) => r.jobId === `refund-receipt:${refundReceipt!.id}`,
      );
      expect(job).toMatchObject({ queue: 'receipts', name: 'refund-receipt' });
    });
  });

  describe('money that no rule returns keeps the 10-day deadline', () => {
    it('a payment in refund_pending goes back by itself (orphan)', async () => {
      clock.now = T0;
      const seeded = await seedOrder(db, { status: 'ordered_at_supplier' });
      expect((await act(seeded.orderId, 'refused', {}, seller)).ok).toBe(true);
      const late = await addPayment(db, seeded.orderId, seeded.paymentId!, 'pending');
      const out = await applyPaymentObject(
        deps,
        providerPayment(late.providerPaymentId, { amountKop: seeded.totalKop }),
        { source: 'webhook' },
      );
      expect(out.result).toBe('orphan_payment');
      expect((await orderRow(db, seeded.orderId)).status).toBe('refund_pending');
      const rows = await refundsOf(seeded.orderId);
      expect(rows.map((r) => [r.scope, r.paymentId, r.status])).toEqual([
        ['order', seeded.paymentId, 'pending'],
        ['orphan', late.id, 'pending'],
      ]);
      expect(rows[1]!.deadlineAt.getTime()).toBe(T0.getTime() + 10 * DAY);
      const templates = (await outboxOf(db, seeded.orderId))
        .filter((r) => r.queue === 'notify')
        .map((r) => (r.data as { template: string }).template);
      expect(templates).toContain('staff_orphan_payment');
      expect(templates).not.toContain('staff_unexpected_payment');
    });

    it('a payment where no rule expects it leaves a refund task for the owner', async () => {
      clock.now = T0;
      const seeded = await seedOrder(db, {
        scheme: 'pay_on_handover',
        status: 'awaiting_confirmation',
        payment: { kind: 'prepayment', status: 'pending' },
      });
      const out = await applyPaymentObject(
        deps,
        providerPayment(seeded.providerPaymentId!, { amountKop: seeded.totalKop }),
        { source: 'webhook' },
      );
      expect(out.result).toBe('ignored');
      const [task] = await refundsOf(seeded.orderId);
      expect(task).toMatchObject({
        status: 'failed',
        error: 'needs_owner',
        scope: 'orphan',
        paymentId: seeded.paymentId!,
        amountKop: seeded.totalKop,
        request: null,
      });
      expect(task!.deadlineAt.getTime()).toBe(T0.getTime() + 10 * DAY);
      // Nothing is sent to the provider for a task, and it is not a «Повторить возврат».
      expect((await outboxOf(db, seeded.orderId)).map((r) => r.jobId)).not.toContain(
        `refund-create:${task!.id}`,
      );
      expect(await codesOf(seeded.orderId)).not.toContain('retry_refund');
    });
  });
});
