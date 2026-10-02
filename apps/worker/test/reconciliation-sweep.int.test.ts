// reconciliation/sweep and reconciliation/nightly on the msw emulation of YooKassa and the
// `_worker` database: Verification «Фаза 1B» step 4 (the webhook never came), a POST /payments
// answer lost before recordPaymentCreated (decision Б7), a lost refund answer, and the nightly
// list check that only alerts. The database is shared with other test files, so the sweep and
// the nightly check run scoped to this file's orders.
import { eq, payments, refunds } from '@detaly/db';
import { performStaffAction, preparePayment } from '@detaly/orders';
import type { CreateRefundRequest } from '@detaly/payments';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { processReconciliation } from '../src/jobs/reconciliation';
import { alertText, runNightly } from '../src/jobs/reconciliation/nightly';
import { runSweep } from '../src/jobs/reconciliation/sweep';
import {
  createOnlinePayment,
  eventsOf,
  forceState,
  job,
  MINUTE,
  orderRow,
  paidPrepayOrder,
  paymentTestDeps,
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

const OWNER = { id: null, role: 'owner', via: 'admin' } as const;

async function paymentRows(orderId: string) {
  return t.deps.db.select().from(payments).where(eq(payments.orderId, orderId));
}

describe('reconciliation/sweep: pending payments (Verification 4)', () => {
  it('paid without a webhook: nothing before 10 minutes, confirmed after', async () => {
    const seeded = await seedOrder(t.deps.db);
    const { providerPaymentId } = await createOnlinePayment(t, seeded.orderId);
    mock.setPaymentStatus(providerPaymentId, 'succeeded');

    clock.advance(5 * MINUTE);
    expect(await runSweep(t.deps, { orderIds: [seeded.orderId] })).toEqual({
      payments: {},
      refunds: {},
    });
    expect((await orderRow(t.deps.db, seeded.orderId)).status).toBe('awaiting_payment');

    clock.advance(6 * MINUTE);
    const report = await runSweep(t.deps, { orderIds: [seeded.orderId] });
    expect(report.payments).toEqual({ applied: 1 });
    expect((await orderRow(t.deps.db, seeded.orderId)).status).toBe('confirmed');
    const succeeded = (await eventsOf(t.deps.db, seeded.orderId)).find(
      (e) => e.type === 'payment_succeeded',
    );
    expect(succeeded?.actorType).toBe('system');
    expect(succeeded?.payload.source).toBe('reconciliation');

    // The next pass finds nothing pending.
    clock.advance(10 * MINUTE);
    expect(await runSweep(t.deps, { orderIds: [seeded.orderId] })).toEqual({
      payments: {},
      refunds: {},
    });
  });

  it('a lost POST /payments answer: the sweep repeats the stored body with the same key', async () => {
    const seeded = await seedOrder(t.deps.db);
    const prepared = await preparePayment(t.deps.engine, {
      orderId: seeded.orderId,
      kind: 'prepayment',
      confirmation: 'redirect',
      returnUrl: 'https://detaly.test/o/token?paid=1',
    });
    if (prepared.kind !== 'create') throw new Error(prepared.kind);
    // The web created the payment at YooKassa and died before recordPaymentCreated.
    await t.deps.payments?.createPayment(prepared.request);
    expect((await paymentRows(seeded.orderId))[0]?.providerPaymentId).toBeNull();

    clock.advance(11 * MINUTE);
    const report = await runSweep(t.deps, { orderIds: [seeded.orderId] });
    expect(report.payments).toEqual({ created: 1 });
    expect(mock.payments.size).toBe(1);
    const posts = mock.requests.filter((r) => r.method === 'POST' && r.path === '/payments');
    expect(posts).toHaveLength(2);
    expect(new Set(posts.map((p) => p.idempotenceKey)).size).toBe(1);
    const [row] = await paymentRows(seeded.orderId);
    expect(row?.providerPaymentId).toBe([...mock.payments.keys()][0]);
    expect((await eventsOf(t.deps.db, seeded.orderId)).map((e) => e.type)).toEqual([
      'payment_created',
    ]);

    // Paid later: the next pass applies it.
    mock.setPaymentStatus(row?.providerPaymentId as string, 'succeeded');
    clock.advance(10 * MINUTE);
    expect((await runSweep(t.deps, { orderIds: [seeded.orderId] })).payments).toEqual({
      applied: 1,
    });
    expect((await orderRow(t.deps.db, seeded.orderId)).status).toBe('confirmed');
  });

  it('no repeated POST once the order no longer waits for the payment', async () => {
    const seeded = await seedOrder(t.deps.db);
    const prepared = await preparePayment(t.deps.engine, {
      orderId: seeded.orderId,
      kind: 'prepayment',
      confirmation: 'redirect',
      returnUrl: 'https://detaly.test/o/token?paid=1',
    });
    expect(prepared.kind).toBe('create');
    await forceState(t.deps.db, seeded.orderId, { status: 'cancelled' });
    clock.advance(11 * MINUTE);
    const report = await runSweep(t.deps, { orderIds: [seeded.orderId] });
    expect(report.payments).toEqual({ skipped_order_status: 1 });
    expect(mock.requests).toEqual([]);
  });

  it('rows that stay pending for good never starve fresh ones out of the batch', async () => {
    // A payment row whose POST never happened, of an order that moved on: skipped on every pass.
    const stuck = await seedOrder(t.deps.db);
    const prepared = await preparePayment(t.deps.engine, {
      orderId: stuck.orderId,
      kind: 'prepayment',
      confirmation: 'redirect',
      returnUrl: 'https://detaly.test/o/token?paid=1',
    });
    expect(prepared.kind).toBe('create');
    await forceState(t.deps.db, stuck.orderId, { status: 'cancelled' });
    // A newer payment, paid without a webhook.
    const fresh = await seedOrder(t.deps.db);
    const pf = await createOnlinePayment(t, fresh.orderId);
    mock.setPaymentStatus(pf.providerPaymentId, 'succeeded');

    clock.advance(11 * MINUTE);
    const scope = { orderIds: [stuck.orderId, fresh.orderId], limit: 1 };
    expect((await runSweep(t.deps, scope)).payments).toEqual({ applied: 1 });
    expect((await orderRow(t.deps.db, fresh.orderId)).status).toBe('confirmed');
    expect((await runSweep(t.deps, scope)).payments).toEqual({ skipped_order_status: 1 });

    // Past the Idempotence-Key lifetime the row can never be repeated: it is not even read.
    clock.advance(24 * 60 * MINUTE);
    expect(await runSweep(t.deps, scope)).toEqual({ payments: {}, refunds: {} });
  });

  it('provider errors are logged and counted; the pass goes on and is never retried', async () => {
    const a = await seedOrder(t.deps.db);
    const b = await seedOrder(t.deps.db);
    const pa = await createOnlinePayment(t, a.orderId);
    const pb = await createOnlinePayment(t, b.orderId);
    mock.setPaymentStatus(pa.providerPaymentId, 'succeeded');
    mock.setPaymentStatus(pb.providerPaymentId, 'succeeded');
    mock.failNext(`GET /payments/${pa.providerPaymentId}`, 503);
    clock.advance(11 * MINUTE);
    const report = await runSweep(t.deps, { orderIds: [a.orderId, b.orderId] });
    expect(report.payments).toEqual({ error: 1, applied: 1 });
    expect((await orderRow(t.deps.db, a.orderId)).status).toBe('awaiting_payment');
    expect((await orderRow(t.deps.db, b.orderId)).status).toBe('confirmed');
  });
});

describe('reconciliation/sweep: pending refunds', () => {
  it('a refund created at YooKassa whose answer was lost: same key, one refund, refunded', async () => {
    const paid = await paidPrepayOrder(t, mock);
    await performStaffAction(t.deps.engine, {
      staff: OWNER,
      action: 'refused',
      targetId: paid.orderId,
    });
    const [refund] = await t.deps.db
      .select()
      .from(refunds)
      .where(eq(refunds.orderId, paid.orderId));
    // The refund-create job died after YooKassa accepted the request.
    await t.deps.payments?.createRefund(refund?.request as CreateRefundRequest);
    expect(mock.refunds.size).toBe(1);

    clock.advance(11 * MINUTE);
    const report = await runSweep(t.deps, { orderIds: [paid.orderId] });
    expect(report.refunds).toEqual({ applied: 1 });
    expect(mock.refunds.size).toBe(1);
    expect((await orderRow(t.deps.db, paid.orderId)).status).toBe('refunded');
  });

  it('payments off: the sweep does nothing', async () => {
    const off = await paymentTestDeps({ clock, fetch, payments: null, receipts: null });
    try {
      expect(await processReconciliation(job('sweep', {}), off.deps)).toEqual({
        payments: {},
        refunds: {},
        skipped: 'payments_disabled',
      });
    } finally {
      await off.close();
    }
  });
});

describe('reconciliation/nightly (decision Б29)', () => {
  it('the day of the provider against the database: one alert to the owner, no transitions', async () => {
    // A: paid and recorded — matches.
    const a = await paidPrepayOrder(t, mock);
    // B: paid at YooKassa, no webhook yet — status differs.
    const b = await seedOrder(t.deps.db);
    const pb = await createOnlinePayment(t, b.orderId);
    mock.setPaymentStatus(pb.providerPaymentId, 'succeeded');
    // C: our payment the provider does not know.
    const c = await seedOrder(t.deps.db);
    const pc = await createOnlinePayment(t, c.orderId);
    mock.payments.delete(pc.providerPaymentId);
    // D: a payment of the shop we never recorded.
    const foreign = await t.deps.payments?.createPayment({
      orderId: '00000000-0000-7000-8000-000000000000',
      orderNumber: 'X-1',
      amountKop: 50_000,
      idempotenceKey: 'nightly-foreign',
      returnUrl: 'https://detaly.test/',
    });
    const eventsBefore = (await eventsOf(t.deps.db, b.orderId)).length;

    clock.advance(11 * MINUTE);
    const report = await runNightly(t.deps, { orderIds: [a.orderId, b.orderId, c.orderId] });
    expect(report.partial).toBe(false);
    expect(report.providerPayments).toBe(3);
    expect(report.discrepancies).toHaveLength(3);
    expect(report.discrepancies).toContainEqual({
      kind: 'status',
      orderNumber: b.number,
      providerPaymentId: pb.providerPaymentId,
      providerStatus: 'succeeded',
      dbStatus: 'pending',
    });
    expect(report.discrepancies).toContainEqual({
      kind: 'missing_at_provider',
      orderNumber: c.number,
      providerPaymentId: pc.providerPaymentId,
      dbStatus: 'pending',
    });
    expect(report.discrepancies).toContainEqual({
      kind: 'missing_in_db',
      providerPaymentId: foreign?.id,
      providerStatus: 'pending',
      amountKop: 50_000,
    });

    expect(t.fakes.alerts.calls).toHaveLength(1);
    const alert = t.fakes.alerts.calls[0];
    expect(alert?.audience).toBe('owner');
    expect(alert?.dedupeKey).toMatch(/^reconciliation:nightly:\d{4}-\d{2}-\d{2}$/u);
    expect(alert?.text).toContain(b.number);
    expect(alert?.text).toContain('Расхождений: 3.');
    expect(alert?.text).not.toContain(b.phone);
    expect(alert?.text).not.toContain(b.phone.slice(1));
    // Alerts only: the order of B did not move.
    expect((await orderRow(t.deps.db, b.orderId)).status).toBe('awaiting_payment');
    expect(await eventsOf(t.deps.db, b.orderId)).toHaveLength(eventsBefore);
    // The list was read with the documented filters.
    const list = mock.requests.find((r) => r.method === 'GET' && r.path === '/payments');
    expect(list?.query['created_at.gte']).toBe(report.window.createdGte);
    expect(list?.query['created_at.lt']).toBe(report.window.createdLt);
  });

  it('a lost POST answer shows as `unrecorded` (the row is found by metadata.payment_row_id)', async () => {
    const seeded = await seedOrder(t.deps.db);
    const prepared = await preparePayment(t.deps.engine, {
      orderId: seeded.orderId,
      kind: 'prepayment',
      confirmation: 'redirect',
      returnUrl: 'https://detaly.test/o/token?paid=1',
    });
    if (prepared.kind !== 'create') throw new Error(prepared.kind);
    const created = await t.deps.payments?.createPayment(prepared.request);
    clock.advance(11 * MINUTE);
    const report = await runNightly(t.deps, { orderIds: [seeded.orderId] });
    expect(report.discrepancies).toEqual([
      {
        kind: 'unrecorded',
        orderNumber: seeded.number,
        providerPaymentId: created?.id,
        providerStatus: 'pending',
      },
    ]);
  });

  it('nothing to report: no alert; the list fails: a partial-check alert', async () => {
    const paid = await paidPrepayOrder(t, mock);
    clock.advance(11 * MINUTE);
    const clean = await runNightly(t.deps, { orderIds: [paid.orderId] });
    expect(clean).toMatchObject({ providerPayments: 1, partial: false, alerted: false });
    expect(clean.discrepancies).toEqual([]);
    expect(t.fakes.alerts.calls).toEqual([]);
    // The queue job runs the same check over the whole database (other files' rows included).
    expect(await processReconciliation(job('nightly', {}), t.deps)).toHaveProperty('window');

    mock.failNext('GET /payments', 500);
    const broken = await runNightly(t.deps, { orderIds: [] });
    expect(broken.partial).toBe(true);
    expect(broken.alerted).toBe(true);
    expect(alertText(broken)).toContain('Сверка неполная');
  });

  it('an unknown job name fails without retries', async () => {
    await expect(processReconciliation(job('weekly', {}), t.deps)).rejects.toMatchObject({
      name: 'UnrecoverableError',
    });
  });
});
