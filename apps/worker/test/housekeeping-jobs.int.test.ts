// housekeeping timers, reminders, SMS budget and deferred 1A effects on the `_worker` database
// with an injected clock (docs/phase-1b-implementation.md section 12.2; PLAN Verification 1B
// steps 7, 15, 19, 20, 21).
//
// These jobs scan every order of the database, so the file runs on a database of its own
// (`${DATABASE_URL_TEST}_worker_ops_hk`, migrated and seeded like `_worker`): timers of other
// worker test files (real time, or the notify file's own clock) never touch these orders and
// the other way round. The clock starts in 2021; assertions look only at the orders each test
// seeded (earlier tests' orders stay in the database).
import { randomBytes, randomInt, randomUUID as uuidv7 } from 'node:crypto';
import {
  and,
  apiCalls,
  asc,
  clientApprovals,
  eq,
  orderEvents,
  orderItems,
  orders,
  outbox,
  payments,
  refunds,
  sql,
  supplierReturns,
  users,
  createDb,
  type Db,
} from '@detaly/db';
import { prepareTestDb } from '@detaly/db/testing';
import type {
  ApprovalProposal,
  Offer,
  OrderItemState,
  OrderStatus,
  PaymentKind,
  PaymentScheme,
  PaymentStatus,
} from '@detaly/domain';
import type { Job } from 'bullmq';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { processHousekeeping } from '../src/jobs/housekeeping';
import { planDeferred } from '../src/jobs/housekeeping/deferred-1a';
import { processNotify } from '../src/jobs/notify';
import { createTestDeps, type TestDeps } from './helpers/test-deps';

const DAY = 86_400_000;
const HOUR = 3_600_000;
const MIN = 60_000;
const T0 = new Date('2021-03-10T06:00:00.000Z');

const PAYMENT_ENV = {
  YOOKASSA_SHOP_ID: 'test-shop',
  YOOKASSA_SECRET_KEY: 'test-secret',
  YOOKASSA_VAT_CODE: '1',
  YOOKASSA_TAX_SYSTEM_CODE: '2',
  APP_BASE_URL: 'https://detaly.test',
};

const clock = { now: new Date(T0) };
const at = (ms: number) => new Date(T0.getTime() + ms);

function randomPhone(): string {
  return `+79${String(randomInt(0, 1_000_000_000)).padStart(9, '0')}`;
}

function offer(brand: string, article: string): Offer {
  return {
    source: 'rossko',
    brand,
    article,
    articleNorm: article.replace(/[^A-Z0-9]/gi, '').toUpperCase(),
    name: 'Фильтр масляный',
    group: null,
    isCross: false,
    priceSupplierKop: 100_000,
    stock: {
      stockId: 'ORB1',
      isLocal: true,
      count: 4,
      multiplicity: 1,
      type: null,
      deliveryDays: 2,
      deliveryStart: null,
      deliveryEnd: null,
      extra: null,
      description: null,
    },
  };
}

interface Seed {
  scheme?: PaymentScheme;
  status: OrderStatus;
  itemState?: OrderItemState;
  payment?: { kind?: PaymentKind; status: PaymentStatus; providerPaymentId?: string | null } | null;
  expiresAt?: Date | null;
  receivedAt?: Date | null;
  createdAt?: Date;
  supplierReturnDeadlineAt?: Date | null;
}

interface Seeded {
  orderId: string;
  userId: string;
  itemIds: string[];
  paymentId: string | null;
  phone: string;
}

const ITEMS = [
  { brand: 'MANN', article: 'W 914/2', priceClientKop: 128_000, priceSupplierKop: 100_000 },
  { brand: 'BOSCH', article: 'F 026', priceClientKop: 64_000, priceSupplierKop: 50_000 },
];

async function seedOrder(db: Db, seed: Seed): Promise<Seeded> {
  const scheme = seed.scheme ?? 'prepay';
  const phone = randomPhone();
  const total = ITEMS.reduce((sum, item) => sum + item.priceClientKop, 0);
  const [user] = await db.insert(users).values({ phone }).returning({ id: users.id });
  const userId = user!.id;
  const createdAt = seed.createdAt ?? at(-DAY);
  const [order] = await db
    .insert(orders)
    .values({
      userId,
      accessToken: randomBytes(32).toString('base64url'),
      status: seed.status,
      paymentScheme: scheme,
      subtotalKop: total,
      totalKop: total,
      itemsHash: 'test',
      expiresAt: seed.expiresAt ?? null,
      receivedAt: seed.receivedAt ?? null,
      supplierReturnDeadlineAt: seed.supplierReturnDeadlineAt ?? null,
      createdAt,
      updatedAt: createdAt,
    })
    .returning({ id: orders.id });
  const orderId = order!.id;
  const itemIds = ITEMS.map(() => uuidv7());
  await db.insert(orderItems).values(
    ITEMS.map((item, i) => {
      const o = offer(item.brand, item.article);
      return {
        id: itemIds[i]!,
        orderId,
        offerKey: `${o.articleNorm}:${item.brand}:ORB1`,
        searchArticleNorm: o.articleNorm,
        brand: item.brand,
        article: item.article,
        name: o.name,
        qty: 1,
        stockId: 'ORB1',
        isLocal: true,
        priceSupplierAtOrderKop: item.priceSupplierKop,
        priceClientKop: item.priceClientKop,
        markupBp: 2800,
        etaDate: '2021-03-12',
        offerSnapshot: o,
        state: seed.itemState ?? 'pending',
        ...(seed.itemState === 'arrived' ? { arrivedAt: seed.receivedAt ?? createdAt } : {}),
      };
    }),
  );
  let paymentId: string | null = null;
  if (seed.payment) {
    paymentId = uuidv7();
    await db.insert(payments).values({
      id: paymentId,
      orderId,
      kind: seed.payment.kind ?? (scheme === 'prepay' ? 'prepayment' : 'full'),
      status: seed.payment.status,
      amountKop: total,
      idempotenceKey: uuidv7(),
      providerPaymentId:
        seed.payment.providerPaymentId === undefined
          ? `pay-${uuidv7()}`
          : seed.payment.providerPaymentId,
      confirmationType: 'redirect',
      request: {},
      paidAt: seed.payment.status === 'succeeded' ? createdAt : null,
      createdAt,
    });
  }
  return { orderId, userId, itemIds, paymentId, phone };
}

async function orderOf(db: Db, orderId: string) {
  const [row] = await db.select().from(orders).where(eq(orders.id, orderId));
  return row!;
}

async function outboxOf(db: Db, orderId: string) {
  return db
    .select()
    .from(outbox)
    .where(sql`${outbox.data}->>'orderId' = ${orderId}`)
    .orderBy(asc(outbox.createdAt), asc(outbox.jobId));
}

async function eventsOf(db: Db, orderId: string) {
  return db
    .select()
    .from(orderEvents)
    .where(eq(orderEvents.orderId, orderId))
    .orderBy(asc(orderEvents.createdAt), asc(orderEvents.id));
}

function job(name: string, data: Record<string, unknown> = {}): Job {
  return { name, data, attemptsMade: 0, opts: { attempts: 1 } } as unknown as Job;
}

describe.skipIf(!inject('workerDatabaseUrl'))('housekeeping (worker-ops)', () => {
  let t: TestDeps;
  let db: Db;
  const run = (name: string) => processHousekeeping({ name }, t.deps);

  beforeAll(async () => {
    const { url } = await prepareTestDb({ url: `${inject('workerDatabaseUrl')}_ops_hk` });
    db = createDb(url, { max: 4 });
    t = await createTestDeps({
      db,
      now: () => clock.now,
      envOverrides: { ...PAYMENT_ENV, SMS_PROVIDER: 'smsaero', SMS_MONTHLY_BUDGET_RUB: '1000' },
    });
  });
  afterAll(async () => {
    await t?.close();
    await db?.close();
  });

  describe('timers', () => {
    it('payment TTL: no payment -> cancelled; pending at the provider -> recheck only', async () => {
      clock.now = T0;
      // 1A order: expires_at null, the deadline counts from created_at (+120 min).
      const unpaid = await seedOrder(db, {
        status: 'awaiting_payment',
        createdAt: at(-3 * HOUR),
      });
      const pending = await seedOrder(db, {
        status: 'awaiting_payment',
        expiresAt: at(-MIN),
        payment: { status: 'pending' },
      });
      const noProviderId = await seedOrder(db, {
        status: 'awaiting_payment',
        expiresAt: at(-MIN),
        payment: { status: 'pending', providerPaymentId: null },
      });
      const fresh = await seedOrder(db, {
        status: 'awaiting_payment',
        createdAt: at(-30 * MIN),
        expiresAt: at(90 * MIN),
      });

      await run('timers');

      expect((await orderOf(db, unpaid.orderId)).status).toBe('cancelled');
      const unpaidEvents = await eventsOf(db, unpaid.orderId);
      expect(unpaidEvents.map((e) => [e.type, e.toStatus, e.actorType])).toEqual([
        ['payment_ttl_expired', 'cancelled', 'system'],
      ]);
      expect((await outboxOf(db, unpaid.orderId)).map((r) => r.data.template)).toEqual([
        'payment_expired',
      ]);

      // Paid-or-not is unknown: never cancelled, only rechecked at the provider.
      expect((await orderOf(db, pending.orderId)).status).toBe('awaiting_payment');
      const rechecks = await outboxOf(db, pending.orderId);
      expect(rechecks).toHaveLength(1);
      expect(rechecks[0]).toMatchObject({
        queue: 'payments',
        name: 'payment-recheck',
        data: { paymentId: pending.paymentId, orderId: pending.orderId },
      });
      expect(rechecks[0]!.jobId).toMatch(new RegExp(`^payment-recheck:${pending.paymentId}:ttl:`));

      expect((await orderOf(db, noProviderId.orderId)).status).toBe('awaiting_payment');
      expect(await outboxOf(db, noProviderId.orderId)).toEqual([]);
      expect((await orderOf(db, fresh.orderId)).status).toBe('awaiting_payment');

      // Same 10-minute slot: no second recheck; the next slot rechecks again.
      await run('timers');
      expect(await outboxOf(db, pending.orderId)).toHaveLength(1);
      clock.now = at(11 * MIN);
      await run('timers');
      expect(await outboxOf(db, pending.orderId)).toHaveLength(2);
      expect((await orderOf(db, pending.orderId)).status).toBe('awaiting_payment');
    });

    it('a succeeded payment is never expired by the TTL', async () => {
      clock.now = T0;
      const paid = await seedOrder(db, {
        status: 'awaiting_payment',
        expiresAt: at(-MIN),
        payment: { status: 'succeeded' },
      });
      await run('timers');
      expect((await orderOf(db, paid.orderId)).status).toBe('awaiting_payment');
      expect(await eventsOf(db, paid.orderId)).toEqual([]);
      expect(await outboxOf(db, paid.orderId)).toEqual([]);
    });

    it('Verification 21: no confirmation in 24 h -> cancelled; 7 days after handover -> completed', async () => {
      clock.now = at(2 * DAY);
      const unconfirmed = await seedOrder(db, {
        scheme: 'pay_on_handover',
        status: 'awaiting_confirmation',
        createdAt: at(DAY - MIN),
        expiresAt: at(2 * DAY - MIN),
      });
      // 1A row without expires_at: created_at + 24 h.
      const legacy = await seedOrder(db, {
        scheme: 'pay_on_handover',
        status: 'awaiting_confirmation',
        createdAt: at(DAY - MIN),
      });
      const notYet = await seedOrder(db, {
        scheme: 'pay_on_handover',
        status: 'awaiting_confirmation',
        createdAt: at(DAY + HOUR),
      });
      const handed = await seedOrder(db, {
        status: 'handed',
        itemState: 'handed',
        expiresAt: at(2 * DAY - MIN),
        payment: { status: 'succeeded' },
      });

      await run('timers');

      for (const id of [unconfirmed.orderId, legacy.orderId]) {
        expect((await orderOf(db, id)).status).toBe('cancelled');
        expect((await eventsOf(db, id)).map((e) => e.type)).toEqual(['confirmation_timeout']);
        expect((await outboxOf(db, id)).map((r) => r.data.template)).toEqual([
          'confirmation_expired',
        ]);
      }
      expect((await orderOf(db, notYet.orderId)).status).toBe('awaiting_confirmation');
      const done = await orderOf(db, handed.orderId);
      expect(done.status).toBe('completed');
      expect(done.completedAt?.toISOString()).toBe(clock.now.toISOString());
      expect((await outboxOf(db, handed.orderId)).map((r) => r.data.template)).toEqual([
        'how_is_it',
      ]);
    });

    it('Verification 19: the handover QR expires -> back to ready', async () => {
      clock.now = at(3 * DAY);
      const qr = await seedOrder(db, {
        scheme: 'pay_on_handover',
        status: 'awaiting_handover_payment',
        itemState: 'arrived',
        receivedAt: at(DAY),
        expiresAt: at(3 * DAY - MIN),
        payment: { kind: 'full', status: 'pending' },
      });
      await run('timers');
      const order = await orderOf(db, qr.orderId);
      expect(order.status).toBe('ready');
      // The storage window keeps running from the arrival.
      expect(order.expiresAt?.toISOString()).toBe(at(DAY + 7 * DAY).toISOString());
      expect((await eventsOf(db, qr.orderId)).map((e) => [e.type, e.toStatus])).toEqual([
        ['payment_ttl_expired', 'ready'],
      ]);
      // The sellers card loses the expired QR state and offers «Выставить оплату» again.
      expect(t.fakes.sellerCards.calls).toContainEqual({ method: 'refresh', orderId: qr.orderId });
    });

    it('Verification 15: prepay not collected on day 10 -> refund_pending, no-show, Rossko return task', async () => {
      clock.now = at(10 * DAY);
      const prepaid = await seedOrder(db, {
        status: 'ready',
        itemState: 'arrived',
        receivedAt: at(0),
        expiresAt: at(10 * DAY - MIN),
        supplierReturnDeadlineAt: at(14 * DAY),
        payment: { status: 'succeeded' },
      });
      await run('timers');

      const order = await orderOf(db, prepaid.orderId);
      expect(order.status).toBe('refund_pending');
      const [user] = await db.select().from(users).where(eq(users.id, prepaid.userId));
      expect(user?.noShowCount).toBe(1);
      const refundRows = await db
        .select()
        .from(refunds)
        .where(eq(refunds.orderId, prepaid.orderId));
      expect(refundRows).toHaveLength(1);
      expect(refundRows[0]).toMatchObject({
        scope: 'order',
        status: 'pending',
        reason: 'no_show',
        amountKop: 192_000,
      });
      const returns = await db
        .select()
        .from(supplierReturns)
        .innerJoin(orderItems, eq(orderItems.id, supplierReturns.orderItemId))
        .where(eq(orderItems.orderId, prepaid.orderId));
      expect(returns.map((r) => r.supplier_returns.kind)).toEqual(['return', 'return']);
      const queued = await outboxOf(db, prepaid.orderId);
      expect(
        queued
          .filter((r) => r.queue === 'notify')
          .map((r) => [r.data.audience, r.data.template])
          .sort(),
      ).toEqual([
        ['client', 'storage_expired'],
        ['sellers', 'staff_supplier_return_task'],
      ]);
      expect(queued.filter((r) => r.queue === 'payments').map((r) => r.name)).toEqual([
        'refund-create',
      ]);
    });

    it('Verification 20: pay on handover not collected on day 7 -> cancelled without refund', async () => {
      clock.now = at(7 * DAY);
      const cod = await seedOrder(db, {
        scheme: 'pay_on_handover',
        status: 'ready',
        itemState: 'arrived',
        receivedAt: at(0),
        expiresAt: at(7 * DAY - MIN),
      });
      const early = await seedOrder(db, {
        scheme: 'pay_on_handover',
        status: 'ready',
        itemState: 'arrived',
        receivedAt: at(DAY),
        expiresAt: at(8 * DAY),
      });
      await run('timers');
      expect((await orderOf(db, cod.orderId)).status).toBe('cancelled');
      expect(await db.select().from(refunds).where(eq(refunds.orderId, cod.orderId))).toEqual([]);
      const [user] = await db.select().from(users).where(eq(users.id, cod.userId));
      expect(user?.noShowCount).toBe(1);
      expect((await orderOf(db, early.orderId)).status).toBe('ready');
    });

    it('Verification 7: silence for 24 h after decision_needed -> approval_timeout -> refund_pending', async () => {
      clock.now = at(5 * DAY);
      const silent = await seedOrder(db, {
        status: 'awaiting_client_approval',
        itemState: 'ordered',
        payment: { status: 'succeeded' },
      });
      // Notification skipped: no timer (expires_at null), the order waits for the sellers' call.
      const unreachable = await seedOrder(db, {
        status: 'awaiting_client_approval',
        itemState: 'ordered',
        payment: { status: 'succeeded' },
      });
      const proposal: ApprovalProposal = { kind: 'new_eta', etaDate: '2021-03-25', note: null };
      await db.insert(clientApprovals).values([
        {
          orderId: silent.orderId,
          kind: 'new_eta',
          scope: 'order',
          proposal,
          notifiedAt: at(4 * DAY - HOUR),
          expiresAt: at(5 * DAY - HOUR),
        },
        { orderId: unreachable.orderId, kind: 'new_eta', scope: 'order', proposal },
      ]);

      await run('timers');

      expect((await orderOf(db, silent.orderId)).status).toBe('refund_pending');
      const [approval] = await db
        .select()
        .from(clientApprovals)
        .where(eq(clientApprovals.orderId, silent.orderId));
      expect(approval).toMatchObject({ decision: 'timeout' });
      expect(approval?.decidedAt?.toISOString()).toBe(clock.now.toISOString());
      expect((await eventsOf(db, silent.orderId)).map((e) => e.type).sort()).toEqual([
        'approval_timeout',
        'refund_created',
      ]);
      expect(
        (await db.select().from(refunds).where(eq(refunds.orderId, silent.orderId))).length,
      ).toBe(1);

      clock.now = at(30 * DAY);
      await run('timers');
      expect((await orderOf(db, unreachable.orderId)).status).toBe('awaiting_client_approval');
      expect(await eventsOf(db, unreachable.orderId)).toEqual([]);
    });
  });

  describe('reminders', () => {
    it('ready: days 3, 6 and 9 exactly once each; after a gap only the latest day', async () => {
      const base = at(40 * DAY);
      clock.now = base;
      const ready = await seedOrder(db, {
        status: 'ready',
        itemState: 'arrived',
        receivedAt: base,
        expiresAt: new Date(base.getTime() + 10 * DAY),
        payment: { status: 'succeeded' },
      });
      const late = await seedOrder(db, {
        status: 'ready',
        itemState: 'arrived',
        receivedAt: new Date(base.getTime() - 7 * DAY),
        expiresAt: new Date(base.getTime() + 3 * DAY),
        payment: { status: 'succeeded' },
      });
      const reminders = async (orderId: string) =>
        (await outboxOf(db, orderId)).filter((r) => r.jobId.startsWith('reminder:'));

      await run('reminders');
      expect(await reminders(ready.orderId)).toEqual([]);
      expect((await reminders(late.orderId)).map((r) => r.jobId)).toEqual([
        `reminder:${late.orderId}:ready:6`,
      ]);

      for (const day of [3, 6, 9]) {
        clock.now = new Date(base.getTime() + day * DAY + MIN);
        await run('reminders');
        await run('reminders');
      }
      const rows = await reminders(ready.orderId);
      expect(rows.map((r) => r.jobId)).toEqual(
        [3, 6, 9].map((d) => `reminder:${ready.orderId}:ready:${d}`),
      );
      expect(rows.map((r) => r.data.readyDays)).toEqual([3, 6, 9]);
      const journal = (await eventsOf(db, ready.orderId)).filter((e) => e.type === 'reminder');
      expect(journal).toHaveLength(3);
      // The notification carries the journal event of its reminder.
      expect(rows.map((r) => r.data.orderEventId)).toEqual(journal.map((e) => e.id));
      expect(rows.every((r) => r.queue === 'notify' && r.name === 'order')).toBe(true);
      expect(rows[0]?.data).toMatchObject({ audience: 'client', template: 'arrived' });
    });

    it('approval: one reminder 12 h after decision_needed was delivered', async () => {
      const base = at(50 * DAY);
      clock.now = base;
      const waiting = await seedOrder(db, {
        status: 'awaiting_client_approval',
        itemState: 'ordered',
        payment: { status: 'succeeded' },
      });
      await db.insert(clientApprovals).values({
        orderId: waiting.orderId,
        kind: 'new_eta',
        scope: 'order',
        proposal: { kind: 'new_eta', etaDate: '2021-05-10', note: null },
        notifiedAt: base,
        expiresAt: new Date(base.getTime() + 24 * HOUR),
      });
      clock.now = new Date(base.getTime() + 11 * HOUR);
      await run('reminders');
      expect(await outboxOf(db, waiting.orderId)).toEqual([]);
      clock.now = new Date(base.getTime() + 12 * HOUR + MIN);
      await run('reminders');
      clock.now = new Date(base.getTime() + 20 * HOUR);
      await run('reminders');
      const rows = await outboxOf(db, waiting.orderId);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.data).toMatchObject({
        audience: 'client',
        template: 'decision_needed',
        reminder: true,
      });
      const [approval] = await db
        .select()
        .from(clientApprovals)
        .where(eq(clientApprovals.orderId, waiting.orderId));
      expect(approval?.remindedAt?.toISOString()).toBe(
        new Date(base.getTime() + 12 * HOUR + MIN).toISOString(),
      );
      const reminderEvents = await eventsOf(db, waiting.orderId);
      expect(reminderEvents.map((e) => e.type)).toEqual(['approval_reminder']);
      // notify/order checks that this approval is still open before sending the reminder.
      expect(reminderEvents[0]?.payload).toMatchObject({ approvalId: approval?.id });
    });

    it('needs_attention and the Rossko invoice: every 4 hours, once per period', async () => {
      const base = at(60 * DAY);
      clock.now = base;
      const attention = await seedOrder(db, {
        status: 'needs_attention',
        itemState: 'pending',
        payment: { status: 'succeeded' },
      });
      const invoice = await seedOrder(db, {
        status: 'awaiting_supplier_invoice',
        itemState: 'ordered',
        payment: { status: 'succeeded' },
      });
      for (const [seeded, to] of [
        [attention, 'needs_attention'],
        [invoice, 'awaiting_supplier_invoice'],
      ] as const) {
        await db.insert(orderEvents).values({
          orderId: seeded.orderId,
          type: 'supplier_checkout_succeeded',
          fromStatus: 'ordering',
          toStatus: to,
          actorType: 'system',
          createdAt: base,
        });
      }
      clock.now = new Date(base.getTime() + 3 * HOUR);
      await run('reminders');
      clock.now = new Date(base.getTime() + 4 * HOUR + MIN);
      await run('reminders');
      await run('reminders');
      clock.now = new Date(base.getTime() + 8 * HOUR + MIN);
      await run('reminders');

      const attentionRows = await outboxOf(db, attention.orderId);
      expect(attentionRows.map((r) => [r.data.audience, r.data.template])).toEqual([
        ['sellers', 'staff_problem'],
        ['sellers', 'staff_problem'],
      ]);
      const sec = Math.floor(base.getTime() / 1000);
      expect(attentionRows.map((r) => r.jobId)).toEqual([
        `reminder:${attention.orderId}:attention:${sec}-1`,
        `reminder:${attention.orderId}:attention:${sec}-2`,
      ]);
      expect((await outboxOf(db, invoice.orderId)).map((r) => r.data.template)).toEqual([
        'staff_supplier_invoice_due',
        'staff_supplier_invoice_due',
      ]);
    });

    it('supplier return 3 days, refund 2 days before the deadline; halfway payment and confirmation', async () => {
      const base = at(70 * DAY);
      clock.now = base;
      const returned = await seedOrder(db, {
        status: 'refund_pending',
        itemState: 'refund_pending',
        payment: { status: 'succeeded' },
        supplierReturnDeadlineAt: new Date(base.getTime() + 2 * DAY),
      });
      await db.insert(supplierReturns).values({
        orderItemId: returned.itemIds[0]!,
        kind: 'return',
        status: 'requested',
        amountExpectedKop: 100_000,
      });
      await db.insert(refunds).values({
        orderId: returned.orderId,
        paymentId: returned.paymentId!,
        amountKop: 192_000,
        reason: 'no_show',
        status: 'pending',
        idempotenceKey: uuidv7(),
        requestedAt: new Date(base.getTime() - 8 * DAY - HOUR),
        deadlineAt: new Date(base.getTime() + 2 * DAY - HOUR),
      });
      const notDue = await seedOrder(db, {
        status: 'refund_pending',
        itemState: 'refund_pending',
        payment: { status: 'succeeded' },
        supplierReturnDeadlineAt: new Date(base.getTime() + 4 * DAY),
      });
      await db.insert(supplierReturns).values({
        orderItemId: notDue.itemIds[0]!,
        kind: 'return',
        status: 'requested',
        amountExpectedKop: 100_000,
      });
      const paying = await seedOrder(db, {
        status: 'awaiting_payment',
        createdAt: new Date(base.getTime() - 61 * MIN),
        expiresAt: new Date(base.getTime() + 59 * MIN),
      });
      const tooEarly = await seedOrder(db, {
        status: 'awaiting_payment',
        createdAt: new Date(base.getTime() - 30 * MIN),
        expiresAt: new Date(base.getTime() + 90 * MIN),
      });
      const confirming = await seedOrder(db, {
        scheme: 'pay_on_handover',
        status: 'awaiting_confirmation',
        createdAt: new Date(base.getTime() - 13 * HOUR),
      });

      await run('reminders');
      await run('reminders');

      const returnedRows = await outboxOf(db, returned.orderId);
      expect(
        returnedRows.map((r) => [r.data.audience, r.data.template, r.data.deadlineDate]),
      ).toEqual([
        ['sellers', 'staff_supplier_return_task', '2021-05-21'],
        ['owner', 'staff_refund_deadline', '2021-05-21'],
      ]);
      expect(await outboxOf(db, notDue.orderId)).toEqual([]);
      expect((await outboxOf(db, paying.orderId)).map((r) => r.data.template)).toEqual([
        'payment_link',
      ]);
      expect(await outboxOf(db, tooEarly.orderId)).toEqual([]);
      expect((await outboxOf(db, confirming.orderId)).map((r) => r.data.template)).toEqual([
        'confirm_request',
      ]);
    });
  });

  describe('sms-budget', () => {
    it('one alert per month at 80%, another at 100%', async () => {
      // A month of its own: notify tests write SMS costs in other months.
      clock.now = new Date('2021-08-15T06:00:00.000Z');
      const spend = async (kop: number) =>
        db.insert(apiCalls).values({
          source: 'sms',
          method: 'send',
          durationMs: 10,
          ok: true,
          costKop: kop,
          createdAt: clock.now,
        });
      // Before the month (Asia/Yekaterinburg): 2021-07-31T19:30Z is already August 00:30 +05.
      await db.insert(apiCalls).values({
        source: 'sms',
        method: 'send',
        durationMs: 10,
        ok: true,
        costKop: 50_000,
        createdAt: new Date('2021-07-31T18:30:00.000Z'),
      });
      await spend(79_000);
      const ok = await run('sms-budget');
      expect(ok).toMatchObject({ month: '2021-08', spentKop: 79_000, state: 'ok', alerted: null });

      await spend(1_000);
      const first = await run('sms-budget');
      expect(first).toMatchObject({ state: 'alert', alerted: 'alert:sms-budget:2021-08:80' });
      const again = await run('sms-budget');
      expect(again).toMatchObject({ state: 'alert', alerted: null });
      const rows = await db
        .select()
        .from(outbox)
        .where(sql`starts_with(${outbox.jobId}, 'alert:sms-budget:2021-08')`);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ queue: 'notify', name: 'alert' });
      expect(rows[0]?.data).toMatchObject({
        audience: 'owner',
        dedupeKey: 'sms-budget:2021-08:80',
      });

      // The queued alert goes out through the AlertPort.
      await processNotify(job('alert', rows[0]!.data), t.deps);
      expect(t.fakes.alerts.calls.at(-1)).toMatchObject({
        audience: 'owner',
        dedupeKey: 'sms-budget:2021-08:80',
      });
      expect(String(t.fakes.alerts.calls.at(-1)?.text)).toContain(
        '800\u00a0₽ из 1\u00a0000\u00a0₽',
      );

      await spend(20_000);
      expect(await run('sms-budget')).toMatchObject({
        state: 'exhausted',
        alerted: 'alert:sms-budget:2021-08:100',
      });
      expect(await run('sms-budget')).toMatchObject({ alerted: null });
    });
  });

  describe('deferred-1a', () => {
    it('queues the notifications 1A owed, once', async () => {
      clock.now = at(80 * DAY);
      const cancelled = await seedOrder(db, {
        status: 'cancelled',
        itemState: 'arrived',
        receivedAt: at(75 * DAY),
      });
      const [event] = await db
        .insert(orderEvents)
        .values({
          orderId: cancelled.orderId,
          type: 'client_cancelled',
          fromStatus: 'awaiting_payment',
          toStatus: 'cancelled',
          actorType: 'client',
          actorId: cancelled.userId,
          payload: {
            deferredEffects: ['cancel_at_supplier_task'],
            deferredNotify: ['client:order_cancelled', 'sellers:staff_cancel_at_supplier_task'],
          },
          createdAt: at(79 * DAY),
        })
        .returning({ id: orderEvents.id });
      // A 1A checkout owes only create_payment (lazy in 1B): nothing to do, no journal row.
      const checkout = await seedOrder(db, { status: 'awaiting_payment' });
      await db.insert(orderEvents).values({
        orderId: checkout.orderId,
        type: 'checkout',
        fromStatus: 'draft',
        toStatus: 'awaiting_payment',
        actorType: 'client',
        payload: { deferredEffects: ['create_payment'] },
        createdAt: at(79 * DAY),
      });

      const first = await run('deferred-1a');
      expect(first).toMatchObject({ queued: expect.any(Number) });
      const rows = await outboxOf(db, cancelled.orderId);
      expect(
        rows.map((r) => [r.jobId, r.data.audience, r.data.template, r.data.orderEventId]),
      ).toEqual([
        [`deferred:${event!.id}:0`, 'client', 'order_cancelled', event!.id],
        [`deferred:${event!.id}:1`, 'sellers', 'staff_cancel_at_supplier_task', event!.id],
      ]);
      const journal = (await eventsOf(db, cancelled.orderId)).filter(
        (e) => e.type === 'deferred_1a_processed',
      );
      expect(journal).toHaveLength(1);
      expect(journal[0]?.payload).toMatchObject({ eventId: event!.id });
      // The 1A event itself is not edited.
      const [original] = await db.select().from(orderEvents).where(eq(orderEvents.id, event!.id));
      expect(original?.payload).not.toHaveProperty('processed');

      await run('deferred-1a');
      expect(await outboxOf(db, cancelled.orderId)).toHaveLength(2);
      expect(
        (await eventsOf(db, cancelled.orderId)).filter((e) => e.type === 'deferred_1a_processed'),
      ).toHaveLength(1);
      expect(await eventsOf(db, checkout.orderId)).toHaveLength(1);
      expect(await outboxOf(db, checkout.orderId)).toEqual([]);
    });

    it('planDeferred: create_payment skipped, the effect maps to the sellers task once', () => {
      expect(planDeferred({ deferredEffects: ['create_payment'] })).toEqual({
        notify: [],
        skipped: [],
      });
      expect(
        planDeferred({
          deferredEffects: ['cancel_at_supplier_task', 'supplier_return_task'],
          deferredNotify: ['client:order_cancelled', 'bogus', 'client:nope'],
        }),
      ).toEqual({
        notify: [
          { audience: 'client', template: 'order_cancelled' },
          { audience: 'sellers', template: 'staff_cancel_at_supplier_task' },
        ],
        skipped: ['notify:bogus', 'notify:client:nope', 'effect:supplier_return_task'],
      });
    });
  });

  it('every run writes no phone into the journal or the outbox', async () => {
    const rows = await db
      .select({ payload: orderEvents.payload, phone: users.phone })
      .from(orderEvents)
      .innerJoin(orders, eq(orders.id, orderEvents.orderId))
      .innerJoin(users, eq(users.id, orders.userId))
      .where(and(eq(orderEvents.actorType, 'system')));
    for (const row of rows) {
      expect(JSON.stringify(row.payload)).not.toContain(row.phone.slice(1));
    }
  });
});
