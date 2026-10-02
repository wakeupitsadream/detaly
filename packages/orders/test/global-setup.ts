// vitest globalSetup for @detaly/orders: a database of its own (`${DATABASE_URL_TEST}_orders`).
// prepareTestDb() drops and recreates schemas, so sharing a database with the db, web or worker
// projects would break their tests when the root `pnpm test` runs projects in parallel.
import { prepareTestDb } from '@detaly/db/testing';
import type { TestProject } from 'vitest/node';

declare module 'vitest' {
  export interface ProvidedContext {
    /** Migrated and seeded database for engine integration tests, null without DATABASE_URL_TEST. */
    ordersDatabaseUrl: string | null;
  }
}

export function ordersDatabaseUrl(base: string): string {
  return `${base}_orders`;
}

export default async function setup(project: TestProject): Promise<void> {
  const base = process.env.DATABASE_URL_TEST;
  if (!base) {
    console.warn('[orders] DATABASE_URL_TEST is not set: skipping prepareTestDb()');
    project.provide('ordersDatabaseUrl', null);
    return;
  }
  const { url } = await prepareTestDb({ url: ordersDatabaseUrl(base) });
  project.provide('ordersDatabaseUrl', url);
}
