// Public API of @detaly/db. Step 0 stubs; implemented in work package P1.
// Drizzle (postgres-js driver, casing: 'snake_case'), migrations in ./drizzle, idempotent seeds.
import type { Env } from '@detaly/config';

function notImplemented(name: string): never {
  throw new Error(`not implemented: @detaly/db ${name}`);
}

/** All tables and pgEnums (built from @detaly/domain/statuses). */
export const schema = {} as const;

/** Drizzle database handle plus the underlying postgres-js client for shutdown. */
export interface Db {
  /** Closes the connection pool (worker shutdown, tests). */
  close(): Promise<void>;
}

export function createDb(_url: string): Db {
  return notImplemented('createDb');
}

/** Applies SQL migrations from packages/db/drizzle. */
export async function migrateDb(_db: Db): Promise<void> {
  notImplemented('migrateDb');
}

/** Idempotent seeds: settings, staff, excluded_groups, legal documents (ON CONFLICT DO NOTHING). */
export async function seed(_db: Db, _env: Env): Promise<void> {
  notImplemented('seed');
}
