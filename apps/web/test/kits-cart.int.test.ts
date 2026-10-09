// Step 5 (docs/kits.md): POST /api/cart/kits — «Весь набор в корзину» — against PG and Redis with
// the Rossko fixtures: the Origin check, the default choice and the alternatives from the radios,
// lines the supplier lacks skipped and counted, prices only through priceOffer (the form carries
// no price, quantity or offer), a kit changed since the page was shown, the cart refusing more
// lines, and the same in the demo over the signed demo cart. A database of its own
// (`<web db>_kitcart`).
import { createRedis, parseEnv, type Redis } from '@detaly/config';
import { deleteKeysByPrefix, testKeyPrefix, testRedisUrl } from '@detaly/config/testing';
import { cartItems, carts, createDb, eq, kits, settings, type Db } from '@detaly/db';
import { prepareTestDb } from '@detaly/db/testing';
import { priceOffer, type Offer } from '@detaly/domain';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { changeKitStatus, saveKit, type SaveKitInput } from '@/server/admin/kits-handler';
import { CART_COOKIE } from '@/server/cart-store';
import { createCartService, type CartService } from '@/server/cart/cart-service';
import { CartRequestError } from '@/server/cart/errors';
import { DEMO_CART_COOKIE, decodeDemoCart } from '@/server/demo/cart-cookie';
import { handleDemoCartRequest } from '@/server/demo/cart-http';
import { createDemoCartService, type DemoCartJar } from '@/server/demo/cart-service';
import { createDemoSupplier } from '@/server/demo/supplier';
import { handleKitAdd, type KitAddDeps } from '@/server/kits/add-handler';
import { loadKit, type KitRecord } from '@/server/kits/catalog';
import { demoKitById } from '@/server/kits/demo-kits';
import { priceKit } from '@/server/kits/kit-view';
import { createSupplierDeps, type Supplier } from '@/server/supplier';
import { intEnv, webDatabaseUrl } from './helpers';

const APP = 'http://127.0.0.1:3100';
const env = intEnv({ APP_BASE_URL: APP });
const NOW = new Date('2026-10-08T05:00:00Z');

let db: Db;
let redis: Redis;
let supplier: Supplier;
let service: CartService;
const prefixes: string[] = [];

beforeAll(async () => {
  const base = new URL(webDatabaseUrl());
  base.pathname = `${base.pathname}_kitcart`;
  const { url } = await prepareTestDb({ url: base.toString() });
  db = createDb(url, { max: 4 });
  redis = createRedis(testRedisUrl());
});

beforeEach(async () => {
  const prefix = testKeyPrefix();
  prefixes.push(prefix);
  supplier = createSupplierDeps({ env, db, redis, keyPrefix: prefix });
  service = createCartService({ db, supplier, loadSettings: () => supplier.settings.get() });
  await db.delete(kits);
  await db.delete(carts);
  await db.update(settings).set({ value: [] }).where(eq(settings.key, 'pricing.group_adjustments'));
});

afterEach(async () => {
  for (const prefix of prefixes.splice(0)) await deleteKeysByPrefix(redis, prefix);
});

afterAll(async () => {
  await redis?.quit();
  await db?.close();
});

const OIL = [
  { alternative: false, brand: 'MANN', article: 'W914/2', qty: 1, role: 'Фильтр масляный' },
  { alternative: true, brand: 'KNECHT', article: 'OC90', qty: 1, role: null },
];
const AIR = [
  { alternative: false, brand: 'MANN', article: 'C26003', qty: 1, role: 'Фильтр воздушный' },
];
const PLUGS = [
  { alternative: false, brand: 'NGK', article: 'BKR6E', qty: 4, role: 'Свечи зажигания' },
  { alternative: true, brand: 'BOSCH', article: 'FR7DCX+', qty: 4, role: null },
];
const MISSING = [
  { alternative: false, brand: 'ACME', article: 'NOPE123', qty: 1, role: 'Фильтр топливный' },
];

/**
 * A published kit. Published by the writer directly, so a line the supplier lacks can be in it
 * (as when the supplier stops offering a part after the master published the kit).
 */
async function publishedKit(lines: SaveKitInput['lines'], publish = true): Promise<KitRecord> {
  const saved = await saveKit(db, {
    id: null,
    version: '',
    header: {
      makeSlug: 'lada',
      model: 'Vesta',
      modelSlug: 'vesta',
      engine: '1.6 16V, 106 л.с.',
      yearsFrom: 2015,
      yearsTo: null,
      note: null,
    },
    lines,
    actor: 'admin',
    now: NOW,
  });
  if (!saved.ok) throw new Error(saved.reason);
  if (publish) {
    await changeKitStatus(db, {
      id: saved.id,
      version: NOW.toISOString(),
      change: 'publish',
      actor: 'admin',
      now: NOW,
    });
  }
  return (await loadKit(db, saved.id))!;
}

function deps(overrides: Partial<KitAddDeps> = {}): KitAddDeps {
  return {
    env,
    service,
    loadKit: (id) => loadKit(db, id, { published: true }),
    price: async (kit) =>
      priceKit(kit, { rossko: supplier.rossko, settings: await supplier.settings.get(), now: NOW }),
    ...overrides,
  };
}

function post(fields: Record<string, string>, headers: Record<string, string> = {}): Request {
  const all: Record<string, string> = {
    'content-type': 'application/x-www-form-urlencoded',
    origin: APP,
    ...headers,
  };
  for (const [key, value] of Object.entries(all)) if (value === '') delete all[key];
  return new Request(`${APP}/api/cart/kits`, {
    method: 'POST',
    headers: all,
    body: new URLSearchParams(fields).toString(),
  });
}

function cartToken(response: Response): string | null {
  const cookie = response.headers.getSetCookie().find((c) => c.startsWith(`${CART_COOKIE}=`));
  return cookie ? (cookie.split(';')[0]?.split('=')[1] ?? null) : null;
}

async function cartLines(token: string) {
  const [cart] = await db.select().from(carts).where(eq(carts.anonToken, token));
  if (!cart) return [];
  const rows = await db.select().from(cartItems).where(eq(cartItems.cartId, cart.id));
  return rows.sort((a, b) => a.offerKey.localeCompare(b.offerKey));
}

function where(response: Response): URL {
  return new URL(response.headers.get('location') ?? '', APP);
}

/** Line ids of the kit by position. */
function lineIds(kit: KitRecord): string[] {
  return kit.lines.map((line) => line.id);
}

describe('POST /api/cart/kits', () => {
  it('refuses a foreign origin and a body that is not a form, adding nothing', async () => {
    const kit = await publishedKit([...OIL, ...AIR]);
    const foreign = await handleKitAdd(
      post({ kit: kit.id, version: kit.version }, { origin: 'https://evil.example' }),
      deps(),
    );
    expect(foreign.status).toBe(403);
    const json = await handleKitAdd(
      new Request(`${APP}/api/cart/kits`, {
        method: 'POST',
        headers: { origin: APP, 'content-type': 'application/json' },
        body: JSON.stringify({ kit: kit.id }),
      }),
      deps(),
    );
    expect(json.status).toBe(400);
    expect(await db.select().from(carts)).toEqual([]);
  });

  it('adds the main lines by default: one new cart, every line priced by priceOffer', async () => {
    const kit = await publishedKit([...OIL, ...AIR, ...PLUGS]);
    const response = await handleKitAdd(post({ kit: kit.id, version: kit.version }), deps());
    expect(response.status).toBe(303);
    expect(where(response).pathname).toBe('/cart');
    expect(Object.fromEntries(where(response).searchParams)).toEqual({
      kit: '3',
      kit_skipped: '0',
    });
    const token = cartToken(response);
    expect(token).toBeTruthy();
    const lines = await cartLines(token!);
    expect(lines.map((line) => [line.offerKey, line.qty, line.priceClientKop])).toEqual([
      ['BKR6E:NGK:ORB1', 4, 31_400],
      ['C26003:MANN-FILTER:ORB1', 1, 88_400],
      ['W9142:MANN-FILTER:MSK7', 1, 79_800],
    ]);
    const pricing = (await supplier.settings.get()).pricing;
    for (const line of lines) {
      expect(line.priceClientKop, line.offerKey).toBe(
        priceOffer(pricing, line.offerSnapshot as Offer).priceClientKop,
      );
    }
  });

  it('takes the alternatives the radios chose', async () => {
    const kit = await publishedKit([...OIL, ...AIR, ...PLUGS]);
    const [oilMain, oilAlt, , plugsMain, plugsAlt] = lineIds(kit);
    const response = await handleKitAdd(
      post({
        kit: kit.id,
        version: kit.version,
        [`pick_${oilMain}`]: oilAlt!,
        [`pick_${plugsMain}`]: plugsAlt!,
      }),
      deps(),
    );
    expect(where(response).searchParams.get('kit')).toBe('3');
    const lines = await cartLines(cartToken(response)!);
    expect(lines.map((line) => [line.offerKey, line.qty])).toEqual([
      ['C26003:MANN-FILTER:ORB1', 1],
      ['FR7DCX:BOSCH:MSK7', 4],
      ['OC90:Knecht:ORB1', 1],
    ]);
  });

  it('prices only through priceOffer with the current adjustments; the form cannot set a price, a quantity or an offer', async () => {
    await db
      .update(settings)
      .set({ value: [{ group: 'filters', localDeltaBp: 300, orderDeltaBp: 200 }] })
      .where(eq(settings.key, 'pricing.group_adjustments'));
    supplier.settings.invalidate();
    const kit = await publishedKit([...OIL, ...AIR]);
    const response = await handleKitAdd(
      post({
        kit: kit.id,
        version: kit.version,
        price: '1',
        priceClientKop: '100',
        qty: '99',
        offerId: 'OC90:Knecht:ORB1',
        q: 'OC90',
      }),
      deps(),
    );
    const lines = await cartLines(cartToken(response)!);
    const pricing = (await supplier.settings.get()).pricing;
    // 623.40 ₽ to order × 1.30 -> 811 ₽; 690.00 ₽ in Orenburg × 1.31 -> 904 ₽
    expect(
      lines.map((line) => [line.offerKey, line.qty, line.priceClientKop, line.markupBp]),
    ).toEqual([
      ['C26003:MANN-FILTER:ORB1', 1, 90_400, 3100],
      ['W9142:MANN-FILTER:MSK7', 1, 81_100, 3000],
    ]);
    for (const line of lines) {
      expect(line.priceClientKop).toBe(
        priceOffer(pricing, line.offerSnapshot as Offer).priceClientKop,
      );
    }
  });

  it('skips a line the supplier lacks now and says how many', async () => {
    const kit = await publishedKit([...OIL, ...MISSING, ...AIR]);
    const response = await handleKitAdd(post({ kit: kit.id, version: kit.version }), deps());
    expect(Object.fromEntries(where(response).searchParams)).toEqual({
      kit: '2',
      kit_skipped: '1',
    });
    const lines = await cartLines(cartToken(response)!);
    expect(lines.map((line) => line.offerKey)).toEqual([
      'C26003:MANN-FILTER:ORB1',
      'W9142:MANN-FILTER:MSK7',
    ]);
  });

  it('a main line the supplier lacks gives way to its alternative', async () => {
    const kit = await publishedKit([
      { ...MISSING[0]!, role: 'Фильтр масляный' },
      { alternative: true, brand: 'KNECHT', article: 'OC90', qty: 1, role: null },
    ]);
    const response = await handleKitAdd(post({ kit: kit.id, version: kit.version }), deps());
    expect(where(response).searchParams.get('kit')).toBe('1');
    const lines = await cartLines(cartToken(response)!);
    expect(lines.map((line) => line.offerKey)).toEqual(['OC90:Knecht:ORB1']);
  });

  it('nothing on offer: back to the kit with a note, no cart', async () => {
    const kit = await publishedKit(MISSING);
    const response = await handleKitAdd(post({ kit: kit.id, version: kit.version }), deps());
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe('/to/lada/vesta?kit=empty&for=1-6-16v#1-6-16v');
    expect(await db.select().from(carts)).toEqual([]);
  });

  it('a kit changed since the page was shown goes back for another look', async () => {
    const kit = await publishedKit([...OIL, ...AIR]);
    const [oilMain, , airMain] = lineIds(kit);
    const changed = '/to/lada/vesta?kit=changed&for=1-6-16v#1-6-16v';
    const stale = await handleKitAdd(
      post({ kit: kit.id, version: '2026-01-01T00:00:00.000Z' }),
      deps(),
    );
    expect(stale.headers.get('location')).toBe(changed);
    const foreignPick = await handleKitAdd(
      post({ kit: kit.id, version: kit.version, [`pick_${oilMain}`]: airMain! }),
      deps(),
    );
    expect(foreignPick.headers.get('location')).toBe(changed);
    const unknownGroup = await handleKitAdd(
      post({ kit: kit.id, version: kit.version, pick_nope: oilMain! }),
      deps(),
    );
    expect(unknownGroup.headers.get('location')).toBe(changed);
    expect(await db.select().from(carts)).toEqual([]);
  });

  it('a draft or an unknown kit is not found', async () => {
    const draft = await publishedKit([...OIL], false);
    for (const id of [draft.id, '01900000-0000-7000-8000-000000000000', 'x'.repeat(65)]) {
      const response = await handleKitAdd(post({ kit: id, version: draft.version }), deps());
      expect(response.status, id).toBe(404);
    }
  });

  it('adds to the visitor’s own cart and merges the same part', async () => {
    const kit = await publishedKit([...OIL, ...AIR]);
    const first = await handleKitAdd(post({ kit: kit.id, version: kit.version }), deps());
    const token = cartToken(first)!;
    const again = await handleKitAdd(
      post({ kit: kit.id, version: kit.version }, { cookie: `${CART_COOKIE}=${token}` }),
      deps(),
    );
    expect(cartToken(again)).toBe(token);
    const lines = await cartLines(token);
    expect(lines.map((line) => [line.offerKey, line.qty])).toEqual([
      ['C26003:MANN-FILTER:ORB1', 2],
      ['W9142:MANN-FILTER:MSK7', 2],
    ]);
    expect(await db.select().from(carts)).toHaveLength(1);
  });

  it('when the cart stops taking lines: what was added stays, the cart says why', async () => {
    const kit = await publishedKit([...OIL, ...AIR, ...PLUGS]);
    let calls = 0;
    const full: CartService = {
      ...service,
      addItem: async (input) => {
        calls += 1;
        if (calls === 2) throw new CartRequestError('cart_full');
        return service.addItem(input);
      },
    };
    const response = await handleKitAdd(
      post({ kit: kit.id, version: kit.version }),
      deps({ service: full }),
    );
    expect(Object.fromEntries(where(response).searchParams)).toEqual({
      kit: '1',
      kit_skipped: '0',
      error: 'cart_full',
    });
    expect(calls).toBe(2);
    expect(await cartLines(cartToken(response)!)).toHaveLength(1);
    // nothing could be added at all: the cart's own message
    const none = await handleKitAdd(
      post({ kit: kit.id, version: kit.version }),
      deps({
        service: {
          ...service,
          addItem: () => Promise.reject(new CartRequestError('too_many_searches')),
        },
      }),
    );
    expect(none.headers.get('location')).toBe('/cart?error=too_many_searches');
  });

  it('a line whose offer changed a moment ago is skipped, the rest goes in', async () => {
    const kit = await publishedKit([...OIL, ...AIR]);
    let calls = 0;
    const flaky: CartService = {
      ...service,
      addItem: async (input) => {
        calls += 1;
        if (calls === 1) throw new CartRequestError('offer_not_found');
        return service.addItem(input);
      },
    };
    const response = await handleKitAdd(
      post({ kit: kit.id, version: kit.version }),
      deps({ service: flaky }),
    );
    expect(Object.fromEntries(where(response).searchParams)).toEqual({
      kit: '1',
      kit_skipped: '1',
    });
    const only = await handleKitAdd(
      post({ kit: kit.id, version: kit.version }),
      deps({ service: { ...service, addItem: () => Promise.reject(new CartRequestError('qty')) } }),
    );
    expect(only.headers.get('location')).toBe('/to/lada/vesta?kit_error=qty&for=1-6-16v#1-6-16v');
  });
});

describe('POST /api/cart/kits in the demo', () => {
  const SECRET = 'test-session-secret-0123456789abcdef';
  const ORIGIN = 'http://localhost:3000';
  const demoEnv = parseEnv({ SESSION_SECRET: SECRET, DEMO_MODE: 'true' });

  it('puts the sample into the signed demo cart; the cart reads it back priced', async () => {
    const demoSupplier = createDemoSupplier({ env: demoEnv });
    const demoService = (jar: DemoCartJar) =>
      createDemoCartService({
        jar,
        supplier: demoSupplier,
        loadSettings: () => demoSupplier.settings.get(),
      });
    const kit = demoKitById('demo-lada-vesta')!;
    const [oilMain, oilAlt] = lineIds(kit);
    const request = new Request(`${ORIGIN}/api/cart/kits`, {
      method: 'POST',
      headers: { origin: ORIGIN, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        kit: kit.id,
        version: 'demo',
        [`pick_${oilMain}`]: oilAlt!,
      }).toString(),
    });
    const response = await handleDemoCartRequest(
      request,
      { env: demoEnv, service: demoService },
      (handlerDeps) =>
        handleKitAdd(request, {
          env: handlerDeps.env,
          service: handlerDeps.service,
          loadKit: (id) => Promise.resolve(demoKitById(id)),
          price: async (k) =>
            priceKit(k, {
              rossko: demoSupplier.rossko,
              settings: await demoSupplier.settings.get(),
              now: NOW,
            }),
        }),
    );
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe('/cart?kit=4&kit_skipped=0');
    const cookies = response.headers.getSetCookie();
    // the live cart token never leaves the demo
    expect(cookies.some((c) => c.startsWith(`${CART_COOKIE}=`))).toBe(false);
    const value = cookies
      .find((c) => c.startsWith(`${DEMO_CART_COOKIE}=`))
      ?.split(';')[0]
      ?.split('=')[1];
    const lines = decodeDemoCart(value, SECRET);
    expect(lines.map((line) => [line.offerId, line.qty]).sort()).toEqual([
      ['BKR6E:NGK:ORB1', 4],
      ['C26003:MANN-FILTER:ORB1', 1],
      ['CU1919:MANN-FILTER:MSK7', 1],
      ['OC90:Knecht:ORB1', 1],
    ]);
    const view = await demoService({
      read: () => Promise.resolve(lines),
      write: () => undefined,
    }).viewCart(null);
    expect(view?.lines).toHaveLength(4);
  });
});
