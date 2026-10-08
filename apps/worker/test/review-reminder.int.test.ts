// Step 3 (docs/reviews.md): «Как деталь?» with the review buttons at completion and the one
// review reminder of housekeeping/reminders, reviews.reminder_days after `completed`: once, only
// while the order is still completed, no review link was opened, no claim after the handover, a
// review link is set and the client has a messenger; checked again right before sending; the
// order never changes. A database of its own (`${workerDatabaseUrl}_hk_reviews`): the reminders
// scan every row of the database.
import { randomBytes, randomInt } from 'node:crypto';
import {
  and,
  claims,
  createDb,
  eq,
  messengerBindings,
  notifications,
  orderEvents,
  orderItems,
  orders,
  outbox,
  settings,
  sql,
  users,
  type Db,
} from '@detaly/db';
import { prepareTestDb } from '@detaly/db/testing';
import type { OrderStatus } from '@detaly/domain';
import type { Job } from 'bullmq';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';
import { processHousekeeping, reviewReminderKey } from '../src/jobs/housekeeping';
import type { RemindersResult } from '../src/jobs/housekeeping/reminders';
import { processNotify } from '../src/jobs/notify';
import { createTestDeps, type TestDeps } from './helpers/test-deps';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
/** Thursday 1 October 2026, 11:00 in Orenburg. */
const T0 = new Date('2026-10-01T06:00:00.000Z');
const BASE = 'https://shop.test';
const YANDEX = 'https://yandex.ru/maps/org/test/1/reviews/';
const TWO_GIS = 'https://2gis.ru/orenburg/firm/1';

const clock = { now: new Date(T0) };
const at = (ms: number) => new Date(T0.getTime() + ms);

function job(name: string, data: Record<string, unknown>): Job {
  return { name, data, attemptsMade: 0, opts: { attempts: 5 } } as unknown as Job;
}

interface InlineButton {
  text: string;
  url?: string;
}

describe.skipIf(!inject('workerDatabaseUrl'))('review reminder (step 3)', () => {
  let db: Db;
  /** Both review links set. */
  let t: TestDeps;
  /** No review link: the feature is off. */
  let plain: TestDeps;

  beforeAll(async () => {
    const { url } = await prepareTestDb({ url: `${inject('workerDatabaseUrl')}_hk_reviews` });
    db = createDb(url, { max: 4 });
    t = await createTestDeps({
      db,
      now: () => clock.now,
      envOverrides: { APP_BASE_URL: BASE, REVIEW_URL_YANDEX: YANDEX, REVIEW_URL_2GIS: TWO_GIS },
    });
    plain = await createTestDeps({
      db,
      now: () => clock.now,
      envOverrides: { APP_BASE_URL: BASE },
    });
  });
  afterAll(async () => {
    await t?.close();
    await plain?.close();
    await db?.close();
  });
  beforeEach(async () => {
    // Every test starts from an empty order book: the reminders scan the whole database.
    await db.delete(notifications);
    await db.delete(outbox);
    await db.delete(orderEvents);
    await db.delete(claims);
    await db.delete(orderItems);
    await db.delete(orders);
    await db.delete(messengerBindings);
    await db.update(settings).set({ value: 3 }).where(eq(settings.key, 'reviews.reminder_days'));
    clock.now = new Date(T0);
  });

  async function reminders(deps: TestDeps): Promise<RemindersResult> {
    return (await processHousekeeping({ name: 'reminders' }, deps.deps)) as RemindersResult;
  }

  async function seedOrder(input: {
    status?: OrderStatus;
    handedAt?: Date;
    completedAt?: Date | null;
    expiresAt?: Date | null;
    messenger?: 'telegram' | 'blocked' | null;
  }) {
    const phone = `+79${String(randomInt(0, 1_000_000_000)).padStart(9, '0')}`;
    const [user] = await db.insert(users).values({ phone }).returning();
    const handedAt = input.handedAt ?? at(-7 * DAY);
    const [order] = await db
      .insert(orders)
      .values({
        userId: user!.id,
        accessToken: randomBytes(32).toString('base64url'),
        status: input.status ?? 'completed',
        paymentScheme: 'pay_on_handover',
        subtotalKop: 128_000,
        totalKop: 128_000,
        itemsHash: 'test',
        pickupCode: '4821',
        handedAt,
        completedAt: input.completedAt === undefined ? T0 : input.completedAt,
        expiresAt: input.expiresAt ?? null,
        createdAt: at(-10 * DAY),
      })
      .returning();
    await db.insert(orderItems).values({
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
      etaDate: '2026-09-20',
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
      state: 'handed',
    });
    const chatId = String(randomInt(1e8, 9e8));
    const messenger = input.messenger === undefined ? 'telegram' : input.messenger;
    if (messenger !== null) {
      await db.insert(messengerBindings).values({
        userId: user!.id,
        channel: 'telegram',
        externalUserId: chatId,
        chatId,
        isPrimary: true,
        blockedAt: messenger === 'blocked' ? at(-DAY) : null,
      });
    }
    return { id: order!.id, token: order!.accessToken, userId: user!.id, chatId, handedAt };
  }

  async function reminderRows(orderId: string) {
    return db
      .select()
      .from(outbox)
      .where(eq(outbox.jobId, reviewReminderKey(orderId)));
  }

  async function openReviewLink(orderId: string, platform: string, when: Date) {
    await db.insert(orderEvents).values({
      orderId,
      type: 'review_link_opened',
      actorType: 'client',
      payload: { platform },
      createdAt: when,
    });
  }

  /** The inline keyboard of the client's last Telegram message. */
  function lastKeyboard(deps: TestDeps): InlineButton[][] {
    const call = deps.fakes.clientTelegram.calls.at(-1);
    const markup = call?.payload.reply_markup as { inline_keyboard?: InlineButton[][] } | undefined;
    return markup?.inline_keyboard ?? [];
  }

  it('queued once reminder_days after completed; sent to the messenger with the review buttons', async () => {
    const order = await seedOrder({ completedAt: T0 });

    clock.now = at(3 * DAY - MIN);
    expect((await reminders(t)).byKind.review).toBeUndefined();
    clock.now = at(3 * DAY);
    expect((await reminders(t)).byKind.review).toBe(1);
    clock.now = at(3 * DAY + 2 * HOUR);
    expect((await reminders(t)).byKind.review).toBeUndefined();

    const rows = await reminderRows(order.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ queue: 'notify', name: 'order' });
    expect(rows[0]?.data).toMatchObject({
      orderId: order.id,
      audience: 'client',
      template: 'review_reminder',
    });
    const journal = await db
      .select({ type: orderEvents.type, payload: orderEvents.payload, to: orderEvents.toStatus })
      .from(orderEvents)
      .where(eq(orderEvents.orderId, order.id));
    expect(journal).toEqual([
      {
        type: 'reminder',
        payload: expect.objectContaining({ kind: 'review', template: 'review_reminder' }),
        to: null,
      },
    ]);

    const before = t.fakes.clientTelegram.calls.length;
    expect(await processNotify(job('order', rows[0]!.data), t.deps)).toEqual({
      status: 'sent',
      channel: 'telegram',
    });
    const sent = t.fakes.clientTelegram.sent().at(-1);
    expect(sent?.chatId).toBe(order.chatId);
    const brand = t.deps.env.BRAND_NAME;
    const [{ number }] = (await db
      .select({ number: orders.number })
      .from(orders)
      .where(eq(orders.id, order.id))) as [{ number: string }];
    expect(sent?.text).toBe(
      `${brand} · заказ ${number}\nЕсли будет минутка — оставьте отзыв о ${brand} в Картах. Спасибо!`,
    );
    expect(lastKeyboard(t)).toEqual([
      [
        { text: 'Отзыв в Яндекс Картах', url: `${BASE}/o/${order.token}/review/yandex` },
        { text: 'Отзыв в 2ГИС', url: `${BASE}/o/${order.token}/review/2gis` },
      ],
      [{ text: 'Есть проблема', url: `${BASE}/o/${order.token}#claim` }],
    ]);

    // A second copy of the job (a worker restart): the notifications row stops it.
    expect(await processNotify(job('order', rows[0]!.data), t.deps)).toEqual({
      status: 'duplicate',
      existing: 'sent',
    });
    expect(t.fakes.clientTelegram.calls.length).toBe(before + 1);
    const notes = await db
      .select({ status: notifications.status, template: notifications.template })
      .from(notifications)
      .where(eq(notifications.orderId, order.id));
    expect(notes).toEqual([{ status: 'sent', template: 'review_reminder' }]);

    // The order itself never changes.
    const [after] = await db.select().from(orders).where(eq(orders.id, order.id));
    expect(after?.status).toBe('completed');
    expect(after?.completedAt?.toISOString()).toBe(T0.toISOString());
  });

  it('only when nothing happened: no opened link, no claim after the handover, a messenger, completed', async () => {
    const remind = await seedOrder({});
    const opened = await seedOrder({});
    await openReviewLink(opened.id, '2gis', at(DAY));
    const claimed = await seedOrder({});
    await db.insert(claims).values({
      orderId: claimed.id,
      kind: 'defect',
      openedAt: at(DAY),
      deadlineAt: at(11 * DAY),
      openedVia: 'web',
    });
    // A delay claim before the handover does not count.
    const delayBefore = await seedOrder({});
    const delayOpenedAt = new Date(delayBefore.handedAt.getTime() - DAY);
    await db.insert(claims).values({
      orderId: delayBefore.id,
      kind: 'delay',
      openedAt: delayOpenedAt,
      deadlineAt: new Date(delayOpenedAt.getTime() + 10 * DAY),
      openedVia: 'web',
      closedAt: delayBefore.handedAt,
    });
    const noMessenger = await seedOrder({ messenger: null });
    const blocked = await seedOrder({ messenger: 'blocked' });
    const refunded = await seedOrder({ status: 'refund_pending' });
    const handed = await seedOrder({ status: 'handed', completedAt: null });

    clock.now = at(3 * DAY);
    expect((await reminders(t)).byKind.review).toBe(2);
    expect(await reminderRows(remind.id)).toHaveLength(1);
    expect(await reminderRows(delayBefore.id)).toHaveLength(1);
    for (const quiet of [opened, claimed, noMessenger, blocked, refunded, handed]) {
      expect(await reminderRows(quiet.id)).toEqual([]);
    }
  });

  it('reviews.reminder_days = 0 switches it off; a reminder a week late is dropped', async () => {
    const order = await seedOrder({});
    await db.update(settings).set({ value: 0 }).where(eq(settings.key, 'reviews.reminder_days'));
    clock.now = at(3 * DAY);
    expect((await reminders(t)).byKind.review).toBeUndefined();
    expect(await reminderRows(order.id)).toEqual([]);

    await db.update(settings).set({ value: 3 }).where(eq(settings.key, 'reviews.reminder_days'));
    const old = await seedOrder({ completedAt: at(-8 * DAY) });
    // T0 + 3 days is 11 days after the old order was completed: beyond the 7-day grace.
    expect((await reminders(t)).byKind.review).toBe(1);
    expect(await reminderRows(order.id)).toHaveLength(1);
    expect(await reminderRows(old.id)).toEqual([]);
  });

  it('without a review link nothing is queued', async () => {
    const order = await seedOrder({});
    clock.now = at(3 * DAY);
    expect((await reminders(plain)).byKind.review).toBeUndefined();
    expect(await reminderRows(order.id)).toEqual([]);
  });

  it('checked again before sending: a link opened meanwhile cancels it', async () => {
    const order = await seedOrder({});
    clock.now = at(3 * DAY);
    expect((await reminders(t)).byKind.review).toBe(1);
    const [row] = await reminderRows(order.id);
    await openReviewLink(order.id, 'yandex', at(3 * DAY + MIN));
    const before = t.fakes.clientTelegram.calls.length;
    expect(await processNotify(job('order', row!.data), t.deps)).toEqual({
      status: 'skipped',
      fallbackReason: 'review_not_due:link_opened',
    });
    expect(t.fakes.clientTelegram.calls.length).toBe(before);
    const [note] = await db
      .select({ status: notifications.status, reason: notifications.fallbackReason })
      .from(notifications)
      .where(
        and(eq(notifications.orderId, order.id), eq(notifications.template, 'review_reminder')),
      );
    expect(note).toEqual({ status: 'skipped', reason: 'review_not_due:link_opened' });
  });

  it('how_is_it at completion: review buttons with the links, the phase 1C message without', async () => {
    clock.now = at(30 * DAY);
    const withLinks = await seedOrder({
      status: 'handed',
      completedAt: null,
      handedAt: at(23 * DAY),
      expiresAt: at(30 * DAY - MIN),
    });
    await processHousekeeping({ name: 'timers' }, t.deps);
    const [completed] = await db.select().from(orders).where(eq(orders.id, withLinks.id));
    expect(completed?.status).toBe('completed');
    const [howIsIt] = await db
      .select()
      .from(outbox)
      .where(
        and(
          sql`${outbox.data}->>'orderId' = ${withLinks.id}`,
          sql`${outbox.data}->>'template' = 'how_is_it'`,
        ),
      );
    expect(howIsIt).toBeDefined();
    await processNotify(job('order', howIsIt!.data), t.deps);
    expect(t.fakes.clientTelegram.sent().at(-1)?.text).toContain(
      `Как деталь? Если всё в порядке — оставьте, пожалуйста, отзыв о ${t.deps.env.BRAND_NAME}: он помогает другим водителям найти нас. Если что-то не так — нажмите «Есть проблема», разберёмся.`,
    );
    expect(lastKeyboard(t)).toEqual([
      [
        { text: 'Отзыв в Яндекс Картах', url: `${BASE}/o/${withLinks.token}/review/yandex` },
        { text: 'Отзыв в 2ГИС', url: `${BASE}/o/${withLinks.token}/review/2gis` },
      ],
      [{ text: 'Есть проблема', url: `${BASE}/o/${withLinks.token}#claim` }],
      [{ text: 'Открыть заказ', url: `${BASE}/o/${withLinks.token}` }],
    ]);

    // The same job of another order without the links: the message of phase 1C.
    const without = await seedOrder({
      status: 'handed',
      completedAt: null,
      handedAt: at(23 * DAY),
      expiresAt: at(30 * DAY - MIN),
    });
    await processHousekeeping({ name: 'timers' }, plain.deps);
    const [plainJob] = await db
      .select()
      .from(outbox)
      .where(
        and(
          sql`${outbox.data}->>'orderId' = ${without.id}`,
          sql`${outbox.data}->>'template' = 'how_is_it'`,
        ),
      );
    await processNotify(job('order', plainJob!.data), plain.deps);
    expect(plain.fakes.clientTelegram.sent().at(-1)?.text).toMatch(
      /\nКак деталь\? Если что-то не так, оформите претензию на странице заказа\.$/,
    );
    expect(lastKeyboard(plain)).toEqual([
      [{ text: 'Претензия', url: `${BASE}/o/${without.token}#claim` }],
      [{ text: 'Открыть заказ', url: `${BASE}/o/${without.token}` }],
    ]);
  });
});
