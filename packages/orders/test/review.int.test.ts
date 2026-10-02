// Review fixes of the engine (phase 1B): proposals at the client's price and not in the past,
// the refund reason of a wrong-amount payment, duplicate payments returned with the whole order,
// and the owner alert for a duplicate payment a rule accepts silently.
import { clientApprovals, eq, payments, receipts, refunds, type Db } from '@detaly/db';
import { v7 as uuidv7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applyPaymentObject, applyTransition, type EngineDeps } from '../src';
import {
  DB_URL,
  eventsOf,
  makeDeps,
  offer,
  openDb,
  orderRow,
  outboxOf,
  providerPayment,
  seedOrder,
  T0,
} from './helpers';

const DAY = 86_400_000;
const staff = { type: 'staff' as const, id: null, staffRole: 'seller' as const };
const owner = { type: 'staff' as const, id: null, staffRole: 'owner' as const };

/** A second succeeded payment of the order (a duplicate), copying the first one's request. */
async function addDuplicatePayment(
  db: Db,
  orderId: string,
  firstPaymentId: string,
  status: 'succeeded' | 'pending' = 'succeeded',
): Promise<{ id: string; providerPaymentId: string }> {
  const [first] = await db.select().from(payments).where(eq(payments.id, firstPaymentId));
  const id = uuidv7();
  const providerPaymentId = `pay-dup-${id}`;
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
  await db.insert(receipts).values({
    orderId,
    paymentId: id,
    kind: first!.kind,
    idempotenceKey: `${idempotenceKey}:receipt`,
    status: status === 'succeeded' ? 'succeeded' : 'pending',
    request: receipt!.request,
  });
  return { id, providerPaymentId };
}

describe.skipIf(!DB_URL)('engine review fixes', () => {
  let db: Db;
  let deps: EngineDeps;

  beforeAll(() => {
    db = openDb();
    deps = makeDeps(db, { env: { SMS_PROVIDER: 'smsaero' } });
  });
  afterAll(async () => {
    await db?.close();
  });

  it('«Аналог» only at the client price of the item; dates not in the past', async () => {
    const seeded = await seedOrder(db, { status: 'needs_attention' });
    const [item1] = seeded.itemIds as [string, string];
    const alt = offer({ brand: 'FILTRON', article: 'OP 520', articleNorm: 'OP520' });
    const proposal = {
      kind: 'alternative' as const,
      offer: alt,
      priceClientKop: 128_000,
      priceSupplierKop: 90_000,
      markupBp: 4222,
      etaDate: '2026-10-09',
      searchArticleNorm: 'OP520',
      offerKey: 'OP520:FILTRON:ORB1',
      marginBp: 2968,
    };
    // A different client price would change the order total behind the payment taken.
    const pricier = await applyTransition(deps, {
      orderId: seeded.orderId,
      event: 'alternative_proposed',
      actor: staff,
      itemId: item1,
      facts: { proposal: { ...proposal, priceClientKop: 150_000 } },
    });
    expect(pricier).toMatchObject({ ok: false, reason: 'guard_failed', failed: ['proposal'] });
    const late = await applyTransition(deps, {
      orderId: seeded.orderId,
      event: 'alternative_proposed',
      actor: staff,
      itemId: item1,
      facts: { proposal: { ...proposal, etaDate: '2026-10-01' } },
    });
    expect(late).toMatchObject({ ok: false, failed: ['proposal'] });
    const pastEta = await applyTransition(deps, {
      orderId: seeded.orderId,
      event: 'new_eta_proposed',
      actor: staff,
      facts: { proposal: { kind: 'new_eta', etaDate: '2026-10-04', note: null } },
    });
    expect(pastEta).toMatchObject({ ok: false, failed: ['proposal'] });
    expect(
      await db.select().from(clientApprovals).where(eq(clientApprovals.orderId, seeded.orderId)),
    ).toHaveLength(0);
    expect(await eventsOf(db, seeded.orderId)).toHaveLength(0);

    const ok = await applyTransition(deps, {
      orderId: seeded.orderId,
      event: 'alternative_proposed',
      actor: staff,
      itemId: item1,
      facts: { proposal },
    });
    expect(ok).toMatchObject({ ok: true, to: 'awaiting_client_approval' });
  });

  it('cancelling a wrong-amount payment parked in needs_attention refunds it as amount_mismatch', async () => {
    const seeded = await seedOrder(db, {
      status: 'needs_attention',
      attentionReason: 'amount_mismatch',
    });
    const result = await applyTransition(deps, {
      orderId: seeded.orderId,
      event: 'order_cancelled',
      actor: owner,
    });
    expect(result).toMatchObject({ ok: true, to: 'refund_pending' });
    const [refund] = await db.select().from(refunds).where(eq(refunds.orderId, seeded.orderId));
    expect(refund).toMatchObject({ scope: 'order', reason: 'amount_mismatch' });
    expect((await orderRow(db, seeded.orderId)).attentionReason).toBeNull();
  });

  it('a whole-order refund also returns a duplicate payment whole (orphan)', async () => {
    const seeded = await seedOrder(db, { status: 'needs_attention' });
    const duplicate = await addDuplicatePayment(db, seeded.orderId, seeded.paymentId!);
    const result = await applyTransition(deps, {
      orderId: seeded.orderId,
      event: 'order_cancelled',
      actor: owner,
    });
    expect(result).toMatchObject({ ok: true, to: 'refund_pending' });
    const rows = await db.select().from(refunds).where(eq(refunds.orderId, seeded.orderId));
    expect(rows).toHaveLength(2);
    // The order's own (oldest) payment drives the order status; the duplicate goes back whole.
    const main = rows.find((r) => r.scope === 'order');
    const orphan = rows.find((r) => r.scope === 'orphan');
    expect(main).toMatchObject({ paymentId: seeded.paymentId, amountKop: seeded.totalKop });
    expect(orphan).toMatchObject({ paymentId: duplicate.id, amountKop: seeded.totalKop });
    const refundJobs = (await outboxOf(db, seeded.orderId)).filter(
      (r) => r.name === 'refund-create',
    );
    expect(refundJobs).toHaveLength(2);
    const [transition] = (await eventsOf(db, seeded.orderId)).filter(
      (e) => e.type === 'order_cancelled',
    );
    expect(transition?.payload).toMatchObject({
      refundId: main!.id,
      duplicateRefundIds: [orphan!.id],
    });
  });

  it('a second QR payment accepted by the rule still alerts the owner', async () => {
    const seeded = await seedOrder(db, {
      scheme: 'pay_on_handover',
      status: 'awaiting_handover_payment',
      clientArrived: true,
      receivedAt: T0,
      expiresAt: new Date(T0.getTime() + 15 * 60_000),
      payment: { kind: 'full', status: 'succeeded' },
    });
    const second = await addDuplicatePayment(db, seeded.orderId, seeded.paymentId!, 'pending');
    const out = await applyPaymentObject(
      deps,
      providerPayment(second.providerPaymentId, { amountKop: seeded.totalKop }),
      { source: 'webhook' },
    );
    expect(out.result).toBe('processed');
    expect((await orderRow(db, seeded.orderId)).status).toBe('awaiting_handover_payment');
    const alerts = (await outboxOf(db, seeded.orderId)).filter(
      (r) => r.queue === 'notify' && r.jobId.endsWith(':staff_unexpected_payment'),
    );
    expect(alerts).toHaveLength(1);
    const journal = (await eventsOf(db, seeded.orderId)).filter((e) => e.type === 'payment_status');
    expect(journal.map((e) => e.payload)).toEqual([
      expect.objectContaining({ paymentId: second.id, note: 'duplicate_payment' }),
    ]);
  });

  it('a single payment accepted by its rule raises no duplicate alert', async () => {
    const seeded = await seedOrder(db, {
      scheme: 'pay_on_handover',
      status: 'awaiting_handover_payment',
      clientArrived: true,
      receivedAt: T0,
      expiresAt: new Date(T0.getTime() + 2 * DAY),
      payment: { kind: 'full', status: 'pending' },
    });
    const out = await applyPaymentObject(
      deps,
      providerPayment(seeded.providerPaymentId!, { amountKop: seeded.totalKop }),
      { source: 'webhook' },
    );
    expect(out.result).toBe('processed');
    const alerts = (await outboxOf(db, seeded.orderId)).filter((r) => r.queue === 'notify');
    expect(alerts).toHaveLength(0);
  });
});
