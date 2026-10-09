// Step 4 (docs/fit-check.md): fit checks on the project database (`${DATABASE_URL_TEST}_vin`) —
// the request from the caller's own cart only, one sellers card per request (outbox notify/fit),
// the master's answers (once), the analog found and priced on the Rossko fixtures, expiry,
// cancellation, retention and the reads of the cart page and the sellers card.
import { randomBytes } from 'node:crypto';
import {
  cartItems,
  carts,
  createDb,
  eq,
  fitChecks,
  inArray,
  outbox,
  settings,
  sql,
  staff,
  type Db,
} from '@detaly/db';
import {
  basePricingConfig,
  DEFAULT_EXCLUDED_RULES,
  FIT_CHECK_SLA_KEY,
  offerViewId,
  type EtaSettings,
  type MarkupRule,
  type Offer,
} from '@detaly/domain';
import { createFixtureCaller, createRosskoClient, createUnlimitedLimiter } from '@detaly/rossko';
import { v7 as uuidv7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import {
  answerFitAnalog,
  answerFitCheck,
  cancelFitChecks,
  createFitCheckRequest,
  expireFitChecks,
  FIT_ANALOG_NOT_FOUND,
  fitCardKey,
  loadCartFitChecks,
  loadFitRequestForStaff,
  loadFitSlaMinutes,
  resolveFitAnalog,
  retainFitChecks,
  type FitAnalog,
} from '../src';

const DB_URL = inject('vinDatabaseUrl');

/** Synthetic VINs that pass isValidVin (never a real car). */
const VIN = 'XTA21099012345678';
const VIN2 = 'XTA21099087654321';
const RULES: MarkupRule[] = [{ fromKop: 0, toKop: null, localBp: 2800, orderBp: 2800 }];
const ETA: EtaSettings = { bufferDays: 1, invoiceLagDays: 0, prepayInvoice: false };
const T0 = new Date('2026-10-08T07:00:00.000Z');
const DAY_MS = 24 * 60 * 60 * 1000;

const rossko = createRosskoClient({
  caller: createFixtureCaller(),
  key1: 'k1',
  key2: 'k2',
  localStockIds: ['ORB1'],
  limiter: createUnlimitedLimiter(),
  allowCheckout: false,
});

async function offerOf(article: string, brand: string): Promise<Offer> {
  const { offers } = await rossko.search(article);
  const offer = offers.find((o) => o.brand === brand && !o.isCross) ?? offers[0];
  if (!offer) throw new Error(`no fixture offer ${article}`);
  return offer;
}

describe.skipIf(!DB_URL)('fit checks', () => {
  let db: Db;
  let staffId: string;

  async function cartWith(...offers: Offer[]): Promise<{ cartId: string; lineIds: string[] }> {
    const [cart] = await db
      .insert(carts)
      .values({ anonToken: randomBytes(32).toString('base64url') })
      .returning();
    const lineIds: string[] = [];
    for (const offer of offers) {
      const [line] = await db
        .insert(cartItems)
        .values({
          cartId: cart!.id,
          offerKey: offerViewId(offer),
          searchArticleNorm: offer.articleNorm,
          brand: offer.brand,
          article: offer.article,
          name: offer.name,
          qty: 1,
          stockId: offer.stock.stockId,
          isLocal: offer.stock.isLocal,
          priceSupplierKop: offer.priceSupplierKop,
          priceClientKop: offer.priceSupplierKop * 2,
          markupBp: 2800,
          offerSnapshot: offer,
          fetchedAt: T0,
        })
        .returning();
      lineIds.push(line!.id);
    }
    return { cartId: cart!.id, lineIds };
  }

  async function rowsOf(requestId: string) {
    return db.select().from(fitChecks).where(eq(fitChecks.requestId, requestId));
  }

  beforeAll(async () => {
    db = createDb(DB_URL as string, { max: 4 });
    const [member] = await db
      .insert(staff)
      .values({
        name: 'Лёша',
        role: 'seller',
        tgUserId: 9_100_000_000 + Math.floor(Math.random() * 1e6),
      })
      .returning();
    staffId = member!.id;
  });

  afterAll(async () => {
    await db?.close();
  });

  it('creates a pending line per ticked line and ONE sellers card per request', async () => {
    const knecht = await offerOf('OC90', 'Knecht');
    const trw = await offerOf('GDB1330', 'TRW');
    const { cartId, lineIds } = await cartWith(knecht, trw);
    const result = await createFitCheckRequest(db, {
      cartId,
      // Upper case ids from a form are the same lines.
      lineIds: lineIds.map((id) => id.toUpperCase()),
      vin: VIN,
      comment: '  двигатель 1.6,   2019 ',
      now: T0,
    });
    expect(result).toMatchObject({ ok: true, lines: 2, skipped: 0 });
    if (!result.ok) return;
    const rows = await rowsOf(result.requestId);
    expect(rows.map((r) => r.brand).sort()).toEqual(['Knecht', 'TRW']);
    for (const row of rows) {
      expect(row).toMatchObject({
        status: 'pending',
        vin: VIN,
        comment: 'двигатель 1.6, 2019',
        cartId,
      });
      expect(row.expiresAt.getTime() - row.createdAt.getTime()).toBe(DAY_MS);
    }
    const jobs = await db
      .select()
      .from(outbox)
      .where(sql`${outbox.jobId} like ${`fit:${result.requestId}:%`}`);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      queue: 'notify',
      name: 'fit',
      jobId: fitCardKey(result.requestId),
      data: { requestId: result.requestId, kind: 'card', key: fitCardKey(result.requestId) },
    });
    // The job data never carries the VIN or the comment.
    expect(JSON.stringify(jobs[0]?.data)).not.toContain(VIN);

    // The same lines again while they wait: nothing new; a new line goes alone.
    expect(
      await createFitCheckRequest(db, { cartId, lineIds, vin: VIN, comment: null, now: T0 }),
    ).toEqual({ ok: false, reason: 'pending' });
  });

  it('never trusts line ids: a line of another cart refuses the whole request', async () => {
    const knecht = await offerOf('OC90', 'Knecht');
    const mine = await cartWith(knecht);
    const theirs = await cartWith(knecht);
    const before = await db.select().from(fitChecks).where(eq(fitChecks.cartId, mine.cartId));
    expect(
      await createFitCheckRequest(db, {
        cartId: mine.cartId,
        lineIds: [...mine.lineIds, ...theirs.lineIds],
        vin: VIN,
        comment: null,
        now: T0,
      }),
    ).toEqual({ ok: false, reason: 'foreign_lines' });
    expect(
      await createFitCheckRequest(db, {
        cartId: mine.cartId,
        lineIds: ['not-a-uuid'],
        vin: VIN,
        comment: null,
        now: T0,
      }),
    ).toEqual({ ok: false, reason: 'foreign_lines' });
    const after = await db.select().from(fitChecks).where(eq(fitChecks.cartId, mine.cartId));
    expect(after).toHaveLength(before.length);
    expect(
      await db.select().from(fitChecks).where(inArray(fitChecks.cartItemId, theirs.lineIds)),
    ).toEqual([]);
  });

  it('refuses a bad VIN, a long comment, no lines and a converted cart', async () => {
    const knecht = await offerOf('OC90', 'Knecht');
    const { cartId, lineIds } = await cartWith(knecht);
    const base = { cartId, lineIds, vin: VIN, comment: null, now: T0 };
    expect(await createFitCheckRequest(db, { ...base, vin: 'XTA2109901234567O' })).toEqual({
      ok: false,
      reason: 'vin',
    });
    expect(await createFitCheckRequest(db, { ...base, comment: 'x'.repeat(201) })).toEqual({
      ok: false,
      reason: 'comment',
    });
    expect(await createFitCheckRequest(db, { ...base, lineIds: [] })).toEqual({
      ok: false,
      reason: 'no_lines',
    });
    await db.update(carts).set({ status: 'converted' }).where(eq(carts.id, cartId));
    expect(await createFitCheckRequest(db, base)).toEqual({ ok: false, reason: 'no_lines' });
  });

  it('an answer once: a second press changes nothing and says what it is', async () => {
    const knecht = await offerOf('OC90', 'Knecht');
    const { cartId, lineIds } = await cartWith(knecht);
    const created = await createFitCheckRequest(db, {
      cartId,
      lineIds,
      vin: VIN,
      comment: null,
      now: T0,
    });
    if (!created.ok) throw new Error('not created');
    const [row] = await rowsOf(created.requestId);
    const at = new Date(T0.getTime() + 20 * 60_000);
    const first = await answerFitCheck(db, { id: row!.id, answer: 'fits', staffId, now: at });
    expect(first).toMatchObject({ ok: true, check: { status: 'fits', answeredBy: staffId } });
    const second = await answerFitCheck(db, {
      id: row!.id,
      answer: 'not_fit',
      staffId,
      now: new Date(at.getTime() + 60_000),
    });
    expect(second).toEqual({ ok: false, reason: 'answered', status: 'fits' });
    const [stored] = await db.select().from(fitChecks).where(eq(fitChecks.id, row!.id));
    expect(stored?.answeredAt?.toISOString()).toBe(at.toISOString());
    expect(await answerFitCheck(db, { id: uuidv7(), answer: 'fits', staffId, now: at })).toEqual({
      ok: false,
      reason: 'not_found',
    });
    expect(await answerFitCheck(db, { id: 'x', answer: 'fits', staffId: null, now: at })).toEqual({
      ok: false,
      reason: 'not_found',
    });
  });

  describe('the analog «БРЕНД АРТИКУЛ»', () => {
    const resolve = (text: string, original = { brand: 'MANN-FILTER', article: 'W 914/2' }) =>
      resolveFitAnalog({
        text,
        original,
        search: async (article) => (await rossko.search(article)).offers,
        pricing: basePricingConfig(RULES),
        excludedRules: DEFAULT_EXCLUDED_RULES,
        eta: ETA,
        now: T0,
      });

    it('found at the supplier and priced with priceOffer', async () => {
      const result = await resolve('KNECHT OC90');
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      // Knecht OC 90 at the Orenburg stock: 412,50 ₽ × 1.28 up to the ruble = 528 ₽.
      expect(result.analog).toMatchObject({
        brand: 'Knecht',
        article: 'OC 90',
        name: 'Фильтр масляный',
        priceClientKop: 52_800,
      });
      expect(result.analog.offer.stock.isLocal).toBe(true);
    });

    it('not found -> «Не нашёл у поставщика — проверьте артикул»', async () => {
      for (const text of ['NOTFOUND 123', 'KNECHT W9142X', 'BOSH OC90']) {
        expect(await resolve(text)).toEqual({
          ok: false,
          reason: 'not_found',
          message: FIT_ANALOG_NOT_FOUND,
        });
      }
    });

    it('the same part, a bad format and a supplier failure are refused', async () => {
      expect(await resolve('KNECHT OC90', { brand: 'Knecht', article: 'OC 90' })).toMatchObject({
        ok: false,
        reason: 'same',
      });
      expect(await resolve('   ')).toMatchObject({ ok: false, reason: 'parse' });
      expect(await resolve('OC90')).toMatchObject({ ok: false, reason: 'parse' });
      const failing = await resolveFitAnalog({
        text: 'KNECHT OC90',
        original: { brand: 'MANN-FILTER', article: 'W 914/2' },
        search: async () => {
          throw new Error('timeout');
        },
        pricing: basePricingConfig(RULES),
        excludedRules: DEFAULT_EXCLUDED_RULES,
        eta: ETA,
        now: T0,
      });
      expect(failing).toMatchObject({ ok: false, reason: 'unavailable' });
    });

    it('answerFitAnalog stores the analog and its offer, once', async () => {
      const mann = await offerOf('W9142', 'MANN-FILTER');
      const { cartId, lineIds } = await cartWith(mann);
      const created = await createFitCheckRequest(db, {
        cartId,
        lineIds,
        vin: VIN,
        comment: null,
        now: T0,
      });
      if (!created.ok) throw new Error('not created');
      const [row] = await rowsOf(created.requestId);
      const resolved = await resolve('KNECHT OC90');
      if (!resolved.ok) throw new Error('not resolved');
      const analog: FitAnalog = resolved.analog;
      const saved = await answerFitAnalog(db, { id: row!.id, analog, staffId, now: T0 });
      expect(saved).toMatchObject({
        ok: true,
        check: { status: 'analog', analogBrand: 'Knecht', analogArticle: 'OC 90' },
      });
      if (saved.ok) expect(saved.check.analogOffer?.articleNorm).toBe('OC90');
      expect(await answerFitAnalog(db, { id: row!.id, analog, staffId, now: T0 })).toEqual({
        ok: false,
        reason: 'answered',
        status: 'analog',
      });
    });
  });

  it('expiry: pending past 24 hours -> expired, once; answers stay', async () => {
    const knecht = await offerOf('OC90', 'Knecht');
    const trw = await offerOf('GDB1330', 'TRW');
    const { cartId, lineIds } = await cartWith(knecht, trw);
    const created = await createFitCheckRequest(db, {
      cartId,
      lineIds,
      vin: VIN,
      comment: null,
      now: T0,
    });
    if (!created.ok) throw new Error('not created');
    const rows = await rowsOf(created.requestId);
    await answerFitCheck(db, { id: rows[0]!.id, answer: 'call_needed', staffId, now: T0 });
    expect(await expireFitChecks(db, new Date(T0.getTime() + DAY_MS - 1))).not.toContain(
      created.requestId,
    );
    expect(await expireFitChecks(db, new Date(T0.getTime() + DAY_MS))).toContain(created.requestId);
    expect(await expireFitChecks(db, new Date(T0.getTime() + 2 * DAY_MS))).not.toContain(
      created.requestId,
    );
    const after = await rowsOf(created.requestId);
    expect(after.map((r) => r.status).sort()).toEqual(['call_needed', 'expired']);
  });

  it('cancellation of lines that leave the cart: pending only, with a card redraw', async () => {
    const knecht = await offerOf('OC90', 'Knecht');
    const trw = await offerOf('GDB1330', 'TRW');
    const { cartId, lineIds } = await cartWith(knecht, trw);
    const created = await createFitCheckRequest(db, {
      cartId,
      lineIds,
      vin: VIN,
      comment: null,
      now: T0,
    });
    if (!created.ok) throw new Error('not created');
    const rows = await rowsOf(created.requestId);
    const answered = rows.find((r) => r.cartItemId === lineIds[1])!;
    await answerFitCheck(db, { id: answered.id, answer: 'fits', staffId, now: T0 });
    expect(await cancelFitChecks(db, { cartId, cartItemIds: lineIds })).toBe(1);
    const after = await rowsOf(created.requestId);
    expect(Object.fromEntries(after.map((r) => [r.cartItemId, r.status]))).toEqual({
      [lineIds[0]!]: 'cancelled',
      [lineIds[1]!]: 'fits',
    });
    const refresh = await db
      .select()
      .from(outbox)
      .where(sql`${outbox.jobId} like ${`fit:${created.requestId}:refresh:%`}`);
    expect(refresh).toHaveLength(1);
    expect(refresh[0]?.data).toMatchObject({ kind: 'refresh', requestId: created.requestId });
    // Another cart's lines are never touched.
    expect(await cancelFitChecks(db, { cartId: uuidv7(), cartItemIds: lineIds })).toBe(0);
  });

  it('retention: VIN and comment cleared after 90 days, newer requests untouched', async () => {
    const knecht = await offerOf('OC90', 'Knecht');
    const old = await cartWith(knecht);
    const fresh = await cartWith(knecht);
    const longAgo = new Date(T0.getTime() - 91 * DAY_MS);
    const a = await createFitCheckRequest(db, {
      ...old,
      vin: VIN,
      comment: 'старая',
      now: longAgo,
    });
    const b = await createFitCheckRequest(db, { ...fresh, vin: VIN2, comment: 'новая', now: T0 });
    if (!a.ok || !b.ok) throw new Error('not created');
    expect(await retainFitChecks(db, T0)).toBeGreaterThanOrEqual(1);
    expect(await retainFitChecks(db, T0)).toBe(0);
    const [cleared] = await rowsOf(a.requestId);
    expect(cleared).toMatchObject({ vin: null, comment: null, brand: 'Knecht' });
    const [kept] = await rowsOf(b.requestId);
    expect(kept).toMatchObject({ vin: VIN2, comment: 'новая' });
  });

  it('reads: the latest check per line with the last VIN, and the sellers card view', async () => {
    const knecht = await offerOf('OC90', 'Knecht');
    const trw = await offerOf('GDB1330', 'TRW');
    const { cartId, lineIds } = await cartWith(knecht, trw);
    const first = await createFitCheckRequest(db, {
      cartId,
      lineIds: [lineIds[0]!],
      vin: VIN,
      comment: null,
      now: T0,
    });
    if (!first.ok) throw new Error('not created');
    const [firstRow] = await rowsOf(first.requestId);
    await answerFitCheck(db, { id: firstRow!.id, answer: 'not_fit', staffId, now: T0 });
    const later = new Date(T0.getTime() + 60_000);
    const second = await createFitCheckRequest(db, {
      cartId,
      lineIds,
      vin: VIN2,
      comment: 'двигатель 1.6',
      now: later,
    });
    if (!second.ok) throw new Error('not created');

    const { latest, lastVin } = await loadCartFitChecks(db, cartId);
    expect(lastVin).toBe(VIN2);
    expect(latest.get(lineIds[0]!)?.requestId).toBe(second.requestId);
    expect(latest.get(lineIds[1]!)?.status).toBe('pending');

    const view = await loadFitRequestForStaff(db, first.requestId);
    expect(view).toMatchObject({
      requestId: first.requestId,
      vin: VIN,
      comment: null,
      lines: [
        {
          n: 1,
          brand: 'Knecht',
          article: 'OC 90',
          status: 'not_fit',
          answeredBy: { id: staffId, name: 'Лёша' },
        },
      ],
    });
    const two = await loadFitRequestForStaff(db, second.requestId);
    expect(two?.lines.map((l) => [l.n, l.brand])).toEqual([
      [1, 'Knecht'],
      [2, 'TRW'],
    ]);
    expect(await loadFitRequestForStaff(db, uuidv7())).toBeNull();
    expect(await loadCartFitChecks(db, 'nope')).toEqual({ latest: new Map(), lastVin: null });
  });

  it('the SLA setting: seeded 60, a stored value within bounds, else the default', async () => {
    expect(await loadFitSlaMinutes(db)).toBe(60);
    await db.update(settings).set({ value: 45 }).where(eq(settings.key, FIT_CHECK_SLA_KEY));
    expect(await loadFitSlaMinutes(db)).toBe(45);
    await db.update(settings).set({ value: 'час' }).where(eq(settings.key, FIT_CHECK_SLA_KEY));
    expect(await loadFitSlaMinutes(db)).toBe(60);
    await db.update(settings).set({ value: 60 }).where(eq(settings.key, FIT_CHECK_SLA_KEY));
  });
});
