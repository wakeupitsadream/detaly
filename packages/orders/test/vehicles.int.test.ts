// Step 6 (docs/garage.md): the client's cars in the database — saved by the merge rules under the
// client's lock, read for the order page and the client bot, deleted by the client, the mileage of
// the handover. On the project database (`_orders`); VINs are synthetic.
import { eq, orderItems, orders, userVehicles, users, type Db } from '@detaly/db';
import type { VehicleData } from '@detaly/domain';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  deleteUserVehicle,
  loadGarage,
  loadOrderVehicle,
  loadUserVehicle,
  loadUserVehicles,
  recordHandoverMileage,
  saveUserVehicle,
} from '../src';
import { DB_URL, openDb, seedOrder, T0 } from './helpers';

const VIN_A = 'XTA21099043456789';
const VIN_B = 'Z94CB41BAER123456';
const DAY_MS = 24 * 60 * 60 * 1000;

function car(over: Partial<VehicleData> = {}): VehicleData {
  return {
    makeSlug: 'lada',
    make: 'Lada',
    model: 'Vesta',
    engine: null,
    year: null,
    vin: null,
    mileageKm: null,
    ...over,
  };
}

describe.skipIf(!DB_URL)('the client cars (step 6)', () => {
  let db: Db;

  beforeAll(() => {
    db = openDb();
  });

  afterAll(async () => {
    await db?.close();
  });

  /** saveUserVehicle in its own transaction, as the checkout runs it in the order's. */
  function save(
    userId: string,
    vehicle: VehicleData,
    over: { source?: 'checkout' | 'kit' | 'proposal' | 'bot'; now?: Date } = {},
  ) {
    return db.transaction((tx) =>
      saveUserVehicle(tx, {
        userId,
        vehicle,
        source: over.source ?? 'checkout',
        now: over.now ?? T0,
      }),
    );
  }

  it('a new car, then the same VIN updates it instead of adding a second one', async () => {
    const { userId } = await seedOrder(db);
    const first = await save(userId, car({ vin: VIN_A, mileageKm: 10_000 }), { source: 'kit' });
    expect(first).toMatchObject({ created: true, changed: true });
    const [row] = await loadUserVehicles(db, userId);
    expect(row).toMatchObject({
      vin: VIN_A,
      mileageKm: 10_000,
      mileageAt: '2026-10-05',
      source: 'kit',
    });

    const later = new Date(T0.getTime() + 30 * DAY_MS);
    const second = await save(
      userId,
      car({ model: 'Granta', vin: VIN_A, year: 2019, mileageKm: 15_000, engine: '1.6' }),
      { now: later },
    );
    expect(second).toEqual({ vehicleId: first!.vehicleId, created: false, changed: true });
    const rows = await loadUserVehicles(db, userId);
    expect(rows).toHaveLength(1);
    // The VIN decides; the make and the model stay as stored, the rest is filled in.
    expect(rows[0]).toMatchObject({
      model: 'Vesta',
      year: 2019,
      engine: '1.6',
      mileageKm: 15_000,
      mileageAt: '2026-11-04',
      source: 'checkout',
    });
  });

  it('the same make, model and year is one car; another VIN or year is another car', async () => {
    const { userId } = await seedOrder(db);
    const a = await save(userId, car({ year: 2019 }));
    const again = await save(userId, car({ model: 'ВЕСТА', year: 2019 }));
    expect(again).toEqual({ vehicleId: a!.vehicleId, created: false, changed: false });
    const otherYear = await save(userId, car({ year: 2015 }));
    expect(otherYear?.created).toBe(true);
    // The first car takes the VIN (one year-exact match), then a different VIN is a new car.
    expect((await save(userId, car({ year: 2019, vin: VIN_A })))?.vehicleId).toBe(a!.vehicleId);
    expect((await save(userId, car({ year: 2019, vin: VIN_B })))?.created).toBe(true);
    expect(await loadUserVehicles(db, userId)).toHaveLength(3);
  });

  it('the same data twice writes nothing the second time (updated_at stays)', async () => {
    const { userId } = await seedOrder(db);
    await save(userId, car({ year: 2019, mileageKm: 5000 }));
    const [before] = await loadUserVehicles(db, userId);
    const repeat = await save(userId, car({ year: 2019, mileageKm: 5000 }), {
      now: new Date(T0.getTime() + DAY_MS),
    });
    expect(repeat?.changed).toBe(false);
    const [after] = await loadUserVehicles(db, userId);
    expect(after?.updatedAt.getTime()).toBe(before?.updatedAt.getTime());
  });

  it('nothing is stored for an anonymized client', async () => {
    const { userId } = await seedOrder(db);
    await db
      .update(users)
      .set({ phone: `anon:${userId}`, anonymizedAt: T0 })
      .where(eq(users.id, userId));
    expect(await save(userId, car())).toBeNull();
    expect(await loadUserVehicles(db, userId)).toEqual([]);
  });

  it('two checkouts of one client at once add one car (the client row is locked)', async () => {
    const { userId } = await seedOrder(db);
    const results = await Promise.all([
      save(userId, car({ vin: VIN_A })),
      save(userId, car({ vin: VIN_A })),
    ]);
    expect(results.map((r) => r?.vehicleId)).toEqual([
      results[0]?.vehicleId,
      results[0]?.vehicleId,
    ]);
    expect(await loadUserVehicles(db, userId)).toHaveLength(1);
  });

  it('the car of an order; «Удалить машину» only for its owner, orders lose the link', async () => {
    const owner = await seedOrder(db, { status: 'handed' });
    const stranger = await seedOrder(db);
    const saved = await save(owner.userId, car({ vin: VIN_A }));
    await db
      .update(orders)
      .set({ vehicleId: saved!.vehicleId })
      .where(eq(orders.id, owner.orderId));
    expect((await loadOrderVehicle(db, owner.orderId))?.vin).toBe(VIN_A);
    expect(await loadOrderVehicle(db, stranger.orderId)).toBeNull();
    expect(await loadOrderVehicle(db, 'nope')).toBeNull();

    expect(
      await loadUserVehicle(db, { userId: stranger.userId, vehicleId: saved!.vehicleId }),
    ).toBeNull();
    expect(
      await deleteUserVehicle(db, { userId: stranger.userId, vehicleId: saved!.vehicleId }),
    ).toBe(false);
    expect(await deleteUserVehicle(db, { userId: owner.userId, vehicleId: saved!.vehicleId })).toBe(
      true,
    );
    expect(await deleteUserVehicle(db, { userId: owner.userId, vehicleId: saved!.vehicleId })).toBe(
      false,
    );
    const [order] = await db.select().from(orders).where(eq(orders.id, owner.orderId));
    expect(order?.vehicleId).toBeNull();
    expect(
      await db.select().from(orderItems).where(eq(orderItems.orderId, owner.orderId)),
    ).toHaveLength(2);
  });

  it('the mileage of the handover: only grows, idempotent, a smaller one only as a correction', async () => {
    const { orderId, userId } = await seedOrder(db, { status: 'handed' });
    expect(await recordHandoverMileage(db, { orderId, mileageKm: 1000, now: T0 })).toEqual({
      ok: false,
      reason: 'no_vehicle',
    });
    const saved = await save(userId, car({ mileageKm: 50_000 }), { source: 'kit' });
    await db.update(orders).set({ vehicleId: saved!.vehicleId }).where(eq(orders.id, orderId));

    const later = new Date(T0.getTime() + 2 * DAY_MS);
    expect(await recordHandoverMileage(db, { orderId, mileageKm: 85_000, now: later })).toEqual({
      ok: true,
      changed: true,
      mileageKm: 85_000,
      vehicleId: saved!.vehicleId,
    });
    let [row] = await loadUserVehicles(db, userId);
    expect(row).toMatchObject({ mileageKm: 85_000, mileageAt: '2026-10-07', source: 'handover' });

    // The same reading again: nothing changes.
    expect(
      await recordHandoverMileage(db, {
        orderId,
        mileageKm: 85_000,
        now: new Date(later.getTime() + DAY_MS),
      }),
    ).toMatchObject({ ok: true, changed: false });
    [row] = await loadUserVehicles(db, userId);
    expect(row?.mileageAt).toBe('2026-10-07');

    expect(await recordHandoverMileage(db, { orderId, mileageKm: 80_000, now: later })).toEqual({
      ok: false,
      reason: 'lower',
      storedKm: 85_000,
      storedAt: '2026-10-07',
    });
    expect(
      await recordHandoverMileage(db, { orderId, mileageKm: 80_000, correction: true, now: later }),
    ).toMatchObject({ ok: true, changed: true, mileageKm: 80_000 });
    [row] = await loadUserVehicles(db, userId);
    expect(row?.mileageKm).toBe(80_000);
  });

  it('«Мои машины»: the cars, newest first, with their latest orders and live items', async () => {
    const { userId, orderId: first } = await seedOrder(db, { status: 'completed' });
    const vesta = await save(userId, car({ year: 2019 }));
    const rio = await save(userId, car({ makeSlug: 'kia', make: 'Kia', model: 'Rio' }), {
      now: new Date(T0.getTime() + DAY_MS),
    });
    await db
      .update(orders)
      .set({ vehicleId: vesta!.vehicleId, createdAt: T0 })
      .where(eq(orders.id, first));
    // Four more orders for the Vesta: only the latest three are shown.
    const more: string[] = [];
    for (let i = 0; i < 4; i += 1) {
      const [order] = await db
        .insert(orders)
        .values({
          userId,
          accessToken: `garage-test-${userId}-${i}`.padEnd(43, 'x'),
          status: i === 3 ? 'draft' : 'handed',
          paymentScheme: 'prepay',
          subtotalKop: 1000,
          totalKop: 1000,
          itemsHash: 'test',
          vehicleId: vesta!.vehicleId,
          createdAt: new Date(T0.getTime() + (i + 1) * 60_000),
        })
        .returning({ id: orders.id });
      more.push(order!.id);
    }
    const garage = await loadGarage(db, userId);
    expect(garage.map((entry) => entry.vehicle.id)).toEqual([rio!.vehicleId, vesta!.vehicleId]);
    expect(garage[0]?.orders).toEqual([]);
    // Drafts are left out; newest first; three at most.
    expect(garage[1]?.orders.map((order) => order.id)).toEqual([more[2], more[1], more[0]]);
    const withItems = await loadGarage(db, userId, { ordersPerVehicle: 10 });
    const firstOrder = withItems[1]?.orders.find((order) => order.id === first);
    expect(firstOrder?.items).toEqual([
      { brand: 'MANN', article: 'W 914/2' },
      { brand: 'BOSCH', article: 'F 026' },
    ]);
    expect(await loadGarage(db, '00000000-0000-7000-8000-000000000000')).toEqual([]);
    // Another client's orders never show under these cars.
    expect(
      (await db.select().from(userVehicles).where(eq(userVehicles.userId, userId))).length,
    ).toBe(2);
  });
});
