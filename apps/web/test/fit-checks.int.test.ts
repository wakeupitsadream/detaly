// Step 4 (docs/fit-check.md) against local PG and Redis with the Rossko fixtures:
// - POST /api/fit-checks (handleFitSubmit): Origin, the closed gate (the body is not even read,
//   nothing is stored), the honeypot, only lines of the caller's own cart, the per-cart limit
//   (10 a day, 429 with a human message), the rows (pending, +24 h) and ONE outbox card job, logs
//   without the VIN, the comment or the cart token;
// - the cart's view of the checks (loadCartFitView): every state, the analog priced with
//   priceOffer, the lazy expiry, a changed line losing its check, the demo without a database;
// - «Заменить» / «Оставить как есть» (handleFitLineAction);
// - POST /api/cart/items with then=check -> /cart?check=<line>;
// - /admin/fit-checks: the answers from the admin (the card redraw through the outbox), the
//   analog by «БРЕНД АРТИКУЛ», the SLA through the audited settings writer, the read model with
//   the statistics, Basic auth and Origin.
import { createRedis, type Redis } from '@detaly/config';
import { deleteKeysByPrefix, testKeyPrefix, testRedisUrl } from '@detaly/config/testing';
import {
  and,
  cartItems,
  carts,
  createDb,
  eq,
  fitChecks,
  inArray,
  outbox,
  settings,
  settingsAudit,
  sql,
  staff,
  type Db,
} from '@detaly/db';
import {
  FIT_CHECK_SLA_KEY,
  fitCheckExpiresAt,
  fitLineState,
  formatRub,
  parseWorkHours,
  priceOffer,
  type Offer,
} from '@detaly/domain';
import { createFixtureCaller } from '@detaly/rossko';
import { answerFitAnalog, answerFitCheck, fitFactsOf } from '@detaly/vin';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { loadAdminFitChecks } from '@/server/admin/fit-checks';
import { handleAdminFitAction, type AdminFitDeps } from '@/server/admin/fit-checks-handler';
import { cartServiceFromSupplier } from '@/server/cart';
import type { CartService } from '@/server/cart/cart-service';
import { handleAddItem } from '@/server/cart/http';
import { CART_COOKIE } from '@/server/cart-store';
import { getCheckoutGate, type CheckoutGate } from '@/server/checkout-gate';
import { loadCartFitView } from '@/server/fit-checks/cart-fit';
import { FIT_FORM_MESSAGES } from '@/server/fit-checks/form';
import { handleFitLineAction, type FitLineActionDeps } from '@/server/fit-checks/line-actions';
import { handleFitSubmit, type FitSubmitDeps } from '@/server/fit-checks/submit-handler';
import { hitSubjectRateLimit, type RateLimitDecision } from '@/server/rate-limit';
import { createSupplierDeps, type Supplier } from '@/server/supplier';
import { intEnv, webDatabaseUrl } from './helpers';

const BASE = 'http://127.0.0.1:3100';
/** Synthetic VINs that pass isValidVin (never a real car). */
const VIN = 'XTA21099012345678';
const VIN_TYPED = 'xta 21099 0123 45678';
const COMMENT = 'двигатель 1.6, 2019';
const ADMIN = 'admin:fit-admin-password';
const AUTH = `Basic ${Buffer.from(ADMIN).toString('base64')}`;

const KNECHT = 'OC90:Knecht:ORB1';
const BOSCH = '0451103079:BOSCH:MSK7';
const MANN = 'W9142:MANN-FILTER:MSK7';

const env = intEnv({
  APP_BASE_URL: BASE,
  RKN_NOTICE_NUMBER: 'TEST-1',
  PICKUP_PHONE: '+7 900 000-00-01',
  ADMIN_BASIC_AUTH: ADMIN,
});

let redis: Redis;
let db: Db;
let supplier: Supplier;
let cart: CartService;
let prefix: string;
let logs: unknown[] = [];
let nudges = 0;

beforeAll(() => {
  redis = createRedis(testRedisUrl());
  db = createDb(webDatabaseUrl(), { max: 4 });
});

beforeEach(() => {
  prefix = testKeyPrefix();
  supplier = createSupplierDeps({
    env,
    db,
    redis,
    keyPrefix: prefix,
    caller: createFixtureCaller(),
  });
  cart = cartServiceFromSupplier(supplier, db);
  logs = [];
  nudges = 0;
});

afterEach(async () => {
  await deleteKeysByPrefix(redis, prefix);
});

afterAll(async () => {
  await redis.quit();
  await db.close();
});

const log = (level: string) => (details: Record<string, unknown>, message: string) => {
  logs.push([level, details, message]);
};
const logger = { info: log('info'), warn: log('warn'), error: log('error') };

/** An active cart with these offers (through the cart API's service, as «В корзину»). */
async function newCart(
  offerIds: readonly string[],
): Promise<{ token: string; cartId: string; lines: string[] }> {
  let token: string | null = null;
  const lines: string[] = [];
  for (const offerId of offerIds) {
    const q = offerId === MANN ? 'W9142' : 'OC90';
    const added = await cart.addItem({ token, q, offerId });
    token = added.token;
    lines.push(added.lineId);
  }
  if (token === null) throw new Error('no cart');
  const [row] = await db.select().from(carts).where(eq(carts.anonToken, token));
  if (!row) throw new Error('cart row missing');
  return { token, cartId: row.id, lines };
}

function submitDeps(overrides: Partial<FitSubmitDeps> = {}): FitSubmitDeps {
  return {
    db,
    env,
    gate: () => getCheckoutGate({ env, db }),
    limitCart: async () => ({ allowed: true, retryAfterSec: 0, window: null }),
    logger,
    nudge: () => {
      nudges += 1;
    },
    ...overrides,
  };
}

interface PostSpec {
  token?: string | null;
  fields?: Record<string, string | string[]>;
  line?: string;
  json?: boolean;
  origin?: string | null;
}

function fitRequest(spec: PostSpec): Request {
  const headers = new Headers();
  if (spec.origin !== null) headers.set('origin', spec.origin ?? BASE);
  if (spec.token) headers.set('cookie', `theme=x; ${CART_COOKIE}=${spec.token}`);
  const url = `${BASE}/api/fit-checks${spec.line ? `?line=${spec.line}` : ''}`;
  if (spec.json) {
    headers.set('content-type', 'application/json');
    headers.set('accept', 'application/json');
    return new Request(url, { method: 'POST', headers, body: JSON.stringify(spec.fields ?? {}) });
  }
  headers.set('content-type', 'application/x-www-form-urlencoded');
  const body = new URLSearchParams();
  for (const [name, value] of Object.entries(spec.fields ?? {})) {
    for (const item of Array.isArray(value) ? value : [value]) body.append(name, item);
  }
  return new Request(url, { method: 'POST', headers, body: body.toString() });
}

async function checksOf(cartId: string) {
  return db.select().from(fitChecks).where(eq(fitChecks.cartId, cartId));
}

async function cardJobs(requestIds: readonly string[]) {
  if (requestIds.length === 0) return [];
  return db
    .select()
    .from(outbox)
    .where(
      inArray(
        outbox.jobId,
        requestIds.map((id) => `fit:${id}:card`),
      ),
    );
}

function logText(): string {
  return JSON.stringify(logs);
}

describe('POST /api/fit-checks', () => {
  it('stores pending checks of the ticked lines, +24 h, and queues ONE card for the request', async () => {
    const c = await newCart([KNECHT, BOSCH, MANN]);
    const before = Date.now();
    const res = await handleFitSubmit(
      fitRequest({
        token: c.token,
        line: c.lines[0],
        fields: {
          vin: VIN_TYPED,
          comment: COMMENT,
          lines: [c.lines[0] as string, c.lines[1] as string],
          line: c.lines[0] as string,
          website: '',
        },
      }),
      submitDeps(),
    );
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe(`/cart?fit=sent#fit-${c.lines[0]}`);
    const rows = await checksOf(c.cartId);
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((r) => r.cartItemId))).toEqual(new Set([c.lines[0], c.lines[1]]));
    expect(new Set(rows.map((r) => r.requestId)).size).toBe(1);
    for (const row of rows) {
      expect(row.status).toBe('pending');
      expect(row.vin).toBe(VIN);
      expect(row.comment).toBe(COMMENT);
      // Until the closing of the next working day of PICKUP_HOURS, at least 24 hours.
      expect(row.expiresAt.toISOString()).toBe(
        fitCheckExpiresAt(row.createdAt, parseWorkHours(env.PICKUP_HOURS ?? null)).toISOString(),
      );
      expect(row.expiresAt.getTime() - row.createdAt.getTime()).toBeGreaterThanOrEqual(
        24 * 3_600_000,
      );
      expect(row.createdAt.getTime()).toBeGreaterThanOrEqual(before - 1000);
    }
    expect(rows.find((r) => r.cartItemId === c.lines[0])).toMatchObject({
      brand: 'Knecht',
      article: 'OC 90',
      name: 'Фильтр масляный',
    });
    const jobs = await cardJobs([rows[0]?.requestId as string]);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ queue: 'notify', name: 'fit' });
    expect(nudges).toBe(1);
    // Never the VIN, the comment or the cart token in a log line.
    expect(logText()).not.toContain(VIN);
    expect(logText()).not.toContain('двигатель');
    expect(logText()).not.toContain(c.token);
  });

  it('«Все детали»: every line of the cart; JSON for the sheet with JavaScript', async () => {
    const c = await newCart([KNECHT, MANN]);
    const res = await handleFitSubmit(
      fitRequest({ token: c.token, json: true, fields: { vin: VIN, all: 'on' } }),
      submitDeps(),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, lines: 2, skipped: 0 });
    expect(await checksOf(c.cartId)).toHaveLength(2);
  });

  it('a line of another cart refuses the whole request: nothing is stored anywhere', async () => {
    const mine = await newCart([KNECHT]);
    const theirs = await newCart([MANN]);
    const res = await handleFitSubmit(
      fitRequest({
        token: mine.token,
        line: mine.lines[0],
        fields: { vin: VIN, lines: [mine.lines[0] as string, theirs.lines[0] as string] },
      }),
      submitDeps(),
    );
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe(
      `/cart?fit_error=lines_foreign&check=${mine.lines[0]}#fit-${mine.lines[0]}`,
    );
    expect(await checksOf(mine.cartId)).toEqual([]);
    expect(await checksOf(theirs.cartId)).toEqual([]);
    // Only someone else's line: the same.
    const json = await handleFitSubmit(
      fitRequest({
        token: mine.token,
        json: true,
        fields: { vin: VIN, lines: [theirs.lines[0] as string] },
      }),
      submitDeps(),
    );
    expect(json.status).toBe(422);
    expect(await json.json()).toMatchObject({ error: 'lines_foreign' });
    expect(await checksOf(theirs.cartId)).toEqual([]);
  });

  it('Origin of another site: 403; the honeypot: 400; no cart: back with «cart»', async () => {
    const c = await newCart([KNECHT]);
    const fields = { vin: VIN, lines: [c.lines[0] as string] };
    const foreign = await handleFitSubmit(
      fitRequest({ token: c.token, fields, origin: 'https://evil.test' }),
      submitDeps(),
    );
    expect(foreign.status).toBe(403);
    const bot = await handleFitSubmit(
      fitRequest({ token: c.token, fields: { ...fields, website: 'https://spam.test' } }),
      submitDeps(),
    );
    expect(bot.status).toBe(400);
    const noCart = await handleFitSubmit(fitRequest({ fields }), submitDeps());
    expect(noCart.status).toBe(303);
    expect(noCart.headers.get('location')).toBe('/cart?fit_error=cart');
    expect(await checksOf(c.cartId)).toEqual([]);
  });

  it('a bad VIN comes back as a code: the VIN never goes into the URL', async () => {
    const c = await newCart([KNECHT]);
    const res = await handleFitSubmit(
      fitRequest({
        token: c.token,
        line: c.lines[0],
        fields: { vin: 'XTA2109O012345678', lines: [c.lines[0] as string] },
      }),
      submitDeps(),
    );
    expect(res.status).toBe(303);
    const location = res.headers.get('location') ?? '';
    expect(location).toBe(`/cart?fit_error=vin_oiq&check=${c.lines[0]}#fit-${c.lines[0]}`);
    expect(location).not.toContain('XTA');
    expect(await checksOf(c.cartId)).toEqual([]);
  });

  it('the closed gate: the body is not read, nothing is stored, the phone is given', async () => {
    const c = await newCart([KNECHT]);
    const closed: CheckoutGate = { open: false, reason: 'rkn', message: 'closed' };
    const request = fitRequest({
      token: c.token,
      line: c.lines[0],
      fields: { vin: VIN, lines: [c.lines[0] as string] },
    });
    const res = await handleFitSubmit(request, submitDeps({ gate: async () => closed }));
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe(
      `/cart?fit_error=closed&check=${c.lines[0]}#fit-${c.lines[0]}`,
    );
    expect(request.bodyUsed).toBe(false);
    const json = await handleFitSubmit(
      fitRequest({ token: c.token, json: true, fields: { vin: VIN, all: 'on' } }),
      submitDeps({ gate: async () => closed }),
    );
    expect(json.status).toBe(403);
    expect(await json.json()).toEqual({
      error: 'closed',
      message: 'Проверка откроется вместе с заказами на сайте. Пока позвоните: +7 900 000-00-01',
    });
    expect(await checksOf(c.cartId)).toEqual([]);
  });

  it('the per-cart limit: 429 with a human message and Retry-After, nothing stored', async () => {
    const c = await newCart([KNECHT]);
    const refused: RateLimitDecision = { allowed: false, retryAfterSec: 3600, window: 'day' };
    let limited: string | null = null;
    const deps = submitDeps({
      limitCart: async (cartId) => {
        limited = cartId;
        return refused;
      },
    });
    const html = await handleFitSubmit(
      fitRequest({ token: c.token, fields: { vin: VIN, lines: [c.lines[0] as string] } }),
      deps,
    );
    expect(html.status).toBe(429);
    expect(html.headers.get('retry-after')).toBe('3600');
    expect(await html.text()).toContain(FIT_FORM_MESSAGES.rate_limited);
    expect(limited).toBe(c.cartId);
    const json = await handleFitSubmit(
      fitRequest({ token: c.token, json: true, fields: { vin: VIN, all: 'on' } }),
      deps,
    );
    expect(json.status).toBe(429);
    expect(await json.json()).toEqual({
      error: 'rate_limited',
      message: FIT_FORM_MESSAGES.rate_limited,
    });
    expect(await checksOf(c.cartId)).toEqual([]);
  });

  it('the per-cart limiter: 10 requests a day per cart, counted under an HMAC of the cart', async () => {
    const cartId = '01890000-0000-7000-8000-00000000fc01';
    const other = '01890000-0000-7000-8000-00000000fc02';
    const hit = (subject: string) =>
      hitSubjectRateLimit(redis, {
        kind: 'fit_check_cart',
        secret: env.SESSION_SECRET,
        subject,
        keyPrefix: prefix,
      });
    for (let i = 0; i < 10; i += 1) expect((await hit(cartId)).allowed).toBe(true);
    const eleventh = await hit(cartId);
    expect(eleventh).toMatchObject({ allowed: false, window: 'day' });
    expect(eleventh.retryAfterSec).toBeGreaterThan(0);
    expect((await hit(other)).allowed).toBe(true);
    const keys = await redis.keys(`${prefix}*`);
    expect(keys.some((key) => key.includes(cartId))).toBe(false);
  });

  it('lines already waiting are skipped; when all wait — 409', async () => {
    const c = await newCart([KNECHT, MANN]);
    const first = await handleFitSubmit(
      fitRequest({
        token: c.token,
        json: true,
        fields: { vin: VIN, lines: [c.lines[0] as string] },
      }),
      submitDeps(),
    );
    expect(await first.json()).toEqual({ ok: true, lines: 1, skipped: 0 });
    const again = await handleFitSubmit(
      fitRequest({ token: c.token, json: true, fields: { vin: VIN, all: 'on' } }),
      submitDeps(),
    );
    expect(await again.json()).toEqual({ ok: true, lines: 1, skipped: 1 });
    const third = await handleFitSubmit(
      fitRequest({ token: c.token, json: true, fields: { vin: VIN, all: 'on' } }),
      submitDeps(),
    );
    expect(third.status).toBe(409);
    expect(await third.json()).toMatchObject({ error: 'pending' });
    expect(await checksOf(c.cartId)).toHaveLength(2);
  });
});

/** The latest check of a line (by cart line id). */
async function checkOf(lineId: string) {
  const [row] = await db
    .select()
    .from(fitChecks)
    .where(eq(fitChecks.cartItemId, lineId))
    .orderBy(sql`${fitChecks.createdAt} desc`)
    .limit(1);
  if (!row) throw new Error('no check');
  return row;
}

async function send(c: { token: string }, lines: readonly string[]): Promise<void> {
  const res = await handleFitSubmit(
    fitRequest({ token: c.token, json: true, fields: { vin: VIN, lines: [...lines] } }),
    submitDeps(),
  );
  expect(res.status).toBe(200);
}

async function fixtureOffer(article: string, brand: string): Promise<Offer> {
  const { offers } = await supplier.rossko.search(article, { priority: 'search' });
  const offer = offers.find((o) => o.brand === brand);
  if (!offer) throw new Error(`fixture ${brand} ${article} missing`);
  return offer;
}

async function view(c: { token: string; cartId: string }, now = new Date(), query = {}) {
  const viewed = await cart.viewCart(c.token);
  if (!viewed) throw new Error('no cart view');
  return loadCartFitView({
    db,
    cartId: c.cartId,
    lines: viewed.lines,
    settings: viewed.settings,
    env,
    now,
    gateOpen: true,
    query,
  });
}

describe('the cart and its checks', () => {
  it('every state of a line, the analog priced with priceOffer, the last VIN of the cart', async () => {
    const c = await newCart([KNECHT, BOSCH, MANN]);
    const fresh = await view(c);
    expect(Object.values(fresh.lines).map((l) => l.state)).toEqual(['none', 'none', 'none']);
    expect(fresh.shared.lastVin).toBeNull();
    expect(fresh.anyPending).toBe(false);

    await send(c, c.lines);
    const pending = await view(c);
    expect(pending.anyPending).toBe(true);
    expect(pending.shared.lastVin).toBe(VIN);
    expect(pending.lines[c.lines[0] as string]?.state).toBe('pending');

    const now = new Date();
    const [knecht, bosch, mann] = await Promise.all(c.lines.map(checkOf));
    await answerFitCheck(db, { id: knecht?.id as string, answer: 'fits', staffId: null, now });
    const analogOffer = await fixtureOffer('W9142', 'MANN-FILTER');
    await answerFitAnalog(db, {
      id: bosch?.id as string,
      analog: {
        brand: analogOffer.brand,
        article: analogOffer.article,
        name: analogOffer.name,
        offer: analogOffer,
      },
      staffId: null,
      now,
    });
    await answerFitCheck(db, { id: mann?.id as string, answer: 'call_needed', staffId: null, now });

    const answered = await view(c);
    expect(answered.anyPending).toBe(false);
    expect(answered.lines[c.lines[0] as string]?.state).toBe('fits');
    expect(answered.lines[c.lines[2] as string]?.state).toBe('call_needed');
    const analog = answered.lines[c.lines[1] as string];
    expect(analog?.state).toBe('analog_offer');
    const settingsNow = await supplier.settings.get();
    expect(analog?.analog).toMatchObject({
      brand: 'MANN-FILTER',
      article: 'W 914/2',
      priceText: formatRub(priceOffer(settingsNow.pricing, analogOffer).priceClientKop),
    });
    expect(analog?.analog?.promiseText).toMatch(/^к /u);
  });

  it('expiry reads lazily from expires_at; a changed line loses its check', async () => {
    const c = await newCart([KNECHT, MANN]);
    await send(c, c.lines);
    const [sent] = await checksOf(c.cartId);
    if (!sent) throw new Error('no check');
    // A minute before expires_at it still waits; at it, it reads expired (the worker may not
    // have marked the row yet).
    const waiting = await view(c, new Date(sent.expiresAt.getTime() - 60_000));
    expect(waiting.lines[c.lines[0] as string]?.state).toBe('pending');
    const expired = await view(c, sent.expiresAt);
    expect(expired.lines[c.lines[0] as string]?.state).toBe('expired');
    expect(expired.anyPending).toBe(false);

    // The client's line now holds another part (as after a replacement in another tab).
    await db
      .update(cartItems)
      .set({ brand: 'BOSCH', article: '0 451 103 079' })
      .where(eq(cartItems.id, c.lines[1] as string));
    const check = await checkOf(c.lines[1] as string);
    expect(
      fitLineState(fitFactsOf(check), { brand: 'BOSCH', article: '0 451 103 079' }, new Date()),
    ).toBe('none');
  });

  it('the query: the form of an own line opens; codes give messages; no demo outside the demo', async () => {
    const c = await newCart([KNECHT]);
    const line = c.lines[0] as string;
    const opened = await view(c, new Date(), {
      check: line,
      fit_error: 'vin',
      fit_demo: line,
    });
    expect(opened.openLine).toBe(line);
    expect(opened.error).toEqual({ code: 'vin', message: FIT_FORM_MESSAGES.vin });
    expect(opened.demoLine).toBeNull();
    const foreign = await view(c, new Date(), {
      check: '01890000-0000-7000-8000-00000000dead',
      fit_error: 'VIN XTA21099012345678',
    });
    expect(foreign.openLine).toBeNull();
    expect(foreign.error).toBeNull();
  });

  it('DEMO_MODE: no database is read, the demo line comes from the query', async () => {
    const viewed = await loadCartFitView({
      db: null,
      cartId: '',
      lines: [],
      settings: await supplier.settings.get(),
      env: { ...env, FIT_GUARANTEE_ENABLED: true },
      now: new Date(),
      gateOpen: true,
      query: { fit_demo: '01890000-0000-7000-8000-000000000001' },
    });
    expect(viewed.shared).toMatchObject({ demo: true, guarantee: true, lastVin: null });
    // Not a line of this cart: nothing shown.
    expect(viewed.demoLine).toBeNull();
  });
});

function lineDeps(overrides: Partial<FitLineActionDeps> = {}): FitLineActionDeps {
  return {
    db,
    env,
    supplier,
    loadSettings: () => supplier.settings.get(),
    logger,
    ...overrides,
  };
}

function lineAction(token: string | null, action: string, origin: string = BASE): Request {
  const headers = new Headers({
    'content-type': 'application/x-www-form-urlencoded',
    origin,
  });
  if (token) headers.set('cookie', `${CART_COOKIE}=${token}`);
  return new Request(`${BASE}/api/cart/items/x/fit`, {
    method: 'POST',
    headers,
    body: new URLSearchParams({ action }).toString(),
  });
}

async function offerAnalog(lineId: string): Promise<Offer> {
  const analog = await fixtureOffer('W9142', 'MANN-FILTER');
  await answerFitAnalog(db, {
    id: (await checkOf(lineId)).id,
    analog: { brand: analog.brand, article: analog.article, name: analog.name, offer: analog },
    staffId: null,
    now: new Date(),
  });
  return analog;
}

describe('«Заменить» and «Оставить как есть»', () => {
  it('«Заменить»: the line becomes the analog priced with priceOffer and counts as checked', async () => {
    const c = await newCart([KNECHT]);
    const line = c.lines[0] as string;
    await send(c, [line]);
    const analog = await offerAnalog(line);
    const res = await handleFitLineAction(lineAction(c.token, 'replace'), line, lineDeps());
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe(`/cart#fit-${line}`);
    const [item] = await db.select().from(cartItems).where(eq(cartItems.id, line));
    const settingsNow = await supplier.settings.get();
    expect(item).toMatchObject({
      brand: 'MANN-FILTER',
      article: 'W 914/2',
      searchArticleNorm: 'W9142',
      priceClientKop: priceOffer(settingsNow.pricing, analog).priceClientKop,
    });
    const after = await view(c);
    expect(after.lines[line]?.state).toBe('analog_accepted');
  });

  it('«Заменить» onto the analog already in the cart: one line, the check moves with it', async () => {
    const c = await newCart([KNECHT, MANN]);
    const [knecht, mann] = c.lines as [string, string];
    await send(c, [knecht]);
    await offerAnalog(knecht);
    const res = await handleFitLineAction(lineAction(c.token, 'replace'), knecht, lineDeps());
    expect(res.status).toBe(303);
    const items = await db.select().from(cartItems).where(eq(cartItems.cartId, c.cartId));
    expect(items.map((i) => i.id)).toEqual([mann]);
    expect(items[0]?.qty).toBe(2);
    expect((await checkOf(mann)).status).toBe('analog');
    expect((await view(c)).lines[mann]?.state).toBe('analog_accepted');
  });

  it('«Оставить как есть»: the part stays, the line is not checked', async () => {
    const c = await newCart([KNECHT]);
    const line = c.lines[0] as string;
    await send(c, [line]);
    await offerAnalog(line);
    const res = await handleFitLineAction(lineAction(c.token, 'keep'), line, lineDeps());
    expect(res.status).toBe(303);
    expect((await checkOf(line)).analogKeptAt).not.toBeNull();
    const [item] = await db.select().from(cartItems).where(eq(cartItems.id, line));
    expect(item?.brand).toBe('Knecht');
    expect((await view(c)).lines[line]?.state).toBe('analog_kept');
  });

  it("only a line of the caller's cart, from this site, with an analog offered", async () => {
    const c = await newCart([KNECHT]);
    const other = await newCart([KNECHT]);
    const line = c.lines[0] as string;
    await send(c, [line]);
    expect(
      (await handleFitLineAction(lineAction(other.token, 'keep'), line, lineDeps())).status,
    ).toBe(404);
    expect(
      (
        await handleFitLineAction(
          lineAction(c.token, 'keep', 'https://evil.test'),
          line,
          lineDeps(),
        )
      ).status,
    ).toBe(403);
    // Pending: nothing to take or keep yet.
    expect(
      (await handleFitLineAction(lineAction(c.token, 'replace'), line, lineDeps())).status,
    ).toBe(409);
    expect((await handleFitLineAction(lineAction(c.token, 'nope'), line, lineDeps())).status).toBe(
      400,
    );
  });
});

describe('«Проверить под мою машину» on a search card', () => {
  it('adds the offer and opens the cart with the form of its line', async () => {
    const res = await handleAddItem(
      new Request(`${BASE}/api/cart/items`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', origin: BASE },
        body: new URLSearchParams({
          q: 'OC90',
          offerId: KNECHT,
          qty: '1',
          then: 'check',
        }).toString(),
      }),
      { service: cart, env },
    );
    expect(res.status).toBe(303);
    const token = /cart=([^;]+)/.exec(res.headers.get('set-cookie') ?? '')?.[1];
    const [row] = await db
      .select()
      .from(carts)
      .where(eq(carts.anonToken, token ?? ''));
    const [item] = await db
      .select()
      .from(cartItems)
      .where(eq(cartItems.cartId, row?.id ?? ''));
    expect(res.headers.get('location')).toBe(`/cart?check=${item?.id}#fit-${item?.id}`);
  });
});

function adminDeps(overrides: Partial<AdminFitDeps> = {}): AdminFitDeps {
  return {
    db,
    env,
    supplier: { rossko: supplier.rossko, settings: supplier.settings },
    logger,
    nudge: () => {
      nudges += 1;
    },
    ...overrides,
  };
}

function adminPost(fields: Record<string, string>, headers: Record<string, string> = {}) {
  return new Request(`${BASE}/api/admin/fit-checks`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      origin: BASE,
      authorization: AUTH,
      ...headers,
    },
    body: new URLSearchParams(fields).toString(),
  });
}

describe('/admin/fit-checks', () => {
  it('answers from the admin redraw the card; a second answer says «уже отвечено»', async () => {
    const c = await newCart([KNECHT, MANN]);
    await send(c, c.lines);
    const knecht = await checkOf(c.lines[0] as string);
    const res = await handleAdminFitAction(
      adminPost({ action: 'answer', id: knecht.id, answer: 'not_fit' }),
      adminDeps(),
    );
    expect(res.status).toBe(303);
    expect(decodeURIComponent(res.headers.get('location') ?? '')).toBe(
      '/admin/fit-checks?done=Knecht OC 90: Не подходит',
    );
    const row = await checkOf(c.lines[0] as string);
    expect(row).toMatchObject({ status: 'not_fit', answeredBy: null });
    expect(row.answeredAt).not.toBeNull();
    const [refresh] = await db
      .select()
      .from(outbox)
      .where(eq(outbox.jobId, `fit:${row.requestId}:refresh:${row.id}`));
    expect(refresh).toMatchObject({ queue: 'notify', name: 'fit' });
    expect(nudges).toBeGreaterThan(0);

    const again = await handleAdminFitAction(
      adminPost({ action: 'answer', id: knecht.id, answer: 'fits' }),
      adminDeps(),
    );
    expect(again.status).toBe(409);
    expect(await again.text()).toContain('Уже отвечено: не подходит');
    expect((await checkOf(c.lines[0] as string)).status).toBe('not_fit');
  });

  it('«Аналог» by «БРЕНД АРТИКУЛ»: found and priced, or «не нашёл у поставщика»', async () => {
    const c = await newCart([KNECHT]);
    await send(c, c.lines);
    const check = await checkOf(c.lines[0] as string);
    const missing = await handleAdminFitAction(
      adminPost({ action: 'analog', id: check.id, text: 'KNECHT W9142X' }),
      adminDeps(),
    );
    expect(missing.status).toBe(422);
    expect(await missing.text()).toContain('Не нашёл у поставщика — проверьте артикул');
    expect((await checkOf(c.lines[0] as string)).status).toBe('pending');

    const found = await handleAdminFitAction(
      adminPost({ action: 'analog', id: check.id, text: 'MANN-FILTER W914/2' }),
      adminDeps(),
    );
    expect(found.status).toBe(303);
    const row = await checkOf(c.lines[0] as string);
    expect(row).toMatchObject({
      status: 'analog',
      analogBrand: 'MANN-FILTER',
      analogArticle: 'W 914/2',
    });
    expect(row.analogOffer?.articleNorm).toBe('W9142');
  });

  it('the SLA through the audited settings writer; bounds; the version', async () => {
    const data = await loadAdminFitChecks(db, { now: new Date(), schedule: null });
    const saved = await handleAdminFitAction(
      adminPost({ action: 'sla', minutes: '45', version: data.sla.version }),
      adminDeps(),
    );
    expect(saved.status).toBe(303);
    const [row] = await db.select().from(settings).where(eq(settings.key, FIT_CHECK_SLA_KEY));
    expect(row?.value).toBe(45);
    expect(row?.updatedBy).toBe('admin');
    const audit = await db
      .select()
      .from(settingsAudit)
      .where(eq(settingsAudit.key, FIT_CHECK_SLA_KEY));
    expect(audit.at(-1)).toMatchObject({ newValue: 45, changedBy: 'admin' });
    // A stale version: 409; out of bounds: 422.
    const stale = await handleAdminFitAction(
      adminPost({ action: 'sla', minutes: '50', version: data.sla.version }),
      adminDeps(),
    );
    expect(stale.status).toBe(409);
    const fresh = await loadAdminFitChecks(db, { now: new Date(), schedule: null });
    expect(fresh.sla.minutes).toBe(45);
    for (const minutes of ['4', '1441', '30.5', 'час']) {
      const bad = await handleAdminFitAction(
        adminPost({ action: 'sla', minutes, version: fresh.sla.version }),
        adminDeps(),
      );
      expect(bad.status).toBe(422);
    }
    // Back to the default for the other tests.
    await handleAdminFitAction(
      adminPost({ action: 'sla', minutes: '60', version: fresh.sla.version }),
      adminDeps(),
    );
  });

  it('Basic auth (401) and Origin (403) come first', async () => {
    const noAuth = await handleAdminFitAction(
      adminPost({ action: 'sla', minutes: '60', version: 'none' }, { authorization: '' }),
      adminDeps(),
    );
    expect(noAuth.status).toBe(401);
    const foreign = await handleAdminFitAction(
      adminPost({ action: 'sla', minutes: '60', version: 'none' }, { origin: 'https://evil.test' }),
      adminDeps(),
    );
    expect(foreign.status).toBe(403);
  });

  it('the read model: requests with their lines and who answered; the statistics; no VIN', async () => {
    const c = await newCart([KNECHT, MANN]);
    await send(c, c.lines);
    const [master] = await db
      .insert(staff)
      .values({ name: 'Мастер Тест', role: 'seller', tgUserId: Math.floor(Math.random() * 1e9) })
      .returning();
    const now = new Date();
    const knecht = await checkOf(c.lines[0] as string);
    await answerFitCheck(db, { id: knecht.id, answer: 'fits', staffId: master?.id ?? null, now });

    const data = await loadAdminFitChecks(db, { now: new Date(), schedule: null });
    const request = data.requests.find((r) => r.requestId === knecht.requestId);
    expect(request?.waiting).toBe(true);
    expect(request?.lines.map((l) => [l.n, l.brand, l.status, l.answeredBy])).toEqual([
      [1, 'Knecht', 'fits', 'Мастер Тест'],
      [2, 'MANN-FILTER', 'pending', null],
    ]);
    expect(JSON.stringify(data)).not.toContain(VIN);
    const week = data.stats.find((s) => s.days === 7)?.stats;
    expect(week?.lines).toBeGreaterThanOrEqual(2);
    expect(week?.byStatus.fits).toBeGreaterThanOrEqual(1);
    expect(week?.answered).toBeGreaterThanOrEqual(1);
    expect(data.stats.map((s) => s.days)).toEqual([7, 30]);
  });
});

describe('the outbox card of a request', () => {
  it('one card job per request, whatever the number of lines', async () => {
    const c = await newCart([KNECHT, BOSCH, MANN]);
    await send(c, c.lines);
    const rows = await checksOf(c.cartId);
    const requestIds = [...new Set(rows.map((r) => r.requestId))];
    expect(requestIds).toHaveLength(1);
    const jobs = await db
      .select()
      .from(outbox)
      .where(and(eq(outbox.queue, 'notify'), eq(outbox.name, 'fit')));
    expect(jobs.filter((j) => j.jobId.startsWith(`fit:${requestIds[0]}:`))).toHaveLength(1);
  });
});
