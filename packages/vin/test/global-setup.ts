// vitest globalSetup for @detaly/vin: a database of its own (`${DATABASE_URL_TEST}_vin`) for the
// VIN request workflow tests (phase 1C, vin-core). prepareTestDb() drops and recreates schemas,
// so sharing a database with another project would break its tests when the root `pnpm test`
// runs projects in parallel.
import { prepareTestDb } from '@detaly/db/testing';
import type { TestProject } from 'vitest/node';

declare module 'vitest' {
  export interface ProvidedContext {
    /** Migrated and seeded database for VIN integration tests, null without DATABASE_URL_TEST. */
    vinDatabaseUrl: string | null;
  }
}

export function vinDatabaseUrl(base: string): string {
  return `${base}_vin`;
}

export default async function setup(project: TestProject): Promise<void> {
  const base = process.env.DATABASE_URL_TEST;
  if (!base) {
    console.warn('[vin] DATABASE_URL_TEST is not set: skipping prepareTestDb()');
    project.provide('vinDatabaseUrl', null);
    return;
  }
  const { url } = await prepareTestDb({ url: vinDatabaseUrl(base) });
  project.provide('vinDatabaseUrl', url);
}
