// BullMQ Workers: housekeeping runs for real, the phase 1 queues get the stub processor.
import { BULLMQ_PREFIX, QUEUE, type Logger, type QueueName, type Redis } from '@detaly/config';
import { Worker, type ConnectionOptions, type Job } from 'bullmq';
import { processHousekeeping } from './jobs/housekeeping';
import { processStub } from './jobs/stub';
import { PROCESSED_QUEUES } from './queues';

export interface CreateWorkersOptions {
  /**
   * Connection for the Workers: an ioredis client from createWorkerRedis()
   * (`protocol: 2`, `maxRetriesPerRequest: null`). BullMQ duplicates it for blocking calls.
   */
  connection: ConnectionOptions;
  /** Client for job side effects (heartbeat key); createRedis(). */
  redis: Redis;
  logger: Logger;
  prefix?: string;
  heartbeatKey?: string;
  now?: () => Date;
}

export function createWorkers(options: CreateWorkersOptions): Worker[] {
  const { connection, redis, logger, heartbeatKey, now } = options;
  const prefix = options.prefix ?? BULLMQ_PREFIX;

  const processorFor = (name: QueueName) =>
    name === QUEUE.housekeeping
      ? (job: Job) => processHousekeeping(job, { redis, heartbeatKey, now })
      : (job: Job) => processStub(job);

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
