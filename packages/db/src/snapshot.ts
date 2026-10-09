import type { PgTransactionConfig } from 'drizzle-orm/pg-core';
import type { Executor } from './executor';

/**
 * A read model made of several queries reads one consistent snapshot: REPEATABLE READ (every
 * statement sees the database as of the first one) and READ ONLY. A writer that commits in
 * between, such as a payment webhook that moves the payment and the order in one transaction,
 * is then seen whole or not at all, never half. Read-only REPEATABLE READ transactions never
 * fail with a serialization error, so callers need no retry.
 */
export const READ_SNAPSHOT: PgTransactionConfig = {
  isolationLevel: 'repeatable read',
  accessMode: 'read only',
};

/**
 * Runs `read` in one REPEATABLE READ, READ ONLY transaction (READ_SNAPSHOT). Given a
 * transaction already, it runs as a savepoint of that transaction, under the caller's snapshot
 * rules. `read` must only read: a write, or `select … for update`, fails in a read-only
 * transaction.
 */
export function readSnapshot<T>(db: Executor, read: (tx: Executor) => Promise<T>): Promise<T> {
  return db.transaction((tx) => read(tx), READ_SNAPSHOT);
}
