// CLI: node --import tsx packages/db/src/seed-cli.ts
// Idempotent: a second run logs `changed: false`.
import { createLogger, databaseUrl, getEnv } from '@detaly/config';
import { createDb } from './client';
import { isNoopSeed, seed } from './seed';

const env = getEnv();
const log = createLogger('db-seed', { level: env.LOG_LEVEL, base: { gitSha: env.GIT_SHA } });
const db = createDb(databaseUrl(env), { max: 2 });
try {
  const report = await seed(db, env);
  log.info({ changed: !isNoopSeed(report), report }, 'seed complete');
} catch (error) {
  log.error({ err: error }, 'seed failed');
  process.exitCode = 1;
} finally {
  await db.close();
}
