// Payments, refunds and receipts on the real database (section 5.4): preparing a payment (Б5–Б7),
// applying payment objects (duplicate, amount_mismatch, late payment, orphan, stale cancel),
// refund objects and receipt objects.
import { and, eq, payments, receipts, refunds, webhookEvents, type Db } from '@detaly/db';
import { v7 as uuidv7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  applyPaymentObject,
  applyReceiptObject,
  applyRefundObject,
  loadOrderSnapshot,
  performStaffAction,
  preparePayment,
  recordPaymentCreated,
  type EngineDeps,
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
} from './helpers';

async function webhookRow(db: Db, externalId: string): Promise<string> {
  const id = uuidv7();
  await db.insert(webhookEvents).values({
    id,
    source: 'yookassa',
    externalId,
    eventType: 'payment.succeeded',
    payload: { event: 'payment.succeeded' },
  });
  return id;
}

describe.skipIf(!DB_URL)('payments, refunds, receipts', () => {
  let db: Db;
  let deps: EngineDeps;

  beforeAll(() => {
    db = openDb();
    deps = makeDeps(db);
  });
  afterAll(async () => {
    await db?.close();
  });

  describe('preparePayment / recordPaymentCreated', () => {
    it('creates one payment, repeats it with the same key, then reuses its link', async () => {
      const seeded = await seedOrder(db, { status: 'awaiting_payment', payment: null });
      const input = {
        orderId: seeded.orderId,
        kind: 'prepayment' as const,
        confirmation: 'redirect' as const,
        returnUrl: `https://detaly.test/o/token?paid=1`,
      };
      const first = await preparePayment(deps, input);
      if (first.kind !== 'create') throw new Error(`expected create, got ${first.kind}`);
      expect(first.request).toMatchObject({
        orderId: seeded.orderId,
        orderNumber: seeded.number,
        amountKop: seeded.totalKop,
        confirmation: 'redirect',
        metadata: {
          order_id: seeded.orderId,
          order_number: seeded.number,
          payment_row_id: first.paymentRowId,
        },
      });
      const lines = first.request.receipt?.lines ?? [];
      expect(lines.every((l) => l.paymentMode === 'full_prepayment')).toBe(true);
      expect(lines.reduce((s, l) => s + l.unitPriceKop * l.quantity, 0)).toBe(seeded.totalKop);

      // No provider id yet (crash after POST): the same row, key and body.
      const second = await preparePayment(deps, input);
      expect(second).toEqual(first);
      const rows = await db.select().from(payments).where(eq(payments.orderId, seeded.orderId));
      expect(rows).toHaveLength(1);
      const receiptRows = await db
        .select()
        .from(receipts)
        .where(eq(receipts.orderId, seeded.orderId));
      expect(receiptRows).toEqual([
        expect.objectContaining({
          kind: 'prepayment',
          status: 'pending',
          idempotenceKey: `${first.request.idempotenceKey}:receipt`,
        }),
      ]);

      await recordPaymentCreated(
        deps,
        first.paymentRowId,
        providerPayment('yk-1', {
          status: 'pending',
          amountKop: seeded.totalKop,
          confirmationUrl: 'https://yoomoney.test/pay/yk-1',
          expiresAt: new Date(T0.getTime() + 3_600_000).toISOString(),
        }),
      );
      const third = await preparePayment(deps, input);
      expect(third).toEqual({ kind: 'reuse', confirmationUrl: 'https://yoomoney.test/pay/yk-1' });
      // Recording twice journals once.
      await recordPaymentCreated(
        deps,
        first.paymentRowId,
        providerPayment('yk-1', { status: 'pending', amountKop: seeded.totalKop }),
      );
      const created = (await eventsOf(db, seeded.orderId)).filter(
        (e) => e.type === 'payment_created',
      );
      expect(created).toHaveLength(1);
      assertNoPhone(created, seeded.phone);
    });

    it('is unavailable without the YooKassa variables or in another status', async () => {
      const seeded = await seedOrder(db, { status: 'awaiting_payment', payment: null });
      const input = {
        orderId: seeded.orderId,
        kind: 'prepayment' as const,
        confirmation: 'redirect' as const,
        returnUrl: 'https://detaly.test/o/x',
      };
      const noKeys = makeDeps(db, { env: { YOOKASSA_VAT_CODE: undefined } });
      expect(await preparePayment(noKeys, input)).toEqual({
        kind: 'unavailable',
        reason: 'payments_disabled',
      });
      expect(await preparePayment(deps, { ...input, kind: 'full', confirmation: 'qr' })).toEqual({
        kind: 'unavailable',
        reason: 'wrong_status',
      });
    });
  });

  describe('applyPaymentObject', () => {
    it('succeeded -> confirmed once; the second application is a duplicate', async () => {
      const seeded = await seedOrder(db, {
        status: 'awaiting_payment',
        payment: { status: 'pending', receiptStatus: 'pending' },
      });
      const webhookId = await webhookRow(db, seeded.providerPaymentId!);
      const object = providerPayment(seeded.providerPaymentId!, { amountKop: seeded.totalKop });
      const first = await applyPaymentObject(deps, object, {
        source: 'webhook',
        webhookEventId: webhookId,
      });
      expect(first.result).toBe('processed');
      expect(first.transition).toMatchObject({ ok: true, to: 'confirmed' });
      const order = await orderRow(db, seeded.orderId);
      expect(order).toMatchObject({ status: 'confirmed' });
      expect(order.paidAt?.getTime()).toBe(T0.getTime());
      const [hook] = await db.select().from(webhookEvents).where(eq(webhookEvents.id, webhookId));
      expect(hook).toMatchObject({ result: 'processed' });
      expect(hook?.processedAt).not.toBeNull();
      const jobs = (await outboxOf(db, seeded.orderId)).map((r) => r.jobId);
      const [receipt] = await db
        .select()
        .from(receipts)
        .where(and(eq(receipts.orderId, seeded.orderId), eq(receipts.kind, 'prepayment')));
      expect(jobs).toContain(`payment-receipt:${receipt!.id}`);
      expect(jobs.filter((j) => j.startsWith('notify:'))).toHaveLength(2);

      const second = await applyPaymentObject(deps, object, { source: 'reconciliation' });
      expect(second).toEqual({ result: 'duplicate' });
      expect(
        (await eventsOf(db, seeded.orderId)).filter((e) => e.type === 'payment_succeeded'),
      ).toHaveLength(1);
      expect((await outboxOf(db, seeded.orderId)).map((r) => r.jobId)).toEqual(jobs);
    });

    it('amount differs from the total -> needs_attention (amount_mismatch), owner alert', async () => {
      const seeded = await seedOrder(db, {
        status: 'awaiting_payment',
        payment: { status: 'pending' },
      });
      const out = await applyPaymentObject(
        deps,
        providerPayment(seeded.providerPaymentId!, { amountKop: seeded.totalKop - 100 }),
        { source: 'webhook' },
      );
      expect(out.result).toBe('amount_mismatch');
      const order = await orderRow(db, seeded.orderId);
      expect(order).toMatchObject({
        status: 'needs_attention',
        attentionReason: 'amount_mismatch',
      });
      const notify = (await outboxOf(db, seeded.orderId)).filter((r) => r.queue === 'notify');
      expect(notify.map((r) => r.data)).toEqual([
        expect.objectContaining({ audience: 'owner', template: 'staff_amount_mismatch' }),
      ]);
    });

    it('a payment in another currency never matches', async () => {
      const seeded = await seedOrder(db, {
        status: 'awaiting_payment',
        payment: { status: 'pending' },
      });
      const out = await applyPaymentObject(
        deps,
        providerPayment(seeded.providerPaymentId!, { amountKop: seeded.totalKop, currency: 'USD' }),
        { source: 'webhook' },
      );
      expect(out.result).toBe('amount_mismatch');
    });

    it('canceled current payment -> cancelled; a stale cancel of an older one -> stale', async () => {
      const seeded = await seedOrder(db, {
        status: 'awaiting_payment',
        payment: { status: 'pending' },
      });
      // A newer payment exists: the old one's cancel is stale.
      const newer = uuidv7();
      await db.insert(payments).values({
        id: newer,
        orderId: seeded.orderId,
        kind: 'prepayment',
        status: 'pending',
        amountKop: seeded.totalKop,
        idempotenceKey: uuidv7(),
        providerPaymentId: `pay-new-${newer}`,
        createdAt: new Date(Date.now() + 1000),
      });
      const stale = await applyPaymentObject(
        deps,
        providerPayment(seeded.providerPaymentId!, {
          status: 'canceled',
          amountKop: seeded.totalKop,
        }),
        { source: 'webhook' },
      );
      expect(stale).toEqual({ result: 'stale' });
      expect((await orderRow(db, seeded.orderId)).status).toBe('awaiting_payment');

      const current = await applyPaymentObject(
        deps,
        providerPayment(`pay-new-${newer}`, {
          status: 'canceled',
          amountKop: seeded.totalKop,
          cancellationReason: 'expired_on_confirmation',
        }),
        { source: 'webhook' },
      );
      expect(current.result).toBe('processed');
      expect(current.transition).toMatchObject({ ok: true, to: 'cancelled' });
      const [row] = await db.select().from(payments).where(eq(payments.id, newer));
      expect(row).toMatchObject({
        status: 'canceled',
        cancellationReason: 'expired_on_confirmation',
      });
      expect((await eventsOf(db, seeded.orderId)).map((e) => e.type)).toEqual([
        'webhook_stale',
        'payment_canceled',
      ]);
    });

    it('a payment of a cancelled order -> refund_pending with refund_prepayment', async () => {
      const seeded = await seedOrder(db, {
        status: 'cancelled',
        payment: { status: 'pending' },
      });
      const out = await applyPaymentObject(
        deps,
        providerPayment(seeded.providerPaymentId!, { amountKop: seeded.totalKop }),
        { source: 'reconciliation' },
      );
      expect(out.transition).toMatchObject({ ok: true, to: 'refund_pending' });
      const [refund] = await db.select().from(refunds).where(eq(refunds.orderId, seeded.orderId));
      expect(refund).toMatchObject({
        scope: 'order',
        reason: 'late_payment',
        amountKop: seeded.totalKop,
        paymentId: seeded.paymentId,
      });
      const [refundReceipt] = await db
        .select()
        .from(receipts)
        .where(eq(receipts.refundId, refund!.id));
      expect(refundReceipt?.kind).toBe('refund_prepayment');
      expect((await itemRows(db, seeded.orderId)).map((i) => i.state)).toEqual([
        'refund_pending',
        'refund_pending',
      ]);
      const notify = (await outboxOf(db, seeded.orderId)).filter((r) => r.queue === 'notify');
      expect(notify.map((r) => (r.data as { template: string }).template)).toEqual([
        'late_payment_refund',
      ]);
    });

    it('a payment of a refunded order -> orphan refund, status kept, owner alert', async () => {
      const seeded = await seedOrder(db, { status: 'refunded' });
      // The first payment was refunded in full.
      await db.insert(refunds).values({
        orderId: seeded.orderId,
        paymentId: seeded.paymentId!,
        amountKop: seeded.totalKop,
        reason: 'refusal',
        scope: 'order',
        status: 'succeeded',
        idempotenceKey: uuidv7(),
        requestedAt: T0,
        deadlineAt: T0,
      });
      const second = uuidv7();
      const original = await db.select().from(payments).where(eq(payments.id, seeded.paymentId!));
      await db.insert(payments).values({
        id: second,
        orderId: seeded.orderId,
        kind: 'prepayment',
        status: 'pending',
        amountKop: seeded.totalKop,
        idempotenceKey: uuidv7(),
        providerPaymentId: `pay-2-${second}`,
        request: original[0]?.request,
      });
      const out = await applyPaymentObject(
        deps,
        providerPayment(`pay-2-${second}`, { amountKop: seeded.totalKop }),
        { source: 'webhook' },
      );
      expect(out).toEqual({ result: 'orphan_payment' });
      expect((await orderRow(db, seeded.orderId)).status).toBe('refunded');
      const orphan = await db
        .select()
        .from(refunds)
        .where(and(eq(refunds.orderId, seeded.orderId), eq(refunds.scope, 'orphan')));
      expect(orphan).toEqual([
        expect.objectContaining({
          paymentId: second,
          amountKop: seeded.totalKop,
          reason: 'late_payment',
        }),
      ]);
      const types = (await eventsOf(db, seeded.orderId)).map((e) => e.type);
      expect(types).toEqual(['refund_created', 'orphan_payment']);
      const notify = (await outboxOf(db, seeded.orderId)).filter((r) => r.queue === 'notify');
      expect(notify.map((r) => r.data)).toEqual([
        expect.objectContaining({ audience: 'owner', template: 'staff_orphan_payment' }),
      ]);
    });

    it('an unknown payment is ignored', async () => {
      const out = await applyPaymentObject(deps, providerPayment(`pay-unknown-${uuidv7()}`), {
        source: 'reconciliation',
      });
      expect(out).toEqual({ result: 'ignored' });
    });

    it('finds the row by metadata.payment_row_id when the provider id was not recorded', async () => {
      const seeded = await seedOrder(db, {
        status: 'awaiting_payment',
        payment: { status: 'pending' },
      });
      await db
        .update(payments)
        .set({ providerPaymentId: null })
        .where(eq(payments.id, seeded.paymentId!));
      const out = await applyPaymentObject(
        deps,
        providerPayment('yk-meta-1', {
          amountKop: seeded.totalKop,
          metadata: { payment_row_id: seeded.paymentId!, order_id: seeded.orderId },
        }),
        { source: 'reconciliation' },
      );
      expect(out.result).toBe('processed');
      const [row] = await db.select().from(payments).where(eq(payments.id, seeded.paymentId!));
      expect(row?.providerPaymentId).toBe('yk-meta-1');
    });
  });

  describe('applyRefundObject', () => {
    it('order refund: succeeded -> refunded once; items refunded', async () => {
      const seeded = await seedOrder(db, { status: 'ordered_at_supplier' });
      const refused = await performStaffAction(deps, {
        staff: { id: null, role: 'seller', via: 'bot' },
        action: 'refused',
        targetId: seeded.orderId,
      });
      expect(refused.ok).toBe(true);
      const [refund] = await db.select().from(refunds).where(eq(refunds.orderId, seeded.orderId));
      expect(refund).toMatchObject({ reason: 'refusal', amountKop: seeded.totalKop });
      const refusal = (await eventsOf(db, seeded.orderId)).find((e) => e.type === 'client_refused');
      expect(refusal?.payload).toMatchObject({
        tasks: ['cancel_at_supplier'],
        refundId: refund!.id,
        receipt: 'refund_prepayment',
      });
      const templates = (await outboxOf(db, seeded.orderId))
        .filter((r) => r.queue === 'notify')
        .map((r) => (r.data as { template: string }).template);
      expect(templates).toEqual(['refund_started', 'staff_cancel_at_supplier_task']);
      await db
        .update(refunds)
        .set({ providerRefundId: `rf-${refund!.id}` })
        .where(eq(refunds.id, refund!.id));
      const object = providerRefund(`rf-${refund!.id}`, {
        paymentId: seeded.providerPaymentId!,
        amountKop: seeded.totalKop,
      });
      const out = await applyRefundObject(deps, object, { source: 'webhook' });
      expect(out.transition).toMatchObject({ ok: true, to: 'refunded' });
      expect(
        (await itemRows(db, seeded.orderId)).map((i) => [i.state, i.refundedAmountKop]),
      ).toEqual([
        ['refunded', 128_000],
        ['refunded', 64_000],
      ]);
      const [refundReceipt] = await db
        .select()
        .from(receipts)
        .where(eq(receipts.refundId, refund!.id));
      expect(refundReceipt?.status).toBe('succeeded');
      expect(await applyRefundObject(deps, object, { source: 'reconciliation' })).toEqual({
        result: 'duplicate',
      });
    });

    it('matches a refund without provider id by payment and amount; canceled -> failed + alert', async () => {
      const seeded = await seedOrder(db, { status: 'needs_attention' });
      const cancel = await performStaffAction(deps, {
        staff: { id: null, role: 'seller', via: 'bot' },
        action: 'cancel',
        targetId: seeded.orderId,
      });
      expect(cancel.ok).toBe(true);
      const out = await applyRefundObject(
        deps,
        providerRefund('rf-canceled', {
          status: 'canceled',
          paymentId: seeded.providerPaymentId!,
          amountKop: seeded.totalKop,
        }),
        { source: 'webhook' },
      );
      expect(out.transition).toMatchObject({
        ok: true,
        from: 'refund_pending',
        to: 'refund_pending',
      });
      const [refund] = await db.select().from(refunds).where(eq(refunds.orderId, seeded.orderId));
      expect(refund).toMatchObject({ status: 'failed', providerRefundId: 'rf-canceled' });
      const templates = (await outboxOf(db, seeded.orderId))
        .filter((r) => r.queue === 'notify')
        .map((r) => (r.data as { template: string }).template);
      expect(templates).toContain('staff_refund_failed');
    });
  });

  describe('applyReceiptObject', () => {
    it('succeeded journals once; a final error cancels the row and «Повторить чек» takes a new key', async () => {
      const seeded = await seedOrder(db, {
        status: 'ready',
        clientArrived: true,
        offset: 'pending',
      });
      const [offset] = await db
        .select()
        .from(receipts)
        .where(and(eq(receipts.orderId, seeded.orderId), eq(receipts.kind, 'offset')));

      const failed = await applyReceiptObject(deps, offset!.id, {
        error: { code: 'invalid_request', message: 'tax_system_code', final: true },
      });
      expect(failed).toEqual({ status: 'canceled', changed: true });
      expect((await eventsOf(db, seeded.orderId)).map((e) => e.type)).toEqual(['receipt_failed']);

      const retry = await performStaffAction(deps, {
        staff: { id: null, role: 'seller', via: 'bot' },
        action: 'rcpt',
        targetId: seeded.orderId,
      });
      expect(retry.ok).toBe(true);
      const offsets = await db
        .select()
        .from(receipts)
        .where(and(eq(receipts.orderId, seeded.orderId), eq(receipts.kind, 'offset')))
        .orderBy(receipts.createdAt, receipts.id);
      expect(offsets.map((r) => r.status)).toEqual(['canceled', 'pending']);
      expect(offsets[1]?.idempotenceKey).not.toBe(offsets[0]?.idempotenceKey);

      const ok = await applyReceiptObject(deps, offsets[1]!.id, providerReceipt('rc-2'));
      expect(ok).toEqual({ status: 'succeeded', changed: true });
      const again = await applyReceiptObject(deps, offsets[1]!.id, providerReceipt('rc-2'));
      expect(again).toEqual({ status: 'succeeded', changed: false });
      const snapshot = await loadOrderSnapshot(db, seeded.orderId, { lock: false });
      expect(snapshot?.receipts.find((r) => r.id === offsets[1]!.id)).toMatchObject({
        providerReceiptId: 'rc-2',
        fiscalDocumentNumber: '12345',
      });
      expect(
        (await eventsOf(db, seeded.orderId)).filter((e) => e.type === 'receipt_succeeded'),
      ).toHaveLength(1);
    });

    it('«Повторить чек» on a pending receipt re-queues it without a new row', async () => {
      const seeded = await seedOrder(db, {
        status: 'ready',
        clientArrived: true,
        offset: 'pending',
      });
      const retry = await performStaffAction(deps, {
        staff: { id: null, role: 'seller', via: 'bot' },
        action: 'rcpt',
        targetId: seeded.orderId,
      });
      expect(retry.ok).toBe(true);
      const offsets = await db
        .select()
        .from(receipts)
        .where(and(eq(receipts.orderId, seeded.orderId), eq(receipts.kind, 'offset')));
      expect(offsets).toHaveLength(1);
      const jobs = (await outboxOf(db, seeded.orderId)).map((r) => r.jobId);
      expect(jobs.some((j) => j.startsWith(`offset:${offsets[0]!.id}:retry:`))).toBe(true);
    });
  });
});
