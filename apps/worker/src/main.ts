// Worker entry point: node --import tsx apps/worker/src/main.ts
// Step 0 stub; BullMQ queues, heartbeat scheduler, seller bot and graceful shutdown
// are implemented in work package P6.
import { createLogger, QUEUE_NAMES } from '@detaly/config';

const logger = createLogger('worker');
logger.warn({ queues: QUEUE_NAMES }, 'worker stub: nothing to run yet (phase 0, step 0)');
