// CLI: node --import tsx packages/db/src/migrate.ts (production: from the worker image).
import { getEnv } from '@detaly/config';
import { createDb, migrateDb } from './index';

const db = createDb(getEnv().DATABASE_URL);
try {
  await migrateDb(db);
} finally {
  await db.close();
}
