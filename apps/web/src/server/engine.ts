/**
 * The order engine of web (@detaly/orders): one EngineDeps per process. `nudge` wakes the
 * worker's outbox dispatcher right after a commit (decision Б1); it is best effort: without it
 * the dispatcher picks the rows up on its next poll, so a Redis error is swallowed.
 */
import { OUTBOX_CHANNEL } from '@detaly/config';
import type { EngineDeps } from '@detaly/orders';
import { getDb } from './db';
import { serverEnv } from './env';
import { singleton } from './globals';
import { getRedis } from './redis';

export function getEngineDeps(): EngineDeps {
  return singleton('engine', () => ({
    db: getDb(),
    env: serverEnv(),
    nudge: () => {
      try {
        getRedis()
          .publish(OUTBOX_CHANNEL, '1')
          .catch(() => undefined);
      } catch {
        // Redis client could not be created: the dispatcher polls anyway.
      }
    },
  }));
}
