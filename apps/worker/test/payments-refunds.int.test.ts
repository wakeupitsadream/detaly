// payments/refund-create on the msw emulation of YooKassa and the `_worker` database:
// Verification «Фаза 1B» steps 11 and 15 (the refund half), partial refunds of items, a 4xx
// rejection, the job run twice and a crash between the provider answer and our write.
import { and, eq, receipts, refunds, users } from '@detaly/db';
import { applyTransition, performStaffAction } from '@detaly/orders';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { processPayments } from '../src/jobs/payments';
import { runSweep } from '../src/jobs/reconciliation/sweep';
import {
  eventsOf,
  expectNoPhone,
  forceState,
  job,
  orderRow,
  outboxOf,
  paidPrepayOrder,
  paymentTestDeps,
  runOutbox,
  MINUTE,
  testClock,
  yooKassa,
  type PaymentTestDeps,
} from './payments-helpers';

let clock = testClock();
const { mock, fetch, garbleNext } = yooKassa(() => clock);
let t: PaymentTestDeps;

beforeEach(async () => {
  clock = testClock();
  t = await paymentTestDeps({ clock, fetch });
});
afterEach(async () => {
  await t.close();
  mock.reset();
});

const OWNER = { id: null, role: 'owner', via: 'admin' } as const;

async function refundsOf(orderId: string) {
  return t.deps.db.select().from(refunds).where(eq(refunds.orderId, orderId));
}

async function refundReceipts(orderId: string) {
  return t.deps.db
    .select()
    .from(receipts)
    .where(and(eq(receipts.orderId, orderId), eq(receipts.kind, 'refund_prepayment')));
}

describe('payments/refund-create: the whole order (Verification 11)', () => {
  it('«Отказ клиента» → refund_pending → POST /refunds with the receipt → refunded', async () => {
    const paid = await paidPrepayOrder(t, mock);
    const action = await performStaffAction(t.deps.engine, {
      staff: OWNER,
      action: 'refused',
      targetId: paid.orderId,
    });
    expect(action.ok).toBe(true);
    expect((await orderRow(t.deps.db, paid.orderId)).status).toBe('refund_pending');

    const [result] = await runOutbox(t, paid.orderId, { queue: 'payments', name: 'refund-create' });
    expect(result).toMatchObject({ outcome: 'applied', providerStatus: 'succeeded' });
    expect((await orderRow(t.deps.db, paid.orderId)).status).toBe('refunded');

    const [refund] = await refundsOf(paid.orderId);
    expect(refund?.status).toBe('succeeded');
    expect(refund?.providerRefundId).not.toBeNull();
    expect(refund?.amountKop).toBe(paid.totalKop);
    const [receipt] = await refundReceipts(paid.orderId);
    expect(receipt?.status).toBe('succeeded');

    // POST /refunds carried the refund receipt mirroring the prepayment (full_prepayment).
    const post = mock.requests.find((r) => r.method === 'POST' && r.path === '/refunds');
    const items = (post?.body?.receipt as { items: { payment_mode: string }[] }).items;
    expect(items.every((i) => i.payment_mode === 'full_prepayment')).toBe(true);
    expect(post?.idempotenceKey).toBe(refund?.idempotenceKey);

    const types = (await eventsOf(t.deps.db, paid.orderId)).map((e) => e.type);
    expect(types).toContain('refund_succeeded');
    const notify = (await outboxOf(t.deps.db, paid.orderId)).filter((o) => o.queue === 'notify');
    expect(notify.filter((o) => o.data.template === 'money_sent')).toHaveLength(1);
    expectNoPhone(await eventsOf(t.deps.db, paid.orderId), paid.phone);

    // The same job again: the refund is settled, no second POST.
    const again = await processPayments(job('refund-create', { refundId: refund?.id }), t.deps);
    expect(again).toEqual({ outcome: 'skipped', reason: 'settled' });
    expect(mock.refunds.size).toBe(1);
    expect(mock.requests.filter((r) => r.method === 'POST' && r.path === '/refunds')).toHaveLength(
      1,
    );
  });

  it('a pending refund at the provider records its id; refund.succeeded later settles it', async () => {
    mock.configure({ refundStatus: 'pending' });
    const paid = await paidPrepayOrder(t, mock);
    await performStaffAction(t.deps.engine, {
      staff: OWNER,
      action: 'refused',
      targetId: paid.orderId,
    });
    const [result] = await runOutbox(t, paid.orderId, { queue: 'payments', name: 'refund-create' });
    expect(result).toMatchObject({ outcome: 'applied', result: 'pending' });
    const [refund] = await refundsOf(paid.orderId);
    expect(refund?.status).toBe('pending');
    expect(refund?.providerRefundId).not.toBeNull();

    mock.setRefundStatus(refund?.providerRefundId as string, 'succeeded');
    const again = await processPayments(job('refund-create', { refundId: refund?.id }), t.deps);
    // A known provider id is re-read (GET), never posted again.
    expect(again).toMatchObject({ outcome: 'applied', providerStatus: 'succeeded' });
    expect(mock.requests.filter((r) => r.method === 'POST' && r.path === '/refunds')).toHaveLength(
      1,
    );
    expect((await orderRow(t.deps.db, paid.orderId)).status).toBe('refunded');
  });

  it('a crash between the provider answer and our write: the retry gets the same refund', async () => {
    const paid = await paidPrepayOrder(t, mock);
    await performStaffAction(t.deps.engine, {
      staff: OWNER,
      action: 'refused',
      targetId: paid.orderId,
    });
    const [refund] = await refundsOf(paid.orderId);
    // YooKassa created the refund, the answer was lost.
    mock.failNext('POST /refunds', 'network', { afterProcessing: true });
    await expect(
      processPayments(job('refund-create', { refundId: refund?.id }), t.deps),
    ).rejects.toMatchObject({ name: 'PaymentProviderError' });
    expect((await refundsOf(paid.orderId))[0]?.status).toBe('pending');

    // The queue retries with the stored body and the same Idempotence-Key.
    const retry = await processPayments(job('refund-create', { refundId: refund?.id }), t.deps);
    expect(retry).toMatchObject({ outcome: 'applied', providerStatus: 'succeeded' });
    expect(mock.refunds.size).toBe(1);
    const posts = mock.requests.filter((r) => r.method === 'POST' && r.path === '/refunds');
    expect(posts).toHaveLength(2);
    expect(new Set(posts.map((p) => p.idempotenceKey)).size).toBe(1);
    expect((await orderRow(t.deps.db, paid.orderId)).status).toBe('refunded');
  });

  it('4xx from POST /refunds → refund failed, refund_failed, owner alert; the order stays refund_pending', async () => {
    const paid = await paidPrepayOrder(t, mock);
    await performStaffAction(t.deps.engine, {
      staff: OWNER,
      action: 'refused',
      targetId: paid.orderId,
    });
    mock.failNext('POST /refunds', 400);
    const [result] = await runOutbox(t, paid.orderId, { queue: 'payments', name: 'refund-create' });
    expect(result).toEqual({ outcome: 'rejected', error: 'invalid_request (HTTP 400)' });

    const [refund] = await refundsOf(paid.orderId);
    expect(refund?.status).toBe('failed');
    expect(refund?.error).toBe('invalid_request (HTTP 400)');
    expect(refund?.alertedAt).not.toBeNull();
    expect((await orderRow(t.deps.db, paid.orderId)).status).toBe('refund_pending');
    const events = await eventsOf(t.deps.db, paid.orderId);
    expect(events.map((e) => e.type)).toContain('refund_failed');
    const owner = (await outboxOf(t.deps.db, paid.orderId)).filter(
      (o) => o.queue === 'notify' && o.data.audience === 'owner',
    );
    expect(owner.map((o) => o.data.template)).toEqual(['staff_refund_failed']);
    expect(t.fakes.nudges.count).toBeGreaterThan(0);

    // Run again: nothing happens (the refund is settled as failed, the owner refunds by hand).
    const again = await processPayments(job('refund-create', { refundId: refund?.id }), t.deps);
    expect(again).toEqual({ outcome: 'skipped', reason: 'settled' });
  });
});

describe('payments/refund-create: the money may have moved', () => {
  it('an unreadable answer to POST /refunds is never written off: pending, then the same key', async () => {
    const paid = await paidPrepayOrder(t, mock);
    await performStaffAction(t.deps.engine, {
      staff: OWNER,
      action: 'refused',
      targetId: paid.orderId,
    });
    garbleNext('POST /refunds');
    await expect(
      runOutbox(t, paid.orderId, { queue: 'payments', name: 'refund-create' }),
    ).rejects.toMatchObject({ name: 'UnrecoverableError' });
    // YooKassa did refund: no refund_failed, no «refund failed» alert to the owner.
    expect(mock.refunds.size).toBe(1);
    const [refund] = await refundsOf(paid.orderId);
    expect(refund?.status).toBe('pending');
    expect(refund?.alertedAt).toBeNull();
    expect((await eventsOf(t.deps.db, paid.orderId)).map((e) => e.type)).not.toContain(
      'refund_failed',
    );
    expect(
      (await outboxOf(t.deps.db, paid.orderId)).filter(
        (o) => o.data.template === 'staff_refund_failed',
      ),
    ).toEqual([]);

    clock.advance(11 * MINUTE);
    expect((await runSweep(t.deps, { orderIds: [paid.orderId] })).refunds).toEqual({ applied: 1 });
    expect(mock.refunds.size).toBe(1);
    const posts = mock.requests.filter((r) => r.method === 'POST' && r.path === '/refunds');
    expect(posts).toHaveLength(2);
    expect(new Set(posts.map((p) => p.idempotenceKey)).size).toBe(1);
    expect((await orderRow(t.deps.db, paid.orderId)).status).toBe('refunded');
  });

  it('no provider id past the Idempotence-Key lifetime: no second POST, dead-letter instead', async () => {
    const paid = await paidPrepayOrder(t, mock);
    await performStaffAction(t.deps.engine, {
      staff: OWNER,
      action: 'refused',
      targetId: paid.orderId,
    });
    const [refund] = await refundsOf(paid.orderId);
    clock.advance(25 * 60 * MINUTE);
    await expect(
      processPayments(job('refund-create', { refundId: refund?.id }), t.deps),
    ).rejects.toMatchObject({ name: 'UnrecoverableError' });
    expect((await runSweep(t.deps, { orderIds: [paid.orderId] })).refunds).toEqual({
      skipped_idempotence_key_expired: 1,
    });
    expect(mock.requests.filter((r) => r.method === 'POST' && r.path === '/refunds')).toEqual([]);
    expect((await refundsOf(paid.orderId))[0]?.status).toBe('pending');
  });
});

describe('payments/refund-create: no-show of a prepaid order (Verification 15)', () => {
  it('storage_expired on the 10th day → refund_pending, no_show_count + 1, refund receipt succeeded', async () => {
    const paid = await paidPrepayOrder(t, mock);
    await forceState(t.deps.db, paid.orderId, { status: 'ready', itemState: 'arrived' });
    const expired = await applyTransition(t.deps.engine, {
      orderId: paid.orderId,
      event: 'storage_expired',
      actor: { type: 'system', id: null },
      facts: { pickupWindowElapsed: true },
    });
    expect(expired.ok).toBe(true);
    expect((await orderRow(t.deps.db, paid.orderId)).status).toBe('refund_pending');
    const [user] = await t.deps.db.select().from(users).where(eq(users.id, paid.userId));
    expect(user?.noShowCount).toBe(1);

    await runOutbox(t, paid.orderId, { queue: 'payments', name: 'refund-create' });
    expect((await orderRow(t.deps.db, paid.orderId)).status).toBe('refunded');
    const [refund] = await refundsOf(paid.orderId);
    expect(refund?.reason).toBe('no_show');
    expect((await refundReceipts(paid.orderId))[0]?.status).toBe('succeeded');
  });
});

describe('payments/refund-create: items (partial refunds)', () => {
  it('two cancelled items of the same price: two refunds, each matched to its own row', async () => {
    const paid = await paidPrepayOrder(t, mock, { prices: [64_000, 64_000, 10_000] });
    await forceState(t.deps.db, paid.orderId, {
      status: 'ordered_at_supplier',
      itemState: 'ordered',
    });
    for (const itemId of paid.itemIds.slice(0, 2)) {
      const result = await performStaffAction(t.deps.engine, {
        staff: OWNER,
        action: 'icancel',
        targetId: itemId,
      });
      expect(result.ok).toBe(true);
    }
    const pending = await refundsOf(paid.orderId);
    expect(pending.map((r) => [r.scope, r.amountKop])).toEqual([
      ['item', 64_000],
      ['item', 64_000],
    ]);

    const results = await runOutbox(t, paid.orderId, { queue: 'payments', name: 'refund-create' });
    expect(results).toHaveLength(2);
    const settled = await refundsOf(paid.orderId);
    expect(settled.every((r) => r.status === 'succeeded')).toBe(true);
    expect(new Set(settled.map((r) => r.providerRefundId)).size).toBe(2);
    // A partial refund never changes the order status.
    expect((await orderRow(t.deps.db, paid.orderId)).status).toBe('ordered_at_supplier');
    const types = (await eventsOf(t.deps.db, paid.orderId)).map((e) => e.type);
    expect(types.filter((type) => type === 'partial_refund_succeeded')).toHaveLength(2);
    // Each refund receipt has one line: the cancelled item.
    for (const request of mock.requests.filter(
      (r) => r.method === 'POST' && r.path === '/refunds',
    )) {
      expect((request.body?.receipt as { items: unknown[] }).items).toHaveLength(1);
    }
  });

  it('4xx of an item refund → partial_refund_failed, the order status stays', async () => {
    const paid = await paidPrepayOrder(t, mock);
    await forceState(t.deps.db, paid.orderId, {
      status: 'ordered_at_supplier',
      itemState: 'ordered',
    });
    await performStaffAction(t.deps.engine, {
      staff: OWNER,
      action: 'icancel',
      targetId: paid.itemIds[0] as string,
    });
    mock.failNext('POST /refunds', 422);
    const [result] = await runOutbox(t, paid.orderId, { queue: 'payments', name: 'refund-create' });
    expect(result).toMatchObject({ outcome: 'rejected' });
    expect((await orderRow(t.deps.db, paid.orderId)).status).toBe('ordered_at_supplier');
    const types = (await eventsOf(t.deps.db, paid.orderId)).map((e) => e.type);
    expect(types).toContain('partial_refund_failed');
  });
});
