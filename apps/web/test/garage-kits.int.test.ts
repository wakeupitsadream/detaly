// Step 6 (docs/garage.md): a cart filled by «Весь набор в корзину» remembers its kit (carts.kit_id)
// for the «Моя машина» prefill — only through the handler's rememberKit (wired with
// GARAGE_ENABLED, test/garage-flag.test.ts), only after a line went in, never failing the kit;
// proposal carts are never touched. A database of its own (`<web db>_garagekit`).
import { createRedis, type Redis } from '@detaly/config';
import { deleteKeysByPrefix, testKeyPrefix, testRedisUrl } from '@detaly/config/testing';
import { carts, createDb, eq, kits, settings, type Db } from '@detaly/db';
import { prepareTestDb } from '@detaly/db/testing';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { changeKitStatus, saveKit, type SaveKitInput } from '@/server/admin/kits-handler';
import { CART_COOKIE, newCartToken } from '@/server/cart-store';
import { createCartService, type CartService } from '@/server/cart/cart-service';
import { rememberCartKit } from '@/server/kits';
import { handleKitAdd, type KitAddDeps } from '@/server/kits/add-handler';
import { loadKit, type KitRecord } from '@/server/kits/catalog';
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
  base.pathname = `${base.pathname}_garagekit`;
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

async function publishedKit(lines: SaveKitInput['lines']): Promise<KitRecord> {
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
  await changeKitStatus(db, {
    id: saved.id,
    version: NOW.toISOString(),
    change: 'publish',
    actor: 'admin',
    now: NOW,
  });
  return (await loadKit(db, saved.id))!;
}

const AIR = [
  { alternative: false, brand: 'MANN', article: 'C26003', qty: 1, role: 'Фильтр воздушный' },
];
const MISSING = [
  { alternative: false, brand: 'ACME', article: 'NOPE123', qty: 1, role: 'Фильтр топливный' },
];

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

function post(fields: Record<string, string>): Request {
  return new Request(`${APP}/api/cart/kits`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', origin: APP },
    body: new URLSearchParams(fields).toString(),
  });
}

function cookieToken(response: Response): string | null {
  const cookie = response.headers.getSetCookie().find((c) => c.startsWith(`${CART_COOKIE}=`));
  return cookie ? (cookie.split(';')[0]?.slice(CART_COOKIE.length + 1) ?? null) : null;
}

describe('the kit of a cart (step 6)', () => {
  it('rememberKit is called once with the cart and the kit after a line went in', async () => {
    const kit = await publishedKit(AIR);
    const calls: [string, string][] = [];
    const response = await handleKitAdd(
      post({ kit: kit.id, version: kit.version }),
      deps({
        rememberKit: async (token, kitId) => {
          calls.push([token, kitId]);
          await rememberCartKit(db, token, kitId);
        },
      }),
    );
    expect(response.status).toBe(303);
    const token = cookieToken(response);
    expect(calls).toEqual([[token, kit.id]]);
    const [cart] = await db.select().from(carts).where(eq(carts.anonToken, token!));
    expect(cart?.kitId).toBe(kit.id);
  });

  it('not when nothing went in, and the kit never fails because of it', async () => {
    const missing = await publishedKit(MISSING);
    const calls: string[] = [];
    const none = await handleKitAdd(
      post({ kit: missing.id, version: missing.version }),
      deps({ rememberKit: async (_token, kitId) => void calls.push(kitId) }),
    );
    expect(none.status).toBe(303);
    expect(calls).toEqual([]);

    await db.delete(kits);
    const kit = await publishedKit(AIR);
    const failing = await handleKitAdd(
      post({ kit: kit.id, version: kit.version }),
      deps({
        rememberKit: async () => {
          throw new Error('database gone');
        },
      }),
    );
    expect(failing.status).toBe(303);
    expect(failing.headers.get('location')).toMatch(/^\/cart\?kit=1/);
  });

  it('without rememberKit (GARAGE_ENABLED off) the cart has no kit', async () => {
    const kit = await publishedKit(AIR);
    const response = await handleKitAdd(post({ kit: kit.id, version: kit.version }), deps());
    const [cart] = await db
      .select()
      .from(carts)
      .where(eq(carts.anonToken, cookieToken(response)!));
    expect(cart?.kitId).toBeNull();
  });

  it('rememberCartKit touches only the client cart of the token, never a proposal', async () => {
    const kit = await publishedKit(AIR);
    const token = newCartToken();
    await db.insert(carts).values({ anonToken: token });
    const proposalToken = newCartToken();
    const [proposal] = await db
      .insert(carts)
      .values({
        anonToken: proposalToken,
        proposalToken: 'p'.repeat(32),
        proposalExpiresAt: new Date(Date.now() + 86_400_000),
      })
      .returning();
    await rememberCartKit(db, token, kit.id);
    await rememberCartKit(db, proposalToken, kit.id);
    await rememberCartKit(db, token, 'not-a-uuid');
    const [client] = await db.select().from(carts).where(eq(carts.anonToken, token));
    const [after] = await db.select().from(carts).where(eq(carts.id, proposal!.id));
    expect(client?.kitId).toBe(kit.id);
    expect(after?.kitId).toBeNull();
  });
});
