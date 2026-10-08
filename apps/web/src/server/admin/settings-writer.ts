/**
 * The audited settings writer of the admin (step 2, docs/pricing.md; reused by step 3,
 * docs/reviews.md). In one transaction under the row lock of the key: the optimistic version
 * must still match (another tab may have saved meanwhile), an equal value is not written again,
 * otherwise `settings` gets the new value with updated_by and `settings_audit` the old and the
 * new value, who and when.
 */
import { eq, settings, settingsAudit, type Database } from '@detaly/db';

/** Who edits settings from the admin (one Basic auth account, decision Б19). */
export const ADMIN_ACTOR = 'admin';

/** settings.updated_at of a row as the optimistic version of an editor ('none' without a row). */
export function settingsVersion(row: { updatedAt: Date } | null | undefined): string {
  return row ? row.updatedAt.toISOString() : 'none';
}

export type AuditedWriteOutcome = 'saved' | 'unchanged' | 'conflict';

export interface AuditedWrite {
  key: string;
  /** The new value in its normal form (jsonb). */
  value: unknown;
  /** The version the editor was opened with (settingsVersion); null skips the check. */
  version: string | null;
  /** True when the stored value already equals the new one (then nothing is written). */
  same: (stored: unknown) => boolean;
  changedBy?: string;
  at: Date;
}

export async function writeAuditedSetting(
  db: Database,
  input: AuditedWrite,
): Promise<AuditedWriteOutcome> {
  const changedBy = input.changedBy ?? ADMIN_ACTOR;
  return db.transaction(async (tx): Promise<AuditedWriteOutcome> => {
    const [row] = await tx
      .select({ value: settings.value, updatedAt: settings.updatedAt })
      .from(settings)
      .where(eq(settings.key, input.key))
      .for('update');
    if (input.version !== null && settingsVersion(row) !== input.version) return 'conflict';
    if (row !== undefined && input.same(row.value)) return 'unchanged';
    await tx
      .insert(settings)
      .values({ key: input.key, value: input.value, updatedBy: changedBy, updatedAt: input.at })
      .onConflictDoUpdate({
        target: settings.key,
        set: { value: input.value, updatedBy: changedBy, updatedAt: input.at },
      });
    await tx.insert(settingsAudit).values({
      key: input.key,
      oldValue: row?.value ?? null,
      newValue: input.value,
      changedBy,
      changedAt: input.at,
    });
    return 'saved';
  });
}
