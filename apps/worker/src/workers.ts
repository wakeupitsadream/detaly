// BullMQ Workers. With `deps` (phase 1B) every queue runs its processor from jobs/*; without
// them (the phase 0 composition in app.ts until worker-core builds WorkerDeps) housekeeping runs
// the heartbeat and the other queues get the phase 0 stub.
import {
  BULLMQ_PREFIX,
  HEARTBEAT_KEY,
  QUEUE,
  type Logger,
  type QueueName,
  type Redis,
} from '@detaly/config';
import { Worker, type ConnectionOptions, type Job } from 'bullmq';
import type { WorkerDeps } from './deps';
import { PROCESSORS } from './jobs';
import { processHousekeeping } from './jobs/housekeeping';
import { processStub } from './jobs/stub';
import { PROCESSED_QUEUES } from './queues';

export interface CreateWorkersOptions {
  /**
   * Connection for the Workers: an ioredis client from createWorkerRedis()
   * (`protocol: 2`, `maxRetriesPerRequest: null`). BullMQ duplicates it for blocking calls.
   */
  connection: ConnectionOptions;
  /** Client for job side effects (heartbeat key); createRedis(). Ignored with `deps`. */
  redis: Redis;
  logger: Logger;
  prefix?: string;
  heartbeatKey?: string;
  now?: () => Date;
  /** Phase 1B dependencies: every queue runs its processor with them. */
  deps?: WorkerDeps;
}

export function createWorkers(options: CreateWorkersOptions): Worker[] {
  const { connection, redis, logger, deps } = options;
  const prefix = options.prefix ?? BULLMQ_PREFIX;
  const heartbeat = {
    redis,
    now: options.now ?? (() => new Date()),
    heartbeatKey: options.heartbeatKey ?? HEARTBEAT_KEY,
  };

  const processorFor = (name: QueueName) => {
    if (name === QUEUE.deadLetter) throw new Error('dead-letter is a parking queue');
    if (deps) {
      const processor = PROCESSORS[name];
      return (job: Job) => processor(job, deps);
    }
    return name === QUEUE.housekeeping
      ? (job: Job) => processHousekeeping(job, heartbeat)
      : (job: Job) => processStub(job);
  };

  return PROCESSED_QUEUES.map((name) => {
    const worker = new Worker(name, processorFor(name), {
      connection,
      prefix,
      concurrency: 1,
    });
    worker.on('failed', (job, error) => {
      logger.warn(
        { queue: name, jobId: job?.id, jobName: job?.name, err: error.message },
        'job failed',
      );
    });
    worker.on('error', (error) => {
      logger.error({ queue: name, err: error }, 'worker error');
    });
    return worker;
  });
}
