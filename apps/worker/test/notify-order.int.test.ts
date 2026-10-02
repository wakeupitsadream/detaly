// notify/order on the `_worker` database with an injected clock (docs/phase-1b-implementation.md
// section 12.1, decisions Б16, Б20, Б21): the notifications row before sending, dedupe, SMS
// limits and budget, api_calls accounting, decision_needed starting (or not) the approval timer.
// The SMS driver is the real @detaly/notify driver on a fake fetch (no network).
//
// The file runs on a database of its own (`${DATABASE_URL_TEST}_worker_ops_notify`): it runs the
// housekeeping timers, which scan every order, and sums SMS spending per month, so sharing
// `_worker` with other files would let them act on each other's rows. The clock starts in 2022.
import { randomBytes, randomInt, randomUUID } from 'node:crypto';
import {
  apiCalls,
  asc,
  clientApprovals,
  eq,
  notifications,
  orderEvents,
  orderItems,
  orders,
  outbox,
  payments,
  sql,
  users,
  createDb,
  type Db,
} from '@detaly/db';
import { prepareTestDb } from '@detaly/db/testing';
import {
  addDays,
  localDate,
  type OrderItemState,
  type OrderStatus,
  type PaymentScheme,
} from '@detaly/domain';
import { createSmsDriver } from '@detaly/notify';
import { applyTransition } from '@detaly/orders';
import { UnrecoverableError, type Job } from 'bullmq';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { processHousekeeping } from '../src/jobs/housekeeping';
import { processNotify } from '../src/jobs/notify';
import { createTestDeps, type TestDeps } from './helpers/test-deps';

const HOUR = 3_600_000;
const MIN = 60_000;
const T0 = new Date('2022-05-10T06:00:00.000Z');

const ENV = {
  YOOKASSA_SHOP_ID: 'test-shop',
  YOOKASSA_SECRET_KEY: 'test-secret',
  YOOKASSA_VAT_CODE: '1',
  YOOKASSA_TAX_SYSTEM_CODE: '2',
  APP_BASE_URL: 'https://detaly.test',
  SMS_PROVIDER: 'smsaero',
  PICKUP_ADDRESS: 'ул. Тестовая, 1',
  PICKUP_HOURS: '9:00–19:00',
};

const clock = { now: new Date(T0) };

/** The SMS Aero gateway on a fake fetch: records requests, answers with `status`. */
function fakeGateway() {
  const gateway = {
    status: 200,
    calls: [] as URL[],
    fetch: (async (input: string | URL | Request) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      gateway.calls.push(url);
      return new Response(
        JSON.stringify({ success: true, data: { id: gateway.calls.length, cost: '3.69' } }),
        { status: gateway.status, headers: { 'content-type': 'application/json' } },
      );
    }) as typeof fetch,
  };
  return gateway;
}

function smsDriver(gateway: ReturnType<typeof fakeGateway>) {
  return createSmsDriver({
    provider: 'smsaero',
    login: 'shop@example.test',
    apiKey: 'test-key',
    sender: 'Shop',
    apiUrl: 'https://sms.test/v2',
    fetch: gateway.fetch,
  });
}

function job(data: Record<string, unknown>, attemptsMade = 0): Job {
  return { name: 'order', data, attemptsMade, opts: { attempts: 5 } } as unknown as Job;
}

function randomPhone(): string {
  return `+79${String(randomInt(0, 1_000_000_000)).padStart(9, '0')}`;
}

async function seedOrder(
  db: Db,
  input: {
    status: OrderStatus;
    scheme?: PaymentScheme;
    itemState?: OrderItemState;
    paid?: boolean;
    phone?: string;
    anonymized?: boolean;
  },
) {
  const phone = input.phone ?? randomPhone();
  const [user] = await db
    .insert(users)
    .values(
      input.anonymized ? { phone: `anon:${randomUUID()}`, anonymizedAt: clock.now } : { phone },
    )
    .returning({ id: users.id });
  const [order] = await db
    .insert(orders)
    .values({
      userId: user!.id,
      accessToken: randomBytes(32).toString('base64url'),
      status: input.status,
      paymentScheme: input.scheme ?? 'prepay',
      subtotalKop: 128_000,
      totalKop: 128_000,
      itemsHash: 'test',
      pickupCode: '4821',
      createdAt: new Date(clock.now.getTime() - 24 * HOUR),
    })
    .returning({ id: orders.id, number: orders.number, accessToken: orders.accessToken });
  const itemId = randomUUID();
  await db.insert(orderItems).values({
    id: itemId,
    orderId: order!.id,
    offerKey: 'W9142:MANN:ORB1',
    searchArticleNorm: 'W9142',
    brand: 'MANN',
    article: 'W 914/2',
    name: 'Фильтр масляный',
    qty: 1,
    stockId: 'ORB1',
    isLocal: true,
    priceSupplierAtOrderKop: 100_000,
    priceClientKop: 128_000,
    markupBp: 2800,
    etaDate: '2022-05-12',
    offerSnapshot: {
      source: 'rossko',
      brand: 'MANN',
      article: 'W 914/2',
      articleNorm: 'W9142',
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
    },
    state: input.itemState ?? 'ordered',
  });
  if (input.paid) {
    await db.insert(payments).values({
      orderId: order!.id,
      kind: 'prepayment',
      status: 'succeeded',
      amountKop: 128_000,
      idempotenceKey: randomUUID(),
      providerPaymentId: `pay-${randomUUID()}`,
      confirmationType: 'redirect',
      request: {},
      paidAt: clock.now,
    });
  }
  return { orderId: order!.id, number: order!.number, token: order!.accessToken, itemId, phone };
}

/** A journal event to hang a notification on (reminders and alerts do the same). */
async function journalEvent(db: Db, orderId: string): Promise<string> {
  const [row] = await db
    .insert(orderEvents)
    .values({ orderId, type: 'reminder', actorType: 'system', payload: {}, createdAt: clock.now })
    .returning({ id: orderEvents.id });
  return row!.id;
}

async function rowsOfEvent(db: Db, eventId: string) {
  return db
    .select()
    .from(notifications)
    .where(sql`starts_with(${notifications.dedupeKey}, ${`${eventId}:`})`)
    .orderBy(asc(notifications.createdAt));
}

async function outboxOf(db: Db, orderId: string) {
  return db
    .select()
    .from(outbox)
    .where(sql`${outbox.data}->>'orderId' = ${orderId}`)
    .orderBy(asc(outbox.createdAt), asc(outbox.jobId));
}

/** «Новый срок» by a seller through the engine; returns the decision_needed outbox data. */
async function proposeNewEta(t: TestDeps, orderId: string) {
  const result = await applyTransition(t.deps.engine, {
    orderId,
    event: 'new_eta_proposed',
    actor: { type: 'staff', id: null, staffRole: 'seller' },
    facts: {
      proposal: { kind: 'new_eta', etaDate: addDays(localDate(clock.now), 10), note: null },
    },
  });
  return result;
}

describe.skipIf(!inject('workerDatabaseUrl'))('notify/order (worker-ops)', () => {
  const gateway = fakeGateway();
  let t: TestDeps;
  let db: Db;

  beforeAll(async () => {
    const { url } = await prepareTestDb({ url: `${inject('workerDatabaseUrl')}_ops_notify` });
    db = createDb(url, { max: 4 });
    t = await createTestDeps({
      db,
      now: () => clock.now,
      envOverrides: ENV,
      smsDriver: smsDriver(gateway),
    });
  });
  afterAll(async () => {
    await t?.close();
    await db?.close();
  });

  it('decision_needed by SMS: row before sending, timer from the send, one SMS for a repeated job', async () => {
    clock.now = T0;
    const order = await seedOrder(db, { status: 'needs_attention', paid: true });
    const proposed = await proposeNewEta(t, order.orderId);
    expect(proposed).toMatchObject({ ok: true, to: 'awaiting_client_approval' });
    const [row] = (await outboxOf(db, order.orderId)).filter((r) => r.queue === 'notify');
    expect(row?.data).toMatchObject({ audience: 'client', template: 'decision_needed' });
    const before = gateway.calls.length;

    const result = await processNotify(job(row!.data), t.deps);
    expect(result).toEqual({ status: 'sent', channel: 'sms' });
    expect(gateway.calls.length).toBe(before + 1);
    const sms = gateway.calls.at(-1)!;
    expect(sms.searchParams.get('number')).toBe(order.phone.slice(1));
    const text = sms.searchParams.get('text') ?? '';
    expect(text).toContain(order.number);
    expect(text).toContain(`https://detaly.test/o/${order.token}`);
    expect(text).not.toContain(order.phone.slice(2));

    const eventId = String(row!.data.orderEventId);
    const [sent] = await rowsOfEvent(db, eventId);
    expect(sent).toMatchObject({
      dedupeKey: `${eventId}:decision_needed:sms`,
      status: 'sent',
      channel: 'sms',
      attempts: 1,
      fallbackReason: 'no_messenger',
      error: null,
    });
    expect(sent?.sentAt?.toISOString()).toBe(T0.toISOString());
    expect(JSON.stringify(sent)).not.toContain(order.phone.slice(2));

    const [approval] = await db
      .select()
      .from(clientApprovals)
      .where(eq(clientApprovals.orderId, order.orderId));
    expect(approval?.notifiedAt?.toISOString()).toBe(T0.toISOString());
    expect(approval?.expiresAt?.toISOString()).toBe(
      new Date(T0.getTime() + 24 * HOUR).toISOString(),
    );
    const journal = await db
      .select()
      .from(orderEvents)
      .where(eq(orderEvents.orderId, order.orderId))
      .orderBy(asc(orderEvents.createdAt));
    expect(journal.map((e) => e.type)).toContain('approval_notified');

    const calls = await db
      .select()
      .from(apiCalls)
      .where(
        sql`${apiCalls.source} = 'sms' and ${apiCalls.createdAt} = ${T0.toISOString()}::timestamptz`,
      );
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ ok: true, costKop: 500, method: 'send', error: null });

    // The same job again (retry, duplicate outbox dispatch): no second SMS.
    expect(await processNotify(job(row!.data, 1), t.deps)).toEqual({
      status: 'duplicate',
      existing: 'sent',
    });
    expect(gateway.calls.length).toBe(before + 1);
    expect(await rowsOfEvent(db, eventId)).toHaveLength(1);

    // Verification 7, silence: the timer started at the send runs out 24 h later.
    clock.now = new Date(T0.getTime() + 24 * HOUR + MIN);
    await processHousekeeping({ name: 'timers' }, t.deps);
    const [after] = await db.select().from(orders).where(eq(orders.id, order.orderId));
    expect(after?.status).toBe('refund_pending');
  });

  it('decision_needed skipped: no timer, approval_unreachable and a task for the sellers', async () => {
    clock.now = new Date(T0.getTime() + 2 * 24 * HOUR);
    // The engine sees SMS configured, but the worker has no SMS driver (e.g. gateway removed).
    const noSms = await createTestDeps({ db, now: () => clock.now, envOverrides: ENV });
    try {
      const order = await seedOrder(noSms.deps.db, { status: 'needs_attention', paid: true });
      expect(await proposeNewEta(noSms, order.orderId)).toMatchObject({ ok: true });
      const [row] = (await outboxOf(db, order.orderId)).filter((r) => r.queue === 'notify');

      const result = await processNotify(job(row!.data), noSms.deps);
      expect(result).toEqual({ status: 'skipped', fallbackReason: 'no_messenger:sms_unavailable' });
      const eventId = String(row!.data.orderEventId);
      const [skipped] = await rowsOfEvent(db, eventId);
      expect(skipped).toMatchObject({
        dedupeKey: `${eventId}:decision_needed:none`,
        status: 'skipped',
        channel: null,
        fallbackReason: 'no_messenger:sms_unavailable',
        attempts: 1,
      });

      const [approval] = await db
        .select()
        .from(clientApprovals)
        .where(eq(clientApprovals.orderId, order.orderId));
      expect(approval).toMatchObject({ notifiedAt: null, expiresAt: null, decidedAt: null });
      const journal = await db
        .select()
        .from(orderEvents)
        .where(eq(orderEvents.orderId, order.orderId));
      const unreachable = journal.find((e) => e.type === 'approval_unreachable');
      expect(unreachable?.payload).toMatchObject({
        approvalId: approval?.id,
        reason: 'no_messenger:sms_unavailable',
      });
      const staff = (await outboxOf(db, order.orderId)).filter(
        (r) => r.data.template === 'staff_approval_unreachable',
      );
      expect(staff.map((r) => [r.jobId, r.data.audience])).toEqual([
        [`notify:${unreachable?.id}:staff_approval_unreachable`, 'sellers'],
      ]);

      // The sellers' card goes through the seller card port, once.
      const card = await processNotify(job(staff[0]!.data), noSms.deps);
      expect(card).toEqual({ status: 'sent', channel: 'telegram' });
      expect(await processNotify(job(staff[0]!.data), noSms.deps)).toMatchObject({
        status: 'duplicate',
      });
      expect(noSms.fakes.sellerCards.calls).toEqual([
        {
          method: 'post',
          input: {
            orderId: order.orderId,
            template: 'staff_approval_unreachable',
            orderEventId: unreachable?.id,
            note: null,
          },
        },
      ]);

      // No timer: two days later the order still waits for the sellers' call.
      clock.now = new Date(clock.now.getTime() + 48 * HOUR);
      await processHousekeeping({ name: 'timers' }, noSms.deps);
      const [after] = await db.select().from(orders).where(eq(orders.id, order.orderId));
      expect(after?.status).toBe('awaiting_client_approval');
    } finally {
      await noSms.close();
    }
  });

  it('Verification 7: without any channel «Новый срок» is refused; the order stays in needs_attention', async () => {
    clock.now = new Date(T0.getTime() + 5 * 24 * HOUR);
    const off = await createTestDeps({
      db,
      now: () => clock.now,
      envOverrides: { ...ENV, SMS_PROVIDER: 'none' },
    });
    try {
      const order = await seedOrder(off.deps.db, { status: 'needs_attention', paid: true });
      expect(await proposeNewEta(off, order.orderId)).toMatchObject({
        ok: false,
        reason: 'guard_failed',
        status: 'needs_attention',
      });
      expect(
        await db.select().from(clientApprovals).where(eq(clientApprovals.orderId, order.orderId)),
      ).toEqual([]);
      expect(await outboxOf(db, order.orderId)).toEqual([]);
    } finally {
      await off.close();
    }
  });

  it('SMS limit: one SMS per number in 10 minutes, the next one is skipped', async () => {
    clock.now = new Date(T0.getTime() + 10 * 24 * HOUR);
    const order = await seedOrder(db, {
      status: 'ready',
      scheme: 'pay_on_handover',
      itemState: 'arrived',
    });
    const first = await journalEvent(db, order.orderId);
    const data = (eventId: string) => ({
      orderId: order.orderId,
      orderEventId: eventId,
      audience: 'client',
      template: 'arrived',
      readyDays: 3,
    });
    const before = gateway.calls.length;
    expect(await processNotify(job(data(first)), t.deps)).toEqual({
      status: 'sent',
      channel: 'sms',
    });
    const text = gateway.calls.at(-1)?.searchParams.get('text') ?? '';
    expect(text).toContain(`Заказ ${order.number} ждёт вас 3 дн.`);
    expect(text).toContain('4821');

    clock.now = new Date(clock.now.getTime() + MIN);
    const second = await journalEvent(db, order.orderId);
    expect(await processNotify(job(data(second)), t.deps)).toEqual({
      status: 'skipped',
      fallbackReason: 'sms_rate_limited',
    });
    expect(gateway.calls.length).toBe(before + 1);
    const [limited] = await rowsOfEvent(db, second);
    expect(limited).toMatchObject({
      status: 'skipped',
      fallbackReason: 'sms_rate_limited',
      dedupeKey: `${second}:arrived:sms`,
    });

    clock.now = new Date(clock.now.getTime() + 11 * MIN);
    const third = await journalEvent(db, order.orderId);
    expect(await processNotify(job(data(third)), t.deps)).toMatchObject({ status: 'sent' });
    expect(gateway.calls.length).toBe(before + 2);
  });

  it('two copies of one job at the same time: one SMS', async () => {
    clock.now = new Date(T0.getTime() + 12 * 24 * HOUR);
    const order = await seedOrder(db, {
      status: 'ready',
      scheme: 'pay_on_handover',
      itemState: 'arrived',
    });
    const eventId = await journalEvent(db, order.orderId);
    const data = { orderEventId: eventId, audience: 'client', template: 'arrived' };
    const before = gateway.calls.length;
    const results = await Promise.all([
      processNotify(job(data), t.deps),
      processNotify(job(data), t.deps),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual(['duplicate', 'sent']);
    expect(gateway.calls.length).toBe(before + 1);
    expect(await rowsOfEvent(db, eventId)).toHaveLength(1);
  });

  it('SMS budget spent for the month: skipped without calling the gateway', async () => {
    clock.now = new Date('2022-09-15T06:00:00.000Z');
    const spent = await createTestDeps({
      db,
      now: () => clock.now,
      envOverrides: { ...ENV, SMS_MONTHLY_BUDGET_RUB: '10' },
      smsDriver: smsDriver(gateway),
    });
    try {
      await spent.deps.db.insert(apiCalls).values({
        source: 'sms',
        method: 'send',
        durationMs: 5,
        ok: true,
        costKop: 1_000,
        createdAt: clock.now,
      });
      const order = await seedOrder(db, {
        status: 'ready',
        scheme: 'pay_on_handover',
        itemState: 'arrived',
      });
      const eventId = await journalEvent(db, order.orderId);
      const before = gateway.calls.length;
      const result = await processNotify(
        job({ orderEventId: eventId, audience: 'client', template: 'arrived' }),
        spent.deps,
      );
      expect(result).toEqual({ status: 'skipped', fallbackReason: 'sms_budget_exhausted' });
      expect(gateway.calls.length).toBe(before);
    } finally {
      await spent.close();
    }
  });

  it('gateway failures: retried while attempts remain, then failed without PD; no timer', async () => {
    clock.now = new Date(T0.getTime() + 20 * 24 * HOUR);
    const order = await seedOrder(db, { status: 'needs_attention', paid: true });
    expect(await proposeNewEta(t, order.orderId)).toMatchObject({ ok: true });
    const [row] = (await outboxOf(db, order.orderId)).filter((r) => r.queue === 'notify');
    const eventId = String(row!.data.orderEventId);
    gateway.status = 503;
    try {
      const retry = await processNotify(job(row!.data, 0), t.deps).catch((e: unknown) => e);
      expect(retry).toBeInstanceOf(Error);
      expect(retry).not.toBeInstanceOf(UnrecoverableError);
      let [state] = await rowsOfEvent(db, eventId);
      expect(state).toMatchObject({ status: 'queued', attempts: 1 });
      expect(state?.error).toBe('smsaero: sms gateway unavailable (http 503)');

      // The last attempt: failed; the approval timer does not start.
      const final = await processNotify(job(row!.data, 4), t.deps).catch((e: unknown) => e);
      expect(final).toBeInstanceOf(Error);
      [state] = await rowsOfEvent(db, eventId);
      expect(state).toMatchObject({ status: 'failed', attempts: 2 });
      expect(JSON.stringify(state)).not.toContain(order.phone.slice(2));
      const [approval] = await db
        .select()
        .from(clientApprovals)
        .where(eq(clientApprovals.orderId, order.orderId));
      expect(approval?.expiresAt).toBeNull();
      const types = (
        await db.select().from(orderEvents).where(eq(orderEvents.orderId, order.orderId))
      ).map((e) => e.type);
      expect(types).toContain('approval_unreachable');
      const failedCalls = await db
        .select()
        .from(apiCalls)
        .where(
          sql`${apiCalls.source} = 'sms' and ${apiCalls.createdAt} = ${clock.now.toISOString()}::timestamptz`,
        );
      expect(failedCalls.map((c) => [c.ok, c.costKop, c.error])).toEqual([
        [false, 0, 'smsaero:http 503'],
        [false, 0, 'smsaero:http 503'],
      ]);

      // A 4xx is final at once: UnrecoverableError, no retries.
      gateway.status = 400;
      clock.now = new Date(clock.now.getTime() + HOUR);
      const other = await seedOrder(db, {
        status: 'ready',
        scheme: 'pay_on_handover',
        itemState: 'arrived',
      });
      const otherEvent = await journalEvent(db, other.orderId);
      const rejected = await processNotify(
        job({ orderEventId: otherEvent, audience: 'client', template: 'arrived' }),
        t.deps,
      ).catch((e: unknown) => e);
      expect(rejected).toBeInstanceOf(UnrecoverableError);
      const [rejectedRow] = await rowsOfEvent(db, otherEvent);
      expect(rejectedRow).toMatchObject({ status: 'failed', attempts: 1 });
    } finally {
      gateway.status = 200;
    }
  });

  it('client without a channel for the template: skipped with the reason', async () => {
    clock.now = new Date(T0.getTime() + 30 * 24 * HOUR);
    const order = await seedOrder(db, { status: 'confirmed', paid: true });
    const paidEvent = await journalEvent(db, order.orderId);
    // `paid` is not in the SMS allowlist (PLAN section 4).
    expect(
      await processNotify(
        job({ orderEventId: paidEvent, audience: 'client', template: 'paid' }),
        t.deps,
      ),
    ).toEqual({ status: 'skipped', fallbackReason: 'no_messenger:not_in_sms_allowlist' });

    const anonymous = await seedOrder(db, {
      status: 'ready',
      scheme: 'pay_on_handover',
      itemState: 'arrived',
      anonymized: true,
    });
    const arrivedEvent = await journalEvent(db, anonymous.orderId);
    expect(
      await processNotify(
        job({ orderEventId: arrivedEvent, audience: 'client', template: 'arrived' }),
        t.deps,
      ),
    ).toEqual({ status: 'skipped', fallbackReason: 'no_messenger:no_phone' });
  });

  it('decision_needed after the client already decided: skipped, no SMS, no timer, no task', async () => {
    clock.now = new Date(T0.getTime() + 35 * 24 * HOUR);
    const order = await seedOrder(db, { status: 'needs_attention', paid: true });
    expect(await proposeNewEta(t, order.orderId)).toMatchObject({ ok: true });
    const [row] = (await outboxOf(db, order.orderId)).filter((r) => r.queue === 'notify');
    const eventId = String(row!.data.orderEventId);
    // The client answered on /o/<token> before the (retried) job got to send.
    clock.now = new Date(clock.now.getTime() + 5 * MIN);
    expect(
      await applyTransition(t.deps.engine, {
        orderId: order.orderId,
        event: 'client_approved',
        actor: { type: 'client', id: null },
      }),
    ).toMatchObject({ ok: true });
    const before = gateway.calls.length;

    expect(await processNotify(job(row!.data, 1), t.deps)).toEqual({
      status: 'skipped',
      fallbackReason: 'approval_closed',
    });
    // A late 12-hour reminder of the same (closed) approval is dropped the same way.
    const reminder = await journalEvent(db, order.orderId);
    expect(
      await processNotify(
        job({
          orderEventId: reminder,
          audience: 'client',
          template: 'decision_needed',
          reminder: true,
        }),
        t.deps,
      ),
    ).toEqual({ status: 'skipped', fallbackReason: 'approval_closed' });
    expect(gateway.calls.length).toBe(before);
    expect(await rowsOfEvent(db, eventId)).toMatchObject([
      { status: 'skipped', fallbackReason: 'approval_closed', channel: 'sms' },
    ]);
    const [approval] = await db
      .select()
      .from(clientApprovals)
      .where(eq(clientApprovals.orderId, order.orderId));
    expect(approval).toMatchObject({ decision: 'approved', notifiedAt: null, expiresAt: null });
    const types = (
      await db.select().from(orderEvents).where(eq(orderEvents.orderId, order.orderId))
    ).map((e) => e.type);
    expect(types).not.toContain('approval_unreachable');
    expect(types).not.toContain('approval_notified');
  });

  it('owner: the AlertPort with the admin link, never the client phone in clear', async () => {
    clock.now = new Date(T0.getTime() + 31 * 24 * HOUR);
    const order = await seedOrder(db, { status: 'needs_attention', paid: true });
    const eventId = await journalEvent(db, order.orderId);
    const result = await processNotify(
      job({ orderEventId: eventId, audience: 'owner', template: 'staff_approval_unreachable' }),
      t.deps,
    );
    expect(result).toEqual({ status: 'sent', channel: 'telegram' });
    const alert = t.fakes.alerts.calls.at(-1);
    expect(alert).toMatchObject({
      audience: 'owner',
      dedupeKey: `${eventId}:staff_approval_unreachable`,
    });
    expect(alert?.text).toContain(order.number);
    expect(alert?.text).toContain(`https://detaly.test/admin/orders/${order.orderId}`);
    expect(alert?.text).toContain(`•••${order.phone.slice(-4)}`);
    expect(alert?.text).not.toContain(order.phone.slice(2));
  });

  it('bad data and missing events fail without retries', async () => {
    const missing = await processNotify(
      job({ orderEventId: randomUUID(), audience: 'client', template: 'arrived' }),
      t.deps,
    ).catch((e: unknown) => e);
    expect(missing).toBeInstanceOf(UnrecoverableError);
    const bad = await processNotify(
      job({ orderEventId: randomUUID(), audience: 'nobody', template: 'arrived' }),
      t.deps,
    ).catch((e: unknown) => e);
    expect(bad).toBeInstanceOf(UnrecoverableError);
  });
});
