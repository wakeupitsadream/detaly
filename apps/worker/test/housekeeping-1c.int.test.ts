// Phase 1C housekeeping on a database of its own (docs/phase-1c-implementation.md section 7.3):
// the VIN reminder after 4 hours (at the opening hours when it falls at night), the claim
// deadline 2 days before, the installation reminder 24 hours before a confirmed slot — each
// exactly once; the 90-day retention of VIN photos; the ready reminders of days 3/6/9 (phase 1B
// regression) now with the packaging photo.
//
// Reminders and retention scan every row of the database, hence `${DATABASE_URL_TEST}_worker_hk_1c`
// (migrated and seeded like `_worker`); the clock starts in 2020.
import { randomBytes, randomInt, randomUUID } from 'node:crypto';
import {
  asc,
  claims,
  createDb,
  eq,
  installBookings,
  messengerBindings,
  orderItems,
  orderPhotos,
  orders,
  outbox,
  sql,
  users,
  vinRequests,
  type Db,
} from '@detaly/db';
import { prepareTestDb } from '@detaly/db/testing';
import type { OrderStatus, VinRequestStatus } from '@detaly/domain';
import { createMemoryFileStore, type FileStore } from '@detaly/files';
import type { Job } from 'bullmq';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { processHousekeeping } from '../src/jobs/housekeeping';
import type { RemindersResult } from '../src/jobs/housekeeping/reminders';
import { nextOpeningAt } from '../src/jobs/housekeeping/opening';
import type { RetentionResult } from '../src/jobs/housekeeping/retention';
import { processNotify } from '../src/jobs/notify';
import { createTestDeps, type TestDeps } from './helpers/test-deps';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
/** Wednesday 10 June 2020, 11:00 in Orenburg (UTC+5). */
const T0 = new Date('2020-06-10T06:00:00.000Z');

const ENV = {
  APP_BASE_URL: 'https://detaly.test',
  PICKUP_POINT_NAME: 'Пункт выдачи',
  PICKUP_ADDRESS: 'ул. Тестовая, 1',
  PICKUP_HOURS: 'Ежедневно 9:00-19:00',
  INSTALL_PARTNER_NAME: 'Тестовый сервис',
};

const clock = { now: new Date(T0) };
const at = (ms: number) => new Date(T0.getTime() + ms);

function job(name: string, data: Record<string, unknown>): Job {
  return { name, data, attemptsMade: 0, opts: { attempts: 5 } } as unknown as Job;
}

function randomPhone(): string {
  return `+79${String(randomInt(0, 1_000_000_000)).padStart(9, '0')}`;
}

async function seedOrder(db: Db, input: { status: OrderStatus; receivedAt?: Date | null }) {
  const [user] = await db.insert(users).values({ phone: randomPhone() }).returning();
  const [order] = await db
    .insert(orders)
    .values({
      userId: user!.id,
      accessToken: randomBytes(32).toString('base64url'),
      status: input.status,
      paymentScheme: 'prepay',
      subtotalKop: 128_000,
      totalKop: 128_000,
      itemsHash: 'test',
      pickupCode: '4821',
      receivedAt: input.receivedAt ?? null,
      createdAt: at(-DAY),
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
    etaDate: '2020-06-12',
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
    state: 'arrived',
  });
  return { orderId: order!.id, number: order!.number, userId: user!.id };
}

async function seedVin(
  db: Db,
  input: { createdAt: Date; status?: VinRequestStatus; photos?: string[]; proposalCount?: number },
) {
  const phone = randomPhone();
  const [user] = await db.insert(users).values({ phone }).returning();
  const [row] = await db
    .insert(vinRequests)
    .values({
      userId: user!.id,
      phone,
      vin: 'XTA21099012345678',
      needText: 'Фильтр масляный',
      status: input.status ?? 'new',
      photos: input.photos ?? [],
      proposalCount: input.proposalCount ?? 0,
      createdAt: input.createdAt,
    })
    .returning();
  return row!;
}

async function outboxRow(db: Db, jobId: string) {
  return db.select().from(outbox).where(eq(outbox.jobId, jobId));
}

async function reminders(t: TestDeps): Promise<RemindersResult> {
  return (await processHousekeeping({ name: 'reminders' }, t.deps)) as RemindersResult;
}

async function retention(t: TestDeps): Promise<RetentionResult> {
  return (await processHousekeeping({ name: 'retention' }, t.deps)) as RetentionResult;
}

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 74, 70, 73, 70, 0xff, 0xd9]);

describe('nextOpeningAt (PICKUP_HOURS)', () => {
  const hours = 'Пн-Пт 9:00-19:00, Сб 10:00-16:00';
  it('open now -> now; evening -> next morning; Saturday evening -> Monday', () => {
    // Wednesday 11:00 local.
    expect(nextOpeningAt(T0, hours)).toEqual(T0);
    // Wednesday 20:00 local -> Thursday 09:00 local (04:00Z).
    expect(nextOpeningAt(new Date('2020-06-10T15:00:00Z'), hours)).toEqual(
      new Date('2020-06-11T04:00:00Z'),
    );
    // Wednesday 07:30 local -> 09:00 the same day.
    expect(nextOpeningAt(new Date('2020-06-10T02:30:00Z'), hours)).toEqual(
      new Date('2020-06-10T04:00:00Z'),
    );
    // Saturday 13 June 17:00 local -> Monday 15 June 09:00 local.
    expect(nextOpeningAt(new Date('2020-06-13T12:00:00Z'), hours)).toEqual(
      new Date('2020-06-15T04:00:00Z'),
    );
    // Not understood or empty: now (better a night reminder than none).
    expect(nextOpeningAt(T0, 'по договорённости')).toEqual(T0);
    expect(nextOpeningAt(T0, undefined)).toEqual(T0);
  });
});

describe.skipIf(!inject('workerDatabaseUrl'))('housekeeping 1C (worker-ops)', () => {
  let t: TestDeps;
  let db: Db;

  beforeAll(async () => {
    const { url } = await prepareTestDb({ url: `${inject('workerDatabaseUrl')}_hk_1c` });
    db = createDb(url, { max: 4 });
    t = await createTestDeps({ db, now: () => clock.now, envOverrides: ENV });
  });
  afterAll(async () => {
    await t?.close();
    await db?.close();
  });

  describe('reminders', () => {
    it('VIN without an answer: one card after 4 h; at night it waits for the opening', async () => {
      clock.now = T0;
      const day = await seedVin(db, { createdAt: T0 });
      const answered = await seedVin(db, {
        createdAt: T0,
        status: 'offered',
        proposalCount: 1,
      });
      const taken = await seedVin(db, { createdAt: T0, status: 'in_work' });

      clock.now = at(4 * HOUR - MIN);
      expect((await reminders(t)).byKind.vin).toBeUndefined();

      clock.now = at(4 * HOUR);
      expect((await reminders(t)).byKind.vin).toBe(2);
      for (const request of [day, taken]) {
        const [row] = await outboxRow(db, `reminder:vin:${request.id}:4h`);
        expect(row).toMatchObject({ queue: 'notify', name: 'vin' });
        expect(row?.data).toEqual({
          vinRequestId: request.id,
          audience: 'sellers',
          key: `reminder:vin:${request.id}:4h`,
          n: 1,
          note: 'Без ответа 4 ч',
          reminder: true,
        });
        // 15:00 in Orenburg: the point is open, the card goes now.
        expect(row?.availableAt.toISOString()).toBe(at(4 * HOUR).toISOString());
      }
      expect(await outboxRow(db, `reminder:vin:${answered.id}:4h`)).toEqual([]);
      const [reminded] = await db.select().from(vinRequests).where(eq(vinRequests.id, day.id));
      expect(reminded?.remindedAt?.toISOString()).toBe(at(4 * HOUR).toISOString());

      clock.now = at(9 * HOUR);
      expect((await reminders(t)).byKind.vin).toBeUndefined();

      // A request at 17:00 local: 4 hours later it is 21:00, the card waits for 09:00.
      const evening = await seedVin(db, { createdAt: at(6 * HOUR) });
      clock.now = at(10 * HOUR);
      expect((await reminders(t)).byKind.vin).toBe(1);
      const [night] = await outboxRow(db, `reminder:vin:${evening.id}:4h`);
      expect(night?.availableAt.toISOString()).toBe('2020-06-11T04:00:00.000Z');

      // The job itself: the card through postVin with the note.
      expect(await processNotify(job('vin', night!.data), t.deps)).toEqual({ status: 'posted' });
      expect(t.fakes.sellerCards.calls.at(-1)).toEqual({
        method: 'postVin',
        input: { vinRequestId: evening.id, note: 'Без ответа 4 ч' },
      });
    });

    it('claim deadline: the owner once, 2 days before; decided claims are quiet', async () => {
      clock.now = at(DAY);
      const order = await seedOrder(db, { status: 'handed' });
      const openedAt = at(DAY);
      const [open] = await db
        .insert(claims)
        .values({
          orderId: order.orderId,
          kind: 'defect',
          openedAt,
          deadlineAt: new Date(openedAt.getTime() + 10 * DAY),
          openedVia: 'web',
        })
        .returning();
      const other = await seedOrder(db, { status: 'handed' });
      await db.insert(claims).values({
        orderId: other.orderId,
        kind: 'refusal',
        openedAt,
        deadlineAt: new Date(openedAt.getTime() + 10 * DAY),
        decision: 'reject',
        decisionText: 'Деталь была в употреблении',
        decidedAt: openedAt,
      });

      clock.now = new Date(openedAt.getTime() + 8 * DAY - MIN);
      expect((await reminders(t)).byKind.claim_deadline).toBeUndefined();
      clock.now = new Date(openedAt.getTime() + 8 * DAY);
      expect((await reminders(t)).byKind.claim_deadline).toBe(1);
      const key = `reminder:${order.orderId}:claim:${open!.id}`;
      const [row] = await outboxRow(db, key);
      expect(row?.data).toMatchObject({
        orderId: order.orderId,
        audience: 'owner',
        template: 'staff_claim_deadline',
        deadlineDate: '2020-06-21',
      });
      clock.now = new Date(openedAt.getTime() + 9 * DAY);
      expect((await reminders(t)).byKind.claim_deadline).toBeUndefined();
      // The decided claim of the other order got no reminder.
      const quiet = await db
        .select({ jobId: outbox.jobId })
        .from(outbox)
        .where(sql`starts_with(${outbox.jobId}, ${`reminder:${other.orderId}:claim:`})`);
      expect(quiet).toEqual([]);

      await processNotify(job('order', row!.data), t.deps);
      const alert = t.fakes.alerts.calls.at(-1);
      expect(alert?.audience).toBe('owner');
      expect(alert?.text).toContain(`Претензия по заказу ${order.number}: брак.`);
      expect(alert?.text).toContain('Ответить до 21 июня');
    });

    it('installation: the client once, 24 h before a confirmed slot', async () => {
      clock.now = at(2 * DAY);
      const order = await seedOrder(db, { status: 'ready', receivedAt: at(2 * DAY) });
      const chatId = String(randomInt(1e8, 9e8));
      await db.insert(messengerBindings).values({
        userId: order.userId,
        channel: 'telegram',
        externalUserId: chatId,
        chatId,
        isPrimary: true,
      });
      const slotAt = at(5 * DAY + 3 * HOUR); // Monday 15 June, 14:00 local
      const [booking] = await db
        .insert(installBookings)
        .values({
          orderId: order.orderId,
          userId: order.userId,
          slotAt,
          status: 'confirmed',
          confirmedAt: at(2 * DAY),
          createdVia: 'web',
        })
        .returning();
      const pending = await seedOrder(db, { status: 'ready', receivedAt: at(2 * DAY) });
      await db.insert(installBookings).values({
        orderId: pending.orderId,
        userId: pending.userId,
        slotAt,
        status: 'requested',
      });

      clock.now = new Date(slotAt.getTime() - DAY - MIN);
      expect((await reminders(t)).byKind.install).toBeUndefined();
      clock.now = new Date(slotAt.getTime() - DAY);
      expect((await reminders(t)).byKind.install).toBe(1);
      clock.now = new Date(slotAt.getTime() - HOUR);
      expect((await reminders(t)).byKind.install).toBeUndefined();
      const [saved] = await db
        .select()
        .from(installBookings)
        .where(eq(installBookings.id, booking!.id));
      expect(saved?.remindedAt?.toISOString()).toBe(new Date(slotAt.getTime() - DAY).toISOString());

      const [row] = await outboxRow(db, `reminder:${order.orderId}:install:${booking!.id}`);
      expect(row?.data).toMatchObject({ audience: 'client', template: 'install_reminder' });
      expect(await processNotify(job('order', row!.data), t.deps)).toEqual({
        status: 'sent',
        channel: 'telegram',
      });
      const sent = t.fakes.clientTelegram.sent().at(-1);
      expect(sent?.chatId).toBe(chatId);
      expect(sent?.text).toContain(
        'Напоминаем о записи на установку: пн 15 июн 14:00, Тестовый сервис.',
      );
      expect(sent?.text).toContain('оплачивается в сервисе по его чеку');
    });

    it('regression 1B: ready reminders on days 3, 6 and 9 exactly once, now with the photo', async () => {
      const receivedAt = at(20 * DAY);
      clock.now = receivedAt;
      const order = await seedOrder(db, { status: 'ready', receivedAt });
      const chatId = String(randomInt(1e8, 9e8));
      await db.insert(messengerBindings).values({
        userId: order.userId,
        channel: 'telegram',
        externalUserId: chatId,
        chatId,
        isPrimary: true,
      });
      const key = `order/${order.orderId}/${randomUUID()}.jpg`;
      await t.deps.files.put(key, JPEG);
      await db
        .insert(orderPhotos)
        .values({ orderId: order.orderId, kind: 'packaging', s3Key: key });

      const keys = (n: number) => `reminder:${order.orderId}:ready:${n}`;
      for (const dayN of [3, 6, 9]) {
        clock.now = new Date(receivedAt.getTime() + dayN * DAY - MIN);
        await reminders(t);
        expect(await outboxRow(db, keys(dayN)), `before day ${dayN}`).toEqual([]);
        clock.now = new Date(receivedAt.getTime() + dayN * DAY);
        await reminders(t);
        clock.now = new Date(receivedAt.getTime() + dayN * DAY + 2 * HOUR);
        await reminders(t);
        const rows = await outboxRow(db, keys(dayN));
        expect(rows, `day ${dayN}`).toHaveLength(1);
        expect(rows[0]?.data).toMatchObject({ template: 'arrived', readyDays: dayN });
      }
      const all = await db
        .select({ jobId: outbox.jobId })
        .from(outbox)
        .where(sql`starts_with(${outbox.jobId}, ${`reminder:${order.orderId}:`})`)
        .orderBy(asc(outbox.jobId));
      expect(all.map((r) => r.jobId)).toEqual([keys(3), keys(6), keys(9)]);

      const [day9] = await outboxRow(db, keys(9));
      const before = t.fakes.clientTelegram.calls.length;
      expect(await processNotify(job('order', day9!.data), t.deps)).toEqual({
        status: 'sent',
        channel: 'telegram',
      });
      const call = t.fakes.clientTelegram.calls.slice(before);
      expect(call.map((c) => c.method)).toEqual(['sendPhoto']);
      const caption = String(call[0]?.payload.caption);
      expect(caption).toContain('Заказ ждёт вас 9 дн.');
      expect(caption).toContain('По оферте заказ хранится 10 дн., затем возврат денег.');
      expect(caption).toContain('Код выдачи: 4821');
    });
  });

  describe('retention', () => {
    async function storeVinPhotos(requestId: string, count: number): Promise<string[]> {
      const keys: string[] = [];
      for (let i = 0; i < count; i += 1) {
        const key = `vin/${requestId}/${randomUUID()}.jpg`;
        await t.deps.files.put(key, JPEG);
        keys.push(key);
      }
      await db.update(vinRequests).set({ photos: keys }).where(eq(vinRequests.id, requestId));
      return keys;
    }

    it('day 91 deletes the objects and the keys, day 89 keeps them; a second run finds nothing', async () => {
      clock.now = at(200 * DAY);
      const old = await seedVin(db, { createdAt: at(200 * DAY - 91 * DAY), status: 'converted' });
      const young = await seedVin(db, { createdAt: at(200 * DAY - 89 * DAY), status: 'closed' });
      const oldKeys = await storeVinPhotos(old.id, 2);
      const youngKeys = await storeVinPhotos(young.id, 1);

      expect(await retention(t)).toMatchObject({ deleted: 2, requests: 1, failed: 0 });
      const stored = t.fakes.files.keys();
      for (const key of oldKeys) expect(stored).not.toContain(key);
      expect(stored).toContain(youngKeys[0]);
      const [cleared] = await db.select().from(vinRequests).where(eq(vinRequests.id, old.id));
      expect(cleared?.photos).toEqual([]);
      expect(cleared?.photosDeletedAt?.toISOString()).toBe(at(200 * DAY).toISOString());
      const [kept] = await db.select().from(vinRequests).where(eq(vinRequests.id, young.id));
      expect(kept?.photos).toEqual(youngKeys);
      expect(kept?.photosDeletedAt).toBeNull();

      expect(await retention(t)).toEqual({ deleted: 0, requests: 0, failed: 0, waiting: 0 });

      // Two days later the young one is 91 days old too.
      clock.now = at(202 * DAY);
      expect(await retention(t)).toMatchObject({ deleted: 1, requests: 1 });
      expect(t.fakes.files.keys()).not.toContain(youngKeys[0]);
    });

    it('a failed key keeps its request for the next run; FILES_STORAGE=none waits', async () => {
      clock.now = at(300 * DAY);
      const request = await seedVin(db, { createdAt: at(300 * DAY - 100 * DAY) });
      const keys = await storeVinPhotos(request.id, 2);
      const memory = t.fakes.files;
      const flaky: FileStore = {
        kind: 'memory',
        put: (key, bytes) => memory.put(key, bytes),
        get: (key) => memory.get(key),
        async delete(key) {
          if (key === keys[1]) throw new Error('s3: 503');
          await memory.delete(key);
        },
      };
      const flakyDeps = { ...t.deps, files: flaky };
      expect(await processHousekeeping({ name: 'retention' }, flakyDeps)).toMatchObject({
        deleted: 1,
        requests: 0,
        failed: 1,
      });
      const [waiting] = await db.select().from(vinRequests).where(eq(vinRequests.id, request.id));
      expect(waiting?.photos).toEqual(keys);
      expect(waiting?.photosDeletedAt).toBeNull();

      const none = createMemoryFileStore();
      const noneDeps = { ...t.deps, files: { ...none, kind: 'none' as const } };
      expect(await processHousekeeping({ name: 'retention' }, noneDeps)).toMatchObject({
        deleted: 0,
        requests: 0,
        waiting: 1,
      });

      expect(await retention(t)).toMatchObject({ deleted: 2, requests: 1, failed: 0 });
      expect(t.fakes.files.keys().filter((k) => keys.includes(k))).toEqual([]);
    });
  });
});
