// Shared column builders. Column keys are camelCase; createDb and drizzle.config.ts use
// `casing: 'snake_case'`, so `totalKop` is stored as `total_kop`.
import { sql, type SQL } from 'drizzle-orm';
import { check, integer, timestamp, uuid, type AnyPgColumn } from 'drizzle-orm/pg-core';
import { v7 as uuidv7 } from 'uuid';

/** uuid v7 primary key generated in the application (time-ordered, index friendly). */
export const id = () =>
  uuid()
    .primaryKey()
    .$defaultFn(() => uuidv7());

/** timestamptz */
export const tstz = () => timestamp({ withTimezone: true });

export const createdAt = () => tstz().notNull().defaultNow();

/** Set on insert and refreshed by drizzle on every update made through the query builder. */
export const updatedAt = () =>
  tstz()
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date());

/** Money: integer kopecks. Pair every such column with a `kopCheck`. */
export const kop = () => integer();

/** `<table>_<column>_check`: column >= 0 (NULL passes, as with any CHECK). */
export function kopCheck(table: string, column: string, col: AnyPgColumn) {
  return check(`${table}_${column}_check`, sql`${col} >= 0`);
}

/** Named CHECK with the conventional `<table>_<suffix>_check` name. */
export function namedCheck(table: string, suffix: string, expr: SQL) {
  return check(`${table}_${suffix}_check`, expr);
}
