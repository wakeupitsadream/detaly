// receipts/offset and offset-poll (decision Б22) on the msw emulation of YooKassa and the
// `_worker` database: the offset receipt at «Клиент пришёл», its polling, Verification «Фаза 1B»
// step 13 (POST /receipts rejected → alert, «Выдал» blocked), the 15-minute give-up, a lost
// answer repeated with the same Idempotence-Key and «Повторить чек».
import { and, eq, receipts } from '@detaly/db';
import { loadStaffActions, performStaffAction } from '@detaly/orders';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { processReceipts } from '../src/jobs/receipts';
import {
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

/** A prepaid order at the point; «Клиент пришёл» writes the offset receipt and its job. */
async function clientCame() {
  const paid = await paidPrepayOrder(t, mock);
  // The prepayment receipt is checked by its own job; here only the offset one matters.
  await runOutbox(t, paid.orderId, { queue: 'receipts', name: 'payment-receipt' });
  await forceState(t.deps.db, paid.orderId, { status: 'ready', itemState: 'arrived' });
  const came = await performStaffAction(t.deps.engine, {
    staff: SELLER,
    action: 'came',
    targetId: paid.orderId,
  });
  expect(came.ok).toBe(true);
  const offset = await offsetRow(paid.orderId);
  expect(offset?.status).toBe('pending');
  return { ...paid, receiptId: offset?.id as string };
}

async function offsetRow(orderId: string) {
  const rows = await t.deps.db
    .select()
    .from(receipts)
    .where(and(eq(receipts.orderId, orderId), eq(receipts.kind, 'offset')));
  return rows.at(-1);
}

async function handed(orderId: string) {
  const actions = await loadStaffActions(t.deps.engine, orderId, 'seller');
  return actions?.find((a) => a.code === 'handed');
}

function receiptPosts() {
  return mock.requests.filter((r) => r.method === 'POST' && r.path === '/receipts');
}

describe('receipts/offset: registered after polling (Verification 9, offset half)', () => {
  it('POST /receipts → pending → poll in 2 minutes → succeeded → card redrawn, «Выдал» enabled', async () => {
    const order = await clientCame();
    expect((await handed(order.orderId))?.enabled).not.toBe(true);

    const [first] = await runOutbox(t, order.orderId, { queue: 'receipts', name: 'offset' });
    expect(first).toEqual({
      status: 'pending',
      nextPollAt: new Date(clock.now.getTime() + 2 * MINUTE).toISOString(),
    });
    // The offset receipt: settlements [{type: prepayment}], full_payment items.
    const body = receiptPosts()[0]?.body as {
      settlements: { type: string }[];
      items: { payment_mode: string }[];
      payment_id: string;
    };
    expect(body.settlements.map((s) => s.type)).toEqual(['prepayment']);
    expect(body.items.every((i) => i.payment_mode === 'full_payment')).toBe(true);
    expect(body.payment_id).toBe(order.providerPaymentId);
    const row = await offsetRow(order.orderId);
    expect(row?.providerReceiptId).not.toBeNull();
    expect(row?.attempts).toBe(1);
    expect(row?.firstAttemptAt?.getTime()).toBe(clock.now.getTime());

    mock.setReceiptStatus(row?.providerReceiptId as string, 'succeeded');
    clock.advance(2 * MINUTE);
    expect(await runOutbox(t, order.orderId, { queue: 'receipts', name: 'offset-poll' })).toEqual([
      { status: 'succeeded' },
    ]);
    const done = await offsetRow(order.orderId);
    expect(done?.status).toBe('succeeded');
    expect(done?.fiscalDocumentNumber).toBe('3986');
    // GET /receipts/{id}, no second POST.
    expect(receiptPosts()).toHaveLength(1);
    expect(t.fakes.sellerCards.calls).toEqual([{ method: 'refresh', orderId: order.orderId }]);
    expect((await handed(order.orderId))?.enabled).toBe(true);
    // Two receipts at the provider: the prepayment and the offset.
    expect(mock.receipts.size).toBe(2);
    expectNoPhone(await eventsOf(t.deps.db, order.orderId), order.phone);
    expectNoPhone(await outboxOf(t.deps.db, order.orderId), order.phone);
  });

  it('the same job twice after success: one receipt, one journal event', async () => {
    mock.configure({ receiptStatus: 'succeeded' });
    const order = await clientCame();
    const data = { receiptId: order.receiptId, orderId: order.orderId };
    expect(await processReceipts(job('offset', data), t.deps)).toEqual({ status: 'succeeded' });
    expect(await processReceipts(job('offset', data), t.deps)).toEqual({ skipped: 'succeeded' });
    expect(receiptPosts()).toHaveLength(1);
    const events = await eventsOf(t.deps.db, order.orderId);
    expect(
      events.filter(
        (e) => e.type === 'receipt_succeeded' && e.payload.receiptId === order.receiptId,
      ),
    ).toHaveLength(1);
  });

  it('a lost answer: the next poll repeats POST /receipts with the same Idempotence-Key', async () => {
    const order = await clientCame();
    mock.failNext('POST /receipts', 'network', { afterProcessing: true });
    const [first] = await runOutbox(t, order.orderId, { queue: 'receipts', name: 'offset' });
    expect(first).toMatchObject({ status: 'pending' });
    expect((await offsetRow(order.orderId))?.providerReceiptId).toBeNull();
    expect((await offsetRow(order.orderId))?.error).toBe('network: no answer');

    clock.advance(2 * MINUTE);
    await runOutbox(t, order.orderId, { queue: 'receipts', name: 'offset-poll' });
    const posts = receiptPosts();
    expect(posts).toHaveLength(2);
    expect(new Set(posts.map((p) => p.idempotenceKey)).size).toBe(1);
    // One offset receipt at the provider (plus the prepayment one).
    expect(mock.receipts.size).toBe(2);
    expect((await offsetRow(order.orderId))?.providerReceiptId).not.toBeNull();
  });
});

describe('receipts/offset: failures (Verification 13)', () => {
  it('POST /receipts rejected (tax_system_code) → canceled, alert to sellers and owner, «Выдал» blocked', async () => {
    mock.configure({ rejectTaxSystemCode: 2 });
    const order = await clientCame();
    const [result] = await runOutbox(t, order.orderId, { queue: 'receipts', name: 'offset' });
    expect(result).toEqual({ status: 'canceled', alerted: true });
    const row = await offsetRow(order.orderId);
    expect(row?.status).toBe('canceled');
    expect(row?.alertedAt).not.toBeNull();
    expect(row?.error).toContain('invalid_request');

    const alerts = (await outboxOf(t.deps.db, order.orderId)).filter(
      (o) => o.data.template === 'staff_receipt_failed',
    );
    expect(alerts.map((o) => o.data.audience).sort()).toEqual(['owner', 'sellers']);
    const failed = (await eventsOf(t.deps.db, order.orderId)).filter(
      (e) => e.type === 'receipt_failed',
    );
    // The engine's own journal event carries the alert (no second one).
    expect(failed).toHaveLength(1);
    expect(alerts.every((o) => o.data.orderEventId === failed[0]?.id)).toBe(true);
    expect(t.fakes.sellerCards.calls).toEqual([{ method: 'refresh', orderId: order.orderId }]);

    expect((await handed(order.orderId))?.enabled).not.toBe(true);
    const attempt = await performStaffAction(t.deps.engine, {
      staff: SELLER,
      action: 'handed',
      targetId: order.orderId,
    });
    expect(attempt.ok).toBe(false);
    expect((await orderRow(t.deps.db, order.orderId)).status).toBe('ready');
  });

  it('no `succeeded` within 15 minutes → one alert, polling stops, «Выдал» stays blocked', async () => {
    const order = await clientCame();
    const results: unknown[] = await runOutbox(t, order.orderId, {
      queue: 'receipts',
      name: 'offset',
    });
    for (let i = 0; i < 10; i += 1) {
      clock.advance(2 * MINUTE);
      results.push(
        ...(await runOutbox(t, order.orderId, { queue: 'receipts', name: 'offset-poll' })),
      );
    }
    // Polls at 0, 2, …, 14 and the last one exactly at 15 minutes.
    expect(results).toHaveLength(9);
    expect(results.at(-1)).toEqual({ status: 'pending', alerted: true });
    expect(results.slice(0, -1).every((r) => (r as { status: string }).status === 'pending')).toBe(
      true,
    );
    const row = await offsetRow(order.orderId);
    expect(row?.status).toBe('pending');
    expect(row?.attempts).toBe(9);
    expect(row?.alertedAt).not.toBeNull();
    // Still one POST: the rest were GET /receipts/{id}.
    expect(receiptPosts()).toHaveLength(1);
    const alerts = (await outboxOf(t.deps.db, order.orderId)).filter(
      (o) => o.data.template === 'staff_receipt_failed',
    );
    expect(alerts).toHaveLength(2);
    expect((await handed(order.orderId))?.enabled).not.toBe(true);

    // A late duplicate poll does not alert again.
    expect(
      await processReceipts(job('offset-poll', { receiptId: order.receiptId }), t.deps),
    ).toEqual({ status: 'pending', alerted: false });

    // «Повторить чек»: the pending receipt is re-queued, a new window starts, and it succeeds.
    mock.setReceiptStatus(row?.providerReceiptId as string, 'succeeded');
    const retry = await performStaffAction(t.deps.engine, {
      staff: SELLER,
      action: 'rcpt',
      targetId: order.orderId,
    });
    expect(retry.ok).toBe(true);
    expect(await runOutbox(t, order.orderId, { queue: 'receipts', name: 'offset' })).toEqual([
      { status: 'succeeded' },
    ]);
    const done = await offsetRow(order.orderId);
    expect(done?.status).toBe('succeeded');
    expect(done?.alertedAt).toBeNull();
    expect((await handed(order.orderId))?.enabled).toBe(true);
  });

  it('bad job data and an unknown job name fail without retries', async () => {
    await expect(processReceipts(job('offset', {}), t.deps)).rejects.toMatchObject({
      name: 'UnrecoverableError',
    });
    await expect(processReceipts(job('vacuum', {}), t.deps)).rejects.toMatchObject({
      name: 'UnrecoverableError',
    });
  });
});
