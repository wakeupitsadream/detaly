/**
 * Articles that answer in ROSSKO_MODE=fixtures: the demo strip and the hero link to them and
 * the home install widget plans one of each. Plain data, so both components and the server
 * layer can import it.
 */
export const DEMO_ARTICLES = ['OC90', 'W9142', 'GDB1330'] as const;

/** The same articles as a visitor reads them: what the part is and its number as printed. */
export const DEMO_EXAMPLES: readonly {
  q: (typeof DEMO_ARTICLES)[number];
  what: string;
  /** One word for narrow screens. */
  short: string;
  article: string;
}[] = [
  { q: 'OC90', what: 'Масляный фильтр', short: 'Фильтр', article: 'OC 90' },
  { q: 'W9142', what: 'Масляный фильтр', short: 'Фильтр', article: 'W 914/2' },
  { q: 'GDB1330', what: 'Тормозные колодки', short: 'Колодки', article: 'GDB1330' },
];
