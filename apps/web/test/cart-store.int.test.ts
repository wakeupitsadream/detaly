// Cart persistence against local PG/Redis with the fixtures caller (wrapped to count and
// alter supplier answers). Redis keys live under test:<uuid>:.
import { createRedis, type Redis } from '@detaly/config';
import { deleteKeysByPrefix, testKeyPrefix, testRedisUrl } from '@detaly/config/testing';
import { cartItems, carts, createDb, eq, type Db } from '@detaly/db';
import {
  cartLineFromOffer,
  DEFAULT_EXCLUDED_RULES,
  repriceCartLines,
  type Offer,
  type RepriceContext,
} from '@detaly/domain';
import { createFixtureCaller, RosskoCallError, type RosskoCaller } from '@detaly/rossko';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  CART_COOKIE,
  cartCookieOptions,
  fetchFreshOffers,
  findActiveCart,
  isCartToken,
  MAX_CART_LINES,
  MAX_CART_SEARCHES,
  newCartToken,
  persistRepricing,
  readCartToken,
  removeCartLines,
  SupplierSearchError,
} from '@/server/cart-store';
import { createSupplierDeps, WEB_CRITICAL_MAX_WAIT_MS, type Supplier } from '@/server/supplier';
import { intEnv, webDatabaseUrl } from './helpers';

const prefix = testKeyPrefix();
let redis: Redis;
let db: Db;

/** Fixture caller that counts GetSearch calls and can fail or reprice articles. */
const fixtures = createFixtureCaller();
const calls: string[] = [];
const failing = new Set<string>();
let priceFactor = 1;

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
    // Scale every "price" field of the answer (string or number).
    return JSON.parse(JSON.stringify(raw), (key, value: unknown) =>
      key === 'price' && (typeof value === 'string' || typeof value === 'number')
        ? (Number(value) * priceFactor).toFixed(2)
        : value,
    ) as unknown;
  },
};

let supplier: Supplier;

const ctx = (): RepriceContext => ({
  markupRules: [{ fromKop: 0, toKop: null, localBp: 2800, orderBp: 2800 }],
  excludedRules: DEFAULT_EXCLUDED_RULES,
  eta: { bufferDays: 1, invoiceLagDays: 1, prepayInvoice: false },
  now: new Date(),
});

beforeAll(() => {
  redis = createRedis(testRedisUrl());
  db = createDb(webDatabaseUrl(), { max: 3 });
  supplier = createSupplierDeps({ env: intEnv(), db, redis, keyPrefix: prefix, caller });
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

async function offerOf(query: string, brand: string, stockId: string): Promise<Offer> {
  const { offers } = await supplier.rossko.search(query);
  const offer = offers.find((o) => o.brand === brand && o.stock.stockId === stockId);
  if (!offer) throw new Error(`fixture offer ${brand}/${stockId} missing`);
  return offer;
}

async function insertCart(
  token = newCartToken(),
  status: 'active' | 'converted' = 'active',
): Promise<{ id: string; token: string }> {
  const [cart] = await db.insert(carts).values({ anonToken: token, status }).returning();
  if (!cart) throw new Error('cart not inserted');
  return { id: cart.id, token };
}

async function insertLine(cartId: string, offer: Offer, search: string, qty = 1) {
  const line = cartLineFromOffer(offer, search, qty, ctx());
  const [row] = await db
    .insert(cartItems)
    .values({
      cartId,
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
    })
    .returning();
  if (!row) throw new Error('line not inserted');
  return row;
}

describe('cart token and cookie', () => {
  it('is 43 base64url characters (256 bits)', () => {
    const token = newCartToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(isCartToken(token)).toBe(true);
    expect(newCartToken()).not.toBe(token);
    expect(isCartToken('short')).toBe(false);
    expect(isCartToken(`${token}=`)).toBe(false);
    expect(isCartToken(undefined)).toBe(false);
  });

  it('cookie options: HttpOnly, Lax, Secure only on https, Max-Age from CART_TTL_DAYS', () => {
    expect(CART_COOKIE).toBe('cart');
    expect(cartCookieOptions({ APP_BASE_URL: 'http://127.0.0.1:3100', CART_TTL_DAYS: 30 })).toEqual(
      { httpOnly: true, sameSite: 'lax', path: '/', secure: false, maxAge: 2_592_000 },
    );
    expect(
      cartCookieOptions({ APP_BASE_URL: 'https://detaly.example', CART_TTL_DAYS: 7 }),
    ).toMatchObject({ secure: true, maxAge: 604_800 });
    expect(intEnv().CART_TTL_DAYS).toBe(30);
  });

  it('reads only well-formed tokens from cookies', () => {
    const token = newCartToken();
    const store = (value?: string) => ({
      get: (name: string) => (name === CART_COOKIE && value !== undefined ? { value } : undefined),
    });
    expect(readCartToken(store(token))).toBe(token);
    expect(readCartToken(store('x'))).toBeNull();
    expect(readCartToken(store())).toBeNull();
  });

  it('limits are as decided (Д17)', () => {
    expect(MAX_CART_LINES).toBe(20);
    expect(MAX_CART_SEARCHES).toBe(10);
    expect(WEB_CRITICAL_MAX_WAIT_MS).toBe(5_000);
  });
});

describe('findActiveCart', () => {
  it('returns the active cart of the token with its lines in insertion order', async () => {
    const cart = await insertCart();
    const knecht = await offerOf('OC90', 'Knecht', 'ORB1');
    const mann = await offerOf('OC90', 'MANN-FILTER', 'ORB1');
    const first = await insertLine(cart.id, knecht, 'OC90', 2);
    await insertLine(cart.id, mann, 'OC90');

    const found = await findActiveCart(db, cart.token);
    expect(found?.cart.id).toBe(cart.id);
    expect(found?.lines.map((l) => l.offerKey)).toEqual([
      'OC90:Knecht:ORB1',
      'W71275:MANN-FILTER:ORB1',
    ]);
    expect(found?.lines[0]).toEqual({
      id: first.id,
      offerKey: 'OC90:Knecht:ORB1',
      searchArticleNorm: 'OC90',
      qty: 2,
      priceSupplierKop: 41_250,
      priceClientKop: 52_800,
      markupBp: 2800,
      isLocal: true,
      etaDate: first.etaDate,
      offer: knecht,
    });
  });

  it('does not find another token, a converted cart or a malformed token', async () => {
    await insertCart();
    expect(await findActiveCart(db, newCartToken())).toBeNull();
    const converted = await insertCart(newCartToken(), 'converted');
    expect(await findActiveCart(db, converted.token)).toBeNull();
    expect(await findActiveCart(db, 'not-a-token')).toBeNull();
  });
});

describe('fetchFreshOffers', () => {
  it('goes through the cache for pages and past it with bypassCache', async () => {
    const article = 'GDB1330';
    const first = await fetchFreshOffers(supplier.rossko, [article, article], {
      priority: 'search',
    });
    expect(first.get(article)?.length).toBeGreaterThan(0);
    expect(calls).toEqual([article]);

    await fetchFreshOffers(supplier.rossko, [article], { priority: 'search' });
    expect(calls).toEqual([article]);

    const fresh = await fetchFreshOffers(supplier.rossko, [article], {
      priority: 'critical',
      bypassCache: true,
    });
    expect(calls).toEqual([article, article]);
    expect(fresh.get(article)).toEqual(first.get(article));
  });

  it('maps a not-found article to an empty list, not to a failure', async () => {
    const result = await fetchFreshOffers(supplier.rossko, ['NOSUCH123'], {
      priority: 'critical',
      bypassCache: true,
    });
    expect(result.get('NOSUCH123')).toEqual([]);
  });

  it('turns a failing article into null for pages and throws for checkout', async () => {
    failing.add('W9142');
    const page = await fetchFreshOffers(supplier.rossko, ['W9142', 'OC90'], {
      priority: 'search',
      bypassCache: true,
    });
    expect(page.get('W9142')).toBeNull();
    expect(page.get('OC90')?.length).toBeGreaterThan(0);

    const error = await fetchFreshOffers(supplier.rossko, ['OC90', 'W9142'], {
      priority: 'critical',
      bypassCache: true,
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SupplierSearchError);
    expect((error as SupplierSearchError).articleNorm).toBe('W9142');
  });
});

describe('persistRepricing and removeCartLines', () => {
  it('stores fresh prices (+10% at the supplier), drops vanished lines, keeps stale ones', async () => {
    const cart = await insertCart();
    const knecht = await offerOf('OC90', 'Knecht', 'ORB1');
    const vanished: Offer = { ...knecht, stock: { ...knecht.stock, stockId: 'GONE1' } };
    const brembo = (await supplier.rossko.search('GDB1330')).offers[0];
    if (!brembo) throw new Error('GDB1330 fixture missing');
    const kept = await insertLine(cart.id, knecht, 'OC90', 2);
    const gone = await insertLine(cart.id, vanished, 'OC90');
    const stale = await insertLine(cart.id, brembo, 'GDB1330');
    const active = await findActiveCart(db, cart.token);
    if (!active) throw new Error('cart not found');

    priceFactor = 1.1;
    failing.add('GDB1330');
    const fresh = await fetchFreshOffers(
      supplier.rossko,
      active.lines.map((l) => l.searchArticleNorm),
      { priority: 'search', bypassCache: true },
    );
    expect(fresh.get('GDB1330')).toBeNull();
    const { lines, changes } = repriceCartLines(active.lines, fresh, ctx());
    expect(changes).toEqual([
      expect.objectContaining({
        kind: 'price',
        lineId: kept.id,
        oldPriceKop: 52_800,
        newPriceKop: 58_100,
        deltaKop: 5_300,
      }),
      expect.objectContaining({ kind: 'unavailable', lineId: gone.id }),
    ]);
    const removed = await persistRepricing(db, cart.id, lines);
    expect(removed).toEqual([gone.id]);

    const rows = await db.select().from(cartItems).where(eq(cartItems.cartId, cart.id));
    const byId = new Map(rows.map((r) => [r.id, r]));
    expect(byId.has(gone.id)).toBe(false);
    expect(byId.get(kept.id)).toMatchObject({
      qty: 2,
      priceClientKop: 58_100,
      priceSupplierKop: 45_375,
      markupBp: 2800,
    });
    expect(byId.get(kept.id)?.offerSnapshot.priceSupplierKop).toBe(45_375);
    expect(byId.get(kept.id)?.fetchedAt.getTime()).toBeGreaterThanOrEqual(kept.fetchedAt.getTime());
    expect(byId.get(stale.id)).toMatchObject({
      priceClientKop: stale.priceClientKop,
      fetchedAt: stale.fetchedAt,
    });
  });

  it('removes an excluded line (stop rule on the name) in the same transaction', async () => {
    const cart = await insertCart();
    const knecht = await offerOf('OC90', 'Knecht', 'ORB1');
    const line = await insertLine(cart.id, knecht, 'OC90');
    const active = await findActiveCart(db, cart.token);
    if (!active) throw new Error('cart not found');
    const fresh = await fetchFreshOffers(supplier.rossko, ['OC90'], { priority: 'search' });
    const { lines, changes } = repriceCartLines(active.lines, fresh, {
      ...ctx(),
      excludedRules: [{ kind: 'keyword', pattern: 'фильтр*', reason: 'Тест' }],
    });
    expect(changes).toEqual([
      expect.objectContaining({ kind: 'excluded', lineId: line.id, reason: 'Тест' }),
    ]);
    expect(await persistRepricing(db, cart.id, lines)).toEqual([line.id]);
    expect((await findActiveCart(db, cart.token))?.lines).toEqual([]);
  });

  it('keeps a quantity lowered in another tab after the snapshot was read', async () => {
    const cart = await insertCart();
    const knecht = await offerOf('OC90', 'Knecht', 'ORB1');
    const line = await insertLine(cart.id, knecht, 'OC90', 3);
    const active = await findActiveCart(db, cart.token);
    if (!active) throw new Error('cart not found');
    const fresh = await fetchFreshOffers(supplier.rossko, ['OC90'], { priority: 'search' });
    const { lines } = repriceCartLines(active.lines, fresh, ctx());
    expect(lines[0]?.qty).toBe(3);
    // Another tab lowers the quantity while the supplier call was in flight.
    await db.update(cartItems).set({ qty: 1 }).where(eq(cartItems.id, line.id));
    await persistRepricing(db, cart.id, lines);
    const [row] = await db.select().from(cartItems).where(eq(cartItems.id, line.id));
    expect(row?.qty).toBe(1);
  });

  it('removeCartLines ignores lines of other carts', async () => {
    const a = await insertCart();
    const b = await insertCart();
    const knecht = await offerOf('OC90', 'Knecht', 'ORB1');
    const lineA = await insertLine(a.id, knecht, 'OC90');
    const lineB = await insertLine(b.id, knecht, 'OC90');
    expect(await removeCartLines(db, a.id, [lineA.id, lineB.id])).toBe(1);
    expect(await removeCartLines(db, a.id, [])).toBe(0);
    expect((await findActiveCart(db, b.token))?.lines.map((l) => l.id)).toEqual([lineB.id]);
  });
});
