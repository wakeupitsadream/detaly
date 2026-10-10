// Step 8 (docs/rossko-automation.md) on databases of its own (`${workerDatabaseUrl}_rossko8`,
// `_rossko8poll`, migrated and seeded like `_worker`): the jobs scan every order and every supplier
// order, and the tests change settings, so no other test file's rows may be there. The clock is
// injected; the pickup point works Mon–Fri 10:00–19:00 (Asia/Yekaterinburg, UTC+5; 9 October 2026
// is a Friday).
//
// - the deadline alerts: «Не заказано у поставщика», «Срок поставщика под угрозой», «Срок сорван»,
//   «Не забирают» — once per order and kind, across the weekend, the latest only after a gap,
//   as the order card with its buttons in the sellers chat;
// - the cutoff reminder: nothing without cutoff times or on a day off, one push per cutoff;
// - the shadow auto-order: journaled at «Проверить и заказать» with the decision, the reasons and
//   whether the press ordered, and one line on the seller card;
// - the GetOrders polling: off by default and in fixtures mode; with ROSSKO_MODE=live, the switch
//   and a synthetic map — the shipped push, a refusal → needs_attention once per item, one alert
//   per unmapped code (acted on once it is mapped), change only, batches of 20, errors survive.
import { randomBytes, randomInt } from 'node:crypto';
import {
  and,
  asc,
  createDb,
  eq,
  orderEvents,
  orderItems,
  orders,
  outbox,
  settings,
  sql,
  supplierOrderItems,
  supplierOrders,
  users,
  type Db,
} from '@detaly/db';
import { prepareTestDb } from '@detaly/db/testing';
import {
  cutoffReminderText,
  deadlineAlertKey,
  deadlineAlertNote,
  type Offer,
  type OrderItemState,
  type OrderStatus,
  type PaymentScheme,
} from '@detaly/domain';
import { performStaffAction } from '@detaly/orders';
import {
  createFixtureCaller,
  createRosskoClient,
  createUnlimitedLimiter,
  FIXTURE_LOCAL_STOCK_IDS,
  RosskoCallError,
  type RosskoCaller,
} from '@detaly/rossko';
import type { Job } from 'bullmq';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { createCardService } from '../src/bots/seller/cards';
import { countNotOrdered, processHousekeeping } from '../src/jobs/housekeeping';
import { processNotify } from '../src/jobs/notify';
import { processRossko, type PollOrdersResult } from '../src/jobs/rossko';
import { fakeTelegram, type FakeTelegram } from './fixtures/telegram';
import { createTestDeps, type TestDeps } from './helpers/test-deps';

const BASE_URL = 'https://detaly.test';
const SELLER_CHAT = -100_999_000_000 - randomInt(0, 1_000_000);
const PICKUP_HOURS = 'Пн–Пт 10:00–19:00';
const clock = { now: new Date('2026-10-12T06:01:00.000Z') };

/** Local Yekaterinburg wall time -> Date. */
function local(wall: string): Date {
  return new Date(`${wall}:00+05:00`);
}

function job(name: string, data: Record<string, unknown> = {}): Job {
  return {
    id: `test-${name}`,
    name,
    data,
    attemptsMade: 0,
    opts: { attempts: 1 },
  } as unknown as Job;
}

const fixtureClient = createRosskoClient({
  caller: createFixtureCaller(),
  key1: 'k1',
  key2: 'k2',
  localStockIds: FIXTURE_LOCAL_STOCK_IDS,
  limiter: createUnlimitedLimiter(),
  allowCheckout: false,
});

/** A bundled fixture offer (Knecht OC 90 and TRW GDB1330 at ORB1). */
async function fixtureOffer(article: string, brand: string): Promise<Offer> {
  const { offers } = await fixtureClient.search(article);
  const offer = offers.find(
    (o) => o.brand === brand && o.stock.stockId === 'ORB1' && o.articleNorm === article,
  );
  if (!offer) throw new Error(`no fixture offer ${brand} ${article}`);
  return offer;
}

interface Part {
  article: string;
  brand: string;
}

const PARTS: Part[] = [
  { article: 'OC90', brand: 'Knecht' },
  { article: 'GDB1330', brand: 'TRW' },
];

interface Seeded {
  orderId: string;
  number: string;
  userId: string;
  itemIds: string[];
  supplierOrderId: string | null;
}

/**
 * An order directly in `status`, its items in `itemState`, a journal transition into the status
 * at `enteredAt`, and (with `rosskoOrderIds`) a created supplier order covering every item.
 */
async function seedOrder(
  db: Db,
  input: {
    status: OrderStatus;
    itemState?: OrderItemState;
    scheme?: PaymentScheme;
    parts?: Part[];
    enteredAt?: Date;
    promisedDate?: string | null;
    receivedAt?: Date | null;
    rosskoOrderIds?: string[] | null;
    noShowCount?: number;
  },
): Promise<Seeded> {
  const parts = input.parts ?? PARTS.slice(0, 1);
  const offers = await Promise.all(parts.map((part) => fixtureOffer(part.article, part.brand)));
  const rows = offers.map((offer) => {
    const priceClientKop = Math.ceil((offer.priceSupplierKop * 12_800) / 1_000_000) * 100;
    return {
      offerKey: `${offer.articleNorm}:${offer.brand}:${offer.stock.stockId}`,
      searchArticleNorm: offer.articleNorm,
      brand: offer.brand,
      article: offer.article,
      name: offer.name,
      qty: 1,
      stockId: offer.stock.stockId,
      isLocal: offer.stock.isLocal,
      priceSupplierAtOrderKop: offer.priceSupplierKop,
      priceClientKop,
      markupBp: 2800,
      etaDate: '2026-10-12',
      offerSnapshot: offer,
      state: input.itemState ?? 'pending',
    };
  });
  const total = rows.reduce((sum, row) => sum + row.priceClientKop * row.qty, 0);
  const phone = `+79${String(randomInt(0, 1_000_000_000)).padStart(9, '0')}`;
  const [user] = await db
    .insert(users)
    .values({ phone, noShowCount: input.noShowCount ?? 0 })
    .returning({ id: users.id });
  const enteredAt = input.enteredAt ?? clock.now;
  const [order] = await db
    .insert(orders)
    .values({
      userId: user!.id,
      accessToken: randomBytes(32).toString('base64url'),
      status: input.status,
      paymentScheme: input.scheme ?? 'prepay',
      subtotalKop: total,
      totalKop: total,
      itemsHash: 'test',
      promisedDate: input.promisedDate ?? null,
      receivedAt: input.receivedAt ?? null,
      confirmedAt: enteredAt,
      createdAt: enteredAt,
      updatedAt: enteredAt,
    })
    .returning({ id: orders.id, number: orders.number });
  const inserted = await db
    .insert(orderItems)
    .values(rows.map((row) => ({ ...row, orderId: order!.id })))
    .returning({ id: orderItems.id });
  await db.insert(orderEvents).values({
    orderId: order!.id,
    type: 'payment_succeeded',
    fromStatus: 'awaiting_payment',
    toStatus: input.status,
    actorType: 'system',
    actorId: 'test',
    payload: {},
    createdAt: enteredAt,
  });
  let supplierOrderId: string | null = null;
  if (input.rosskoOrderIds) {
    const [so] = await db
      .insert(supplierOrders)
      .values({
        orderId: order!.id,
        attemptNo: 1,
        status: 'created',
        rosskoOrderIds: input.rosskoOrderIds,
        createdAt: enteredAt,
      })
      .returning({ id: supplierOrders.id });
    supplierOrderId = so!.id;
    await db
      .insert(supplierOrderItems)
      .values(inserted.map((item) => ({ supplierOrderId: so!.id, orderItemId: item.id })));
  }
  return {
    orderId: order!.id,
    number: order!.number,
    userId: user!.id,
    itemIds: inserted.map((item) => item.id),
    supplierOrderId,
  };
}

async function setSetting(db: Db, key: string, value: unknown): Promise<void> {
  await db
    .insert(settings)
    .values({ key, value })
    .onConflictDoUpdate({ target: settings.key, set: { value } });
}

async function outboxRows(db: Db, like: string) {
  return db
    .select()
    .from(outbox)
    .where(sql`${outbox.jobId} like ${like}`)
    .orderBy(asc(outbox.createdAt), asc(outbox.jobId));
}

async function eventsOf(db: Db, orderId: string, type: string) {
  return db
    .select()
    .from(orderEvents)
    .where(and(eq(orderEvents.orderId, orderId), eq(orderEvents.type, type)))
    .orderBy(asc(orderEvents.createdAt), asc(orderEvents.id));
}

/** The text and the buttons of the last message the fake Telegram got. */
function lastCard(tg: FakeTelegram): { text: string; buttons: string[] } {
  const call = [...tg.calls]
    .reverse()
    .find((c) => c.method === 'sendMessage' || c.method === 'editMessageText');
  if (!call) throw new Error('no card was sent');
  const markup = call.payload.reply_markup as
    { inline_keyboard?: { text: string }[][] } | undefined;
  return {
    text: String(call.payload.text),
    buttons: (markup?.inline_keyboard ?? []).flat().map((button) => button.text),
  };
}

/** Runs the notify job of an outbox row as the dispatcher would. */
async function dispatch(t: TestDeps, row: { name: string; data: Record<string, unknown> }) {
  return processNotify(job(row.name, row.data), t.deps);
}

describe.skipIf(!inject('workerDatabaseUrl'))('step 8: deadline alerts and cutoffs', () => {
  let t: TestDeps;
  let db: Db;
  let tg: FakeTelegram;
  const run = (name: string) => processHousekeeping({ name }, t.deps);

  beforeAll(async () => {
    const { url } = await prepareTestDb({ url: `${inject('workerDatabaseUrl')}_rossko8` });
    db = createDb(url, { max: 4 });
    t = await createTestDeps({
      db,
      now: () => clock.now,
      envOverrides: {
        APP_BASE_URL: BASE_URL,
        TG_SELLER_CHAT_ID: String(SELLER_CHAT),
        PICKUP_HOURS,
      },
    });
    tg = fakeTelegram();
    // The real cards over a recording Telegram: the alert is the order card with its buttons.
    t.deps.sellerCards = createCardService(t.deps, tg.api);
  });
  afterAll(async () => {
    await t?.close();
    await db?.close();
  });

  it('«Не заказано у поставщика»: working minutes only, once per order', async () => {
    clock.now = local('2026-10-12T10:30');
    // Confirmed on Friday 18:00: 60 working minutes on Friday, the weekend does not count.
    const friday = await seedOrder(db, {
      status: 'confirmed',
      enteredAt: local('2026-10-09T18:00'),
    });
    // Confirmed this morning, and one Rossko already took (a created supplier order).
    const fresh = await seedOrder(db, {
      status: 'confirmed',
      enteredAt: local('2026-10-12T10:00'),
    });
    const taken = await seedOrder(db, {
      status: 'ordering',
      enteredAt: local('2026-10-09T12:00'),
      rosskoOrderIds: ['70100001'],
    });
    // Stuck in `ordering` since Friday noon: GetCheckout never finished.
    const stuck = await seedOrder(db, { status: 'ordering', enteredAt: local('2026-10-09T12:00') });

    await run('rossko-deadlines');
    expect(await outboxRows(db, `reminder:${friday.orderId}:%`)).toEqual([]);
    expect(await outboxRows(db, `reminder:${stuck.orderId}:%`)).toHaveLength(1);

    clock.now = local('2026-10-12T11:01');
    await run('rossko-deadlines');
    await run('rossko-deadlines'); // a restart: nothing twice
    const rows = await outboxRows(db, `reminder:${friday.orderId}:%`);
    expect(rows.map((row) => row.jobId)).toEqual([deadlineAlertKey(friday.orderId, 'not_ordered')]);
    expect(rows[0]!.data).toMatchObject({
      audience: 'sellers',
      template: 'staff_not_ordered',
      note: deadlineAlertNote('not_ordered', {
        status: 'confirmed',
        scheme: 'prepay',
        promisedDate: null,
        orderWithinMinutes: 120,
      }),
    });
    expect(await outboxRows(db, `reminder:${fresh.orderId}:%`)).toEqual([]);
    expect(await outboxRows(db, `reminder:${taken.orderId}:%`)).toEqual([]);
    const stuckRows = await outboxRows(db, `reminder:${stuck.orderId}:%`);
    expect(stuckRows.map((row) => row.jobId)).toEqual([
      deadlineAlertKey(stuck.orderId, 'not_ordered'),
    ]);
    expect(String(stuckRows[0]!.data.note)).toContain('Заказ у Rossko не завершился');

    // The journal: one `reminder` event with the alert kind, no PD.
    const events = await eventsOf(db, friday.orderId, 'reminder');
    expect(events.map((event) => event.payload)).toEqual([
      expect.objectContaining({ alert: 'not_ordered', kind: 'rossko_not_ordered', n: '1' }),
    ]);

    // The card in the sellers chat: the headline, the note, «Проверить и заказать», the admin.
    await dispatch(t, rows[0]!);
    const card = lastCard(tg);
    expect(card.text.split('\n')[0]).toBe(`Не заказано у поставщика ${friday.number}`);
    expect(card.text).toContain('нажмите «Проверить и заказать»');
    expect(card.buttons).toContain('Проверить и заказать');
    expect(card.buttons).toContain('Открыть в админке');
    expect(tg.messages().every((m) => m.chatId === String(SELLER_CHAT))).toBe(true);
  });

  it("the admin's own deadline is read from settings", async () => {
    clock.now = local('2026-10-12T10:31');
    const order = await seedOrder(db, {
      status: 'confirmed',
      enteredAt: local('2026-10-12T10:00'),
    });
    await setSetting(db, 'rossko.order_within_minutes', 30);
    try {
      await run('rossko-deadlines');
      expect((await outboxRows(db, `reminder:${order.orderId}:%`)).map((r) => r.jobId)).toEqual([
        deadlineAlertKey(order.orderId, 'not_ordered'),
      ]);
    } finally {
      await setSetting(db, 'rossko.order_within_minutes', 120);
    }
  });

  it('«Срок поставщика под угрозой», then «Срок сорван»; after a gap only «Срок сорван»', async () => {
    clock.now = local('2026-10-09T18:30');
    const monday = await seedOrder(db, {
      status: 'ordered_at_supplier',
      itemState: 'ordered',
      promisedDate: '2026-10-12',
      enteredAt: local('2026-10-08T12:00'),
      rosskoOrderIds: ['70200001'],
    });
    const arrived = await seedOrder(db, {
      status: 'ordered_at_supplier',
      itemState: 'arrived',
      promisedDate: '2026-10-12',
      enteredAt: local('2026-10-08T12:00'),
      rosskoOrderIds: ['70200002'],
    });
    const kinds = async (seeded: Seeded) =>
      (await outboxRows(db, `reminder:${seeded.orderId}:%`)).map((row) => row.jobId.split(':')[2]);

    await run('rossko-deadlines');
    expect(await kinds(monday)).toEqual([]);

    // Friday 19:00 is the end of the working day before Monday.
    clock.now = local('2026-10-09T19:05');
    await run('rossko-deadlines');
    clock.now = local('2026-10-11T12:00'); // Sunday
    await run('rossko-deadlines');
    expect(await kinds(monday)).toEqual(['rossko_supplier_late']);
    const late = (await outboxRows(db, `reminder:${monday.orderId}:%`))[0]!;
    expect(String(late.data.note)).toBe(
      'Клиенту обещано к пн 12 октября, а детали ещё не приехали — позвоните менеджеру Rossko и уточните срок.',
    );

    // Tuesday at the opening: «Срок сорван», with the penalty line of a prepaid order.
    clock.now = local('2026-10-13T10:00');
    await run('rossko-deadlines');
    await run('rossko-deadlines');
    expect(await kinds(monday)).toEqual(['rossko_supplier_late', 'rossko_supplier_overdue']);
    const overdue = (await outboxRows(db, `reminder:${monday.orderId}:%`))[1]!;
    expect(overdue.data.template).toBe('staff_supplier_overdue');
    expect(String(overdue.data.note)).toContain('ст. 23.1 ЗоЗПП');
    expect(await kinds(arrived)).toEqual([]);

    // Promised for last Friday, first seen on Tuesday: «Срок сорван» only.
    const gap = await seedOrder(db, {
      status: 'ordered_at_supplier',
      itemState: 'ordered',
      scheme: 'pay_on_handover',
      promisedDate: '2026-10-09',
      enteredAt: local('2026-10-07T12:00'),
      rosskoOrderIds: ['70200003'],
    });
    await run('rossko-deadlines');
    expect(await kinds(gap)).toEqual(['rossko_supplier_overdue']);
    const gapRow = (await outboxRows(db, `reminder:${gap.orderId}:%`))[0]!;
    expect(String(gapRow.data.note)).not.toContain('23.1');

    // The card: the headline, «Приехало» of the part still on its way.
    await dispatch(t, overdue);
    const card = lastCard(tg);
    expect(card.text.split('\n')[0]).toBe(`Срок сорван ${monday.number}`);
    expect(card.text).toContain('Просрочка выдачи предоплаченного заказа');
    expect(card.buttons.some((label) => label.startsWith('Приехало'))).toBe(true);
  });

  it('«Не забирают» after more than 3 working days at the point', async () => {
    // Arrived Monday 15:00: Tue, Wed, Thu — due Friday at the opening.
    clock.now = local('2026-10-16T09:59');
    const waiting = await seedOrder(db, {
      status: 'ready',
      itemState: 'arrived',
      receivedAt: local('2026-10-12T15:00'),
      enteredAt: local('2026-10-12T15:00'),
    });
    await run('rossko-deadlines');
    expect(await outboxRows(db, `reminder:${waiting.orderId}:%`)).toEqual([]);
    clock.now = local('2026-10-16T10:00');
    await run('rossko-deadlines');
    await run('rossko-deadlines');
    const rows = await outboxRows(db, `reminder:${waiting.orderId}:%`);
    expect(rows.map((row) => row.jobId)).toEqual([
      deadlineAlertKey(waiting.orderId, 'not_picked_up'),
    ]);
    expect(rows[0]!.data).toMatchObject({
      template: 'staff_not_picked_up',
      note: 'Заказ ждёт клиента больше 3 рабочих дней — позвоните клиенту.',
    });
    await dispatch(t, rows[0]!);
    const card = lastCard(tg);
    expect(card.text.split('\n')[0]).toBe(`Не забирают ${waiting.number}`);
    expect(card.text).toContain('позвоните клиенту');
    expect(card.text).toMatch(/Клиент •••\d{4}/u);
  });

  it('the cutoff reminder: nothing without times; once per cutoff; not on a day off', async () => {
    clock.now = local('2026-10-15T10:35'); // Thursday
    await seedOrder(db, { status: 'confirmed', enteredAt: local('2026-10-15T10:00') });
    expect(await run('rossko-cutoff')).toEqual({ due: null, notOrdered: 0, alerted: null });
    expect(await outboxRows(db, 'alert:rossko-cutoff:%')).toEqual([]);

    await setSetting(db, 'rossko.cutoff_times', ['16:00', '11:00']);
    try {
      // What «не заказано» counts: confirmed orders and needs_attention ones with a pending part.
      const before = await countNotOrdered(t.deps);
      await seedOrder(db, { status: 'needs_attention', itemState: 'pending' });
      await seedOrder(db, { status: 'needs_attention', itemState: 'ordered' });
      await seedOrder(db, { status: 'ordered_at_supplier', itemState: 'ordered' });
      const notOrdered = await countNotOrdered(t.deps);
      expect(notOrdered).toBe(before + 1);

      clock.now = local('2026-10-15T10:34');
      expect(await run('rossko-cutoff')).toMatchObject({ due: null, alerted: null });
      clock.now = local('2026-10-15T10:35');
      expect(await run('rossko-cutoff')).toEqual({
        due: 'rossko-cutoff:2026-10-15:11:00',
        notOrdered,
        alerted: 'alert:rossko-cutoff:2026-10-15:11:00',
      });
      clock.now = local('2026-10-15T10:40');
      expect(await run('rossko-cutoff')).toMatchObject({ alerted: null });
      const rows = await outboxRows(db, 'alert:rossko-cutoff:%');
      expect(rows.map((row) => row.jobId)).toEqual(['alert:rossko-cutoff:2026-10-15:11:00']);
      expect(rows[0]!.data).toEqual({
        audience: 'sellers',
        text: cutoffReminderText({ minutesLeft: 25, cutoff: '11:00', notOrdered }),
        dedupeKey: 'rossko-cutoff:2026-10-15:11:00',
      });
      expect(String(rows[0]!.data.text)).toMatch(/^Через 25 минут отсечка Rossko \(11:00\): /u);

      // The second cutoff of the day has its own push; Saturday has none.
      clock.now = local('2026-10-15T15:35');
      await run('rossko-cutoff');
      clock.now = local('2026-10-17T10:35');
      expect(await run('rossko-cutoff')).toMatchObject({ due: null, alerted: null });
      expect((await outboxRows(db, 'alert:rossko-cutoff:%')).map((row) => row.jobId)).toEqual([
        'alert:rossko-cutoff:2026-10-15:11:00',
        'alert:rossko-cutoff:2026-10-15:16:00',
      ]);
    } finally {
      await setSetting(db, 'rossko.cutoff_times', []);
    }
  });
});

describe.skipIf(!inject('workerDatabaseUrl'))('step 8: the shadow auto-order', () => {
  let t: TestDeps;
  let db: Db;
  let tg: FakeTelegram;

  beforeAll(async () => {
    const { url } = await prepareTestDb({ url: `${inject('workerDatabaseUrl')}_rossko8shadow` });
    db = createDb(url, { max: 4 });
    t = await createTestDeps({
      db,
      now: () => clock.now,
      envOverrides: {
        APP_BASE_URL: BASE_URL,
        TG_SELLER_CHAT_ID: String(SELLER_CHAT),
        PICKUP_HOURS,
        ROSSKO_ALLOW_CHECKOUT: 'true',
        ROSSKO_DELIVERY_ID: 'fx-delivery',
        ROSSKO_PAYMENT_ID: 'fx-payment',
      },
    });
    tg = fakeTelegram();
    t.deps.sellerCards = createCardService(t.deps, tg.api);
  });
  afterAll(async () => {
    await t?.close();
    await db?.close();
  });

  /** «Проверить и заказать» of the staff, then the rossko/recheck job of its outbox row. */
  async function press(orderId: string) {
    const result = await performStaffAction(t.deps.engine, {
      staff: { id: null, role: 'owner', via: 'admin' },
      action: 'recheck',
      targetId: orderId,
    });
    expect(result.ok).toBe(true);
    const [row] = await db
      .select()
      .from(outbox)
      .where(and(eq(outbox.queue, 'rossko'), sql`${outbox.data}->>'orderId' = ${orderId}`));
    return processRossko(job('recheck', row!.data), t.deps);
  }

  it('«ДА»: journaled after the transition with masterOrdered, one line on the card', async () => {
    clock.now = local('2026-10-12T11:00');
    const order = await seedOrder(db, { status: 'confirmed', parts: PARTS });
    const result = await press(order.orderId);
    expect(result).toMatchObject({
      outcome: 'applied',
      to: 'ordering',
      shadow: { decision: 'yes', reasons: [] },
    });
    const [shadow] = await eventsOf(db, order.orderId, 'auto_order_shadow');
    expect(shadow?.payload).toMatchObject({
      decision: 'yes',
      reasons: [],
      masterOrdered: true,
      outcome: 'ordering',
      maxTotalKop: 1_500_000,
    });
    expect(shadow?.actorType).toBe('system');
    // The shadow orders nothing: the one supplier order is the press's own GetCheckout attempt.
    expect(
      await db.select().from(supplierOrders).where(eq(supplierOrders.orderId, order.orderId)),
    ).toHaveLength(1);

    await t.deps.sellerCards.post({ orderId: order.orderId, template: null });
    const card = lastCard(tg);
    expect(card.text.split('\n')).toContain('Автозаказ бы: ДА');
  });

  it('«НЕТ — причины»: a no-show client and a total above the limit, the press still orders', async () => {
    clock.now = local('2026-10-12T11:30');
    await setSetting(db, 'rossko.auto_order_max_total_kop', 100_00);
    try {
      const order = await seedOrder(db, { status: 'confirmed', noShowCount: 1 });
      expect(await press(order.orderId)).toMatchObject({
        outcome: 'applied',
        to: 'ordering',
        shadow: { decision: 'no', reasons: ['total_over_limit', 'no_show'] },
      });
      const [shadow] = await eventsOf(db, order.orderId, 'auto_order_shadow');
      expect(shadow?.payload).toMatchObject({
        decision: 'no',
        reasons: ['total_over_limit', 'no_show'],
        masterOrdered: true,
        maxTotalKop: 10_000,
      });
      await t.deps.sellerCards.post({ orderId: order.orderId, template: null });
      expect(lastCard(tg).text.replace(/\s/gu, ' ')).toContain(
        'Автозаказ бы: НЕТ — сумма больше 100 ₽, клиент уже не приходил за заказом',
      );
    } finally {
      await setSetting(db, 'rossko.auto_order_max_total_kop', 1_500_000);
    }
  });

  it('a recheck problem: «НЕТ» and needs_attention, the master did not order (yet)', async () => {
    clock.now = local('2026-10-12T12:00');
    const order = await seedOrder(db, { status: 'confirmed' });
    // The fixture has 4 OC 90 at ORB1: ask for more than there is.
    await db.update(orderItems).set({ qty: 50 }).where(eq(orderItems.orderId, order.orderId));
    expect(await press(order.orderId)).toMatchObject({
      outcome: 'applied',
      to: 'needs_attention',
      shadow: { decision: 'no', reasons: ['unavailable'] },
    });
    const [shadow] = await eventsOf(db, order.orderId, 'auto_order_shadow');
    expect(shadow?.payload).toMatchObject({ masterOrdered: false, outcome: 'needs_attention' });
    // The problem card shows the line too.
    await t.deps.sellerCards.post({ orderId: order.orderId, template: 'staff_problem' });
    expect(lastCard(tg).text).toContain('Автозаказ бы: НЕТ — у поставщика нет нужного количества');
  });
});

// ---------------------------------------------------------------------------------------------
// GetOrders polling
// ---------------------------------------------------------------------------------------------

interface SyntheticStatus {
  code: number | null;
  name: string | null;
  /** Parts GetOrders lists for the Rossko order; default none. */
  parts?: Part[];
}

/** GetOrders over a mutable table of statuses; records the ids of every call. */
function syntheticGetOrders() {
  const statuses = new Map<string, SyntheticStatus>();
  const calls: string[][] = [];
  let failWhen: ((ids: string[]) => boolean) | null = null;
  const caller: RosskoCaller = {
    async call(method, args) {
      if (method !== 'GetOrders') throw new Error(`unexpected ${method}`);
      const raw = (args.order_ids as { id?: unknown } | undefined)?.id;
      const ids = (Array.isArray(raw) ? raw : [raw]).map(String);
      calls.push(ids);
      if (failWhen?.(ids)) {
        throw new RosskoCallError('GetOrders', 'timeout of 15000ms exceeded', { timeout: true });
      }
      return {
        OrdersResult: {
          success: true,
          message: '',
          OrdersList: {
            Order: ids
              .filter((id) => statuses.has(id))
              .map((id) => {
                const status = statuses.get(id)!;
                return {
                  id,
                  created: '2026-10-12T09:00:00+03:00',
                  ...(status.code === null ? {} : { status: status.code }),
                  ...(status.name === null ? {} : { status_name: status.name }),
                  parts: {
                    part: (status.parts ?? []).map((part) => ({
                      brand: part.brand,
                      partnumber: part.article,
                      count: 1,
                      status: status.code,
                    })),
                  },
                };
              }),
          },
        },
      };
    },
  };
  return {
    caller,
    calls,
    set(id: string, status: SyntheticStatus) {
      statuses.set(id, status);
    },
    failWhen(predicate: ((ids: string[]) => boolean) | null) {
      failWhen = predicate;
    },
  };
}

describe.skipIf(!inject('workerDatabaseUrl'))('step 8: the GetOrders polling', () => {
  let t: TestDeps;
  let db: Db;
  let rossko: ReturnType<typeof syntheticGetOrders>;
  const poll = async () => (await processRossko(job('poll-orders'), t.deps)) as PollOrdersResult;

  beforeAll(async () => {
    const { url } = await prepareTestDb({ url: `${inject('workerDatabaseUrl')}_rossko8poll` });
    db = createDb(url, { max: 4 });
    t = await createTestDeps({
      db,
      now: () => clock.now,
      envOverrides: {
        APP_BASE_URL: BASE_URL,
        TG_SELLER_CHAT_ID: String(SELLER_CHAT),
        PICKUP_HOURS,
        ROSSKO_MODE: 'live',
        ROSSKO_KEY1: 'test-key-one',
        ROSSKO_KEY2: 'test-key-two',
      },
    });
    rossko = syntheticGetOrders();
    t.deps.rossko = createRosskoClient({
      caller: rossko.caller,
      key1: 'test-key-one',
      key2: 'test-key-two',
      localStockIds: FIXTURE_LOCAL_STOCK_IDS,
      limiter: createUnlimitedLimiter(),
      allowCheckout: false,
    });
  });
  afterAll(async () => {
    await t?.close();
    await db?.close();
  });

  it('is off by default, and off in fixtures mode even when switched on', async () => {
    clock.now = local('2026-10-12T12:00');
    await seedOrder(db, {
      status: 'ordered_at_supplier',
      itemState: 'ordered',
      rosskoOrderIds: ['80000001'],
    });
    rossko.set('80000001', { code: 3, name: 'Отгружен' });
    expect(await poll()).toEqual({ outcome: 'off', reason: 'disabled' });
    expect(rossko.calls).toEqual([]);

    const fixturesEnv = { ...t.deps.env, ROSSKO_MODE: 'fixtures' as const };
    await setSetting(db, 'rossko.poll_enabled', true);
    try {
      expect(await processRossko(job('poll-orders'), { ...t.deps, env: fixturesEnv })).toEqual({
        outcome: 'off',
        reason: 'not_live',
      });
      expect(rossko.calls).toEqual([]);
    } finally {
      await setSetting(db, 'rossko.poll_enabled', false);
    }
  });

  describe('on, with a synthetic status map', () => {
    beforeAll(async () => {
      await setSetting(db, 'rossko.poll_enabled', true);
      await setSetting(db, 'rossko.order_status_map', {
        '1': 'in_progress',
        '3': 'shipped_to_point',
        '9': 'refused',
      });
    });

    it('shipped: one card «Отгружено Rossko» with «Приехало», only on a change', async () => {
      clock.now = local('2026-10-12T12:20');
      const order = await seedOrder(db, {
        status: 'ordered_at_supplier',
        itemState: 'ordered',
        rosskoOrderIds: ['80000101'],
      });
      rossko.set('80000101', { code: 1, name: 'В работе' });
      await poll();
      const [first] = await db
        .select()
        .from(supplierOrders)
        .where(eq(supplierOrders.id, order.supplierOrderId!));
      expect(first).toMatchObject({
        statusCode: 1,
        statusName: 'В работе',
        statusCheckedAt: clock.now,
        statusChangedAt: clock.now,
      });
      expect(first!.rosskoStatuses['80000101']).toMatchObject({ code: 1, handled: true });
      const shippedOf = async (orderId: string) =>
        (await outboxRows(db, 'notify:%:staff_supplier_shipped')).filter(
          (row) => row.data.orderId === orderId,
        );
      expect(await shippedOf(order.orderId)).toEqual([]);

      rossko.set('80000101', { code: 3, name: 'Отгружен на точку' });
      clock.now = local('2026-10-12T12:40');
      await poll();
      clock.now = local('2026-10-12T13:00');
      await poll(); // the same code again: nothing
      const statusEvents = await eventsOf(db, order.orderId, 'rossko_status');
      expect(statusEvents.map((event) => [event.payload.code, event.payload.action])).toEqual([
        [1, 'in_progress'],
        [3, 'shipped_to_point'],
      ]);
      const pushes = await outboxRows(db, `notify:${statusEvents[1]!.id}:%`);
      expect(pushes.map((row) => row.data)).toEqual([
        expect.objectContaining({
          audience: 'sellers',
          template: 'staff_supplier_shipped',
          note: `Rossko отгрузил заказ ${order.number} на точку — проверьте приёмку (Rossko № 80000101: «Отгружен на точку»).`,
        }),
      ]);
      const [row] = await db
        .select()
        .from(supplierOrders)
        .where(eq(supplierOrders.id, order.supplierOrderId!));
      expect(row).toMatchObject({
        statusCode: 3,
        statusChangedAt: local('2026-10-12T12:40'),
        statusCheckedAt: local('2026-10-12T13:00'),
      });

      // The card: the headline, the note and the «Приехало» button; the order is not touched.
      const tg = fakeTelegram();
      const cards = createCardService(t.deps, tg.api);
      await processNotify(job('order', pushes[0]!.data), { ...t.deps, sellerCards: cards });
      const card = lastCard(tg);
      expect(card.text.split('\n')[0]).toBe(`Отгружено Rossko ${order.number}`);
      expect(card.text).toContain('проверьте приёмку');
      expect(card.buttons.some((label) => label.startsWith('Приехало'))).toBe(true);
      const [current] = await db.select().from(orders).where(eq(orders.id, order.orderId));
      expect(current?.status).toBe('ordered_at_supplier');
    });

    it('refused: «Проблема с позицией → отказ поставщика» once per item', async () => {
      clock.now = local('2026-10-12T14:00');
      const order = await seedOrder(db, {
        status: 'ordered_at_supplier',
        itemState: 'ordered',
        parts: PARTS,
        rosskoOrderIds: ['80000201'],
      });
      rossko.set('80000201', { code: 9, name: 'Отказ' });
      await poll();
      await poll();
      const problems = await eventsOf(db, order.orderId, 'item_problem');
      expect(problems).toHaveLength(1);
      expect(problems[0]).toMatchObject({
        fromStatus: 'ordered_at_supplier',
        toStatus: 'needs_attention',
        actorType: 'system',
      });
      expect(problems[0]!.payload).toMatchObject({
        problem: 'declined',
        via: 'rossko_poll',
        itemId: order.itemIds[0],
        refusedItemIds: order.itemIds,
      });
      const [after] = await db.select().from(orders).where(eq(orders.id, order.orderId));
      expect(after?.attentionReason).toBe('item_problem:declined');
      // The sellers get the problem card of the engine (staff_problem).
      expect(await outboxRows(db, `notify:${problems[0]!.id}:staff_problem`)).toHaveLength(1);

      // The master sends it on anyway; Rossko flips the code back and forth: no second refusal.
      await db
        .update(orders)
        .set({ status: 'ordered_at_supplier', attentionReason: null })
        .where(eq(orders.id, order.orderId));
      rossko.set('80000201', { code: 1, name: 'В работе' });
      await poll();
      rossko.set('80000201', { code: 9, name: 'Отказ' });
      await poll();
      expect(await eventsOf(db, order.orderId, 'item_problem')).toHaveLength(1);
      const [still] = await db.select().from(orders).where(eq(orders.id, order.orderId));
      expect(still?.status).toBe('ordered_at_supplier');
    });

    it('refused for one Rossko order of two: only its part', async () => {
      clock.now = local('2026-10-12T14:20');
      const order = await seedOrder(db, {
        status: 'ordered_at_supplier',
        itemState: 'ordered',
        parts: PARTS,
        rosskoOrderIds: ['80000301', '80000302'],
      });
      rossko.set('80000301', { code: 1, name: 'В работе', parts: [PARTS[0]!] });
      rossko.set('80000302', { code: 9, name: 'Отказ', parts: [PARTS[1]!] });
      await poll();
      const problems = await eventsOf(db, order.orderId, 'item_problem');
      expect(problems.map((event) => event.payload.refusedItemIds)).toEqual([[order.itemIds[1]]]);
    });

    it('refused when the order no longer waits for the supplier: one staff alert instead', async () => {
      clock.now = local('2026-10-12T14:40');
      const order = await seedOrder(db, {
        status: 'awaiting_client_approval',
        itemState: 'ordered',
        rosskoOrderIds: ['80000401'],
      });
      rossko.set('80000401', { code: 9, name: 'Отказ' });
      await poll();
      await poll();
      expect(await eventsOf(db, order.orderId, 'item_problem')).toEqual([]);
      const alerts = await outboxRows(db, `alert:rossko-refused:${order.supplierOrderId}:%`);
      expect(alerts).toHaveLength(1);
      expect(String(alerts[0]!.data.text)).toContain(
        `Rossko: отказ поставщика по заказу ${order.number} (Rossko № 80000401`,
      );
    });

    it('an unmapped code: one alert per supplier order and code, acted on once mapped', async () => {
      clock.now = local('2026-10-12T15:00');
      const order = await seedOrder(db, {
        status: 'ordered_at_supplier',
        itemState: 'ordered',
        rosskoOrderIds: ['80000501'],
      });
      rossko.set('80000501', { code: 5, name: 'В пути на склад' });
      await poll();
      await poll();
      const alerts = await outboxRows(db, `alert:rossko-status:${order.supplierOrderId}:%`);
      expect(alerts.map((row) => row.jobId)).toEqual([
        `alert:rossko-status:${order.supplierOrderId}:5`,
      ]);
      expect(alerts[0]!.data).toMatchObject({
        audience: 'sellers',
        text:
          'Rossko: статус «В пути на склад» (код 5) — что это значит? Настройте в /admin/rossko.\n' +
          `Заказ ${order.number}, Rossko № 80000501. ${BASE_URL}/admin/rossko`,
      });
      // Nothing was done with the order.
      expect(
        (await outboxRows(db, 'notify:%:staff_supplier_shipped')).filter(
          (row) => row.data.orderId === order.orderId,
        ),
      ).toEqual([]);
      const [so] = await db
        .select()
        .from(supplierOrders)
        .where(eq(supplierOrders.id, order.supplierOrderId!));
      expect(so!.rosskoStatuses['80000501']).toMatchObject({ code: 5, handled: false });

      // The founder maps 5 to «отгружен на точку»: the next run applies it to this order once.
      await setSetting(db, 'rossko.order_status_map', {
        '1': 'in_progress',
        '3': 'shipped_to_point',
        '5': 'shipped_to_point',
        '9': 'refused',
      });
      try {
        await poll();
        await poll();
        const events = await eventsOf(db, order.orderId, 'rossko_status');
        expect(events.map((event) => [event.payload.action, event.payload.mappedLater])).toEqual([
          ['unmapped', undefined],
          ['shipped_to_point', true],
        ]);
        expect(await outboxRows(db, `notify:${events[1]!.id}:staff_supplier_shipped`)).toHaveLength(
          1,
        );
      } finally {
        await setSetting(db, 'rossko.order_status_map', {
          '1': 'in_progress',
          '3': 'shipped_to_point',
          '9': 'refused',
        });
      }
    });

    it('batches of at most 20 ids; a failed batch is logged and the rest goes on', async () => {
      clock.now = local('2026-10-12T16:00');
      const seeded: Seeded[] = [];
      for (let i = 0; i < 25; i += 1) {
        const id = String(80001000 + i);
        seeded.push(
          await seedOrder(db, {
            status: 'ordered_at_supplier',
            itemState: 'ordered',
            rosskoOrderIds: [id],
          }),
        );
        rossko.set(id, { code: 1, name: 'В работе' });
      }
      const failing = String(80001000 + 24);
      rossko.failWhen((ids) => ids.includes(failing));
      rossko.calls.length = 0;
      let result: PollOrdersResult;
      try {
        result = await poll();
      } finally {
        rossko.failWhen(null);
      }
      // Every open supplier order of the database is asked about once, at most 20 ids per call.
      const asked = rossko.calls.flat();
      expect(new Set(asked).size).toBe(asked.length);
      expect(asked.length).toBeGreaterThan(20);
      expect(rossko.calls.every((ids) => ids.length <= 20)).toBe(true);
      expect(rossko.calls.length).toBe(Math.ceil(asked.length / 20));
      expect(result).toMatchObject({ outcome: 'polled', failedCalls: 1, errors: 0 });
      // The batch with the failing id was skipped, every other one applied.
      const failed = new Set(rossko.calls.filter((ids) => ids.includes(failing)).flat());
      const checked = async (order: Seeded) => {
        const [row] = await db
          .select({ checkedAt: supplierOrders.statusCheckedAt })
          .from(supplierOrders)
          .where(eq(supplierOrders.id, order.supplierOrderId!));
        return row?.checkedAt ?? null;
      };
      for (const [i, order] of seeded.entries()) {
        const id = String(80001000 + i);
        expect(asked).toContain(id);
        expect(await checked(order)).toEqual(failed.has(id) ? null : clock.now);
      }

      // The next run asks about the skipped ones first and applies them.
      clock.now = local('2026-10-12T16:20');
      rossko.calls.length = 0;
      expect(await poll()).toMatchObject({ outcome: 'polled', failedCalls: 0 });
      expect(rossko.calls[0]).toContain(failing);
      for (const order of seeded) expect(await checked(order)).not.toBeNull();
      expect(await checked(seeded[24]!)).toEqual(clock.now);
    });
  });
});
