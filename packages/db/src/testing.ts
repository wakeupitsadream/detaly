// Test database helpers shared by db, web and worker tests (import from '@detaly/db/testing').
import { parseEnv, type Env } from '@detaly/config';
import { minimalEnvSource, testDatabaseUrl } from '@detaly/config/testing';
import postgres from 'postgres';
import { createDb, migrateDb } from './client';
import { seed, type SeedReport } from './seed';

/** Advisory lock key serializing concurrent prepareTestDb() calls on the same database. */
const PREPARE_LOCK_KEY = 410_020_127;

export interface PrepareTestDbOptions {
  /** Database URL; default DATABASE_URL_TEST (testDatabaseUrl()). */
  url?: string;
  /** Env passed to the seed; default parseEnv(minimalEnvSource()) (deterministic). */
  env?: Env;
  /** Run the seed after migrations (default true). */
  seed?: boolean;
  /** Legal content directory for the seed (default: repository content/legal). */
  legalDir?: string;
}

export interface PreparedTestDb {
  url: string;
  seedReport: SeedReport | null;
}

/** Env used by test seeds unless a test passes its own. */
export function testEnv(overrides: Record<string, string | undefined> = {}): Env {
  return parseEnv(minimalEnvSource(overrides));
}

/** Creates the database named in `url` when it does not exist (via the `postgres` database). */
export async function ensureDatabase(url: string): Promise<void> {
  const target = new URL(url);
  const name = decodeURIComponent(target.pathname.replace(/^\//, ''));
  if (!name) throw new Error('database URL has no database name');
  const admin = new URL(url);
  admin.pathname = '/postgres';
  const sql = postgres(admin.toString(), { max: 1, onnotice: () => {} });
  try {
    const rows = await sql`select 1 from pg_database where datname = ${name}`;
    if (rows.length === 0) {
      try {
        await sql`create database ${sql(name)}`;
      } catch (error) {
        // A concurrent caller created it first.
        const code = (error as { code?: string }).code;
        if (code !== '42P04' && code !== '23505') throw error;
      }
    }
  } finally {
    await sql.end({ timeout: 5 });
  }
}

/** Drops the database (tests that create throwaway databases). */
export async function dropDatabase(url: string): Promise<void> {
  const name = decodeURIComponent(new URL(url).pathname.replace(/^\//, ''));
  const admin = new URL(url);
  admin.pathname = '/postgres';
  const sql = postgres(admin.toString(), { max: 1, onnotice: () => {} });
  try {
    await sql`drop database if exists ${sql(name)} with (force)`;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

/**
 * Creates DATABASE_URL_TEST's database when missing, recreates schemas `public` and
 * `drizzle`, applies migrations and runs the seed. Intended for vitest globalSetup.
 *
 * Destructive: give every concurrently running test project its own database URL
 * (`scripts/dev-db.sh ensure-db <name>`); concurrent calls on one URL are serialized but
 * still reset each other's data.
 */
export async function prepareTestDb(options: PrepareTestDbOptions = {}): Promise<PreparedTestDb> {
  const url = options.url ?? testDatabaseUrl();
  await ensureDatabase(url);
  const db = createDb(url, { max: 4 });
  try {
    const lock = await db.$client.reserve();
    try {
      await lock`select pg_advisory_lock(${PREPARE_LOCK_KEY})`;
      try {
        await lock`drop schema if exists drizzle cascade`;
        await lock`drop schema if exists public cascade`;
        await lock`create schema public`;
        await migrateDb(db);
        const seedReport =
          options.seed === false
            ? null
            : await seed(db, options.env ?? testEnv(), { legalDir: options.legalDir });
        return { url, seedReport };
      } finally {
        await lock`select pg_advisory_unlock(${PREPARE_LOCK_KEY})`;
      }
    } finally {
      lock.release();
    }
  } finally {
    await db.close();
  }
}
