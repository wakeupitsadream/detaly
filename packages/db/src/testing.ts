// Test database helper shared by db, web and worker tests (import from '@detaly/db/testing').
// Step 0 stub; implemented in work package P1.

/**
 * Creates DATABASE_URL_TEST's database when missing, recreates schemas `public` and
 * `drizzle`, applies migrations and runs the seed. Intended for vitest globalSetup.
 */
export async function prepareTestDb(): Promise<void> {
  throw new Error('not implemented: @detaly/db prepareTestDb');
}
