// Worker entry point: node --import tsx apps/worker/src/main.ts
import { createLogger, getEnv } from '@detaly/config';
import { runWorker } from './app';

const env = getEnv();
const logger = createLogger('worker', { level: env.LOG_LEVEL, base: { gitSha: env.GIT_SHA } });

try {
  await runWorker({ env, logger });
} catch (error) {
  logger.fatal({ err: error }, 'worker failed to start');
  process.exit(1);
}
