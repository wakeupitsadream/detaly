// CLI: node --import tsx packages/db/src/seed-cli.ts
import { getEnv } from '@detaly/config';
import { createDb, seed } from './index';

const env = getEnv();
const db = createDb(env.DATABASE_URL);
try {
  await seed(db, env);
} finally {
  await db.close();
}
