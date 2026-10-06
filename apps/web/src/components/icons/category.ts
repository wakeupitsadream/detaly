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
  | 'clutch'
  | 'cooling'
  | 'oil'
  | 'engine'
  | 'body'
  | 'part';

/** Not inside a word: «фара» is a headlight, «фаркоп» is not. */
const HEADLIGHT = /(?<!\p{L})фар(?:а|ы|у|е|ой|ам|ами|ах)?(?!\p{L})|фонар/iu;

/**
 * Order matters: «Фильтр масляный» is a filter, «Колодки дисковые» are pads, «Диск сцепления»
 * is the clutch, «Комплект ремня ГРМ с помпой» is a belt, «Масло моторное» is oil. Sensors are
 * deliberately left out: one «датчик» can be ABS, oxygen or coolant, so only its other words
 * decide (a coolant temperature sensor says «охлажд»).
 */
const RULES: readonly (readonly [RegExp, PartCategory])[] = [
  [/фильтр/iu, 'filter'],
  [/колодк/iu, 'pads'],
  [/сцеплен|выжимн/iu, 'clutch'],
  [/диск/iu, 'disc'],
  [/свеч/iu, 'plug'],
  [/амортиз|стойк/iu, 'shock'],
  [/рем(е|н)|цеп[ьи]\s+грм/iu, 'belt'],
  [/подшип|ступиц/iu, 'bearing'],
  [/щ[её]тк|дворн/iu, 'wiper'],
  [/ламп/iu, 'bulb'],
  [HEADLIGHT, 'bulb'],
  [/радиатор|помп|термостат|охлажд/iu, 'cooling'],
  [/масл/iu, 'oil'],
  [/двигател|прокладк|поршн|клапан|распредвал|коленвал|гбц/iu, 'engine'],
  [/кузов|бампер|зеркал|капот|крыл[оаь]|подкрылк|брызговик|двер/iu, 'body'],
];

export function categoryOf(name: string | null | undefined): PartCategory {
  if (!name) return 'part';
  for (const [re, category] of RULES) if (re.test(name)) return category;
  return 'part';
}

/** What the glyph shows, in words (lower case): alt texts and tests. */
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
  clutch: 'сцепление',
  cooling: 'охлаждение',
  oil: 'масло',
  engine: 'двигатель',
  body: 'кузов',
  part: 'деталь',
};
