import { DEFAULT_EXCLUDED_RULES } from '@detaly/domain';
import type { ExcludedRule } from '@detaly/domain/types';
import type { Executor } from '../executor';
import { excludedGroups } from '../schema';

/**
 * Marked goods are not sold online at start (PLAN decision 10). The list lives in
 * @detaly/domain (DEFAULT_EXCLUDED_RULES, covered by the isExcluded tests) so the seed and the
 * filter cannot drift apart. Whole words, not prefixes: the prefix "масл" would also exclude
 * oil filters ("фильтр масляный"), see PLAN «Текущий шаг», decision 12.
 */
export const EXCLUDED_SEED: readonly ExcludedRule[] = DEFAULT_EXCLUDED_RULES;

/** Inserts missing rules; existing rows (possibly deactivated in the admin) are kept. */
export async function seedExcluded(db: Executor): Promise<string[]> {
  const inserted = await db
    .insert(excludedGroups)
    .values(EXCLUDED_SEED.map((rule) => ({ ...rule })))
    .onConflictDoNothing({ target: [excludedGroups.kind, excludedGroups.pattern] })
    .returning({ pattern: excludedGroups.pattern });
  return inserted.map((row) => row.pattern);
}
