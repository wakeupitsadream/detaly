/**
 * Price group of an offer (docs/pricing.md): the markup adjustment of a group in settings
 * `pricing.group_adjustments` and the internal price benchmark are kept per group. The keys mean
 * the same as the storefront category tiles (apps/web/src/lib/part-categories.ts, which imports
 * this classifier for its test); the storefront icons keep their own glyph rules.
 *
 * priceGroupOf looks at the supplier product group first (when the offer has one), then at the
 * name, and falls back to `other`. Words are compared after splitWords (lower case, 'ё' as 'е',
 * runs of letters and digits), with the grammar of the stop list (excluded.ts): a token is a
 * whole word, a token ending with '*' is a word prefix, a pattern of several tokens needs all of
 * them. Rules are tried in order and the first one wins, which settles the double meanings:
 * «Фильтр масляный» is a filter (not the engine), «Диск сцепления» and «Подшипник выжимной» are
 * the clutch, «Комплект ремня ГРМ с помпой» is the timing belt, «Подшипник опоры амортизатора»
 * is the suspension, «Решётка радиатора» is the body, «Щётка генератора» is not a wiper.
 *
 * Pure and deterministic: the same offer always lands in the same group, so the cart, checkout,
 * the VIN preview and the worker price it the same way.
 */
import { splitWords } from './excluded';
import type { PriceGroup } from './statuses';

export interface PriceGroupInput {
  /** Supplier product group (Offer.group) when the answer has one. */
  productGroup?: string | null;
  name?: string | null;
}

/** Staff wording of the groups (admin pages). */
export const PRICE_GROUP_LABELS: Readonly<Record<PriceGroup, string>> = {
  filters: 'Фильтры',
  brakes: 'Тормоза',
  suspension: 'Подвеска',
  ignition: 'Зажигание',
  timing: 'Ремни и ГРМ',
  bearings: 'Ступицы и подшипники',
  clutch: 'Сцепление',
  cooling: 'Охлаждение',
  wipers: 'Щётки',
  lighting: 'Освещение',
  engine: 'Двигатель',
  body: 'Кузов',
  other: 'Прочее',
};

interface GroupRule {
  group: Exclude<PriceGroup, 'other'>;
  /** Any of these patterns matches the rule... */
  any: readonly string[];
  /** ...unless one of these does (the next rules are tried then). */
  unless?: readonly string[];
}

/** Every form of «фара», but not «фаркоп» or «фартук». */
const HEADLIGHT = ['фара', 'фары', 'фару', 'фаре', 'фарой', 'фар', 'фарам', 'фарами', 'фарах'];
/** Every form of «крыло», but not «крыльчатка» (a pump impeller). */
const WING = ['крыло', 'крыла', 'крылу', 'крылом', 'крыле', 'крылья', 'крыльев', 'крыльям'];

const RULES: readonly GroupRule[] = [
  { group: 'filters', any: ['фильтр*'] },
  { group: 'clutch', any: ['сцеплен*', 'выжимн*', 'маховик*'] },
  {
    group: 'timing',
    any: ['грм', 'ремен*', 'ремн*', 'натяжител*', 'натяжн*', 'обводн*', 'газораспредел*'],
    unless: ['безопасност*'],
  },
  {
    group: 'brakes',
    any: ['тормоз*', 'колодк*', 'суппорт*', 'ручник*', 'abs', 'абс', 'диск*'],
    unless: ['колесн*'],
  },
  {
    group: 'ignition',
    any: ['свеч*', 'зажиган*', 'катушк*', 'высоковольтн*', 'трамблер*', 'бронепровод*'],
  },
  {
    group: 'wipers',
    any: ['стеклоочистител*', 'стеклоомыв*', 'омывател*', 'дворник*', 'щетк*'],
    unless: ['генератор*', 'стартер*'],
  },
  {
    group: 'lighting',
    any: [
      'ламп*',
      ...HEADLIGHT,
      'подфарник*',
      'фонар*',
      'светодиод*',
      'противотуман*',
      'поворотник*',
      'габарит*',
      'ксенон*',
      'розжиг*',
      'освещ*',
      'оптик*',
    ],
  },
  {
    group: 'suspension',
    any: [
      'подвеск*',
      'ходов*',
      'амортизатор*',
      'стойк*',
      'рычаг*',
      'шаров*',
      'сайлент*',
      'стабилизатор*',
      'пружин*',
      'отбойник*',
      'пыльник*',
      'рулев*',
      'наконечник*',
      'шрус*',
    ],
    // Gas struts of the bonnet or the boot, a gear lever, a valve spring.
    unless: ['капот*', 'багажник*', 'кузов*', 'двер*', 'кпп', 'переключ*', 'клапан*'],
  },
  { group: 'bearings', any: ['подшипник*', 'ступиц*', 'ступичн*'] },
  {
    group: 'body',
    any: [
      'кузов*',
      'бампер*',
      'зеркал*',
      'капот*',
      ...WING,
      'подкрылок*',
      'брызговик*',
      'двер*',
      'багажник*',
      'стекл*',
      'решетк*',
      'петл*',
      'фаркоп*',
      'молдинг*',
      'порог*',
      'лонжерон*',
      'эмблем*',
    ],
  },
  {
    group: 'cooling',
    any: [
      'радиатор*',
      'помп*',
      'термостат*',
      'охлажд*',
      'вентилятор*',
      'расширительн*',
      'водян*',
      'интеркулер*',
    ],
  },
  {
    group: 'engine',
    any: [
      'двигател*',
      'прокладк*',
      'поршн*',
      'поршен*',
      'клапан*',
      'распредвал*',
      'коленвал*',
      'гбц',
      'сальник*',
      'вкладыш*',
      'маслосъемн*',
      'маслян*',
      'турбин*',
      'турбокомпрессор*',
      'форсунк*',
      'дроссел*',
      'топливн*',
      'впускн*',
      'выпускн*',
      'коллектор*',
      'цилиндр*',
      'egr',
      'картер*',
      'поддон*',
    ],
  },
];

interface Token {
  stem: string;
  prefix: boolean;
}

function parse(pattern: string): Token[] {
  return pattern
    .split(' ')
    .filter((token) => token !== '')
    .map((token) =>
      token.endsWith('*')
        ? { stem: token.slice(0, -1), prefix: true }
        : { stem: token, prefix: false },
    );
}

interface ParsedRule {
  group: GroupRule['group'];
  any: Token[][];
  unless: Token[][];
}

const PARSED: readonly ParsedRule[] = RULES.map((rule) => ({
  group: rule.group,
  any: rule.any.map(parse),
  unless: (rule.unless ?? []).map(parse),
}));

function matches(words: readonly string[], tokens: readonly Token[]): boolean {
  return tokens.every((token) =>
    words.some((word) => (token.prefix ? word.startsWith(token.stem) : word === token.stem)),
  );
}

/** The group of a text (a product group or a name), or null when no rule matches. */
function classify(text: string | null | undefined): Exclude<PriceGroup, 'other'> | null {
  if (!text) return null;
  const words = splitWords(text);
  if (words.length === 0) return null;
  for (const rule of PARSED) {
    if (!rule.any.some((tokens) => matches(words, tokens))) continue;
    if (rule.unless.some((tokens) => matches(words, tokens))) continue;
    return rule.group;
  }
  return null;
}

/** Supplier product group first, then the name, else `other`. */
export function priceGroupOf(input: PriceGroupInput): PriceGroup {
  return classify(input.productGroup) ?? classify(input.name) ?? 'other';
}
