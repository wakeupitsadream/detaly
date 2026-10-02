import { databaseUrl } from '@detaly/config';
import { createDb, type Db } from '@detaly/db';
import { serverEnv } from './env';
import { singleton } from './globals';
import { DemoModeError, isDemoMode } from './mode';

/** Shared connection pool for route handlers and server components. */
export function getDb(): Db {
  if (isDemoMode()) throw new DemoModeError('database');
  return singleton('db', () =>
    createDb(databaseUrl(serverEnv()), {
      max: 5,
      // Seconds: fail fast instead of hanging a request while Postgres is unreachable.
      postgres: { connect_timeout: 5, idle_timeout: 60 },
    }),
  );
}
