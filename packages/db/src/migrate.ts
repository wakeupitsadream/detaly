// CLI: node --import tsx packages/db/src/migrate.ts (production: from the worker image).
import { createLogger, databaseUrl, getEnv } from '@detaly/config';
import { createDb, migrateDb, MIGRATIONS_FOLDER } from './client';

const env = getEnv();
const log = createLogger('db-migrate', { level: env.LOG_LEVEL, base: { gitSha: env.GIT_SHA } });
const db = createDb(databaseUrl(env), { max: 2 });
try {
  await migrateDb(db);
  log.info({ folder: MIGRATIONS_FOLDER }, 'migrations applied');
} catch (error) {
  log.error({ err: error }, 'migration failed');
  process.exitCode = 1;
} finally {
  await db.close();
}
