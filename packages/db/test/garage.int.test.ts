// Step 6 (docs/garage.md): user_vehicles, orders.vehicle_id and the cart's prefill context
// (migration 0009): the checks, one VIN per client, the cars follow their client (deleted with
// the user, deleted when the user is anonymized, orders lose the link and keep everything else).
// VINs are synthetic.
import { testDatabaseUrl } from '@detaly/config/testing';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type Db } from '../src/client';
import { carts, kits, orderItems, orders, userVehicles, users } from '../src/schema';
import { expectPgError, insertOrder, insertUser, randomToken, SAMPLE_OFFER } from './helpers';

const CHECK = '23514';
const UNIQUE = '23505';
const FOREIGN_KEY = '23503';
const VIN_A = 'XTA21099043456789';
const VIN_B = 'Z94CB41BAER123456';

let db: Db;

beforeAll(() => {
  db = createDb(testDatabaseUrl(), { max: 4 });
});

afterAll(async () => {
  await db?.close();
});

type VehicleInsert = typeof userVehicles.$inferInsert;

async function insertVehicle(userId: string, over: Partial<VehicleInsert> = {}) {
  const [row] = await db
    .insert(userVehicles)
    .values({ userId, make: 'Lada', makeSlug: 'lada', model: 'Vesta', source: 'checkout', ...over })
    .returning();
  if (!row) throw new Error('vehicle not inserted');
  return row;
}

describe('user_vehicles', () => {
  it('stores a car with a uuid v7 id, the times and an optional dated mileage', async () => {
    const user = await insertUser(db);
    const car = await insertVehicle(user.id, {
      engine: '1.6',
      year: 2019,
      vin: VIN_A,
      mileageKm: 85_000,
      mileageAt: '2026-10-09',
      source: 'kit',
    });
    expect(car.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(car).toMatchObject({ vin: VIN_A, mileageKm: 85_000, mileageAt: '2026-10-09' });
    expect(car.createdAt).toBeInstanceOf(Date);
    expect(car.updatedAt).toBeInstanceOf(Date);
  });

  it('checks every column', async () => {
    const user = await insertUser(db);
    const cases: [Partial<VehicleInsert>, string][] = [
      [{ source: 'admin' }, 'user_vehicles_source_check'],
      [{ vin: 'XTA2109904345678O' }, 'user_vehicles_vin_check'],
      [{ vin: 'xta21099043456789' }, 'user_vehicles_vin_check'],
      [{ makeSlug: 'Lada' }, 'user_vehicles_make_slug_check'],
      [{ make: '  ' }, 'user_vehicles_make_check'],
      [{ make: 'M'.repeat(41) }, 'user_vehicles_make_check'],
      [{ model: '' }, 'user_vehicles_model_check'],
      [{ model: 'M'.repeat(61) }, 'user_vehicles_model_check'],
      [{ engine: ' ' }, 'user_vehicles_engine_check'],
      [{ year: 1949 }, 'user_vehicles_year_check'],
      [{ year: 2101 }, 'user_vehicles_year_check'],
      [{ mileageKm: -1, mileageAt: '2026-10-09' }, 'user_vehicles_mileage_km_check'],
      [{ mileageKm: 2_000_001, mileageAt: '2026-10-09' }, 'user_vehicles_mileage_km_check'],
      [{ mileageKm: 1000 }, 'user_vehicles_mileage_at_check'],
      [{ mileageAt: '2026-10-09' }, 'user_vehicles_mileage_at_check'],
    ];
    for (const [over, constraint] of cases) {
      await expectPgError(insertVehicle(user.id, over), CHECK, constraint);
    }
    await expectPgError(
      db.insert(userVehicles).values({
        userId: '00000000-0000-7000-8000-000000000000',
        make: 'Lada',
        model: 'Vesta',
        source: 'checkout',
      }),
      FOREIGN_KEY,
    );
  });

  it('one VIN per client; another client may have the same VIN, cars without VIN repeat freely', async () => {
    const a = await insertUser(db);
    const b = await insertUser(db);
    await insertVehicle(a.id, { vin: VIN_B });
    await expectPgError(
      insertVehicle(a.id, { vin: VIN_B, model: 'Granta' }),
      UNIQUE,
      'user_vehicles_user_id_vin_unique',
    );
    await insertVehicle(b.id, { vin: VIN_B });
    await insertVehicle(a.id);
    await insertVehicle(a.id);
    expect(await db.select().from(userVehicles).where(eq(userVehicles.userId, a.id))).toHaveLength(
      3,
    );
  });
});

describe('orders.vehicle_id', () => {
  it('links an order to a car; deleting the car clears the link and keeps the order', async () => {
    const user = await insertUser(db);
    const car = await insertVehicle(user.id);
    const order = await insertOrder(db, { userId: user.id, vehicleId: car.id });
    await db.insert(orderItems).values({
      orderId: order.id,
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
      offerSnapshot: SAMPLE_OFFER,
    });
    expect(order.vehicleId).toBe(car.id);
    await db.delete(userVehicles).where(eq(userVehicles.id, car.id));
    const [after] = await db.select().from(orders).where(eq(orders.id, order.id));
    expect(after?.vehicleId).toBeNull();
    expect(await db.select().from(orderItems).where(eq(orderItems.orderId, order.id))).toHaveLength(
      1,
    );
  });

  it('refuses a car that does not exist', async () => {
    await expectPgError(
      insertOrder(db, { vehicleId: '00000000-0000-7000-8000-000000000001' }),
      FOREIGN_KEY,
    );
  });
});

describe('the cars follow their client', () => {
  it('a deleted client takes the cars (cascade)', async () => {
    const user = await insertUser(db);
    await insertVehicle(user.id, { vin: VIN_A });
    await db.delete(users).where(eq(users.id, user.id));
    expect(
      await db.select().from(userVehicles).where(eq(userVehicles.userId, user.id)),
    ).toHaveLength(0);
  });

  it('anonymization deletes the cars and clears orders.vehicle_id; the orders stay', async () => {
    const user = await insertUser(db);
    const other = await insertUser(db);
    const car = await insertVehicle(user.id, {
      vin: VIN_A,
      mileageKm: 1000,
      mileageAt: '2026-10-01',
    });
    const second = await insertVehicle(user.id, { model: 'Granta' });
    const otherCar = await insertVehicle(other.id, { vin: VIN_A });
    const order = await insertOrder(db, { userId: user.id, vehicleId: car.id });
    const otherOrder = await insertOrder(db, { userId: other.id, vehicleId: otherCar.id });

    // The anonymization documented by the users schema: phone anon:<id>, no name or e-mail.
    await db
      .update(users)
      .set({ phone: `anon:${user.id}`, name: null, email: null, anonymizedAt: new Date() })
      .where(eq(users.id, user.id));

    expect(
      await db.select().from(userVehicles).where(eq(userVehicles.userId, user.id)),
    ).toHaveLength(0);
    const [kept] = await db.select().from(orders).where(eq(orders.id, order.id));
    expect(kept).toMatchObject({ id: order.id, userId: user.id, vehicleId: null });
    // Another client's car and order are untouched.
    expect(
      (await db.select().from(userVehicles).where(eq(userVehicles.id, otherCar.id))).length,
    ).toBe(1);
    const [untouched] = await db.select().from(orders).where(eq(orders.id, otherOrder.id));
    expect(untouched?.vehicleId).toBe(otherCar.id);
    expect(second.userId).toBe(user.id);
  });

  it('either half of the anonymization is enough (anonymized_at alone, the anon: phone alone)', async () => {
    const byDate = await insertUser(db);
    await insertVehicle(byDate.id);
    await db.update(users).set({ anonymizedAt: new Date() }).where(eq(users.id, byDate.id));
    expect(
      await db.select().from(userVehicles).where(eq(userVehicles.userId, byDate.id)),
    ).toHaveLength(0);

    const byPhone = await insertUser(db);
    await insertVehicle(byPhone.id);
    await db
      .update(users)
      .set({ phone: `anon:${byPhone.id}` })
      .where(eq(users.id, byPhone.id));
    expect(
      await db.select().from(userVehicles).where(eq(userVehicles.userId, byPhone.id)),
    ).toHaveLength(0);
  });

  it('an ordinary update of the client (the name of a new checkout) keeps the cars', async () => {
    const user = await insertUser(db);
    await insertVehicle(user.id);
    await db.update(users).set({ name: 'Иван', noShowCount: 1 }).where(eq(users.id, user.id));
    await db.update(users).set({ phone: user.phone }).where(eq(users.id, user.id));
    expect(
      await db.select().from(userVehicles).where(eq(userVehicles.userId, user.id)),
    ).toHaveLength(1);
  });
});

describe('the prefill context of a cart', () => {
  it('kit_id and repeat_order_id point at a kit and an order and are cleared with them', async () => {
    const [kit] = await db
      .insert(kits)
      .values({
        makeSlug: 'lada',
        model: 'Vesta',
        modelSlug: `garage-${randomToken()
          .toLowerCase()
          .replace(/[^a-z0-9]/g, '')}`.slice(0, 60),
        engine: '1.6 16V, 106 л.с.',
        yearsFrom: 2015,
        slug: '1-6-16v',
        createdBy: 'admin',
        updatedBy: 'admin',
      })
      .returning();
    const order = await insertOrder(db);
    const [cart] = await db
      .insert(carts)
      .values({ anonToken: randomToken(), kitId: kit!.id, repeatOrderId: order.id })
      .returning();
    expect(cart).toMatchObject({ kitId: kit!.id, repeatOrderId: order.id });
    await db.delete(kits).where(eq(kits.id, kit!.id));
    const [after] = await db.select().from(carts).where(eq(carts.id, cart!.id));
    expect(after).toMatchObject({ kitId: null, repeatOrderId: order.id });
    await expectPgError(
      db
        .update(carts)
        .set({ repeatOrderId: '00000000-0000-7000-8000-000000000002' })
        .where(eq(carts.id, cart!.id)),
      FOREIGN_KEY,
    );
  });
});
