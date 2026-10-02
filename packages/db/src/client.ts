import { fileURLToPath } from 'node:url';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres, { type Options, type PostgresType, type Sql } from 'postgres';
import * as schema from './schema';

export { schema };
export type Schema = typeof schema;

/** Drizzle database (also the type of a transaction callback's `tx` for most purposes). */
export type Database = PostgresJsDatabase<Schema>;

/** Drizzle handle plus the underlying postgres-js client; close() ends the pool. */
export type Db = Database & {
  $client: Sql;
  /** Closes the connection pool (worker shutdown, CLI scripts, tests). */
  close(): Promise<void>;
};

/** Transaction handle passed to `db.transaction(async (tx) => ...)`. */
export type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];

export interface CreateDbOptions {
  /** Pool size (postgres-js `max`), default 10. */
  max?: number;
  /** Extra postgres-js options. */
  postgres?: Options<Record<string, PostgresType>>;
}

/** Creates a pooled connection. Column keys are camelCase, columns snake_case. */
export function createDb(url: string, options: CreateDbOptions = {}): Db {
  const client = postgres(url, {
    max: options.max ?? 10,
    onnotice: () => {},
    ...options.postgres,
  });
  const db = drizzle({ client, schema, casing: 'snake_case' });
  return Object.assign(db, {
    close: () => client.end({ timeout: 5 }),
  });
}

/** packages/db/drizzle, resolved relative to this file (works from src and in the worker image). */
export const MIGRATIONS_FOLDER = fileURLToPath(new URL('../drizzle', import.meta.url));

/** Arbitrary constant key for pg_advisory_lock around migrations. */
const MIGRATION_LOCK_KEY = 410_020_126;

/**
 * Applies pending SQL migrations from packages/db/drizzle (journal in schema `drizzle`).
 * Safe to run repeatedly. drizzle's migrator takes no lock, so concurrent runs (two deploys,
 * parallel test setups) are serialized here with a session advisory lock held on a reserved
 * connection; this needs a pool of at least two connections.
 */
export async function migrateDb(
  db: Db,
  options: { migrationsFolder?: string } = {},
): Promise<void> {
  const migrationsFolder = options.migrationsFolder ?? MIGRATIONS_FOLDER;
  if (db.$client.options.max < 2) {
    await migrate(db, { migrationsFolder });
    return;
  }
  const lock = await db.$client.reserve();
  try {
    await lock`select pg_advisory_lock(${MIGRATION_LOCK_KEY})`;
    try {
      await migrate(db, { migrationsFolder });
    } finally {
      await lock`select pg_advisory_unlock(${MIGRATION_LOCK_KEY})`;
    }
  } finally {
    lock.release();
  }
}
