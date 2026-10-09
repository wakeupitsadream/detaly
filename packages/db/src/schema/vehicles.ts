// Step 6 (docs/garage.md): «Моя машина» — the client's cars, behind GARAGE_ENABLED.
import { VEHICLE_SOURCES } from '@detaly/domain/statuses';
import { sql } from 'drizzle-orm';
import { char, date, index, integer, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { createdAt, id, namedCheck, sqlList, updatedAt } from './columns';
import { users } from './people';

/**
 * One car of a client (users = the phone, no accounts). The make is the storefront's
 * (`make_slug`, a CAR_BRANDS slug) when the client named one of them, `make` is what the pages
 * show. One row per car: the same VIN (unique per client) or the same make, model and year
 * update the row instead of adding one (mergeVehicle of @detaly/domain). `mileage_km` only grows;
 * `mileage_at` is the day of its reading. `source` is where the latest data came from
 * (VEHICLE_SOURCES).
 *
 * The row goes with its client: deleted with the user (cascade) and when the user is anonymized
 * (the trigger of migration 0009); orders keep their items and lose the link (orders.vehicle_id,
 * on delete set null). «Удалить машину» in the client bot deletes the row the same way.
 */
export const userVehicles = pgTable(
  'user_vehicles',
  {
    id: id(),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    makeSlug: text(),
    /** As shown: «Lada». */
    make: text().notNull(),
    model: text().notNull(),
    /** «1.6», «1.6 16V». */
    engine: text(),
    year: integer(),
    vin: char({ length: 17 }),
    mileageKm: integer(),
    mileageAt: date({ mode: 'string' }),
    /** VEHICLE_SOURCES. */
    source: text().notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('user_vehicles_user_id_idx').on(t.userId),
    uniqueIndex('user_vehicles_user_id_vin_unique')
      .on(t.userId, t.vin)
      .where(sql`${t.vin} is not null`),
    namedCheck('user_vehicles', 'source', sql`${t.source} in (${sqlList(VEHICLE_SOURCES)})`),
    namedCheck('user_vehicles', 'vin', sql`${t.vin} ~ '^[A-HJ-NPR-Z0-9]{17}$'`),
    // URL slugs of the storefront makes (CAR_BRANDS: 'lada', 'land-rover').
    namedCheck(
      'user_vehicles',
      'make_slug',
      sql`${t.makeSlug} is null or (${t.makeSlug} ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and length(${t.makeSlug}) <= 64)`,
    ),
    namedCheck('user_vehicles', 'make', sql`length(btrim(${t.make})) between 1 and 40`),
    namedCheck('user_vehicles', 'model', sql`length(btrim(${t.model})) between 1 and 60`),
    namedCheck(
      'user_vehicles',
      'engine',
      sql`${t.engine} is null or length(btrim(${t.engine})) between 1 and 40`,
    ),
    namedCheck('user_vehicles', 'year', sql`${t.year} is null or ${t.year} between 1950 and 2100`),
    namedCheck(
      'user_vehicles',
      'mileage_km',
      sql`${t.mileageKm} is null or ${t.mileageKm} between 0 and 2000000`,
    ),
    // A reading has its day; no day without a reading.
    namedCheck(
      'user_vehicles',
      'mileage_at',
      sql`(${t.mileageKm} is null) = (${t.mileageAt} is null)`,
    ),
  ],
);
