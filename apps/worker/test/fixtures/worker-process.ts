// Child process for shutdown.int.test.ts: the same runWorker() as src/main.ts, with BullMQ
// and heartbeat keys under the test's `test:<uuid>:` prefix (the shared Redis must not see
// the production key names from tests).
import { createLogger, parseEnv } from '@detaly/config';
import { runWorker } from '../../src/app';

const bullPrefix = process.env.WORKER_TEST_BULL_PREFIX;
const heartbeatKey = process.env.WORKER_TEST_HEARTBEAT_KEY;
if (!bullPrefix?.startsWith('test:') || !heartbeatKey?.startsWith('test:')) {
  throw new Error('WORKER_TEST_BULL_PREFIX and WORKER_TEST_HEARTBEAT_KEY must start with test:');
}

const env = parseEnv(process.env);
const logger = createLogger('worker', { level: env.LOG_LEVEL, base: { gitSha: env.GIT_SHA } });
await runWorker({ env, logger, bullPrefix, heartbeatKey });
