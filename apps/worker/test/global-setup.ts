// vitest globalSetup for @detaly/worker: a database of its own (`${DATABASE_URL_TEST}_worker`).
// prepareTestDb() drops and recreates schemas, so sharing DATABASE_URL_TEST with the db or web
// projects would break their tests when the root `pnpm test` runs projects in parallel.
import { prepareTestDb } from '@detaly/db/testing';
import type { TestProject } from 'vitest/node';

declare module 'vitest' {
  export interface ProvidedContext {
    /** Migrated and seeded database for worker integration tests, null without DATABASE_URL_TEST. */
    workerDatabaseUrl: string | null;
  }
}

export function workerDatabaseUrl(base: string): string {
  return `${base}_worker`;
}

export default async function setup(project: TestProject): Promise<void> {
  const base = process.env.DATABASE_URL_TEST;
  if (!base) {
    console.warn('[worker] DATABASE_URL_TEST is not set: skipping prepareTestDb()');
    project.provide('workerDatabaseUrl', null);
    return;
  }
  const { url } = await prepareTestDb({ url: workerDatabaseUrl(base) });
  project.provide('workerDatabaseUrl', url);
}
