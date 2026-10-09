/**
 * Step 6 (docs/garage.md): «Моя машина» — the client's cars in the database. The callers check
 * GARAGE_ENABLED; nothing here reads env.
 *
 * - saveUserVehicle: the car of a checkout by the merge rules of @detaly/domain (one row per car;
 *   an update only when something changes), under the client's row lock;
 * - loadUserVehicles / loadOrderVehicle / loadGarage: read models (the order page, the admin, the
 *   client bot's «Мои машины» with the latest orders of every car);
 * - deleteUserVehicle: «Удалить машину» — the row goes, orders keep their items and lose the link
 *   (orders.vehicle_id, on delete set null);
 * - recordHandoverMileage: the staff's reading at the handover (source `handover`), the mileage
 *   only grows unless it is an explicit correction; the same reading again changes nothing.
 *
 * Nothing here logs; callers log ids and counts, never a VIN or a phone.
 */
import {
  and,
  asc,
  desc,
  eq,
  inArray,
  isNotNull,
  orderItems,
  orders,
  sql,
  userVehicles,
  users,
  type Database,
  type Executor,
} from '@detaly/db';
import {
  DROPPED_ORDER_ITEM_STATES,
  findVehicleMatch,
  localDate,
  mergeVehicle,
  type IsoDate,
  type OrderItemState,
  type OrderStatus,
  type StoredVehicle,
  type VehicleData,
  type VehicleSource,
} from '@detaly/domain';
import { isUuid } from './snapshot';

export type VehicleRow = typeof userVehicles.$inferSelect;

/** Cars «Мои машины» shows at most (newest first). */
export const GARAGE_VEHICLES_SHOWN = 10;
/** Orders shown under one car. */
export const GARAGE_ORDERS_PER_VEHICLE = 3;

function storedOf(row: VehicleRow): StoredVehicle {
  return {
    id: row.id,
    makeSlug: row.makeSlug,
    make: row.make,
    model: row.model,
    engine: row.engine,
    year: row.year,
    vin: row.vin,
    mileageKm: row.mileageKm,
    mileageAt: row.mileageAt as IsoDate | null,
    source: row.source as VehicleSource,
    updatedAt: row.updatedAt,
  };
}

/** The client's cars, the latest changed first. */
export async function loadUserVehicles(db: Executor, userId: string): Promise<VehicleRow[]> {
  if (!isUuid(userId)) return [];
  return db
    .select()
    .from(userVehicles)
    .where(eq(userVehicles.userId, userId))
    .orderBy(desc(userVehicles.updatedAt), desc(userVehicles.id));
}

/** The car of an order, or null (none chosen, deleted since, or an unknown order). */
export async function loadOrderVehicle(db: Executor, orderId: string): Promise<VehicleRow | null> {
  if (!isUuid(orderId)) return null;
  const [row] = await db
    .select({ vehicle: userVehicles })
    .from(orders)
    .innerJoin(userVehicles, eq(userVehicles.id, orders.vehicleId))
    .where(eq(orders.id, orderId));
  return row?.vehicle ?? null;
}

export interface SavedVehicle {
  vehicleId: string;
  /** A new row. */
  created: boolean;
  /** The row was written (new, or something changed). */
  changed: boolean;
}

/**
 * Stores `vehicle` for the client by the merge rules (findVehicleMatch, mergeVehicle). Run it in
 * the transaction that writes the order: the client's row is locked first, so two checkouts of
 * one client never add the same car twice. null for an unknown or anonymized client: nothing is
 * stored.
 */
export async function saveUserVehicle(
  tx: Executor,
  input: {
    userId: string;
    vehicle: VehicleData;
    source: VehicleSource;
    now: Date;
    /** A smaller mileage is an explicit correction (mergeMileage). */
    correction?: boolean;
  },
): Promise<SavedVehicle | null> {
  if (!isUuid(input.userId)) return null;
  const [user] = await tx
    .select({ id: users.id, anonymizedAt: users.anonymizedAt, phone: users.phone })
    .from(users)
    .where(eq(users.id, input.userId))
    .for('update');
  if (!user || user.anonymizedAt !== null || user.phone.startsWith('anon:')) return null;
  const rows = await tx
    .select()
    .from(userVehicles)
    .where(eq(userVehicles.userId, input.userId))
    .for('update');
  const match = findVehicleMatch(rows.map(storedOf), input.vehicle);
  const merged = mergeVehicle(match, input.vehicle, {
    source: input.source,
    today: localDate(input.now),
    correction: input.correction,
  });
  if (match === null) {
    const [created] = await tx
      .insert(userVehicles)
      .values({
        userId: input.userId,
        ...merged.write,
        createdAt: input.now,
        updatedAt: input.now,
      })
      .returning({ id: userVehicles.id });
    if (!created) throw new Error('user vehicle insert returned nothing');
    return { vehicleId: created.id, created: true, changed: true };
  }
  if (merged.changed) {
    await tx
      .update(userVehicles)
      .set({ ...merged.write, updatedAt: input.now })
      .where(eq(userVehicles.id, match.id));
  }
  return { vehicleId: match.id, created: false, changed: merged.changed };
}

/**
 * «Удалить машину» of the client bot: the client's own car is deleted (a hard delete: the client
 * asked to forget it); its orders keep everything else and lose the link by the foreign key.
 * false when there is no such car of this client.
 */
export async function deleteUserVehicle(
  db: Executor,
  input: { userId: string; vehicleId: string },
): Promise<boolean> {
  if (!isUuid(input.userId) || !isUuid(input.vehicleId)) return false;
  const deleted = await db
    .delete(userVehicles)
    .where(and(eq(userVehicles.id, input.vehicleId), eq(userVehicles.userId, input.userId)))
    .returning({ id: userVehicles.id });
  return deleted.length > 0;
}

export type HandoverMileageResult =
  | {
      ok: true;
      /** The stored mileage changed (false: the same reading again). */
      changed: boolean;
      mileageKm: number;
      vehicleId: string;
    }
  | { ok: false; reason: 'no_vehicle' }
  /** Smaller than the stored mileage: kept as stored until confirmed as a correction. */
  | { ok: false; reason: 'lower'; storedKm: number; storedAt: IsoDate | null };

/**
 * The staff's reading of the odometer at the handover (seller bot): the order's car gets it by
 * the merge rule, source `handover`. Idempotent; never touches the order.
 */
export async function recordHandoverMileage(
  db: Database,
  input: { orderId: string; mileageKm: number; correction?: boolean; now: Date },
): Promise<HandoverMileageResult> {
  if (!isUuid(input.orderId)) return { ok: false, reason: 'no_vehicle' };
  return db.transaction(async (tx) => {
    const [order] = await tx
      .select({ vehicleId: orders.vehicleId })
      .from(orders)
      .where(eq(orders.id, input.orderId));
    if (!order?.vehicleId) return { ok: false, reason: 'no_vehicle' } as const;
    const [row] = await tx
      .select()
      .from(userVehicles)
      .where(eq(userVehicles.id, order.vehicleId))
      .for('update');
    if (!row) return { ok: false, reason: 'no_vehicle' } as const;
    const stored = storedOf(row);
    const merged = mergeVehicle(
      stored,
      { ...stored, mileageKm: input.mileageKm },
      { source: 'handover', today: localDate(input.now), correction: input.correction },
    );
    if (merged.mileage.lower) {
      return {
        ok: false,
        reason: 'lower',
        storedKm: row.mileageKm ?? 0,
        storedAt: row.mileageAt as IsoDate | null,
      } as const;
    }
    if (merged.changed) {
      await tx
        .update(userVehicles)
        .set({ ...merged.write, updatedAt: input.now })
        .where(eq(userVehicles.id, row.id));
    }
    return {
      ok: true,
      changed: merged.changed,
      mileageKm: merged.write.mileageKm ?? input.mileageKm,
      vehicleId: row.id,
    } as const;
  });
}

export interface GarageOrderView {
  id: string;
  number: string;
  status: OrderStatus;
  createdAt: Date;
  /** The items still in the order (dropped ones left out), in their order. */
  items: { brand: string; article: string }[];
}

export interface GarageVehicleView {
  vehicle: VehicleRow;
  /** The latest orders for this car (drafts left out), newest first. */
  orders: GarageOrderView[];
}

const DROPPED: readonly OrderItemState[] = DROPPED_ORDER_ITEM_STATES;

/** «Мои машины» of the client bot: the client's cars with the latest orders of each. */
export async function loadGarage(
  db: Executor,
  userId: string,
  options: { vehicles?: number; ordersPerVehicle?: number } = {},
): Promise<GarageVehicleView[]> {
  const vehicles = (await loadUserVehicles(db, userId)).slice(
    0,
    options.vehicles ?? GARAGE_VEHICLES_SHOWN,
  );
  if (vehicles.length === 0) return [];
  const perVehicle = options.ordersPerVehicle ?? GARAGE_ORDERS_PER_VEHICLE;
  const ids = vehicles.map((vehicle) => vehicle.id);
  // The latest `perVehicle` orders of every car in one query (row_number over the car).
  const ranked = db
    .select({
      id: orders.id,
      number: orders.number,
      status: orders.status,
      createdAt: orders.createdAt,
      vehicleId: orders.vehicleId,
      rank: sql<number>`row_number() over (partition by ${orders.vehicleId} order by ${orders.createdAt} desc, ${orders.id} desc)`.as(
        'rank',
      ),
    })
    .from(orders)
    .where(
      and(
        inArray(orders.vehicleId, ids),
        isNotNull(orders.vehicleId),
        eq(orders.userId, userId),
        sql`${orders.status} <> 'draft'`,
      ),
    )
    .as('ranked');
  const orderRows = await db
    .select({
      id: ranked.id,
      number: ranked.number,
      status: ranked.status,
      createdAt: ranked.createdAt,
      vehicleId: ranked.vehicleId,
    })
    .from(ranked)
    .where(sql`${ranked.rank} <= ${perVehicle}`)
    .orderBy(desc(ranked.createdAt), desc(ranked.id));
  const orderIds = orderRows.map((row) => row.id);
  const items =
    orderIds.length === 0
      ? []
      : await db
          .select({
            orderId: orderItems.orderId,
            brand: orderItems.brand,
            article: orderItems.article,
            state: orderItems.state,
          })
          .from(orderItems)
          .where(inArray(orderItems.orderId, orderIds))
          .orderBy(asc(orderItems.createdAt), asc(orderItems.id));
  return vehicles.map((vehicle) => ({
    vehicle,
    orders: orderRows
      .filter((row) => row.vehicleId === vehicle.id)
      .map((row) => ({
        id: row.id,
        number: row.number,
        status: row.status,
        createdAt: row.createdAt,
        items: items
          .filter((item) => item.orderId === row.id && !DROPPED.includes(item.state))
          .map((item) => ({ brand: item.brand, article: item.article })),
      })),
  }));
}

/** A car of this client, or null (the bot checks ownership before «Удалить машину»). */
export async function loadUserVehicle(
  db: Executor,
  input: { userId: string; vehicleId: string },
): Promise<VehicleRow | null> {
  if (!isUuid(input.userId) || !isUuid(input.vehicleId)) return null;
  const [row] = await db
    .select()
    .from(userVehicles)
    .where(and(eq(userVehicles.id, input.vehicleId), eq(userVehicles.userId, input.userId)));
  return row ?? null;
}
