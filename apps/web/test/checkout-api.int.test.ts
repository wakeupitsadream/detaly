// POST /api/checkout and the /checkout page data against local PG and Redis with the Rossko
// fixtures caller (wrapped to reprice, fail or count). Every test gets its own Redis prefix
// (supplier cache and limiter), its own cart and phone; thresholds and stop rules are injected
// through loadSettings, never written to the shared settings tables.
import { createRedis, type Redis } from '@detaly/config';
import { deleteKeysByPrefix, testKeyPrefix, testRedisUrl } from '@detaly/config/testing';
import {
  cartItems,
  carts,
  consents,
  createDb,
  documentVersions,
  eq,
  inArray,
  orderItems,
  orders,
  sha256Hex,
  users,
  type Db,
} from '@detaly/db';
import {
  addDays,
  cartLineFromOffer,
  explainPaymentScheme,
  formatPromise,
  MAX_ORDER_TOTAL_KOP,
  type ExcludedRule,
  type IsoDate,
  type Offer,
  type RepriceContext,
} from '@detaly/domain';
import {
  createFixtureCaller,
  RosskoCallError,
  RosskoRateLimitError,
  type RosskoCaller,
  type RosskoClient,
} from '@detaly/rossko';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CheckoutClosed } from '@/components/checkout/CheckoutClosed';
import { newCartToken } from '@/server/cart-store';
import { getCheckoutGate, type CheckoutGate } from '@/server/checkout-gate';
import {
  createCheckoutService,
  type CheckoutLogger,
  type CheckoutService,
  type CheckoutSettings,
} from '@/server/checkout/checkout-service';
import { handleCheckoutRequest } from '@/server/checkout/handler';
import {
  loadCheckoutPage,
  type CheckoutPageData,
  type CheckoutPageReady,
} from '@/server/checkout/page-data';
import { uuidV7 } from '@/server/checkout/uuid';
import { createSupplierDeps, type Supplier } from '@/server/supplier';
import { intEnv, webDatabaseUrl } from './helpers';

const BASE_URL = 'http://127.0.0.1:3100';
const ORIGIN = new URL(BASE_URL).origin;
const UA = 'Mozilla/5.0 (checkout test)';

let redis: Redis;
let db: Db;
const prefixes: string[] = [];

// --- supplier caller: fixtures with a price factor, failures and a call log ------------------
const fixtures = createFixtureCaller();
const searches: string[] = [];
let priceFactor = 1;
let failSearch = false;

const caller: RosskoCaller = {
  lastRawResponse: null,
  async call(method, args) {
    if (method === 'GetSearch') {
      searches.push(String(args.text ?? ''));
      if (failSearch) throw new RosskoCallError('GetSearch', 'synthetic failure');
    }
    const raw = (await fixtures.call(method, args)) as unknown;
    if (method !== 'GetSearch' || priceFactor === 1) return raw;
    return JSON.parse(JSON.stringify(raw), (key, value: unknown) =>
      key === 'price' && (typeof value === 'string' || typeof value === 'number')
        ? (Number(value) * priceFactor).toFixed(2)
        : value,
    ) as unknown;
  },
};

// --- per-test state --------------------------------------------------------------------------
let supplier: Supplier;
let rossko: Pick<RosskoClient, 'search'>;
let settingsOverride: Partial<CheckoutSettings['order']> = {};
let excludedOverride: ExcludedRule[] | null = null;
let gateEnv = intEnv({ RKN_NOTICE_NUMBER: 'TEST-1' });
let logs: { level: string; details: Record<string, unknown>; message: string }[] = [];

const logger: CheckoutLogger = {
  info: (details, message) => logs.push({ level: 'info', details, message }),
  warn: (details, message) => logs.push({ level: 'warn', details, message }),
  error: (details, message) => logs.push({ level: 'error', details, message }),
};

async function loadSettings(): Promise<CheckoutSettings> {
  const base = await supplier.settings.get();
  return {
    ...base,
    excludedRules: excludedOverride ?? base.excludedRules,
    order: { ...base.order, ...settingsOverride },
  };
}

const gate = (): Promise<CheckoutGate> => getCheckoutGate({ env: gateEnv, db });

function service(): CheckoutService {
  return createCheckoutService({
    db,
    supplier: { rossko },
    loadSettings,
    gate,
    logger,
    env: { APP_BASE_URL: BASE_URL, TRUSTED_IP_HEADER: 'x-real-ip' },
  });
}

function page(cartToken: string | null, part: 'all' | 'local' | 'order' = 'all') {
  return loadCheckoutPage({ db, supplier: { rossko }, loadSettings, gate }, { cartToken, part });
}

beforeAll(() => {
  redis = createRedis(testRedisUrl());
  db = createDb(webDatabaseUrl(), { max: 6 });
});

beforeEach(() => {
  const prefix = testKeyPrefix();
  prefixes.push(prefix);
  supplier = createSupplierDeps({ env: intEnv(), db, redis, keyPrefix: prefix, caller });
  rossko = supplier.rossko;
  searches.length = 0;
  priceFactor = 1;
  failSearch = false;
  settingsOverride = {};
  excludedOverride = null;
  gateEnv = intEnv({ RKN_NOTICE_NUMBER: 'TEST-1' });
  logs = [];
});

afterEach(async () => {
  for (const prefix of prefixes.splice(0)) await deleteKeysByPrefix(redis, prefix);
});

afterAll(async () => {
  await redis.quit();
  await db.close();
});

// --- fixtures --------------------------------------------------------------------------------

function randomPhone(): { typed: string; e164: string } {
  const digits = String(Math.floor(Math.random() * 1e9)).padStart(9, '0');
  return {
    typed: `8 (9${digits.slice(0, 2)}) ${digits.slice(2, 5)}-${digits.slice(5, 7)}-${digits.slice(7)}`,
    e164: `+79${digits}`,
  };
}

function randomIp(): string {
  const n = () => 1 + Math.floor(Math.random() * 250);
  return `10.${n()}.${n()}.${n()}`;
}

async function repriceCtx(): Promise<RepriceContext> {
  const s = await supplier.settings.get();
  return { markupRules: s.markupRules, excludedRules: [], eta: s.eta, now: new Date() };
}

async function offerOf(query: string, brand: string, stockId: string): Promise<Offer> {
  const { offers } = await supplier.rossko.search(query);
  const offer = offers.find((o) => o.brand === brand && o.stock.stockId === stockId);
  if (!offer) throw new Error(`fixture offer ${brand}/${stockId} missing`);
  return offer;
}

type LineSpec = [query: string, brand: string, stockId: string, qty?: number];

const KNECHT_LOCAL: LineSpec = ['OC90', 'Knecht', 'ORB1'];
const BOSCH_ORDER: LineSpec = ['OC90', 'BOSCH', 'MSK7'];

function withQty([query, brand, stockId]: LineSpec, qty: number): LineSpec {
  return [query, brand, stockId, qty];
}

/** An active cart with lines priced as the cart API would price them. */
async function makeCart(...specs: LineSpec[]): Promise<{ id: string; token: string }> {
  const token = newCartToken();
  const [cart] = await db.insert(carts).values({ anonToken: token }).returning();
  if (!cart) throw new Error('cart not inserted');
  const ctx = await repriceCtx();
  for (const [query, brand, stockId, qty = 1] of specs) {
    const offer = await offerOf(query, brand, stockId);
    const line = cartLineFromOffer(offer, query, qty, ctx);
    await db.insert(cartItems).values({
      cartId: cart.id,
      offerKey: line.offerKey,
      searchArticleNorm: line.searchArticleNorm,
      brand: offer.brand,
      article: offer.article,
      name: offer.name,
      qty: line.qty,
      stockId: offer.stock.stockId,
      isLocal: line.isLocal,
      etaDate: line.etaDate,
      priceSupplierKop: line.priceSupplierKop,
      priceClientKop: line.priceClientKop,
      markupBp: line.markupBp,
      offerSnapshot: offer,
      fetchedAt: new Date(),
    });
  }
  searches.length = 0;
  return { id: cart.id, token };
}

function ready(data: CheckoutPageData): CheckoutPageReady {
  if (data.kind !== 'ready') throw new Error(`checkout page is ${data.kind}`);
  return data;
}

interface Submit {
  token: string | null;
  page?: CheckoutPageReady;
  phone?: string;
  name?: string;
  body?: Record<string, unknown>;
  headers?: Record<string, string>;
  rawBody?: string;
}

/** POST /api/checkout as the browser would send it from the rendered page. */
async function submit(options: Submit, svc = service()) {
  const pageData = options.page;
  // Without a rendered page the hidden values come from what the gate serves now.
  const open = await gate();
  const documents = pageData?.documents ?? {
    offerVersionId: open.open ? open.docs.offer.id : uuidV7(),
    consentPdVersionId: open.open ? open.docs.consentPd.id : uuidV7(),
    consentMarketingVersionId: open.open ? (open.docs.consentMarketing?.id ?? null) : null,
  };
  const body = {
    part: pageData?.part ?? 'all',
    phone: options.phone ?? randomPhone().typed,
    name: options.name ?? 'Тест Покупатель',
    channel: 'max',
    acceptOffer: true,
    consentPd: true,
    consentMarketing: false,
    expectedTotalKop: pageData?.totals.subtotalKop ?? 0,
    itemsHash: pageData?.itemsHash ?? '0'.repeat(64),
    checkoutKey: pageData?.checkoutKey ?? uuidV7(),
    ...documents,
    expectedScheme: pageData?.decision.scheme ?? 'prepay',
    expectedPromisedDate: pageData?.promisedDate ?? null,
    website: '',
    ...options.body,
  };
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    origin: ORIGIN,
    'user-agent': UA,
    'x-real-ip': randomIp(),
    ...(options.token ? { cookie: `theme=x; cart=${options.token}` } : {}),
    ...options.headers,
  };
  for (const [key, value] of Object.entries(headers)) if (value === '') delete headers[key];
  const response = await handleCheckoutRequest(
    new Request(`${BASE_URL}/api/checkout`, {
      method: 'POST',
      headers,
      body: options.rawBody ?? JSON.stringify(body),
    }),
    svc,
  );
  return {
    status: response.status,
    headers: response.headers,
    json: (await response.json()) as Record<string, unknown>,
    sent: body,
  };
}

async function orderByUrl(url: unknown) {
  const token = String(url).replace(/^\/o\//, '');
  const order = await db.query.orders.findFirst({
    where: (t, ops) => ops.eq(t.accessToken, token),
    with: { items: true, events: true },
  });
  if (!order) throw new Error('order not found');
  return order;
}

async function nothingCreated(phone: string, checkoutKey: unknown): Promise<void> {
  expect(await db.select().from(users).where(eq(users.phone, phone))).toEqual([]);
  expect(
    await db
      .select()
      .from(orders)
      .where(eq(orders.checkoutKey, String(checkoutKey))),
  ).toEqual([]);
}

function logText(): string {
  return JSON.stringify(logs);
}

// --- tests -----------------------------------------------------------------------------------

describe('POST /api/checkout: success', () => {
  it('mixed cart: prepay order awaiting payment, consent evidence, items snapshot, cart converted', async () => {
    const cart = await makeCart(KNECHT_LOCAL, withQty(BOSCH_ORDER, 2));
    const p = ready(await page(cart.token));
    expect(p.mixed).toBe(true);
    expect(p.decision.scheme).toBe('prepay');
    const phone = randomPhone();
    const ip = randomIp();
    searches.length = 0;
    const res = await submit({
      token: cart.token,
      page: p,
      phone: phone.typed,
      name: 'Анна Тестовая',
      headers: { 'x-real-ip': ip },
    });

    expect(res.status).toBe(201);
    expect(res.json.orderUrl).toMatch(/^\/o\/[A-Za-z0-9_-]{43}$/);
    expect(res.json.number).toMatch(/^DT-\d{6}$/);
    // Past the cache: one fresh GetSearch for the query article of both lines.
    expect(searches).toEqual(['OC90']);

    const order = await orderByUrl(res.json.orderUrl);
    const settings = await supplier.settings.get();
    const docs = await gate();
    if (!docs.open) throw new Error('gate closed');
    expect(order).toMatchObject({
      number: res.json.number,
      status: 'awaiting_payment',
      paymentScheme: 'prepay',
      fulfillment: 'pickup',
      subtotalKop: p.totals.subtotalKop,
      courierFeeKop: 0,
      totalKop: p.totals.subtotalKop,
      itemsHash: p.itemsHash,
      offerVersionId: docs.docs.offer.id,
      preferredChannel: 'max',
      checkoutKey: p.checkoutKey,
      cartId: cart.id,
      expiresAt: null,
    });
    expect(order.pickupCode).toMatch(/^\d{6}$/);
    const maxEta = p.lines
      .map((l) => l.etaDate as IsoDate)
      .sort()
      .at(-1) as IsoDate;
    expect(order.promisedDate).toBe(addDays(maxEta, settings.eta.bufferDays));
    expect(formatPromise(order.promisedDate as IsoDate)).toMatch(/^к /);

    expect(order.items).toHaveLength(2);
    const bosch = order.items.find((i) => i.brand === 'BOSCH');
    expect(bosch).toMatchObject({
      offerKey: '0451103079:BOSCH:MSK7',
      searchArticleNorm: 'OC90',
      qty: 2,
      isLocal: false,
      state: 'pending',
      stockId: 'MSK7',
    });
    expect(bosch?.offerSnapshot.priceSupplierKop).toBe(bosch?.priceSupplierAtOrderKop);
    expect(bosch?.priceClientKop).toBe(p.lines.find((l) => !l.isLocal)?.priceClientKop);

    expect(order.events).toHaveLength(1);
    expect(order.events[0]).toMatchObject({
      type: 'checkout',
      fromStatus: 'draft',
      toStatus: 'awaiting_payment',
      actorType: 'client',
      payload: { part: 'all', scheme: 'prepay', items: 2, deferredEffects: ['create_payment'] },
    });
    expect(JSON.stringify(order.events[0]?.payload)).not.toContain(phone.e164);

    const [user] = await db.select().from(users).where(eq(users.phone, phone.e164));
    expect(user).toMatchObject({ name: 'Анна Тестовая', noShowCount: 0 });
    expect(order.userId).toBe(user?.id);
    expect(order.events[0]?.actorId).toBe(user?.id);

    const given = await db.select().from(consents).where(eq(consents.orderId, order.id));
    expect(given).toHaveLength(1);
    expect(given[0]).toMatchObject({
      userId: user?.id,
      kind: 'pd',
      channel: 'web',
      documentVersionId: docs.docs.consentPd.id,
      textSha256: docs.docs.consentPd.sha256,
      ip,
      userAgent: UA,
      revokedAt: null,
    });

    const [after] = await db.select().from(carts).where(eq(carts.id, cart.id));
    expect(after).toMatchObject({ status: 'converted', userId: user?.id });
    expect(await db.select().from(cartItems).where(eq(cartItems.cartId, cart.id))).toEqual([]);

    expect(logs.find((l) => l.message === 'order created')?.details).toEqual({
      number: res.json.number,
      scheme: 'prepay',
      items: 2,
      part: 'all',
    });
    expect(logText()).not.toContain(phone.e164);
    expect(logText()).not.toContain('Анна');
    expect(logText()).not.toContain(ip);
  });

  it('local lines up to the limit: awaiting confirmation, expires in 24 hours', async () => {
    const cart = await makeCart(withQty(KNECHT_LOCAL, 2));
    const p = ready(await page(cart.token));
    expect(p.decision.scheme).toBe('pay_on_handover');
    const before = Date.now();
    const res = await submit({ token: cart.token, page: p });
    expect(res.status).toBe(201);
    const order = await orderByUrl(res.json.orderUrl);
    expect(order).toMatchObject({
      status: 'awaiting_confirmation',
      paymentScheme: 'pay_on_handover',
    });
    const ttlMs = (await supplier.settings.get()).order.onPickupConfirmTtlH * 3_600_000;
    expect(ttlMs).toBe(24 * 3_600_000);
    const expires = order.expiresAt?.getTime() ?? 0;
    expect(expires).toBeGreaterThanOrEqual(before + ttlMs - 1_000);
    expect(expires).toBeLessThanOrEqual(Date.now() + ttlMs + 1_000);
    expect(order.events[0]?.payload).toEqual({ part: 'all', scheme: 'pay_on_handover', items: 1 });
  });

  it('a client with 2 no-shows gets prepay for local lines; the reason is neutral', async () => {
    const phone = randomPhone();
    await db.insert(users).values({ phone: phone.e164, name: 'Старое имя', noShowCount: 2 });
    const cart = await makeCart(KNECHT_LOCAL);
    const p = ready(await page(cart.token));
    expect(p.decision.scheme).toBe('pay_on_handover');
    // The page showed payment on handover: the prepayment is shown first, never applied
    // silently (409 scheme_changed with the neutral reason), and nothing is written.
    const first = await submit({
      token: cart.token,
      page: p,
      phone: phone.typed,
      name: 'Новое имя',
    });
    expect(first.status).toBe(409);
    expect(first.json).toEqual({
      error: 'scheme_changed',
      message: 'Способ оплаты изменился — проверьте его и отправьте форму ещё раз',
      scheme: 'prepay',
      explanation: ['Для этого номера доступна только предоплата.'],
    });
    expect(await db.select().from(orders).where(eq(orders.checkoutKey, p.checkoutKey))).toEqual([]);
    const before = await db.select().from(users).where(eq(users.phone, phone.e164));
    expect(before[0]).toMatchObject({ name: 'Старое имя' });

    // The form sends the scheme it has now shown.
    const res = await submit({
      token: cart.token,
      page: p,
      phone: phone.typed,
      name: 'Новое имя',
      body: { expectedScheme: 'prepay' },
    });
    expect(res.status).toBe(201);
    const order = await orderByUrl(res.json.orderUrl);
    expect(order).toMatchObject({ status: 'awaiting_payment', paymentScheme: 'prepay' });
    expect(order.events[0]?.payload).toMatchObject({
      scheme: 'prepay',
      schemeReasons: ['no_show'],
      deferredEffects: ['create_payment'],
    });
    // Upsert by phone: one user, the latest name (decision Д14).
    const rows = await db.select().from(users).where(eq(users.phone, phone.e164));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ name: 'Новое имя', noShowCount: 2 });
    const sentences = explainPaymentScheme(
      { scheme: 'prepay', reasons: ['no_show'] },
      { onPickupMaxTotalKop: 1_500_000 },
    );
    expect(sentences).toEqual(['Для этого номера доступна только предоплата.']);
    expect(sentences.join(' ')).not.toMatch(/неявк/i);
  });

  it('records the marketing consent as a second row when ticked', async () => {
    const cart = await makeCart(KNECHT_LOCAL);
    const p = ready(await page(cart.token));
    expect(p.marketingAvailable).toBe(true);
    const res = await submit({ token: cart.token, page: p, body: { consentMarketing: true } });
    expect(res.status).toBe(201);
    const order = await orderByUrl(res.json.orderUrl);
    const given = await db.select().from(consents).where(eq(consents.orderId, order.id));
    expect(given.map((c) => c.kind).sort()).toEqual(['marketing', 'pd']);
    const docs = await gate();
    if (!docs.open) throw new Error('gate closed');
    expect(given.find((c) => c.kind === 'marketing')).toMatchObject({
      documentVersionId: docs.docs.consentMarketing?.id,
      textSha256: docs.docs.consentMarketing?.sha256,
    });
  });

  it('split: part=local, then part=order — two orders, cart converted after the second', async () => {
    const cart = await makeCart(KNECHT_LOCAL, BOSCH_ORDER);
    const phone = randomPhone();
    const local = ready(await page(cart.token, 'local'));
    expect(local.part).toBe('local');
    expect(local.lines.map((l) => l.isLocal)).toEqual([true]);
    expect(local.remainingCount).toBe(1);
    const first = await submit({ token: cart.token, page: local, phone: phone.typed });
    expect(first.status).toBe(201);
    const [mid] = await db.select().from(carts).where(eq(carts.id, cart.id));
    expect(mid?.status).toBe('active');

    const rest = ready(await page(cart.token, 'order'));
    expect(rest.lines.map((l) => l.isLocal)).toEqual([false]);
    expect(rest.remainingCount).toBe(0);
    const second = await submit({ token: cart.token, page: rest, phone: phone.typed });
    expect(second.status).toBe(201);
    expect(second.json.orderUrl).not.toBe(first.json.orderUrl);

    const a = await orderByUrl(first.json.orderUrl);
    const b = await orderByUrl(second.json.orderUrl);
    expect([a.status, a.paymentScheme]).toEqual(['awaiting_confirmation', 'pay_on_handover']);
    expect([b.status, b.paymentScheme]).toEqual(['awaiting_payment', 'prepay']);
    expect(a.events[0]?.payload).toMatchObject({ part: 'local' });
    expect(a.userId).toBe(b.userId);
    const [after] = await db.select().from(carts).where(eq(carts.id, cart.id));
    expect(after?.status).toBe('converted');
    expect(await page(cart.token)).toEqual({ kind: 'no_cart' });
  });
});

describe('POST /api/checkout: idempotency', () => {
  it('the same checkoutKey twice in a row gives one order and the same URL', async () => {
    const cart = await makeCart(KNECHT_LOCAL);
    const p = ready(await page(cart.token));
    const phone = randomPhone().typed;
    const first = await submit({ token: cart.token, page: p, phone });
    const second = await submit({ token: cart.token, page: p, phone });
    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    expect(second.json).toEqual(first.json);
    expect(
      await db.select().from(orders).where(eq(orders.checkoutKey, p.checkoutKey)),
    ).toHaveLength(1);
  });

  it('two parallel submits with one key give one order and the same URL', async () => {
    const cart = await makeCart(KNECHT_LOCAL, BOSCH_ORDER);
    const p = ready(await page(cart.token));
    const phone = randomPhone().typed;
    const [a, b] = await Promise.all([
      submit({ token: cart.token, page: p, phone }),
      submit({ token: cart.token, page: p, phone }),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 201]);
    expect(a.json.orderUrl).toBe(b.json.orderUrl);
    const rows = await db.select().from(orders).where(eq(orders.checkoutKey, p.checkoutKey));
    expect(rows).toHaveLength(1);
    const items = await db
      .select()
      .from(orderItems)
      .where(
        inArray(
          orderItems.orderId,
          rows.map((r) => r.id),
        ),
      );
    expect(items).toHaveLength(2);
  });

  it('a duplicate whose key check ran before the first commit still gets the same order', async () => {
    const cart = await makeCart(KNECHT_LOCAL);
    const p = ready(await page(cart.token));
    const phone = randomPhone().typed;
    // The duplicate's first lookup by checkout_key misses (the first submit has not committed
    // yet) and its answer is held until the first submit has converted the cart.
    let releaseLookup: () => void = () => undefined;
    const firstDone = new Promise<void>((resolve) => {
      releaseLookup = resolve;
    });
    let held = false;
    let onHeld: () => void = () => undefined;
    const lookupHeld = new Promise<void>((resolve) => {
      onHeld = resolve;
    });
    const racingDb = new Proxy(db, {
      get(target, prop) {
        if (prop === 'query') {
          return new Proxy(target.query, {
            get(query, table) {
              if (table !== 'orders') return Reflect.get(query, table) as unknown;
              return {
                findFirst: async (...args: Parameters<typeof query.orders.findFirst>) => {
                  const result = await query.orders.findFirst(...args);
                  if (!held) {
                    held = true;
                    expect(result).toBeUndefined();
                    onHeld();
                    await firstDone;
                  }
                  return result;
                },
              };
            },
          });
        }
        const value = Reflect.get(target, prop) as unknown;
        return typeof value === 'function'
          ? (value as (...args: unknown[]) => unknown).bind(target)
          : value;
      },
    });
    const duplicate = submit(
      { token: cart.token, page: p, phone },
      createCheckoutService({
        db: racingDb,
        supplier: { rossko },
        loadSettings,
        gate,
        logger,
        env: { APP_BASE_URL: BASE_URL, TRUSTED_IP_HEADER: 'x-real-ip' },
      }),
    );
    await lookupHeld;
    const first = await submit({ token: cart.token, page: p, phone });
    releaseLookup();
    const second = await duplicate;
    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    expect(second.json.orderUrl).toBe(first.json.orderUrl);
  });

  it('a key used with another cart does not reveal that order', async () => {
    const cart = await makeCart(KNECHT_LOCAL);
    const p = ready(await page(cart.token));
    expect((await submit({ token: cart.token, page: p })).status).toBe(201);
    const other = await makeCart(KNECHT_LOCAL);
    const res = await submit({ token: other.token, page: p });
    expect(res.status).toBe(409);
    expect(res.json.error).toBe('checkout_key_conflict');
    expect(res.json).not.toHaveProperty('orderUrl');
  });
});

describe('POST /api/checkout: stale prices and contents (409)', () => {
  it('the supplier price rose between the page and the submit: 409, nothing created, cart repriced', async () => {
    const cart = await makeCart(KNECHT_LOCAL);
    const p = ready(await page(cart.token));
    const oldPrice = p.lines[0]?.priceClientKop;
    priceFactor = 1.1;
    const phone = randomPhone();
    const res = await submit({ token: cart.token, page: p, phone: phone.typed });
    expect(res.status).toBe(409);
    expect(res.json).toMatchObject({ error: 'stale' });
    const changes = res.json.changes as {
      kind: string;
      oldPriceKop: number;
      newPriceKop: number;
    }[];
    expect(changes[0]).toMatchObject({ kind: 'price', oldPriceKop: oldPrice });
    expect(changes[0]!.newPriceKop).toBeGreaterThan(oldPrice!);
    expect(res.json.totalKop).toBe(changes[0]!.newPriceKop);
    expect(res.json.itemsHash).toMatch(/^[0-9a-f]{64}$/);
    expect(res.json.itemsHash).not.toBe(p.itemsHash);
    await nothingCreated(phone.e164, p.checkoutKey);

    const [line] = await db.select().from(cartItems).where(eq(cartItems.cartId, cart.id));
    expect(line?.priceClientKop).toBe(changes[0]!.newPriceKop);
    expect(logs.find((l) => l.message === 'checkout stale')?.details).toEqual({
      changes: 1,
      lines: 1,
    });

    // The refreshed page shows the new total and the same hash; a resubmit goes through.
    const again = ready(await page(cart.token));
    expect(again.changes).toEqual([]);
    expect(again.itemsHash).toBe(res.json.itemsHash);
    expect(again.totals.subtotalKop).toBe(res.json.totalKop);
    const ok = await submit({ token: cart.token, page: again, phone: phone.typed });
    expect(ok.status).toBe(201);
  });

  it('a stale expectedTotalKop from the client gives 409 without line changes', async () => {
    const cart = await makeCart(KNECHT_LOCAL);
    const p = ready(await page(cart.token));
    const phone = randomPhone();
    const res = await submit({
      token: cart.token,
      page: p,
      phone: phone.typed,
      body: { expectedTotalKop: p.totals.subtotalKop - 10_000 },
    });
    expect(res.status).toBe(409);
    expect(res.json).toMatchObject({
      error: 'stale',
      changes: [],
      totalKop: p.totals.subtotalKop,
      itemsHash: p.itemsHash,
    });
    await nothingCreated(phone.e164, p.checkoutKey);
  });

  it('a stale itemsHash gives 409', async () => {
    const cart = await makeCart(KNECHT_LOCAL);
    const p = ready(await page(cart.token));
    const res = await submit({ token: cart.token, page: p, body: { itemsHash: 'f'.repeat(64) } });
    expect(res.status).toBe(409);
    expect(res.json.itemsHash).toBe(p.itemsHash);
  });

  it('a stop rule that appeared after adding: 409 excluded, the line leaves the cart', async () => {
    const cart = await makeCart(KNECHT_LOCAL, BOSCH_ORDER);
    const p = ready(await page(cart.token));
    excludedOverride = [{ kind: 'keyword', pattern: 'фильтр*', reason: 'Тестовая стоп-группа' }];
    const phone = randomPhone();
    const res = await submit({ token: cart.token, page: p, phone: phone.typed });
    expect(res.status).toBe(409);
    const changes = res.json.changes as { kind: string; reason?: string }[];
    expect(changes.map((c) => c.kind)).toEqual(['excluded', 'excluded']);
    expect(changes[0]?.reason).toBe('Тестовая стоп-группа');
    expect(res.json.totalKop).toBe(0);
    await nothingCreated(phone.e164, p.checkoutKey);
    expect(await db.select().from(cartItems).where(eq(cartItems.cartId, cart.id))).toEqual([]);
    expect(await page(cart.token)).toEqual({ kind: 'no_cart' });
  });

  it('the cart was edited in another tab during the supplier check: 409, nothing created', async () => {
    const cart = await makeCart(withQty(KNECHT_LOCAL, 2));
    const p = ready(await page(cart.token));
    const inner = rossko;
    rossko = {
      async search(article, options) {
        const result = await inner.search(article, options);
        await db.update(cartItems).set({ qty: 1 }).where(eq(cartItems.cartId, cart.id));
        return result;
      },
    };
    const phone = randomPhone();
    const res = await submit({ token: cart.token, page: p, phone: phone.typed });
    expect(res.status).toBe(409);
    expect(res.json).toMatchObject({
      error: 'stale',
      changes: [],
      totalKop: null,
      itemsHash: null,
    });
    await nothingCreated(phone.e164, p.checkoutKey);
    const [line] = await db.select().from(cartItems).where(eq(cartItems.cartId, cart.id));
    expect(line?.qty).toBe(1);
  });

  it('an offer that vanished at the supplier is removed from the cart (409 unavailable)', async () => {
    const cart = await makeCart(KNECHT_LOCAL);
    await db
      .update(cartItems)
      .set({ offerKey: 'OC90:Knecht:GONE1' })
      .where(eq(cartItems.cartId, cart.id));
    const res = await submit({
      token: cart.token,
      body: { expectedTotalKop: 52_800, itemsHash: 'a'.repeat(64) },
    });
    expect(res.status).toBe(409);
    expect((res.json.changes as { kind: string }[])[0]?.kind).toBe('unavailable');
    expect(await db.select().from(cartItems).where(eq(cartItems.cartId, cart.id))).toEqual([]);
  });
});

describe('POST /api/checkout: refusals that create nothing', () => {
  it.each([
    ['consentPd', { consentPd: false }, 'consentPd'],
    ['acceptOffer', { acceptOffer: undefined }, 'acceptOffer'],
  ])('without %s: 422 consent_required', async (_label, override, field) => {
    const cart = await makeCart(KNECHT_LOCAL);
    const p = ready(await page(cart.token));
    const phone = randomPhone();
    const res = await submit({ token: cart.token, page: p, phone: phone.typed, body: override });
    expect(res.status).toBe(422);
    expect(res.json.error).toBe('consent_required');
    expect(res.json.fields).toHaveProperty(field);
    await nothingCreated(phone.e164, p.checkoutKey);
    expect(searches).toEqual([]);
    const [still] = await db.select().from(carts).where(eq(carts.id, cart.id));
    expect(still?.status).toBe('active');
  });

  it('a bad phone: 422 validation with the field message', async () => {
    const cart = await makeCart(KNECHT_LOCAL);
    const p = ready(await page(cart.token));
    const res = await submit({ token: cart.token, page: p, phone: '+1 202 555 0100' });
    expect(res.status).toBe(422);
    expect(res.json).toMatchObject({ error: 'validation', fields: { phone: expect.any(String) } });
  });

  it('a filled honeypot: 400, only the fact is logged', async () => {
    const cart = await makeCart(KNECHT_LOCAL);
    const p = ready(await page(cart.token));
    const phone = randomPhone();
    const res = await submit({
      token: cart.token,
      page: p,
      phone: phone.typed,
      body: { website: 'http://spam.example' },
    });
    expect(res.status).toBe(400);
    expect(res.json.error).toBe('rejected');
    await nothingCreated(phone.e164, p.checkoutKey);
    expect(logs).toEqual([{ level: 'warn', details: {}, message: 'checkout honeypot' }]);
  });

  it.each([
    ['a foreign Origin', { origin: 'https://evil.example' }],
    ['no Origin and no Sec-Fetch-Site', { origin: '' }],
    ['no Origin and a cross-site fetch', { origin: '', 'sec-fetch-site': 'cross-site' }],
  ])('%s: 403', async (_label, headers) => {
    const cart = await makeCart(KNECHT_LOCAL);
    const p = ready(await page(cart.token));
    const phone = randomPhone();
    const res = await submit({ token: cart.token, page: p, phone: phone.typed, headers });
    expect(res.status).toBe(403);
    expect(res.json.error).toBe('forbidden_origin');
    await nothingCreated(phone.e164, p.checkoutKey);
  });

  it('no Origin but Sec-Fetch-Site same-origin is accepted', async () => {
    const cart = await makeCart(KNECHT_LOCAL);
    const p = ready(await page(cart.token));
    const res = await submit({
      token: cart.token,
      page: p,
      headers: { origin: '', 'sec-fetch-site': 'same-origin' },
    });
    expect(res.status).toBe(201);
  });

  it('minOrderTotalKop 100 000 through injected settings: 422 below_minimum with the missing sum', async () => {
    settingsOverride = { minOrderTotalKop: 100_000 };
    const cart = await makeCart(KNECHT_LOCAL);
    const p = ready(await page(cart.token));
    expect(p.totals.subtotalKop).toBe(52_800);
    expect(p.minimums.ok).toBe(false);
    const phone = randomPhone();
    const res = await submit({ token: cart.token, page: p, phone: phone.typed });
    expect(res.status).toBe(422);
    expect(res.json).toMatchObject({ error: 'below_minimum', code: 'min_total' });
    expect(String(res.json.message).replace(/\u00a0/g, ' ')).toBe(
      'Минимальная сумма заказа 1 000 ₽ — добавьте позиции ещё на 472 ₽',
    );
    await nothingCreated(phone.e164, p.checkoutKey);
  });

  it('minMarginKop above the margin: 422 without disclosing the margin', async () => {
    settingsOverride = { minMarginKop: 1_000_000 };
    const cart = await makeCart(KNECHT_LOCAL);
    const p = ready(await page(cart.token));
    const phone = randomPhone();
    const res = await submit({ token: cart.token, page: p, phone: phone.typed });
    expect(res.status).toBe(422);
    expect(res.json).toEqual({
      error: 'below_minimum',
      code: 'min_margin',
      message: 'Заказ слишком маленький для оформления на сайте — добавьте ещё позицию',
    });
    await nothingCreated(phone.e164, p.checkoutKey);
  });

  it('RKN_NOTICE_NUMBER empty: 403 checkout_closed and a page without PD fields', async () => {
    gateEnv = intEnv({ RKN_NOTICE_NUMBER: undefined, PICKUP_PHONE: '+7 900 000-00-01' });
    const cart = await makeCart(KNECHT_LOCAL);
    const phone = randomPhone();
    const res = await submit({
      token: cart.token,
      phone: phone.typed,
      body: { expectedTotalKop: 52_800, itemsHash: 'a'.repeat(64) },
    });
    expect(res.status).toBe(403);
    expect(res.json.error).toBe('checkout_closed');
    expect(res.json.message).toBe(
      'Оформление на сайте скоро откроется. Пока закажите по телефону +7 900 000-00-01.',
    );
    expect(searches).toEqual([]);
    await nothingCreated(phone.e164, res.sent.checkoutKey);

    const data = await page(cart.token);
    expect(data.kind).toBe('closed');
    if (data.kind !== 'closed') return;
    const html = renderToStaticMarkup(
      createElement(CheckoutClosed, { message: data.message, phone: '+7 900 000-00-01' }),
    );
    expect(html).toContain('Оформление на сайте скоро откроется');
    expect(html).toContain('tel:+79000000001');
    expect(html).not.toMatch(/<(input|form|textarea|select)\b/);
  });

  it('the supplier fails: 503, nothing created', async () => {
    const cart = await makeCart(KNECHT_LOCAL);
    const p = ready(await page(cart.token));
    failSearch = true;
    const phone = randomPhone();
    const res = await submit({ token: cart.token, page: p, phone: phone.typed });
    expect(res.status).toBe(503);
    expect(res.json.error).toBe('supplier_unavailable');
    await nothingCreated(phone.e164, p.checkoutKey);
    expect(logs.find((l) => l.message === 'checkout supplier unavailable')).toBeDefined();
  });

  it('the limiter has no window (RosskoRateLimitError): 503 with Retry-After', async () => {
    const cart = await makeCart(KNECHT_LOCAL);
    const p = ready(await page(cart.token));
    rossko = {
      search: () => Promise.reject(new RosskoRateLimitError(4_200)),
    };
    const phone = randomPhone();
    const res = await submit({ token: cart.token, page: p, phone: phone.typed });
    expect(res.status).toBe(503);
    expect(res.headers.get('retry-after')).toBe('5');
    expect(res.headers.get('cache-control')).toBe('no-store');
    await nothingCreated(phone.e164, p.checkoutKey);
  });

  it('no cart cookie, an unknown cart or a converted cart: 404 cart_empty', async () => {
    expect((await submit({ token: null })).json.error).toBe('cart_empty');
    expect((await submit({ token: newCartToken() })).status).toBe(404);
    const cart = await makeCart(KNECHT_LOCAL);
    await db.update(carts).set({ status: 'converted' }).where(eq(carts.id, cart.id));
    expect((await submit({ token: cart.token })).status).toBe(404);
  });

  it('a body that is not JSON or lacks the hidden fields: 400', async () => {
    const cart = await makeCart(KNECHT_LOCAL);
    expect((await submit({ token: cart.token, rawBody: 'phone=1' })).status).toBe(400);
    const res = await submit({ token: cart.token, body: { checkoutKey: 'x' } });
    expect(res.status).toBe(400);
    expect(res.json.error).toBe('bad_request');
  });
});

describe('/checkout page data', () => {
  it('reprices through the cache and offers the split for a mixed cart', async () => {
    const cart = await makeCart(KNECHT_LOCAL, BOSCH_ORDER);
    const p = ready(await page(cart.token));
    // The fixture answer was cached by makeCart: no new GetSearch for the page.
    expect(searches).toEqual([]);
    expect(p.part).toBe('all');
    expect(p.offerSplit).toBe(true);
    expect(p.explanation[0]).toContain('детали под заказ');
    expect(p.promisedDate).not.toBeNull();
    // Per line: the eta buffer is added as on /cart, never the raw supplier date.
    const { eta } = await supplier.settings.get();
    for (const line of p.lines) {
      expect(line.etaDate).not.toBeNull();
      expect(p.linePromises[line.id]).toBe(
        formatPromise(addDays(line.etaDate as IsoDate, eta.bufferDays)),
      );
    }
    expect(eta.bufferDays).toBeGreaterThan(0);
    expect(p.checkoutKey).toMatch(/^[0-9a-f-]{36}$/);
    // A homogeneous cart ignores part.
    const single = await makeCart(KNECHT_LOCAL);
    expect(ready(await page(single.token, 'order')).part).toBe('all');
  });

  it('no cart or an empty cart: no_cart (the page redirects to /cart)', async () => {
    expect(await page(null)).toEqual({ kind: 'no_cart' });
    expect(await page(newCartToken())).toEqual({ kind: 'no_cart' });
    const token = newCartToken();
    await db.insert(carts).values({ anonToken: token });
    expect(await page(token)).toEqual({ kind: 'no_cart' });
  });

  it('a page repricing that removes everything shows the changes once', async () => {
    const cart = await makeCart(KNECHT_LOCAL);
    excludedOverride = [{ kind: 'keyword', pattern: 'фильтр*', reason: 'Тест' }];
    const data = await page(cart.token);
    expect(data.kind).toBe('emptied');
    expect(await page(cart.token)).toEqual({ kind: 'no_cart' });
  });
});

describe('checkout terms the client saw (audit of phase 1A)', () => {
  it('a page view with nothing cached never calls the supplier; the submit checks fresh', async () => {
    const cart = await makeCart(KNECHT_LOCAL, BOSCH_ORDER);
    // Another prefix: the cache filled by makeCart is not visible to this supplier.
    const prefix = testKeyPrefix();
    prefixes.push(prefix);
    supplier = createSupplierDeps({ env: intEnv(), db, redis, keyPrefix: prefix, caller });
    rossko = supplier.rossko;
    searches.length = 0;
    const p = ready(await page(cart.token));
    expect(searches).toEqual([]);
    expect(p.staleCount).toBe(2);
    const res = await submit({ token: cart.token, page: p });
    expect(res.status).toBe(201);
    expect(searches.sort()).toEqual(['OC90']);
  });

  it('a new consent version published after the page: 409 documents_changed, nothing created', async () => {
    const cart = await makeCart(KNECHT_LOCAL);
    const p = ready(await page(cart.token));
    // Sorts before the seeded versions, so only an env pointing at it serves it.
    const bodyMd = '# Согласие\n\nНовая редакция.\n';
    await db
      .insert(documentVersions)
      .values({
        kind: 'consent_pd',
        version: '0000-web-test-pd2',
        title: 'Согласие (новая редакция)',
        bodyMd,
        sha256: sha256Hex(bodyMd),
        sourcePath: 'test/consent_pd/0000-web-test-pd2.md',
        publishedAt: null,
      })
      .onConflictDoNothing();
    gateEnv = intEnv({
      RKN_NOTICE_NUMBER: 'TEST-1',
      LEGAL_CONSENT_PD_VERSION: '0000-web-test-pd2',
    });
    const phone = randomPhone();
    const res = await submit({ token: cart.token, page: p, phone: phone.typed });
    expect(res.status).toBe(409);
    expect(res.json).toMatchObject({ error: 'documents_changed' });
    await nothingCreated(phone.e164, p.checkoutKey);
    expect(searches).toEqual([]);

    // The re-rendered page carries the new version; the consent records exactly that one.
    const again = ready(await page(cart.token));
    expect(again.documents.consentPdVersionId).not.toBe(p.documents.consentPdVersionId);
    const ok = await submit({ token: cart.token, page: again, phone: phone.typed });
    expect(ok.status).toBe(201);
    const order = await orderByUrl(ok.json.orderUrl);
    const [pd] = await db.select().from(consents).where(eq(consents.orderId, order.id));
    expect(pd).toMatchObject({
      documentVersionId: again.documents.consentPdVersionId,
      textSha256: sha256Hex(bodyMd),
    });
    expect(order.offerVersionId).toBe(again.documents.offerVersionId);
  });

  it('an outdated offer or marketing version from the form: 409, nothing created', async () => {
    const cart = await makeCart(KNECHT_LOCAL);
    const p = ready(await page(cart.token));
    const phone = randomPhone();
    const offer = await submit({
      token: cart.token,
      page: p,
      phone: phone.typed,
      body: { offerVersionId: uuidV7() },
    });
    expect(offer.status).toBe(409);
    expect(offer.json.error).toBe('documents_changed');
    const marketing = await submit({
      token: cart.token,
      page: p,
      phone: phone.typed,
      body: { consentMarketing: true, consentMarketingVersionId: uuidV7() },
    });
    expect(marketing.status).toBe(409);
    await nothingCreated(phone.e164, p.checkoutKey);
    // Without the marketing tick its version does not matter.
    const ok = await submit({
      token: cart.token,
      page: p,
      phone: phone.typed,
      body: { consentMarketingVersionId: uuidV7() },
    });
    expect(ok.status).toBe(201);
  });

  it('settings from env fallbacks (database read failed): 503, no supplier call, no order', async () => {
    const cart = await makeCart(KNECHT_LOCAL);
    const p = ready(await page(cart.token));
    const svc = createCheckoutService({
      db,
      supplier: { rossko },
      loadSettings: async () => ({ ...(await loadSettings()), fromDatabase: false }),
      gate,
      logger,
      env: { APP_BASE_URL: BASE_URL, TRUSTED_IP_HEADER: 'x-real-ip' },
    });
    const phone = randomPhone();
    const res = await submit({ token: cart.token, page: p, phone: phone.typed }, svc);
    expect(res.status).toBe(503);
    expect(res.json).toMatchObject({ error: 'settings_unavailable' });
    expect(res.headers.get('retry-after')).toBe('60');
    expect(searches).toEqual([]);
    await nothingCreated(phone.e164, p.checkoutKey);
  });

  it('a later promised date than the page showed: 409 with the new date; an earlier one is fine', async () => {
    const cart = await makeCart(KNECHT_LOCAL);
    const p = ready(await page(cart.token));
    if (p.promisedDate === null) throw new Error('no promised date');
    const shown = addDays(p.promisedDate, -1);
    const phone = randomPhone();
    const res = await submit({
      token: cart.token,
      page: p,
      phone: phone.typed,
      body: { expectedPromisedDate: shown },
    });
    expect(res.status).toBe(409);
    expect(res.json).toMatchObject({
      error: 'stale',
      message: 'Срок получения изменился — проверьте его и отправьте форму ещё раз',
      changes: [],
      promisedDate: p.promisedDate,
      promiseText: formatPromise(p.promisedDate),
      totalKop: p.totals.subtotalKop,
      itemsHash: p.itemsHash,
    });
    await nothingCreated(phone.e164, p.checkoutKey);

    const earlier = await submit({
      token: cart.token,
      page: p,
      phone: phone.typed,
      body: { expectedPromisedDate: addDays(p.promisedDate, 1) },
    });
    expect(earlier.status).toBe(201);
    expect((await orderByUrl(earlier.json.orderUrl)).promisedDate).toBe(p.promisedDate);
  });

  it('an order above MAX_ORDER_TOTAL_KOP: the page blocks it and the API answers 422', async () => {
    priceFactor = 200;
    const cart = await makeCart(withQty(KNECHT_LOCAL, 6));
    const p = ready(await page(cart.token));
    expect(p.totals.subtotalKop).toBeGreaterThan(MAX_ORDER_TOTAL_KOP);
    expect(p.minimums).toMatchObject({ ok: false, code: 'max_total' });
    const phone = randomPhone();
    const res = await submit({ token: cart.token, page: p, phone: phone.typed });
    expect(res.status).toBe(422);
    expect(res.json).toMatchObject({ error: 'below_minimum', code: 'max_total' });
    await nothingCreated(phone.e164, p.checkoutKey);
  });

  it('the split is not offered when a part alone misses the minimum order total', async () => {
    const cart = await makeCart(KNECHT_LOCAL, BOSCH_ORDER);
    const whole = ready(await page(cart.token));
    expect(whole.offerSplit).toBe(true);
    // The whole cart passes, the Orenburg part alone (528 ₽) does not.
    settingsOverride = { minOrderTotalKop: whole.totals.subtotalKop - 100 };
    const p = ready(await page(cart.token));
    expect(p.minimums.ok).toBe(true);
    expect(p.offerSplit).toBe(false);
  });
});
