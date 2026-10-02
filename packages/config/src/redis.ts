import { Redis, type RedisOptions } from 'ioredis';

export { Redis };
export type { RedisOptions };

/**
 * ioredis 6 defaults to RESP3; we pin RESP2 (`protocol: 2`) until BullMQ and our Lua
 * scripts are verified on RESP3. Pass extra options to override.
 */
export function createRedis(url: string, options: RedisOptions = {}): Redis {
  return new Redis(url, { protocol: 2, ...options });
}

/** Connection for BullMQ Worker/QueueEvents: blocking commands need maxRetriesPerRequest: null. */
export function createWorkerRedis(url: string, options: RedisOptions = {}): Redis {
  return createRedis(url, { maxRetriesPerRequest: null, ...options });
}
