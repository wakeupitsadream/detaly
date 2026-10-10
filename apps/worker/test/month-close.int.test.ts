// Step 7 (docs/month-close.md) on a database of its own (`${workerDatabaseUrl}_month`, migrated
// and seeded like `_worker`): the reminders job scans every order and the month close sums every
// row of the month, so no other test file's orders may be there. The clock is injected.
//
// - supplier returns still at the point: reminders 3 days and 1 day before the Rossko deadline and
//   once it passed, one message per stage, the latest stage only after a gap, nothing again after
//   a restart;
// - «Сдал водителю» without «Деньги вернулись» for 10 days: one alert to the owner per return;
// - «Закрытие <месяц>» to the owner once per month; the sellers chat (no owner chat, or Telegram
//   refuses it) gets the text without the money figures;
// - the finance reminders on the days of finance.reminder_days, once per month each.
import { randomBytes, randomInt, randomUUID } from 'node:crypto';
import { createLogger } from '@detaly/config';
import {
  and,
  asc,
  createDb,
  eq,
  notifications,
  orderEvents,
  orderItems,
  orders,
  outbox,
  payments,
  receipts,
  settings,
  sql,
  staff,
  supplierReturns,
  users,
  type Db,
} from '@detaly/db';
import { prepareTestDb } from '@detaly/db/testing';
import {
  financeReminderText,
  formatRub,
  monthCloseFallbackText,
  monthCloseText,
  type OrderItemState,
  type OrderStatus,
  type SupplierReturnStatus,
} from '@detaly/domain';
import type { Job } from 'bullmq';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { createAlerts } from '../src/alerts';
import { processHousekeeping } from '../src/jobs/housekeeping';
import type {
  FinanceRemindersResult,
  MonthCloseResult,
} from '../src/jobs/housekeeping/month-close';
import { supplierReturnStage } from '../src/jobs/housekeeping/reminders';
import { processNotify } from '../src/jobs/notify';
import { fakeTelegram } from './fixtures/telegram';
import { createTestDeps, type TestDeps } from './helpers/test-deps';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const BASE_URL = 'https://detaly.test';
const SELLER_CHAT = -100_888_000_000 - randomInt(0, 1_000_000);
const logger = createLogger('month-close-test', { level: 'silent' });

const clock = { now: new Date('2026-03-10T06:00:00.000Z') };

const ITEMS = [
  { brand: 'MANN', article: 'W 914/2', priceClientKop: 128_000, priceSupplierKop: 100_000 },
  { brand: 'BOSCH', article: 'F 026', priceClientKop: 64_000, priceSupplierKop: 50_000 },
];

interface Seeded {
  orderId: string;
  number: string;
  itemIds: string[];
}

async function seedOrder(
  db: Db,
  input: {
    status: OrderStatus;
    itemState: OrderItemState;
    deadline?: Date | null;
    handedAt?: Date | null;
  },
): Promise<Seeded> {
  const phone = `+79${String(randomInt(0, 1_000_000_000)).padStart(9, '0')}`;
  const [user] = await db.insert(users).values({ phone }).returning({ id: users.id });
  const total = ITEMS.reduce((sum, item) => sum + item.priceClientKop, 0);
  const [order] = await db
    .insert(orders)
    .values({
      userId: user!.id,
      accessToken: randomBytes(32).toString('base64url'),
      status: input.status,
      paymentScheme: 'prepay',
      subtotalKop: total,
      totalKop: total,
      itemsHash: 'test',
      supplierReturnDeadlineAt: input.deadline ?? null,
      handedAt: input.handedAt ?? null,
    })
    .returning({ id: orders.id, number: orders.number });
  const itemIds: string[] = [];
  for (const item of ITEMS) {
    const articleNorm = item.article.replace(/[^A-Z0-9]/giu, '').toUpperCase();
    const [row] = await db
      .insert(orderItems)
      .values({
        orderId: order!.id,
        offerKey: `${articleNorm}:${item.brand}:ORB1`,
        searchArticleNorm: articleNorm,
        brand: item.brand,
        article: item.article,
        name: 'Фильтр масляный',
        qty: 1,
        stockId: 'ORB1',
        isLocal: true,
        priceSupplierAtOrderKop: item.priceSupplierKop,
        priceClientKop: item.priceClientKop,
        markupBp: 2800,
        etaDate: '2026-03-12',
        offerSnapshot: {
          source: 'rossko',
          brand: item.brand,
          article: item.article,
          articleNorm,
          name: 'Фильтр масляный',
          group: null,
          isCross: false,
          priceSupplierKop: item.priceSupplierKop,
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
        state: input.itemState,
      })
      .returning({ id: orderItems.id });
    itemIds.push(row!.id);
  }
  return { orderId: order!.id, number: order!.number, itemIds };
}

async function addReturn(
  db: Db,
  orderItemId: string,
  input: { status: SupplierReturnStatus; shippedAt?: Date | null; updatedAt?: Date },
): Promise<string> {
  const [row] = await db
    .insert(supplierReturns)
    .values({
      orderItemId,
      kind: 'return',
      status: input.status,
      amountExpectedKop: 100_000,
      shippedAt: input.shippedAt ?? null,
      ...(input.status === 'refunded'
        ? { amountReceivedKop: 100_000, refundedAt: input.updatedAt ?? clock.now }
        : {}),
      ...(input.updatedAt ? { createdAt: input.updatedAt, updatedAt: input.updatedAt } : {}),
    })
    .returning({ id: supplierReturns.id });
  return row!.id;
}

async function outboxOf(db: Db, orderId: string) {
  return db
    .select()
    .from(outbox)
    .where(sql`${outbox.jobId} like ${`reminder:${orderId}:%`}`)
    .orderBy(asc(outbox.createdAt), asc(outbox.jobId));
}

async function alertRows(db: Db, prefix: string) {
  return db
    .select()
    .from(outbox)
    .where(sql`${outbox.jobId} like ${`alert:${prefix}%`}`)
    .orderBy(asc(outbox.createdAt), asc(outbox.jobId));
}

function job(name: string, data: Record<string, unknown>): Job {
  return { name, data, attemptsMade: 0, opts: { attempts: 1 } } as unknown as Job;
}

describe('supplierReturnStage', () => {
  const deadline = new Date('2026-03-15T19:00:00.000Z');
  const at = (ms: number) => new Date(deadline.getTime() - ms);
  it('3 days, the last day, overdue; nothing earlier', () => {
    expect(supplierReturnStage(deadline, at(3 * DAY + MIN))).toBeNull();
    expect(supplierReturnStage(deadline, at(3 * DAY))?.kind).toBe('supplier_return');
    expect(supplierReturnStage(deadline, at(DAY + MIN))?.kind).toBe('supplier_return');
    expect(supplierReturnStage(deadline, at(DAY))?.kind).toBe('supplier_return_1d');
    expect(supplierReturnStage(deadline, at(MIN))?.kind).toBe('supplier_return_1d');
    expect(supplierReturnStage(deadline, at(0))?.kind).toBe('supplier_return_overdue');
    expect(supplierReturnStage(deadline, at(-5 * DAY))?.kind).toBe('supplier_return_overdue');
    expect(supplierReturnStage(deadline, at(2 * DAY))?.note).toBeNull();
  });
});

describe.skipIf(!inject('workerDatabaseUrl'))('step 7 housekeeping (own database)', () => {
  let t: TestDeps;
  let db: Db;
  const run = (name: string) => processHousekeeping({ name }, t.deps);

  beforeAll(async () => {
    const { url } = await prepareTestDb({ url: `${inject('workerDatabaseUrl')}_month` });
    db = createDb(url, { max: 4 });
    t = await createTestDeps({
      db,
      now: () => clock.now,
      envOverrides: { APP_BASE_URL: BASE_URL, TG_SELLER_CHAT_ID: String(SELLER_CHAT) },
    });
  });
  afterAll(async () => {
    await t?.close();
    await db?.close();
  });

  it('supplier return reminders: 3 days, 1 day, overdue — once each, the latest after a gap', async () => {
    const t0 = new Date('2026-03-10T06:00:00.000Z');
    clock.now = t0;
    // Deadline in 5 days: every stage in turn.
    const steady = await seedOrder(db, {
      status: 'refund_pending',
      itemState: 'refund_pending',
      deadline: new Date(t0.getTime() + 5 * DAY),
    });
    await addReturn(db, steady.itemIds[0]!, { status: 'requested' });
    // Deadline in 12 hours on the first run: the last-day reminder only, no «3 days».
    const late = await seedOrder(db, {
      status: 'refund_pending',
      itemState: 'refund_pending',
      deadline: new Date(t0.getTime() + 12 * HOUR),
    });
    await addReturn(db, late.itemIds[0]!, { status: 'requested' });
    // Handed to the driver already: no deadline reminders at all.
    const gone = await seedOrder(db, {
      status: 'refund_pending',
      itemState: 'refund_pending',
      deadline: new Date(t0.getTime() - DAY),
    });
    await addReturn(db, gone.itemIds[0]!, { status: 'shipped', shippedAt: t0 });

    const kinds = async (seeded: Seeded) =>
      (await outboxOf(db, seeded.orderId)).map((row) => row.jobId.split(':')[2]);

    await run('reminders');
    expect(await kinds(steady)).toEqual([]);
    expect(await kinds(late)).toEqual(['supplier_return_1d']);

    clock.now = new Date(t0.getTime() + 2 * DAY + 12 * HOUR);
    await run('reminders');
    await run('reminders'); // a restart: nothing twice
    expect(await kinds(steady)).toEqual(['supplier_return']);
    expect(await kinds(late)).toEqual(['supplier_return_1d', 'supplier_return_overdue']);

    clock.now = new Date(t0.getTime() + 4 * DAY + 12 * HOUR);
    await run('reminders');
    clock.now = new Date(t0.getTime() + 5 * DAY + MIN);
    await run('reminders');
    clock.now = new Date(t0.getTime() + 9 * DAY);
    await run('reminders');
    await run('reminders');

    const rows = await outboxOf(db, steady.orderId);
    expect(rows.map((row) => row.jobId)).toEqual([
      `reminder:${steady.orderId}:supplier_return:2026-03-15`,
      `reminder:${steady.orderId}:supplier_return_1d:2026-03-15`,
      `reminder:${steady.orderId}:supplier_return_overdue:2026-03-15`,
    ]);
    for (const row of rows) {
      expect(row.data).toMatchObject({
        audience: 'sellers',
        template: 'staff_supplier_return_task',
        deadlineDate: '2026-03-15',
      });
    }
    expect(rows[0]!.data.note).toBeUndefined();
    expect(String(rows[1]!.data.note)).toContain('последний день');
    expect(String(rows[2]!.data.note)).toContain('Срок возврата Rossko прошёл');
    expect(await kinds(late)).toEqual(['supplier_return_1d', 'supplier_return_overdue']);
    expect(await kinds(gone)).toEqual([]);

    // One journal event per reminder.
    const events = await db
      .select({ payload: orderEvents.payload })
      .from(orderEvents)
      .where(and(eq(orderEvents.orderId, steady.orderId), eq(orderEvents.type, 'reminder')));
    expect(events.map((event) => event.payload.kind)).toEqual([
      'supplier_return',
      'supplier_return_1d',
      'supplier_return_overdue',
    ]);

    // The overdue reminder reaches the sellers card with its line.
    const before = t.fakes.sellerCards.calls.length;
    await processNotify(job('order', rows[2]!.data), t.deps);
    const posted = t.fakes.sellerCards.calls.slice(before);
    expect(posted).toEqual([
      {
        method: 'post',
        input: expect.objectContaining({
          orderId: steady.orderId,
          template: 'staff_supplier_return_task',
          note: rows[2]!.data.note,
        }),
      },
    ]);
  });

  it('the owner is alerted once when the money is not back 10 days after «Сдал водителю»', async () => {
    const t0 = new Date('2026-05-20T06:00:00.000Z');
    clock.now = t0;
    const due = await seedOrder(db, { status: 'refund_pending', itemState: 'refund_pending' });
    const dueReturn = await addReturn(db, due.itemIds[0]!, {
      status: 'shipped',
      shippedAt: new Date(t0.getTime() - 10 * DAY - MIN),
    });
    const young = await seedOrder(db, { status: 'refund_pending', itemState: 'refund_pending' });
    const youngReturn = await addReturn(db, young.itemIds[0]!, {
      status: 'shipped',
      shippedAt: new Date(t0.getTime() - 9 * DAY),
    });
    const paid = await seedOrder(db, { status: 'refund_pending', itemState: 'refund_pending' });
    const paidReturn = await addReturn(db, paid.itemIds[0]!, {
      status: 'refunded',
      shippedAt: new Date(t0.getTime() - 20 * DAY),
      updatedAt: new Date(t0.getTime() - 15 * DAY),
    });
    // Accepted by Rossko before step 7 tracked the handing: the wait counts from then.
    const accepted = await seedOrder(db, { status: 'refund_pending', itemState: 'refund_pending' });
    const acceptedReturn = await addReturn(db, accepted.itemIds[0]!, {
      status: 'accepted',
      updatedAt: new Date(t0.getTime() - 11 * DAY),
    });

    await run('reminders');
    await run('reminders');
    const keyOf = (id: string) => `alert:supplier-refund-due:${id}`;
    // Returns of the first test (shipped in March) are due as well: only this test's are looked at.
    const mine = [dueReturn, youngReturn, paidReturn, acceptedReturn].map(keyOf);
    const alertsOfMine = async () =>
      (await alertRows(db, 'supplier-refund-due:')).filter((row) => mine.includes(row.jobId));
    const alerts = await alertsOfMine();
    expect(alerts.map((row) => row.jobId).sort()).toEqual(
      [keyOf(dueReturn), keyOf(acceptedReturn)].sort(),
    );
    const dueAlert = alerts.find((row) => row.jobId === keyOf(dueReturn))!;
    expect(dueAlert).toMatchObject({ queue: 'notify', name: 'alert' });
    expect(dueAlert.data).toMatchObject({
      audience: 'owner',
      dedupeKey: `supplier-refund-due:${dueReturn}`,
    });
    expect(dueAlert.data.text).toBe(
      `Rossko не вернул деньги за возврат: заказ ${due.number}, MANN W 914/2 × 1, ждём ${formatRub(100_000)} — ` +
        `сдан водителю 10 мая, денег нет 10 дней и больше. ` +
        `Сверьте с выпиской Rossko и отметьте «Деньги вернулись» — ${BASE_URL}/admin/returns`,
    );
    const acceptedAlert = alerts.find((row) => row.jobId === keyOf(acceptedReturn))!;
    expect(String(acceptedAlert.data.text)).toContain('— принят Rossko 9 мая,');
    expect(JSON.stringify(alerts.map((row) => row.data))).not.toMatch(/\+79\d{9}/u);

    // A day later the young one is due too; nothing else repeats.
    clock.now = new Date(t0.getTime() + DAY + MIN);
    await run('reminders');
    expect((await alertsOfMine()).map((row) => row.jobId).sort()).toEqual(
      [keyOf(dueReturn), keyOf(acceptedReturn), keyOf(youngReturn)].sort(),
    );
  });

  it('«Закрытие месяца» once per month; the sellers chat gets it without the money figures', async () => {
    // September 2026 (Asia/Yekaterinburg): one prepay order handed on the 12th.
    const handedAt = new Date('2026-09-12T08:00:00.000Z');
    const order = await seedOrder(db, { status: 'handed', itemState: 'handed', handedAt });
    const [payment] = await db
      .insert(payments)
      .values({
        orderId: order.orderId,
        kind: 'prepayment',
        status: 'succeeded',
        amountKop: 192_000,
        idempotenceKey: randomUUID(),
        providerPaymentId: `pay-${randomUUID()}`,
        confirmationType: 'redirect',
        request: {},
        paidAt: new Date('2026-09-10T08:00:00.000Z'),
      })
      .returning({ id: payments.id });
    const [receipt] = await db
      .insert(receipts)
      .values({
        orderId: order.orderId,
        paymentId: payment!.id,
        kind: 'prepayment',
        idempotenceKey: randomUUID(),
        status: 'succeeded',
      })
      .returning({ id: receipts.id });
    const event = (type: string, at: string, payload: Record<string, unknown> = {}) => ({
      orderId: order.orderId,
      type,
      actorType: 'system' as const,
      actorId: 'test',
      payload,
      createdAt: new Date(at),
    });
    await db
      .insert(orderEvents)
      .values([
        event('receipt_succeeded', '2026-09-10T08:01:00.000Z', { receiptId: receipt!.id }),
        event('item_arrived', '2026-09-11T08:00:00.000Z', { itemId: order.itemIds[0] }),
        event('item_arrived', '2026-09-11T08:05:00.000Z', { itemId: order.itemIds[1] }),
        { ...event('handed_over', '2026-09-12T08:00:00.000Z'), toStatus: 'handed' as const },
      ] as (typeof orderEvents.$inferInsert)[]);

    clock.now = new Date('2026-10-01T04:00:00.000Z'); // 09:00 local on the 1st
    const first = (await run('month-close')) as MonthCloseResult;
    const second = (await run('month-close')) as MonthCloseResult;
    expect(first).toEqual({
      month: '2026-09',
      operations: 3,
      alerted: 'alert:month-close:2026-09',
    });
    expect(second).toEqual({ month: '2026-09', operations: 3, alerted: null });

    const rows = await alertRows(db, 'month-close:');
    expect(rows).toHaveLength(1);
    const url = `${BASE_URL}/admin/month?m=2026-09`;
    // Revenue: the prepayment receipt 1 920 ₽. Margin: 1 920 − 1 500 purchase − 53,76 acquiring
    // (2,8%) = 366,24 ₽, 19,07%. Operations: 2 arrivals + 1 handover.
    expect(rows[0]!.data).toEqual({
      audience: 'owner',
      text: monthCloseText({
        month: '2026-09',
        revenueKop: 192_000,
        marginKop: 36_624,
        marginBp: 1907,
        operations: 3,
        url,
      }),
      fallbackText: monthCloseFallbackText({ month: '2026-09', operations: 3, url }),
      dedupeKey: 'month-close:2026-09',
    });
    expect(String(rows[0]!.data.text)).toMatch(
      /^Закрытие сентября 2026: выручка по чекам 1\s920\s₽, маржа 366,24\s₽ \(19,07%\), операций для акта 3, расхождений с ЮKassa: проверить\./u,
    );

    // No owner with a Telegram id in this database: the sellers chat, without the figures.
    const tg = fakeTelegram();
    const alerts = createAlerts({ db, telegram: tg.api, sellerChatId: SELLER_CHAT, logger });
    await processNotify(job('alert', rows[0]!.data), { ...t.deps, alerts });
    await processNotify(job('alert', rows[0]!.data), { ...t.deps, alerts });
    expect(tg.messages()).toEqual([
      {
        chatId: String(SELLER_CHAT),
        text: 'Закрытие сентября 2026: операций для акта 3. Отчёт месяца — в админке: ' + url,
      },
    ]);
    expect(tg.messages()[0]!.text).not.toMatch(/выручка|маржа|₽/u);
    const [stored] = await db
      .select()
      .from(notifications)
      .where(eq(notifications.dedupeKey, 'alert:month-close:2026-09'));
    expect(stored).toMatchObject({ chatId: String(SELLER_CHAT), status: 'sent' });

    // With the owner's chat: the owner gets the figures; when Telegram refuses the owner's chat,
    // the sellers chat gets the text without them.
    const ownerTg = 8_500_000_000 + randomInt(0, 1_000_000);
    const [owner] = await db
      .insert(staff)
      .values({ name: 'Владелец', role: 'owner', tgUserId: ownerTg })
      .returning({ id: staff.id });
    try {
      clock.now = new Date('2026-11-01T04:00:00.000Z');
      const october = (await run('month-close')) as MonthCloseResult;
      expect(october).toMatchObject({ month: '2026-10', alerted: 'alert:month-close:2026-10' });
      const [octoberRow] = await alertRows(db, 'month-close:2026-10');
      const toOwner = fakeTelegram();
      await processNotify(job('alert', octoberRow!.data), {
        ...t.deps,
        alerts: createAlerts({ db, telegram: toOwner.api, sellerChatId: SELLER_CHAT, logger }),
      });
      expect(toOwner.messages()).toEqual([
        { chatId: String(ownerTg), text: String(octoberRow!.data.text) },
      ]);
      expect(toOwner.messages()[0]!.text).toContain('Закрытие октября 2026: выручка по чекам 0');

      const refused = fakeTelegram({
        fail: (call) =>
          call.payload.chat_id === String(ownerTg)
            ? { error_code: 403, description: "Forbidden: bot can't initiate conversation" }
            : null,
      });
      await createAlerts({ db, telegram: refused.api, sellerChatId: SELLER_CHAT, logger }).send({
        audience: 'owner',
        text: 'Закрытие: выручка 1 ₽',
        fallbackText: 'Закрытие: отчёт в админке',
        dedupeKey: `test:${randomUUID()}`,
      });
      // The refused try to the owner's chat, then the sellers chat with the fallback text.
      expect(refused.messages()).toEqual([
        { chatId: String(ownerTg), text: 'Закрытие: выручка 1 ₽' },
        { chatId: String(SELLER_CHAT), text: 'Закрытие: отчёт в админке' },
      ]);
    } finally {
      // notifications keep the owner's id: the row stays, inactive.
      await db.update(staff).set({ isActive: false }).where(eq(staff.id, owner!.id));
    }
  });

  it('finance reminders: on their days (a missed day within 2 days), once per month', async () => {
    const reminders = async (iso: string) => {
      clock.now = new Date(iso);
      return (await run('finance-reminders')) as FinanceRemindersResult;
    };
    // 09:10 local = 04:10Z.
    expect(await reminders('2026-12-02T04:10:00.000Z')).toEqual({ month: '2026-11', alerted: [] });
    expect(await reminders('2026-12-03T04:10:00.000Z')).toEqual({
      month: '2026-11',
      alerted: ['alert:finance-reminder:act:2026-11'],
    });
    expect((await reminders('2026-12-03T10:00:00.000Z')).alerted).toEqual([]);
    expect((await reminders('2026-12-04T04:10:00.000Z')).alerted).toEqual([]);
    // The worker was down on the 5th: the bank check goes out on the 6th.
    expect((await reminders('2026-12-06T04:10:00.000Z')).alerted).toEqual([
      'alert:finance-reminder:bank_check:2026-11',
    ]);
    // Day 28 is past the grace of day 25: no tax reminder for November.
    expect((await reminders('2026-12-28T04:10:00.000Z')).alerted).toEqual([]);
    expect((await reminders('2027-01-25T04:10:00.000Z')).alerted).toEqual([
      'alert:finance-reminder:tax:2026-12',
    ]);

    const rows = await alertRows(db, 'finance-reminder:');
    expect(rows.map((row) => row.jobId)).toEqual([
      'alert:finance-reminder:act:2026-11',
      'alert:finance-reminder:bank_check:2026-11',
      'alert:finance-reminder:tax:2026-12',
    ]);
    expect(rows.map((row) => row.data)).toEqual([
      {
        audience: 'owner',
        text: financeReminderText('act', { month: '2026-11', baseUrl: BASE_URL }),
        dedupeKey: 'finance-reminder:act:2026-11',
      },
      {
        audience: 'owner',
        text: financeReminderText('bank_check', { month: '2026-11', baseUrl: BASE_URL }),
        dedupeKey: 'finance-reminder:bank_check:2026-11',
      },
      {
        audience: 'owner',
        text: financeReminderText('tax', { month: '2026-12', baseUrl: BASE_URL }),
        dedupeKey: 'finance-reminder:tax:2026-12',
      },
    ]);
    expect(rows[1]!.data.text).toBe(
      `Сверьте операции в интернет-банке за ноябрь 2026. Список для сверки — ${BASE_URL}/admin/month?m=2026-11`,
    );
    expect(rows[2]!.data.text).toBe('Срок уплаты налога АУСН — до 25-го (за декабрь 2026).');

    // The days are settings: the act on the 10th from now on.
    await db
      .update(settings)
      .set({ value: { act: 10, bank_check: 5, tax: 25 }, updatedBy: 'test' })
      .where(eq(settings.key, 'finance.reminder_days'));
    try {
      expect((await reminders('2027-02-03T04:10:00.000Z')).alerted).toEqual([]);
      expect((await reminders('2027-02-10T04:10:00.000Z')).alerted).toEqual([
        'alert:finance-reminder:act:2027-01',
      ]);
    } finally {
      await db
        .update(settings)
        .set({ value: { act: 3, bank_check: 5, tax: 25 }, updatedBy: 'seed' })
        .where(eq(settings.key, 'finance.reminder_days'));
    }
  });
});
