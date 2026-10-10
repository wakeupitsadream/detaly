// Step 7 (docs/month-close.md): the month close. One row per «Сверить» of /admin/month — the
// payments and refunds of the month at the provider against the database, kept as a snapshot so
// the page shows the last result without calling the provider again.
import { sql } from 'drizzle-orm';
import { index, jsonb, pgTable, text } from 'drizzle-orm/pg-core';
import { createdAt, id, namedCheck } from './columns';

export const financeReconciliations = pgTable(
  'finance_reconciliations',
  {
    id: id(),
    /** The month compared, 'YYYY-MM' (Asia/Yekaterinburg). */
    month: text().notNull(),
    createdAt: createdAt(),
    /** 'admin' (the Basic auth account) or a staff id. */
    createdBy: text().notNull(),
    /**
     * Counts, the differences and the provider error, if any (ReconciliationResult of
     * @detaly/orders). Ids, order numbers, statuses and amounts only: no personal data.
     */
    result: jsonb().$type<Record<string, unknown>>().notNull(),
  },
  (t) => [
    index('finance_reconciliations_month_created_at_idx').on(t.month, t.createdAt),
    namedCheck(
      'finance_reconciliations',
      'month',
      sql`${t.month} ~ '^20[0-9]{2}-(0[1-9]|1[0-2])$'`,
    ),
    namedCheck(
      'finance_reconciliations',
      'created_by',
      sql`length(btrim(${t.createdBy})) between 1 and 64`,
    ),
  ],
);
