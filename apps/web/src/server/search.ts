/**
 * Wiring of the search service with real dependencies (lazy singletons). Tests build their
 * own with createSearchDeps and a key prefix.
 */
import type { Env, Redis } from '@detaly/config';
import { searchLog, type Database } from '@detaly/db';
import type { RosskoCaller } from '@detaly/rossko';
import { serverEnv } from './env';
import { getDb } from './db';
import { singleton } from './globals';
import { getLogger } from './logger';
import { getRedis } from './redis';
import { createWebRossko } from './rossko';
import { createSearchService, type SearchService, type SearchServiceDeps } from './search-service';
import { createSettingsReader } from './settings';

export interface SearchDepsOptions {
  env: Env;
  db: Database;
  redis: Redis;
  keyPrefix?: string;
  caller?: RosskoCaller;
  onError?: (error: unknown, what: string) => void;
}

export function createSearchDeps(options: SearchDepsOptions): SearchServiceDeps {
  const { env, db, redis, keyPrefix, caller, onError } = options;
  const settings = createSettingsReader({
    db,
    env,
    onError: (error) => onError?.(error, 'settings'),
  });
  const rossko = createWebRossko({ env, redis, db, settings, keyPrefix, caller, onError });
  return {
    rossko: rossko.client,
    limiter: rossko.limiter,
    loadSettings: () => settings.get(),
    logSearch: (row) => db.insert(searchLog).values(row),
    onBackgroundError: onError,
  };
}

export function getSearchService(): SearchService {
  return singleton('search-service', () => {
    const log = getLogger();
    return createSearchService(
      createSearchDeps({
        env: serverEnv(),
        db: getDb(),
        redis: getRedis(),
        onError: (error, what) =>
          log.warn({ err: error instanceof Error ? error.message : String(error), what }, 'search'),
      }),
    );
  });
}
