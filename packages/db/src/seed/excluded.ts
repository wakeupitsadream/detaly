import type { ExcludedRule } from '@detaly/domain/types';
import type { Executor } from '../executor';
import { excludedGroups } from '../schema';

const MARKING = 'Маркировка «Честный знак»';

/**
 * Marked goods are not sold online at start (PLAN decision 10). Whole words, not prefixes:
 * the prefix "масл" would also exclude oil filters ("фильтр масляный"), see PLAN «Текущий шаг»,
 * decision 12. Grammar: ExcludedRule in @detaly/domain/types.
 */
export const EXCLUDED_SEED: readonly ExcludedRule[] = [
  { kind: 'keyword', pattern: 'масло', reason: `${MARKING}: масла` },
  { kind: 'keyword', pattern: 'масла', reason: `${MARKING}: масла` },
  { kind: 'keyword', pattern: 'шина', reason: `${MARKING}: шины` },
  { kind: 'keyword', pattern: 'шины', reason: `${MARKING}: шины` },
  { kind: 'keyword', pattern: 'антифриз*', reason: `${MARKING}: охлаждающие жидкости` },
  { kind: 'keyword', pattern: 'тосол', reason: `${MARKING}: охлаждающие жидкости` },
  { kind: 'keyword', pattern: 'жидкость тормозн*', reason: `${MARKING}: тормозные жидкости` },
];

/** Inserts missing rules; existing rows (possibly deactivated in the admin) are kept. */
export async function seedExcluded(db: Executor): Promise<string[]> {
  const inserted = await db
    .insert(excludedGroups)
    .values(EXCLUDED_SEED.map((rule) => ({ ...rule })))
    .onConflictDoNothing({ target: [excludedGroups.kind, excludedGroups.pattern] })
    .returning({ pattern: excludedGroups.pattern });
  return inserted.map((row) => row.pattern);
}
