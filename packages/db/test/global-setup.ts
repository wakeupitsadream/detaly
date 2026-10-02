// vitest globalSetup for @detaly/db: fresh schema, migrations and seed in DATABASE_URL_TEST.
import { prepareTestDb } from '../src/testing';

export default async function setup(): Promise<void> {
  if (!process.env.DATABASE_URL_TEST) {
    // Unit-only runs (pnpm test:unit) need no database; integration tests fail with a hint.
    console.warn('[db] DATABASE_URL_TEST is not set: skipping prepareTestDb()');
    return;
  }
  await prepareTestDb();
}
