// Databases of their own for worker-core integration tests. The outbox dispatcher takes every
// pending outbox row of its database, so running it against the shared `_worker` database would
// steal the rows other test files (engine, payments, notify) write and assert on. Each file
// that runs a dispatcher (or a whole worker process) gets `${DATABASE_URL_TEST}_worker_<suffix>`.
import { prepareTestDb } from '@detaly/db/testing';

/** Migrated and seeded `${DATABASE_URL_TEST}_worker_<suffix>`, or null without DATABASE_URL_TEST. */
export async function prepareOwnDatabase(suffix: string): Promise<string | null> {
  const base = process.env.DATABASE_URL_TEST;
  if (!base) return null;
  const { url } = await prepareTestDb({ url: `${base}_worker_${suffix}` });
  return url;
}

/** true when the integration databases are configured (scripts/dev-db.sh env). */
export const hasTestDatabase = Boolean(process.env.DATABASE_URL_TEST);
