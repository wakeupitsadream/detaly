// Step 6 (docs/garage.md): «Моя машина» on the checkout against PG and Redis with the Rossko
// fixtures, on a database of its own (`<web db>_garage`):
//
// - GARAGE_ENABLED off: the page has no block, the body's `vehicle` is never read (not even an
//   invalid one), no car is stored and the order has none;
// - on: a typed car is stored by the merge rules and becomes orders.vehicle_id in the order
//   transaction (a refused order stores no car), a blank block stores nothing, an invalid one is a
//   422 on its fields, a second order with the same car updates it;
// - the prefill comes only from the cart's own context (a kit, the VIN request of a proposal,
//   «Купить снова»), never from a phone, and the stored source says which;
// - the order page and the admin card show the car only with the switch on.
// VINs are synthetic.
import { createRedis, type Redis } from '@detaly/config';
import { deleteKeysByPrefix, testKeyPrefix, testRedisUrl } from '@detaly/config/testing';
import {
  cartItems,
  carts,
  createDb,
  eq,
  kits,
  orders,
  userVehicles,
  users,
  vinRequests,
  type Db,
} from '@detaly/db';
import { prepareTestDb } from '@detaly/db/testing';
import { cartLineFromOffer, localDate, type Offer } from '@detaly/domain';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { loadAdminOrder } from '@/server/admin/queries';
import { newCartToken } from '@/server/cart-store';
import { getCheckoutGate } from '@/server/checkout-gate';
import {
  createCheckoutService,
  type CheckoutLogger,
  type CheckoutSettings,
} from '@/server/checkout/checkout-service';
import { handleCheckoutRequest } from '@/server/checkout/handler';
import { loadCheckoutPage, type CheckoutPageReady } from '@/server/checkout/page-data';
import { uuidV7 } from '@/server/checkout/uuid';
import { loadVehiclePrefill } from '@/server/garage/prefill';
import { loadOrderView } from '@/server/orders/order-view';
import { createSupplierDeps, type Supplier } from '@/server/supplier';
import type { VehicleFormValues } from '@/lib/vehicle-form';
import { intEnv, webDatabaseUrl } from './helpers';

const BASE_URL = 'http://127.0.0.1:3100';
const VIN_A = 'XTA21099043456789';
const VIN_B = 'Z94CB41BAER123456';

let db: Db;
let redis: Redis;
let supplier: Supplier;
const prefixes: string[] = [];
let logs: { level: string; details: Record<string, unknown>; message: string }[] = [];

const logger: CheckoutLogger = {
  info: (details, message) => logs.push({ level: 'info', details, message }),
  warn: (details, message) => logs.push({ level: 'warn', details, message }),
  error: (details, message) => logs.push({ level: 'error', details, message }),
};

function envOf(garage: boolean) {
  return intEnv({
    APP_BASE_URL: BASE_URL,
    RKN_NOTICE_NUMBER: 'TEST-1',
    GARAGE_ENABLED: garage ? 'true' : 'false',
  });
}

const loadSettings = (): Promise<CheckoutSettings> => supplier.settings.get();

function service(garage: boolean) {
  const env = envOf(garage);
  return createCheckoutService({
    db,
    supplier: { rossko: supplier.rossko },
    loadSettings,
    gate: () => getCheckoutGate({ env, db }),
    logger,
    env,
    nudge: () => undefined,
  });
}

async function page(token: string, garage: boolean): Promise<CheckoutPageReady> {
  const env = envOf(garage);
  const data = await loadCheckoutPage(
    {
      db,
      supplier: { rossko: supplier.rossko },
      loadSettings,
      gate: () => getCheckoutGate({ env, db }),
      garage,
    },
    { cartToken: token, part: 'all' },
  );
  if (data.kind !== 'ready') throw new Error(`checkout page is ${data.kind}`);
  return data;
}

beforeAll(async () => {
  const base = new URL(webDatabaseUrl());
  base.pathname = `${base.pathname}_garage`;
  const { url } = await prepareTestDb({ url: base.toString() });
  db = createDb(url, { max: 6 });
  redis = createRedis(testRedisUrl());
});

beforeEach(() => {
  const prefix = testKeyPrefix();
  prefixes.push(prefix);
  supplier = createSupplierDeps({ env: intEnv(), db, redis, keyPrefix: prefix });
  logs = [];
});

afterEach(async () => {
  for (const prefix of prefixes.splice(0)) await deleteKeysByPrefix(redis, prefix);
});

afterAll(async () => {
  await redis?.quit();
  await db?.close();
});

function randomPhone(): { typed: string; e164: string } {
  const digits = String(Math.floor(Math.random() * 1e9)).padStart(9, '0');
  return { typed: `8 9${digits}`, e164: `+79${digits}` };
}

async function offerOf(query: string, brand: string, stockId: string): Promise<Offer> {
  const { offers } = await supplier.rossko.search(query);
  const offer = offers.find((o) => o.brand === brand && o.stock.stockId === stockId);
  if (!offer) throw new Error(`fixture offer ${brand}/${stockId} missing`);
  return offer;
}

/** An active cart with the local Knecht OC 90, priced as the cart prices it. */
async function makeCart(
  context: Partial<typeof carts.$inferInsert> = {},
): Promise<{ id: string; token: string }> {
  const token = newCartToken();
  const [cart] = await db
    .insert(carts)
    .values({ anonToken: token, ...context })
    .returning();
  const s = await loadSettings();
  const offer = await offerOf('OC90', 'Knecht', 'ORB1');
  const line = cartLineFromOffer(offer, 'OC90', 1, {
    pricing: s.pricing,
    excludedRules: [],
    eta: s.eta,
    now: new Date(),
  });
  await db.insert(cartItems).values({
    cartId: cart!.id,
    offerKey: line.offerKey,
    searchArticleNorm: line.searchArticleNorm,
    brand: offer.brand,
    article: offer.article,
    name: offer.name,
    qty: 1,
    stockId: offer.stock.stockId,
    isLocal: line.isLocal,
    etaDate: line.etaDate,
    priceSupplierKop: line.priceSupplierKop,
    priceClientKop: line.priceClientKop,
    markupBp: line.markupBp,
    offerSnapshot: offer,
    fetchedAt: new Date(),
  });
  return { id: cart!.id, token };
}

async function submit(input: {
  token: string;
  page: CheckoutPageReady;
  phone: string;
  garage: boolean;
  vehicle?: Readonly<Record<string, unknown>> | VehicleFormValues;
  channel?: string;
}) {
  const body = {
    part: input.page.part,
    phone: input.phone,
    name: 'Тест Покупатель',
    channel: input.channel ?? 'sms',
    acceptOffer: true,
    consentPd: true,
    consentMarketing: false,
    expectedTotalKop: input.page.totals.subtotalKop,
    itemsHash: input.page.itemsHash,
    checkoutKey: input.page.checkoutKey,
    ...input.page.documents,
    expectedScheme: input.page.decision.scheme,
    expectedPromisedDate: input.page.promisedDate,
    website: '',
    ...(input.vehicle ? { vehicle: input.vehicle } : {}),
  };
  const response = await handleCheckoutRequest(
    new Request(`${BASE_URL}/api/checkout`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: BASE_URL,
        cookie: `cart=${input.token}`,
        'x-real-ip': '10.1.2.3',
      },
      body: JSON.stringify(body),
    }),
    service(input.garage),
  );
  return { status: response.status, json: (await response.json()) as Record<string, unknown> };
}

async function orderOf(url: unknown) {
  const token = String(url).replace(/^\/o\//, '');
  const [order] = await db.select().from(orders).where(eq(orders.accessToken, token));
  if (!order) throw new Error('order not found');
  return order;
}

async function carsOf(phone: string) {
  const [user] = await db.select().from(users).where(eq(users.phone, phone));
  if (!user) return [];
  return db.select().from(userVehicles).where(eq(userVehicles.userId, user.id));
}

const TYPED = {
  make: 'лада',
  model: 'Vesta',
  engine: '1.6',
  year: '2019',
  vin: 'xta 21099 0434 56789',
  mileage: '85 000',
};

describe('GARAGE_ENABLED off: nothing is collected, stored or shown', () => {
  it('no block on the page; the body’s vehicle is never read, not even an invalid one', async () => {
    const cart = await makeCart();
    const p = await page(cart.token, false);
    expect(p.vehicle).toBeNull();
    const phone = randomPhone();
    const res = await submit({
      token: cart.token,
      page: p,
      phone: phone.typed,
      garage: false,
      vehicle: TYPED,
    });
    expect(res.status).toBe(201);
    expect((await orderOf(res.json.orderUrl)).vehicleId).toBeNull();
    expect(await carsOf(phone.e164)).toEqual([]);

    const second = await makeCart();
    const bad = await submit({
      token: second.token,
      page: await page(second.token, false),
      phone: randomPhone().typed,
      garage: false,
      vehicle: { vin: 'XTA2109904345678O', year: 'вчера' },
    });
    expect(bad.status).toBe(201);
    expect(JSON.stringify(logs)).not.toContain('vehicle');
  });

  it('the order page and the admin card say nothing about a car of an older order', async () => {
    const cart = await makeCart();
    const phone = randomPhone();
    const res = await submit({
      token: cart.token,
      page: await page(cart.token, true),
      phone: phone.typed,
      garage: true,
      vehicle: TYPED,
    });
    const order = await orderOf(res.json.orderUrl);
    expect(order.vehicleId).not.toBeNull();

    const off = await loadOrderView(db, order.accessToken, { env: envOf(false) });
    expect(off?.vehicle).toBeNull();
    const admin = await loadAdminOrder(db, order.id);
    expect(admin?.garage).toBeNull();

    const on = await loadOrderView(db, order.accessToken, { env: envOf(true), garage: true });
    expect(on?.vehicle).toEqual({ label: 'Lada Vesta 1.6, 2019' });
    const adminOn = await loadAdminOrder(db, order.id, { garage: true });
    expect(adminOn?.garage?.vehicle?.vin).toBe(VIN_A);
    expect(adminOn?.garage?.clientVehicles.map((v) => v.id)).toEqual([order.vehicleId]);
  });
});

describe('GARAGE_ENABLED on: the car is saved with the order', () => {
  it('a typed car: normalised, stored for the client and linked in the order transaction', async () => {
    const cart = await makeCart();
    const p = await page(cart.token, true);
    expect(p.vehicle).toEqual({ prefill: null });
    const phone = randomPhone();
    const res = await submit({
      token: cart.token,
      page: p,
      phone: phone.typed,
      garage: true,
      vehicle: TYPED,
    });
    expect(res.status).toBe(201);
    const order = await orderOf(res.json.orderUrl);
    const [car] = await carsOf(phone.e164);
    expect(order.vehicleId).toBe(car?.id);
    expect(car).toMatchObject({
      userId: order.userId,
      makeSlug: 'lada',
      make: 'Lada',
      model: 'Vesta',
      engine: '1.6',
      year: 2019,
      vin: VIN_A,
      mileageKm: 85_000,
      mileageAt: localDate(new Date()),
      source: 'checkout',
    });
    // The log says a car was saved, never which.
    const created = logs.find((log) => log.message === 'order created');
    expect(created?.details).toMatchObject({ vehicle: true });
    expect(JSON.stringify(logs)).not.toContain(VIN_A);
  });

  it('a blank block stores nothing', async () => {
    const cart = await makeCart();
    const phone = randomPhone();
    const res = await submit({
      token: cart.token,
      page: await page(cart.token, true),
      phone: phone.typed,
      garage: true,
      vehicle: { make: ' ', model: '', engine: '', year: '', vin: '', mileage: '' },
    });
    expect(res.status).toBe(201);
    expect((await orderOf(res.json.orderUrl)).vehicleId).toBeNull();
    expect(await carsOf(phone.e164)).toEqual([]);
  });

  it('an invalid car is a 422 on its fields and nothing is created', async () => {
    const cart = await makeCart();
    const phone = randomPhone();
    const res = await submit({
      token: cart.token,
      page: await page(cart.token, true),
      phone: phone.typed,
      garage: true,
      vehicle: { vin: 'XTA2109904345678O', year: '1800', mileage: 'много' },
    });
    expect(res.status).toBe(422);
    expect(res.json).toMatchObject({
      error: 'validation',
      fields: {
        vehicleMake: expect.any(String),
        vehicleModel: expect.any(String),
        vehicleYear: expect.stringContaining('Год выпуска'),
        vehicleVin: expect.stringContaining('O, I и Q'),
        vehicleMileage: expect.stringContaining('Пробег'),
      },
    });
    expect(await db.select().from(users).where(eq(users.phone, phone.e164))).toEqual([]);
  });

  it('the same car on the next order updates the one row (merge), the mileage grows', async () => {
    const phone = randomPhone();
    const first = await makeCart();
    const a = await submit({
      token: first.token,
      page: await page(first.token, true),
      phone: phone.typed,
      garage: true,
      vehicle: { make: 'Lada', model: 'Vesta', vin: VIN_A, mileage: '80000' },
    });
    const second = await makeCart();
    const b = await submit({
      token: second.token,
      page: await page(second.token, true),
      phone: phone.typed,
      garage: true,
      vehicle: { make: 'Лада', model: 'Веста', vin: VIN_A, year: '2019', mileage: '70000' },
    });
    expect([a.status, b.status]).toEqual([201, 201]);
    const cars = await carsOf(phone.e164);
    expect(cars).toHaveLength(1);
    // The year is filled in; a smaller mileage at checkout is not a correction: kept.
    expect(cars[0]).toMatchObject({ vin: VIN_A, year: 2019, mileageKm: 80_000 });
    expect((await orderOf(a.json.orderUrl)).vehicleId).toBe(cars[0]?.id);
    expect((await orderOf(b.json.orderUrl)).vehicleId).toBe(cars[0]?.id);

    // Another VIN is another car of the same client.
    const third = await makeCart();
    await submit({
      token: third.token,
      page: await page(third.token, true),
      phone: phone.typed,
      garage: true,
      vehicle: { make: 'Lada', model: 'Vesta', vin: VIN_B },
    });
    expect(await carsOf(phone.e164)).toHaveLength(2);
  });

  it('a failure after the car is written rolls the car back with the order', async () => {
    // This file's own database: a trigger refuses the order insert of channel «max» only.
    await db.$client.unsafe(`
      create or replace function garage_test_refuse_order() returns trigger language plpgsql as $$
      begin raise exception 'garage test: order refused'; end $$;
      drop trigger if exists garage_test_refuse_order on orders;
      create trigger garage_test_refuse_order before insert on orders
        for each row when (new.preferred_channel = 'max') execute function garage_test_refuse_order();
    `);
    try {
      const cart = await makeCart();
      const phone = randomPhone();
      const p = await page(cart.token, true);
      const body = { token: cart.token, page: p, phone: phone.typed, garage: true, vehicle: TYPED };
      const failed = await submit({ ...body, channel: 'max' });
      expect(failed.status).toBe(500);
      expect(await carsOf(phone.e164)).toEqual([]);
      // The same submit otherwise goes through, with its car.
      const ok = await submit(body);
      expect(ok.status).toBe(201);
      expect(await carsOf(phone.e164)).toHaveLength(1);
    } finally {
      await db.$client.unsafe(`
        drop trigger if exists garage_test_refuse_order on orders;
        drop function if exists garage_test_refuse_order();
      `);
    }
  });

  it('a refused order (the payment scheme changed) stores no car either', async () => {
    const phone = randomPhone();
    // Two no-shows: the server decides prepay where the page showed payment on handover.
    await db.insert(users).values({ phone: phone.e164, noShowCount: 5 });
    const cart = await makeCart();
    const p = await page(cart.token, true);
    expect(p.decision.scheme).toBe('pay_on_handover');
    const res = await submit({
      token: cart.token,
      page: p,
      phone: phone.typed,
      garage: true,
      vehicle: TYPED,
    });
    expect(res.status).toBe(409);
    expect(res.json).toMatchObject({ error: 'scheme_changed' });
    expect(await carsOf(phone.e164)).toEqual([]);
  });
});

describe('the prefill: only the cart’s own context, never a phone', () => {
  it('a plain cart has none, even when the buyer has cars', async () => {
    const phone = randomPhone();
    const owner = await makeCart();
    await submit({
      token: owner.token,
      page: await page(owner.token, true),
      phone: phone.typed,
      garage: true,
      vehicle: TYPED,
    });
    // The same buyer, a new cart: nothing is looked up by the phone.
    const cart = await makeCart();
    const p = await page(cart.token, true);
    expect(p.vehicle).toEqual({ prefill: null });
    const res = await submit({ token: cart.token, page: p, phone: phone.typed, garage: true });
    expect((await orderOf(res.json.orderUrl)).vehicleId).toBeNull();
    expect(await carsOf(phone.e164)).toHaveLength(1);
  });

  it('a kit: its make, model and engine; kept, the car’s source is `kit`', async () => {
    const [kit] = await db
      .insert(kits)
      .values({
        makeSlug: 'lada',
        model: 'Vesta',
        modelSlug: `vesta-${uuidV7().slice(-12)}`,
        engine: '1.6 16V, 106 л.с.',
        yearsFrom: 2015,
        slug: '1-6-16v',
        status: 'published',
        publishedAt: new Date(),
        createdBy: 'admin',
        updatedBy: 'admin',
      })
      .returning();
    const cart = await makeCart({ kitId: kit!.id });
    const p = await page(cart.token, true);
    expect(p.vehicle?.prefill).toEqual({
      source: 'kit',
      values: { make: 'Lada', model: 'Vesta', engine: '1.6 16V', year: '', vin: '', mileage: '' },
      vinHint: null,
    });
    const phone = randomPhone();
    await submit({
      token: cart.token,
      page: p,
      phone: phone.typed,
      garage: true,
      vehicle: { ...p.vehicle!.prefill!.values, year: '2018' },
    });
    expect(await carsOf(phone.e164)).toMatchObject([
      { make: 'Lada', model: 'Vesta', engine: '1.6 16V', year: 2018, source: 'kit' },
    ]);

    // Another model typed over the prefill: the client's own car, source `checkout`.
    const other = await makeCart({ kitId: kit!.id });
    const otherPhone = randomPhone();
    await submit({
      token: other.token,
      page: await page(other.token, true),
      phone: otherPhone.typed,
      garage: true,
      vehicle: { make: 'Lada', model: 'Granta' },
    });
    expect(await carsOf(otherPhone.e164)).toMatchObject([{ model: 'Granta', source: 'checkout' }]);
  });

  it('the VIN request of a proposal: the VIN and «Марка и модель»; unreadable text: no prefill', async () => {
    const [request] = await db
      .insert(vinRequests)
      .values({
        phone: randomPhone().e164,
        vin: VIN_B,
        carText: 'Лада Веста 1.6 2019г',
        needText: 'Колодки передние',
      })
      .returning();
    const cart = await makeCart({ vinRequestId: request!.id });
    const p = await page(cart.token, true);
    expect(p.vehicle?.prefill).toEqual({
      source: 'proposal',
      values: {
        make: 'Lada',
        model: 'Веста',
        engine: '1.6',
        year: '2019',
        vin: VIN_B,
        mileage: '',
      },
      vinHint: null,
    });
    const phone = randomPhone();
    await submit({
      token: cart.token,
      page: p,
      phone: phone.typed,
      garage: true,
      vehicle: p.vehicle!.prefill!.values,
    });
    expect(await carsOf(phone.e164)).toMatchObject([
      { vin: VIN_B, model: 'Веста', year: 2019, source: 'proposal' },
    ]);

    const [vague] = await db
      .insert(vinRequests)
      .values({
        phone: randomPhone().e164,
        vin: VIN_A,
        carText: 'моя старая машина',
        needText: 'Фильтр',
      })
      .returning();
    const vagueCart = await makeCart({ vinRequestId: vague!.id });
    expect((await page(vagueCart.token, true)).vehicle).toEqual({ prefill: null });
  });

  it('«Купить снова»: the car of the repeated order without its VIN (the hint only)', async () => {
    const phone = randomPhone();
    const first = await makeCart();
    const placed = await submit({
      token: first.token,
      page: await page(first.token, true),
      phone: phone.typed,
      garage: true,
      vehicle: TYPED,
    });
    const order = await orderOf(placed.json.orderUrl);
    const cart = await makeCart({ repeatOrderId: order.id });
    const p = await page(cart.token, true);
    expect(p.vehicle?.prefill).toEqual({
      source: 'bot',
      values: { make: 'Lada', model: 'Vesta', engine: '1.6', year: '2019', vin: '', mileage: '' },
      vinHint: '…6789',
    });
    const res = await submit({
      token: cart.token,
      page: p,
      phone: phone.typed,
      garage: true,
      vehicle: { ...p.vehicle!.prefill!.values, mileage: '90000' },
    });
    const repeat = await orderOf(res.json.orderUrl);
    const cars = await carsOf(phone.e164);
    // The same car (make, model, year): its VIN stays, the mileage grows, source `bot`.
    expect(cars).toHaveLength(1);
    expect(cars[0]).toMatchObject({ vin: VIN_A, mileageKm: 90_000, source: 'bot' });
    expect(repeat.vehicleId).toBe(cars[0]?.id);
  });

  it('the prefill of a cart that is not there, or of a malformed id, is none', async () => {
    expect(await loadVehiclePrefill(db, uuidV7(), '2026-10-09')).toBeNull();
    expect(await loadVehiclePrefill(db, 'nope', '2026-10-09')).toBeNull();
  });
});
