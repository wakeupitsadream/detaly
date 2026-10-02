import type { PgDatabase } from 'drizzle-orm/pg-core';
import type { PostgresJsQueryResultHKT } from 'drizzle-orm/postgres-js';
import type * as schema from './schema';

/** Anything queries can run on: the database or a transaction (`tx`). */
export type Executor = PgDatabase<PostgresJsQueryResultHKT, typeof schema>;
