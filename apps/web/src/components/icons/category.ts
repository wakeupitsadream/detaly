/**
 * Part category by the offer name, for the glyph on a PartTile (the supplier API has no
 * photos). Pure: used by server components and tested without React.
 */
export type PartCategory =
  | 'filter'
  | 'pads'
  | 'disc'
  | 'plug'
  | 'shock'
  | 'belt'
  | 'bearing'
  | 'wiper'
  | 'bulb'
  | 'oil'
  | 'part';

/** Order matters: "Фильтр масляный" is a filter, "Колодки дисковые" are pads. */
const RULES: readonly (readonly [RegExp, PartCategory])[] = [
  [/фильтр/iu, 'filter'],
  [/колодк/iu, 'pads'],
  [/диск/iu, 'disc'],
  [/свеч/iu, 'plug'],
  [/амортиз|стойк/iu, 'shock'],
  [/рем(е|н)/iu, 'belt'],
  [/подшип|ступиц/iu, 'bearing'],
  [/щ[её]тк|дворн/iu, 'wiper'],
  [/ламп/iu, 'bulb'],
  [/масл/iu, 'oil'],
];

export function categoryOf(name: string | null | undefined): PartCategory {
  if (!name) return 'part';
  for (const [re, category] of RULES) if (re.test(name)) return category;
  return 'part';
}

/** Short mono caption in the tile corner (rendered uppercase). */
export const CATEGORY_LABEL: Record<PartCategory, string> = {
  filter: 'фильтр',
  pads: 'колодки',
  disc: 'диск',
  plug: 'свеча',
  shock: 'аморт.',
  belt: 'ремень',
  bearing: 'подшип.',
  wiper: 'щётка',
  bulb: 'лампа',
  oil: 'масло',
  part: 'деталь',
};
