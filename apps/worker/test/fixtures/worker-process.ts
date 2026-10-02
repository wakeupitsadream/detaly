// Child process for process.int.test.ts: the same runWorker() as src/main.ts, with BullMQ,
// heartbeat and other Redis keys and the outbox channel under the test's `test:<uuid>:` prefix
// (the shared Redis must not see the production key names from tests).
import { createLogger, parseEnv } from '@detaly/config';
import { runWorker } from '../../src/app';

const prefix = process.env.WORKER_TEST_PREFIX;
if (!prefix?.startsWith('test:')) {
  throw new Error('WORKER_TEST_PREFIX must start with test:');
}

const env = parseEnv(process.env);
const logger = createLogger('worker', { level: env.LOG_LEVEL, base: { gitSha: env.GIT_SHA } });
await runWorker({
  env,
  logger,
  bullPrefix: `${prefix}bull`,
  heartbeatKey: `${prefix}heartbeat`,
  keyPrefix: prefix,
  outboxChannel: `${prefix}outbox`,
});
