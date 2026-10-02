// Cart API and cart page data against local PG/Redis with the fixtures caller (wrapped to
// count, fail and reprice supplier answers). Unique cart tokens per test; Redis keys live
// under test:<uuid>:.
import { createRedis, type Redis } from '@detaly/config';
import { deleteKeysByPrefix, testKeyPrefix, testRedisUrl } from '@detaly/config/testing';
import { cartItems, carts, createDb, eq, sql, type Db } from '@detaly/db';
import { createFixtureCaller, RosskoCallError, type RosskoCaller } from '@detaly/rossko';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { cartServiceFromSupplier } from '@/server/cart';
import { CART_ERROR_MESSAGES } from '@/server/cart/errors';
import { countCartLines } from '@/server/cart/count';
import type { CartService } from '@/server/cart/cart-service';
import { handleAddItem, handleLineRequest, type CartHandlerDeps } from '@/server/cart/http';
import { CART_COOKIE, MAX_CART_LINES, MAX_CART_SEARCHES, newCartToken } from '@/server/cart-store';
import { createSupplierDeps, type Supplier } from '@/server/supplier';
import { intEnv, webDatabaseUrl } from './helpers';

const prefix = testKeyPrefix();
let redis: Redis;
let db: Db;
let supplier: Supplier;
let service: CartService;
let deps: CartHandlerDeps;

const fixtures = createFixtureCaller();
const calls: string[] = [];
const failing = new Set<string>();
let priceFactor = 1;

/** Fixture caller that counts GetSearch calls and can fail or reprice articles. */
const caller: RosskoCaller = {
  lastRawResponse: null,
  async call(method, args) {
    const text = String(args.text ?? '');
    if (method === 'GetSearch') {
      calls.push(text);
      if (failing.has(text)) throw new RosskoCallError('GetSearch', 'synthetic failure');
    }
    const raw = (await fixtures.call(method, args)) as unknown;
    if (method !== 'GetSearch' || priceFactor === 1) return raw;
    return JSON.parse(JSON.stringify(raw), (key, value: unknown) =>
      key === 'price' && (typeof value === 'string' || typeof value === 'number')
        ? (Number(String(value).replace(',', '.')) * priceFactor).toFixed(2)
        : value,
    ) as unknown;
  },
};

const env = intEnv();
const ORIGIN = new URL(env.APP_BASE_URL).origin;

const KNECHT_ORB1 = 'OC90:Knecht:ORB1';
const BOSCH_MSK7 = '0451103079:BOSCH:MSK7';
const LUCAS_MSK7 = 'GDB1330:LUCAS:MSK7';
const CASTROL_ORB1 = 'EDGE5W40:CASTROL:ORB1';

beforeAll(() => {
  redis = createRedis(testRedisUrl());
  db = createDb(webDatabaseUrl(), { max: 4 });
  supplier = createSupplierDeps({ env, db, redis, keyPrefix: prefix, caller });
  service = cartServiceFromSupplier(supplier, db);
  deps = { service, env };
});

beforeEach(() => {
  calls.length = 0;
  failing.clear();
  priceFactor = 1;
});

afterAll(async () => {
  await deleteKeysByPrefix(redis, prefix);
  await redis.quit();
  await db.close();
});

/** Drops cached supplier answers (and limiter counters) of this file only. */
async function clearSupplierCache(): Promise<void> {
  await deleteKeysByPrefix(redis, prefix);
}

interface RequestOptions {
  token?: string | null;
  origin?: string | null;
  secFetchSite?: string;
  method?: string;
}

function headersFor(contentType: string | null, opts: RequestOptions): Headers {
  const headers = new Headers();
  if (contentType) headers.set('content-type', contentType);
  const origin = opts.origin === undefined ? ORIGIN : opts.origin;
  if (origin !== null) headers.set('origin', origin);
  if (opts.secFetchSite) headers.set('sec-fetch-site', opts.secFetchSite);
  if (opts.token) headers.set('cookie', `theme=dark; ${CART_COOKIE}=${opts.token}`);
  return headers;
}

function form(path: string, fields: Record<string, string>, opts: RequestOptions = {}): Request {
  return new Request(`${ORIGIN}${path}`, {
    method: opts.method ?? 'POST',
    headers: headersFor('application/x-www-form-urlencoded', opts),
    body: new URLSearchParams(fields).toString(),
  });
}

function json(path: string, body: unknown, opts: RequestOptions = {}): Request {
  return new Request(`${ORIGIN}${path}`, {
    method: opts.method ?? 'POST',
    headers: headersFor('application/json', opts),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function cookieToken(res: Response): string | null {
  const header = res.headers.get('set-cookie');
  const match = header ? new RegExp(`${CART_COOKIE}=([^;]+)`).exec(header) : null;
  return match?.[1] ?? null;
}

async function add(
  offerId: string,
  { q = 'OC90', qty, token }: { q?: string; qty?: number; token?: string | null } = {},
): Promise<{ res: Response; body: Record<string, unknown>; token: string | null }> {
  const res = await handleAddItem(
    json('/api/cart/items', { q, offerId, ...(qty === undefined ? {} : { qty }) }, { token }),
    deps,
  );
  const body = (await res.json()) as Record<string, unknown>;
  return { res, body, token: cookieToken(res) ?? token ?? null };
}

async function linesOf(token: string) {
  const [cart] = await db.select().from(carts).where(eq(carts.anonToken, token));
  if (!cart) return [];
  return db.select().from(cartItems).where(eq(cartItems.cartId, cart.id));
}

async function cartCount(): Promise<number> {
  const [row] = await db.select({ n: sql<number>`count(*)::int` }).from(carts);
  return row?.n ?? 0;
}

describe('POST /api/cart/items', () => {
  it('adds Knecht OC 90 (ORB1) from a form: 303, cookie, price ceil(412.50 × 1.28) = 528 ₽', async () => {
    const res = await handleAddItem(
      form('/api/cart/items', { q: 'oc 90', offerId: KNECHT_ORB1, qty: '1' }),
      deps,
    );
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/cart?added=1');
    expect(res.headers.get('cache-control')).toBe('no-store');
    const setCookie = res.headers.get('set-cookie') ?? '';
    expect(setCookie).toMatch(/^cart=[A-Za-z0-9_-]{43}; /);
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('SameSite=Lax');
    expect(setCookie).toContain('Path=/');
    expect(setCookie).toContain(`Max-Age=${30 * 86_400}`);
    expect(setCookie).not.toContain('Secure');

    const token = cookieToken(res);
    if (!token) throw new Error('no cookie');
    const rows = await linesOf(token);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      offerKey: KNECHT_ORB1,
      searchArticleNorm: 'OC90',
      brand: 'Knecht',
      article: 'OC 90',
      qty: 1,
      stockId: 'ORB1',
      isLocal: true,
      priceSupplierKop: 41_250,
      priceClientKop: 52_800,
      markupBp: 2800,
    });
    expect(rows[0]?.offerSnapshot.priceSupplierKop).toBe(41_250);
    expect(await countCartLines(db, token)).toBe(1);
  });

  it('JSON: 200 {count, totalKop}; the same offer again -> one line with qty 2', async () => {
    const first = await add(KNECHT_ORB1);
    expect(first.res.status).toBe(200);
    expect(first.body).toEqual({ count: 1, totalKop: 52_800 });
    const token = first.token;
    if (!token) throw new Error('no cookie');

    const second = await add(KNECHT_ORB1, { token });
    expect(second.res.status).toBe(200);
    expect(second.body).toEqual({ count: 1, totalKop: 105_600 });
    expect(cookieToken(second.res)).toBe(token);
    const rows = await linesOf(token);
    expect(rows.map((r) => [r.offerKey, r.qty])).toEqual([[KNECHT_ORB1, 2]]);

    // A cross found by the same query is a second line (BOSCH, to order).
    const third = await add(BOSCH_MSK7, { token });
    expect(third.body).toEqual({ count: 2, totalKop: 105_600 + 64_200 });
    expect((await linesOf(token)).find((r) => r.offerKey === BOSCH_MSK7)).toMatchObject({
      searchArticleNorm: 'OC90',
      isLocal: false,
    });
  });

  it('marked goods (EDGE5W40, motor oil) are not added: 422 excluded, no cart is created', async () => {
    const before = await cartCount();
    const { res, body, token } = await add(CASTROL_ORB1, { q: 'EDGE5W40' });
    expect(res.status).toBe(422);
    expect(body).toEqual({ error: 'excluded', message: 'Не продаём онлайн, спросите в сервисе' });
    expect(token).toBeNull();

    const viaForm = await handleAddItem(
      form('/api/cart/items', { q: 'EDGE5W40', offerId: CASTROL_ORB1 }),
      deps,
    );
    expect(viaForm.status).toBe(303);
    expect(viaForm.headers.get('location')).toBe('/cart?error=excluded');
    expect(viaForm.headers.get('set-cookie')).toBeNull();
    expect(await cartCount()).toBe(before);

    // Into an existing cart: nothing is added either.
    const existing = await add(KNECHT_ORB1);
    if (!existing.token) throw new Error('no cookie');
    const again = await add(CASTROL_ORB1, { q: 'EDGE5W40', token: existing.token });
    expect(again.res.status).toBe(422);
    expect((await linesOf(existing.token)).map((r) => r.offerKey)).toEqual([KNECHT_ORB1]);
  });

  it('quantity above the stock or not a multiple of the step -> 422 qty', async () => {
    const tooMany = await add(KNECHT_ORB1, { qty: 7 });
    expect(tooMany.res.status).toBe(422);
    expect(tooMany.body).toEqual({ error: 'qty', message: 'В наличии только 6 шт.' });

    const notMultiple = await add(LUCAS_MSK7, { q: 'GDB1330', qty: 3 });
    expect(notMultiple.res.status).toBe(422);
    expect(notMultiple.body.error).toBe('qty');
    expect(String(notMultiple.body.message)).toContain('кратно 2');

    // Without qty the step is added; a sum above the stock is refused and nothing changes.
    const lucas = await add(LUCAS_MSK7, { q: 'GDB1330' });
    expect(lucas.body).toEqual({ count: 1, totalKop: expect.any(Number) as number });
    if (!lucas.token) throw new Error('no cookie');
    expect((await linesOf(lucas.token))[0]?.qty).toBe(2);
    const over = await add(LUCAS_MSK7, { q: 'GDB1330', qty: 2, token: lucas.token });
    expect(over.res.status).toBe(422);
    expect(over.body.message).toBe('В наличии только 3 шт.');
    expect((await linesOf(lucas.token))[0]?.qty).toBe(2);

    const zero = await add(KNECHT_ORB1, { qty: 0 });
    expect(zero.res.status).toBe(422);
    const fractional = await handleAddItem(
      json('/api/cart/items', { q: 'OC90', offerId: KNECHT_ORB1, qty: 1.5 }),
      deps,
    );
    expect(fractional.status).toBe(400);
  });

  it('bad input -> 400, an unknown offer -> 404, a supplier failure -> 503', async () => {
    expect((await add(KNECHT_ORB1, { q: '' })).res.status).toBe(400);
    expect((await add('', { q: 'OC90' })).res.status).toBe(400);
    const malformed = await handleAddItem(
      new Request(`${ORIGIN}/api/cart/items`, {
        method: 'POST',
        headers: headersFor('application/json', {}),
        body: '{not json',
      }),
      deps,
    );
    expect(malformed.status).toBe(400);

    const missing = await add('OC90:Knecht:NOPE');
    expect(missing.res.status).toBe(404);
    expect(missing.body.error).toBe('offer_not_found');

    await clearSupplierCache();
    failing.add('W9142');
    const down = await add('W9142:MANN-FILTER:MSK7', { q: 'W9142' });
    expect(down.res.status).toBe(503);
    expect(down.body.error).toBe('supplier_unavailable');
  });

  it('a converted cart in the cookie gets a new cart and a new cookie', async () => {
    const oldToken = newCartToken();
    await db.insert(carts).values({ anonToken: oldToken, status: 'converted' });
    const { res, token } = await add(KNECHT_ORB1, { token: oldToken });
    expect(res.status).toBe(200);
    expect(token).not.toBe(oldToken);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it(`at most ${MAX_CART_LINES} lines and ${MAX_CART_SEARCHES} distinct query articles`, async () => {
    const first = await add(KNECHT_ORB1);
    if (!first.token) throw new Error('no cookie');
    const [cart] = await db.select().from(carts).where(eq(carts.anonToken, first.token));
    const [row] = await linesOf(first.token);
    if (!cart || !row) throw new Error('cart missing');
    const { id: _id, createdAt: _c, updatedAt: _u, ...template } = row;
    await db.insert(cartItems).values(
      Array.from({ length: MAX_CART_LINES - 1 }, (_, i) => ({
        ...template,
        offerKey: `FAKE${i}:X:S`,
      })),
    );
    const full = await add(BOSCH_MSK7, { token: first.token });
    expect(full.res.status).toBe(422);
    expect(full.body).toEqual({ error: 'cart_full', message: CART_ERROR_MESSAGES.cart_full });
    // The same offer still merges into its line.
    expect((await add(KNECHT_ORB1, { token: first.token })).res.status).toBe(200);

    const other = await add(KNECHT_ORB1);
    if (!other.token) throw new Error('no cookie');
    const [otherRow] = await linesOf(other.token);
    if (!otherRow) throw new Error('line missing');
    const { id: _i2, createdAt: _c2, updatedAt: _u2, ...base } = otherRow;
    await db.insert(cartItems).values(
      Array.from({ length: MAX_CART_SEARCHES - 1 }, (_, i) => ({
        ...base,
        offerKey: `SEARCH${i}:X:S`,
        searchArticleNorm: `ART${i}`,
      })),
    );
    expect((await add(BOSCH_MSK7, { token: other.token })).res.status).toBe(200);
    const tooMany = await add(LUCAS_MSK7, { q: 'GDB1330', token: other.token });
    expect(tooMany.res.status).toBe(422);
    expect(tooMany.body.error).toBe('too_many_searches');
  });
});

describe('Origin check (Д19)', () => {
  it('a foreign Origin or no Origin without Sec-Fetch-Site -> 403, nothing written', async () => {
    const before = await cartCount();
    const evil = await handleAddItem(
      form(
        '/api/cart/items',
        { q: 'OC90', offerId: KNECHT_ORB1 },
        { origin: 'https://evil.example' },
      ),
      deps,
    );
    expect(evil.status).toBe(403);
    expect(evil.headers.get('location')).toBeNull();
    const evilJson = await handleAddItem(
      json(
        '/api/cart/items',
        { q: 'OC90', offerId: KNECHT_ORB1 },
        { origin: 'https://evil.example' },
      ),
      deps,
    );
    expect(evilJson.status).toBe(403);
    expect(await evilJson.json()).toMatchObject({ error: 'forbidden_origin' });
    const noOrigin = await handleAddItem(
      json('/api/cart/items', { q: 'OC90', offerId: KNECHT_ORB1 }, { origin: null }),
      deps,
    );
    expect(noOrigin.status).toBe(403);
    expect(await cartCount()).toBe(before);
    expect(calls).toEqual([]);

    const sameSite = await handleAddItem(
      json(
        '/api/cart/items',
        { q: 'OC90', offerId: KNECHT_ORB1 },
        { origin: null, secFetchSite: 'same-origin' },
      ),
      deps,
    );
    expect(sameSite.status).toBe(200);
  });

  it('line changes from a foreign Origin are refused', async () => {
    const { token } = await add(KNECHT_ORB1);
    if (!token) throw new Error('no cookie');
    const [line] = await linesOf(token);
    if (!line) throw new Error('line missing');
    const res = await handleLineRequest(
      json(`/api/cart/items/${line.id}`, undefined, {
        method: 'DELETE',
        token,
        origin: 'https://evil.example',
      }),
      line.id,
      deps,
    );
    expect(res.status).toBe(403);
    expect(await linesOf(token)).toHaveLength(1);
  });
});

describe('/api/cart/items/<id>', () => {
  async function cartWithLine(qty = 1) {
    const { token } = await add(KNECHT_ORB1, { qty });
    if (!token) throw new Error('no cookie');
    const [line] = await linesOf(token);
    if (!line) throw new Error('line missing');
    return { token, lineId: line.id };
  }

  it('form _method=patch changes the quantity, _method=delete removes the line (303 /cart)', async () => {
    const { token, lineId } = await cartWithLine();
    const patched = await handleLineRequest(
      form(`/api/cart/items/${lineId}`, { _method: 'patch', qty: '3' }, { token }),
      lineId,
      deps,
    );
    expect(patched.status).toBe(303);
    expect(patched.headers.get('location')).toBe('/cart');
    expect((await linesOf(token))[0]?.qty).toBe(3);

    const deleted = await handleLineRequest(
      form(`/api/cart/items/${lineId}`, { _method: 'delete' }, { token }),
      lineId,
      deps,
    );
    expect(deleted.status).toBe(303);
    expect(deleted.headers.get('location')).toBe('/cart');
    expect(await linesOf(token)).toEqual([]);
    expect(await countCartLines(db, token)).toBe(0);
  });

  it('real PATCH and DELETE with JSON answer {count, totalKop}', async () => {
    const { token, lineId } = await cartWithLine();
    const patched = await handleLineRequest(
      json(`/api/cart/items/${lineId}`, { qty: 2 }, { token, method: 'PATCH' }),
      lineId,
      deps,
    );
    expect(patched.status).toBe(200);
    expect(await patched.json()).toEqual({ count: 1, totalKop: 105_600 });

    const deleted = await handleLineRequest(
      new Request(`${ORIGIN}/api/cart/items/${lineId}`, {
        method: 'DELETE',
        headers: headersFor(null, { token }),
      }),
      lineId,
      deps,
    );
    expect(deleted.status).toBe(200);
    expect(await deleted.json()).toEqual({ count: 0, totalKop: 0 });
  });

  it('PATCH above the stock -> 422 and the quantity stays', async () => {
    const { token, lineId } = await cartWithLine(2);
    const res = await handleLineRequest(
      json(`/api/cart/items/${lineId}`, { qty: 7 }, { token, method: 'PATCH' }),
      lineId,
      deps,
    );
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ error: 'qty', message: 'В наличии только 6 шт.' });
    const viaForm = await handleLineRequest(
      form(`/api/cart/items/${lineId}`, { _method: 'patch', qty: '0' }, { token }),
      lineId,
      deps,
    );
    expect(viaForm.headers.get('location')).toBe('/cart?error=qty');
    expect((await linesOf(token))[0]?.qty).toBe(2);
  });

  it("another cart's line -> 404 and it is not touched", async () => {
    const victim = await cartWithLine();
    const attacker = await cartWithLine();
    for (const request of [
      json(
        `/api/cart/items/${victim.lineId}`,
        { qty: 3 },
        { token: attacker.token, method: 'PATCH' },
      ),
      json(`/api/cart/items/${victim.lineId}`, undefined, {
        token: attacker.token,
        method: 'DELETE',
      }),
      json(`/api/cart/items/${victim.lineId}`, undefined, { method: 'DELETE' }),
    ]) {
      const res = await handleLineRequest(request, victim.lineId, deps);
      expect(res.status).toBe(404);
      expect(await res.json()).toMatchObject({ error: 'line_not_found' });
    }
    expect((await linesOf(victim.token)).map((r) => r.qty)).toEqual([1]);
    expect((await linesOf(attacker.token)).map((r) => r.qty)).toEqual([1]);

    const badId = await handleLineRequest(
      json('/api/cart/items/not-a-uuid', undefined, { token: victim.token, method: 'DELETE' }),
      'not-a-uuid',
      deps,
    );
    expect(badId.status).toBe(404);
  });

  it('POST without a known _method -> 400', async () => {
    const { token, lineId } = await cartWithLine();
    const res = await handleLineRequest(
      form(`/api/cart/items/${lineId}`, { qty: '2' }, { token }),
      lineId,
      deps,
    );
    expect(res.headers.get('location')).toBe('/cart?error=invalid');
    expect((await linesOf(token))[0]?.qty).toBe(1);
  });
});

describe('opening the cart (viewCart)', () => {
  it('after a +10% supplier price: a price change once, the new price stored', async () => {
    const { token } = await add(KNECHT_ORB1, { qty: 2 });
    if (!token) throw new Error('no cookie');
    await add(LUCAS_MSK7, { q: 'GDB1330', token });

    await clearSupplierCache();
    priceFactor = 1.1;
    calls.length = 0;
    const view = await service.viewCart(token);
    expect(calls.sort()).toEqual(['GDB1330', 'OC90']);
    expect(view?.stale).toBe(false);
    expect(view?.changes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'price',
          offerKey: KNECHT_ORB1,
          title: 'Knecht OC 90',
          oldPriceKop: 52_800,
          newPriceKop: 58_100,
          deltaKop: 5_300,
        }),
      ]),
    );
    const knecht = (await linesOf(token)).find((r) => r.offerKey === KNECHT_ORB1);
    expect(knecht).toMatchObject({ qty: 2, priceClientKop: 58_100, priceSupplierKop: 45_375 });

    // Through the cache now, and nothing left to report.
    calls.length = 0;
    const again = await service.viewCart(token);
    expect(calls).toEqual([]);
    expect(again?.changes).toEqual([]);
    expect(again?.lines.map((l) => l.priceClientKop)).toContain(58_100);
  });

  it('a supplier failure keeps the stored prices and marks the cart stale', async () => {
    await clearSupplierCache();
    const { token } = await add(KNECHT_ORB1);
    if (!token) throw new Error('no cookie');
    await clearSupplierCache();
    failing.add('OC90');
    priceFactor = 1.1;
    const view = await service.viewCart(token);
    expect(view?.stale).toBe(true);
    expect(view?.changes).toEqual([]);
    expect(view?.lines.map((l) => l.priceClientKop)).toEqual([52_800]);
    expect((await linesOf(token))[0]?.priceClientKop).toBe(52_800);
  });

  it('a vanished offer is removed and reported; no or an empty cart -> null', async () => {
    const { token } = await add(KNECHT_ORB1);
    if (!token) throw new Error('no cookie');
    const [line] = await linesOf(token);
    if (!line) throw new Error('line missing');
    await db
      .update(cartItems)
      .set({ offerKey: 'OC90:Knecht:GONE1' })
      .where(eq(cartItems.id, line.id));
    const view = await service.viewCart(token);
    expect(view?.lines).toEqual([]);
    expect(view?.changes).toEqual([expect.objectContaining({ kind: 'unavailable' })]);
    expect(await service.viewCart(token)).toBeNull();
    expect(await service.viewCart(null)).toBeNull();
    expect(await service.viewCart(newCartToken())).toBeNull();
  });
});
