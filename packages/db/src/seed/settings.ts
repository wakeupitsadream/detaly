import { settingsDefaultsFromEnv, type Env } from '@detaly/config';
import type { Executor } from '../executor';
import { settings } from '../schema';

/**
 * Inserts every settings key with its env-derived default. Existing keys are left untouched
 * (ON CONFLICT DO NOTHING) so admin edits survive re-seeding. Returns the inserted keys.
 */
export async function seedSettings(db: Executor, env: Env): Promise<string[]> {
  const defaults = settingsDefaultsFromEnv(env);
  const rows = Object.entries(defaults).map(([key, value]) => ({
    key,
    value: value as unknown,
    updatedBy: 'seed',
  }));
  const inserted = await db
    .insert(settings)
    .values(rows)
    .onConflictDoNothing({ target: settings.key })
    .returning({ key: settings.key });
  return inserted.map((row) => row.key);
}
