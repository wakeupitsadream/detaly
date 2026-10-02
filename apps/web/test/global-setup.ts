// vitest globalSetup for @detaly/web: a database of its own, `${DATABASE_URL_TEST}_web`,
// recreated with migrations and the seed. Unit-only runs work without it.
import { prepareTestDb } from '@detaly/db/testing';
import type { TestProject } from 'vitest/node';

declare module 'vitest' {
  export interface ProvidedContext {
    /** null when DATABASE_URL_TEST is not set (integration tests then fail with a hint). */
    webDatabaseUrl: string | null;
  }
}

export function webTestDatabaseUrl(base: string): string {
  const url = new URL(base);
  url.pathname = `${url.pathname.replace(/\/$/, '')}_web`;
  return url.toString();
}

export default async function setup(project: TestProject): Promise<void> {
  const base = process.env.DATABASE_URL_TEST;
  if (!base) {
    console.warn('[web] DATABASE_URL_TEST is not set: skipping prepareTestDb()');
    project.provide('webDatabaseUrl', null);
    return;
  }
  const url = webTestDatabaseUrl(base);
  await prepareTestDb({ url });
  project.provide('webDatabaseUrl', url);
}
