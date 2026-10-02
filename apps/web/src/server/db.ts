import { createDb, type Db } from '@detaly/db';
import { serverEnv } from './env';
import { singleton } from './globals';

/** Shared connection pool for route handlers and server components. */
export function getDb(): Db {
  return singleton('db', () =>
    createDb(serverEnv().DATABASE_URL, {
      max: 5,
      // Seconds: fail fast instead of hanging a request while Postgres is unreachable.
      postgres: { connect_timeout: 5, idle_timeout: 60 },
    }),
  );
}
