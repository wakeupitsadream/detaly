import { createRedis, type Redis } from '@detaly/config';
import { serverEnv } from './env';
import { singleton } from './globals';
import { getLogger } from './logger';

/** Minimum pause between two "redis unavailable" log lines. */
const ERROR_LOG_INTERVAL_MS = 30_000;

/**
 * Shared Redis connection (RESP2 via createRedis). Commands fail after one reconnect attempt
 * instead of queueing forever, so callers can fail open (rate limit) or answer 503 (search).
 */
export function getRedis(): Redis {
  return singleton('redis', () => {
    const redis = createRedis(serverEnv().REDIS_URL, {
      maxRetriesPerRequest: 1,
      connectTimeout: 2_000,
      retryStrategy: (times) => Math.min(times * 200, 2_000),
    });
    let lastLoggedAt = 0;
    redis.on('error', (error: Error) => {
      const now = Date.now();
      if (now - lastLoggedAt < ERROR_LOG_INTERVAL_MS) return;
      lastLoggedAt = now;
      getLogger().warn({ err: error.message }, 'redis connection error');
    });
    return redis;
  });
}
