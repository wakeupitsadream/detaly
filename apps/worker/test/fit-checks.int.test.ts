// Step 4 (docs/fit-check.md) in the worker, on a database of its own (housekeeping scans every
// fit check): notify/fit (the sellers card once per request, the SLA reminder, the redraw), the
// 5-minute housekeeping (24-hour expiry, the SLA reminder once, counted in the pickup point's
// working hours only) and the daily retention of the VIN and the comment.
import { randomBytes } from 'node:crypto';
import {
  cartItems,
  carts,
  createDb,
  eq,
  fitChecks,
  notifications,
  outbox,
  settings,
  type Db,
} from '@detaly/db';
import { prepareTestDb } from '@detaly/db/testing';
import { FIT_CHECK_SLA_KEY, offerViewId, type Offer } from '@detaly/domain';
import {
  answerFitCheck,
  createFitCheckRequest,
  fitCardKey,
  fitRefreshKey,
  fitReminderKey,
} from '@detaly/vin';
import { UnrecoverableError, type Job } from 'bullmq';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { processHousekeeping } from '../src/jobs/housekeeping';
import type { FitChecksResult } from '../src/jobs/housekeeping/fit-checks';
import { processNotify } from '../src/jobs/notify';
import { createTestDeps, type TestDeps } from './helpers/test-deps';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
/** Synthetic VIN that passes isValidVin (never a real car). */
const VIN = 'XTA21099012345678';
const ENV = {
  APP_BASE_URL: 'https://detaly.test',
  PICKUP_HOURS: 'Пн–Пт 10:00–19:00',
  TG_SELLER_CHAT_ID: '-100777',
};

/** Local Yekaterinburg wall time (UTC+5): '2026-10-13T18:30' is Tuesday 18:30. */
function local(wall: string): Date {
  return new Date(`${wall}:00+05:00`);
}

const clock = { now: local('2026-10-13T12:00') };

const OFFER: Offer = {
  source: 'rossko',
  brand: 'MANN-FILTER',
  article: 'W 914/2',
  articleNorm: 'W9142',
  name: 'Фильтр масляный',
  group: null,
  isCross: false,
  priceSupplierKop: 62_340,
  stock: {
    stockId: 'MSK7',
    isLocal: false,
    count: 12,
    multiplicity: 1,
    type: null,
    deliveryDays: 3,
    deliveryStart: null,
    deliveryEnd: null,
    extra: null,
    description: null,
  },
};

function job(name: string, data: Record<string, unknown>): Job {
  return { name, data, attemptsMade: 0, opts: { attempts: 5 } } as unknown as Job;
}

describe.skipIf(!inject('workerDatabaseUrl'))('fit checks in the worker', () => {
  let t: TestDeps;
  let db: Db;

  async function request(
    createdAt: Date,
    lines = 1,
  ): Promise<{ requestId: string; ids: string[] }> {
    const [cart] = await db
      .insert(carts)
      .values({ anonToken: randomBytes(32).toString('base64url') })
      .returning();
    const lineIds: string[] = [];
    for (let i = 0; i < lines; i += 1) {
      const offer = { ...OFFER, stock: { ...OFFER.stock, stockId: `MSK${i}` } };
      const [line] = await db
        .insert(cartItems)
        .values({
          cartId: cart!.id,
          offerKey: offerViewId(offer),
          searchArticleNorm: 'W9142',
          brand: offer.brand,
          article: offer.article,
          name: offer.name,
          qty: 1,
          stockId: offer.stock.stockId,
          isLocal: false,
          priceSupplierKop: offer.priceSupplierKop,
          priceClientKop: 80_000,
          markupBp: 2800,
          offerSnapshot: offer,
          fetchedAt: createdAt,
        })
        .returning();
      lineIds.push(line!.id);
    }
    const created = await createFitCheckRequest(db, {
      cartId: cart!.id,
      lineIds,
      vin: VIN,
      comment: 'двигатель 1.6, 2019',
      now: createdAt,
    });
    if (!created.ok) throw new Error(`not created: ${created.reason}`);
    const rows = await db
      .select({ id: fitChecks.id })
      .from(fitChecks)
      .where(eq(fitChecks.requestId, created.requestId));
    return { requestId: created.requestId, ids: rows.map((r) => r.id) };
  }

  async function run(): Promise<FitChecksResult> {
    return (await processHousekeeping({ name: 'fit-checks' }, t.deps)) as FitChecksResult;
  }

  async function outboxOf(key: string) {
    return db.select().from(outbox).where(eq(outbox.jobId, key));
  }

  beforeAll(async () => {
    const { url } = await prepareTestDb({ url: `${inject('workerDatabaseUrl')}_hk_fit` });
    db = createDb(url, { max: 4 });
    t = await createTestDeps({ db, now: () => clock.now, envOverrides: ENV });
  });
  afterAll(async () => {
    await t?.close();
    await db?.close();
  });

  describe('notify/fit', () => {
    it('the card of a request goes once, through postFit, with a notifications row', async () => {
      clock.now = local('2026-10-13T12:00');
      const { requestId } = await request(clock.now, 2);
      const [queued] = await outboxOf(fitCardKey(requestId));
      expect(queued).toMatchObject({ queue: 'notify', name: 'fit' });
      expect(await processNotify(job('fit', queued!.data), t.deps)).toEqual({ status: 'posted' });
      expect(t.fakes.sellerCards.calls.at(-1)).toEqual({
        method: 'postFit',
        input: { requestId, note: null },
      });
      const before = t.fakes.sellerCards.calls.length;
      expect(await processNotify(job('fit', queued!.data), t.deps)).toEqual({
        status: 'duplicate',
      });
      expect(t.fakes.sellerCards.calls).toHaveLength(before);
      const [row] = await db
        .select()
        .from(notifications)
        .where(eq(notifications.dedupeKey, `fit:${requestId}:staff_fit_card:0:telegram`));
      expect(row).toMatchObject({
        template: 'staff_fit_card',
        status: 'sent',
        chatId: '-100777',
        channel: 'telegram',
      });
      // The row and the job never carry the VIN or the comment.
      expect(JSON.stringify(row?.payload)).not.toContain(VIN);
      expect(JSON.stringify(queued?.data)).not.toContain('двигатель');
    });

    it('a card that reached no chat is skipped, never sent; refresh redraws; bad data fails', async () => {
      const { requestId } = await request(local('2026-10-13T12:05'));
      const skipping = await createTestDeps({
        db,
        now: () => clock.now,
        envOverrides: ENV,
        sellerCards: {
          async post() {
            return { status: 'skipped', fallbackReason: 'driver_unavailable' };
          },
          async refresh() {},
          async sendHandoverQr() {},
          async postFit() {
            return { status: 'skipped', fallbackReason: 'driver_unavailable' };
          },
        },
      });
      try {
        expect(
          await processNotify(
            job('fit', { requestId, kind: 'card', key: fitCardKey(requestId) }),
            skipping.deps,
          ),
        ).toEqual({ status: 'skipped', fallbackReason: 'driver_unavailable' });
      } finally {
        await skipping.close();
      }
      const [row] = await db
        .select()
        .from(notifications)
        .where(eq(notifications.dedupeKey, `fit:${requestId}:staff_fit_card:0:telegram`));
      expect(row?.status).toBe('skipped');

      expect(
        await processNotify(
          job('fit', { requestId, kind: 'refresh', key: fitRefreshKey(requestId, 'x') }),
          t.deps,
        ),
      ).toEqual({ status: 'refreshed' });
      expect(t.fakes.sellerCards.calls.at(-1)).toEqual({ method: 'refreshFit', requestId });

      for (const data of [{}, { requestId, kind: 'menu' }, { requestId: 'x', kind: 'card' }]) {
        await expect(processNotify(job('fit', data), t.deps)).rejects.toBeInstanceOf(
          UnrecoverableError,
        );
      }
    });
  });

  describe('housekeeping/fit-checks', () => {
    it('the SLA reminder once, after 60 minutes of working time (not of the night)', async () => {
      // Tuesday 18:30: 30 working minutes today, 30 more on Wednesday from 10:00.
      const sent = local('2026-10-13T18:30');
      const { requestId } = await request(sent, 2);
      const answered = await request(sent);
      await answerFitCheck(db, { id: answered.ids[0]!, answer: 'fits', staffId: null, now: sent });

      // Earlier tests left their own requests in this database: assert by this request's key.
      clock.now = local('2026-10-13T20:00');
      await run();
      expect(await outboxOf(fitReminderKey(requestId))).toEqual([]);
      clock.now = local('2026-10-14T10:29');
      await run();
      expect(await outboxOf(fitReminderKey(requestId))).toEqual([]);

      clock.now = local('2026-10-14T10:30');
      expect((await run()).reminders).toBe(1);
      const [reminder] = await outboxOf(fitReminderKey(requestId));
      expect(reminder?.data).toEqual({
        requestId,
        kind: 'reminder',
        key: fitReminderKey(requestId),
        note: 'Без ответа больше часа — клиент ждёт',
      });
      // Answered requests never get one.
      expect(await outboxOf(fitReminderKey(answered.requestId))).toEqual([]);

      // Once: later runs (and a restarted worker) queue nothing more.
      clock.now = local('2026-10-14T11:30');
      expect((await run()).reminders).toBe(0);
      expect(await outboxOf(fitReminderKey(requestId))).toHaveLength(1);

      // The job re-posts the card with the note while a line waits…
      expect(await processNotify(job('fit', reminder!.data), t.deps)).toEqual({
        status: 'posted',
      });
      expect(t.fakes.sellerCards.calls.at(-1)).toEqual({
        method: 'postFit',
        input: { requestId, note: 'Без ответа больше часа — клиент ждёт' },
      });
      // …and the dedupe row keeps a second copy from posting again.
      expect(await processNotify(job('fit', reminder!.data), t.deps)).toEqual({
        status: 'duplicate',
      });
    });

    it('a reminder for a request answered meanwhile is skipped, not posted', async () => {
      const sent = local('2026-10-14T11:00');
      const { requestId, ids } = await request(sent);
      clock.now = local('2026-10-14T12:05');
      expect((await run()).reminders).toBeGreaterThanOrEqual(1);
      const [reminder] = await outboxOf(fitReminderKey(requestId));
      await answerFitCheck(db, { id: ids[0]!, answer: 'not_fit', staffId: null, now: clock.now });
      const before = t.fakes.sellerCards.calls.length;
      expect(await processNotify(job('fit', reminder!.data), t.deps)).toEqual({
        status: 'skipped',
        fallbackReason: 'fit_answered',
      });
      expect(t.fakes.sellerCards.calls).toHaveLength(before);
    });

    it('a shorter SLA from settings, counted the same way', async () => {
      await db.update(settings).set({ value: 30 }).where(eq(settings.key, FIT_CHECK_SLA_KEY));
      try {
        const sent = local('2026-10-15T12:00');
        const { requestId } = await request(sent);
        clock.now = local('2026-10-15T12:29');
        await run();
        expect(await outboxOf(fitReminderKey(requestId))).toEqual([]);
        clock.now = local('2026-10-15T12:30');
        await run();
        const [reminder] = await outboxOf(fitReminderKey(requestId));
        expect(reminder?.data).toMatchObject({ note: 'Без ответа больше 30 мин — клиент ждёт' });
      } finally {
        await db.update(settings).set({ value: 60 }).where(eq(settings.key, FIT_CHECK_SLA_KEY));
      }
    });

    it('expiry: 24 hours without an answer -> expired, the card redrawn, once', async () => {
      // Friday 18:50: 10 working minutes before closing, so the SLA cannot pass before expiry.
      const sent = local('2026-10-16T18:50');
      const { requestId, ids } = await request(sent, 2);
      await answerFitCheck(db, { id: ids[1]!, answer: 'call_needed', staffId: null, now: sent });
      clock.now = new Date(sent.getTime() + DAY - MIN);
      await run();
      const before = await db.select().from(fitChecks).where(eq(fitChecks.requestId, requestId));
      expect(before.map((r) => r.status).sort()).toEqual(['call_needed', 'pending']);

      clock.now = new Date(sent.getTime() + DAY);
      const result = await run();
      expect(result.expired).toBeGreaterThanOrEqual(1);
      const after = await db.select().from(fitChecks).where(eq(fitChecks.requestId, requestId));
      expect(after.map((r) => r.status).sort()).toEqual(['call_needed', 'expired']);
      const [refresh] = await outboxOf(fitRefreshKey(requestId, 'expired'));
      expect(refresh?.data).toEqual({
        requestId,
        kind: 'refresh',
        key: fitRefreshKey(requestId, 'expired'),
      });
      // An expired request never gets the SLA reminder afterwards, and expiry runs once.
      clock.now = new Date(sent.getTime() + DAY + HOUR);
      expect((await run()).expired).toBe(0);
      expect(await outboxOf(fitReminderKey(requestId))).toEqual([]);
    });
  });

  describe('retention', () => {
    it('VIN and comment cleared 90 days after the request, the check itself stays', async () => {
      clock.now = local('2026-10-17T12:00');
      const old = await request(new Date(clock.now.getTime() - 91 * DAY));
      const young = await request(new Date(clock.now.getTime() - 89 * DAY));
      await processHousekeeping({ name: 'retention' }, t.deps);
      const [cleared] = await db.select().from(fitChecks).where(eq(fitChecks.id, old.ids[0]!));
      expect(cleared).toMatchObject({ vin: null, comment: null, brand: 'MANN-FILTER' });
      const [kept] = await db.select().from(fitChecks).where(eq(fitChecks.id, young.ids[0]!));
      expect(kept).toMatchObject({ vin: VIN, comment: 'двигатель 1.6, 2019' });
      // Two days later the young one goes too.
      clock.now = new Date(clock.now.getTime() + 2 * DAY);
      await processHousekeeping({ name: 'retention' }, t.deps);
      const [later] = await db.select().from(fitChecks).where(eq(fitChecks.id, young.ids[0]!));
      expect(later).toMatchObject({ vin: null, comment: null, status: 'pending' });
    });
  });
});
