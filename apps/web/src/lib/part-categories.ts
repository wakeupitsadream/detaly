/**
 * «Популярные категории» on the home page (docs/design-v2.md, section 4): twelve tiles that lead
 * to a VIN request with the category already written in «Что нужно» (there is no catalogue by
 * category: a master picks the part). No oils, tyres or fluids. Plain data, so server
 * components and tests import it without React; the tile draws `icon` with CategoryIcon until
 * a photo is set in `image` (WebP in public/images/categories/).
 *
 * Step 2 (docs/pricing.md): every tile names its price group, the key of the markup adjustments
 * (PRICE_GROUPS of @detaly/domain). The domain classifier priceGroupOf is the one source of
 * truth: test/part-categories-groups.test.ts checks that it puts each tile's «Что нужно» text
 * into that group. The icons keep their own glyph rules.
 */
import type { PriceGroup } from '@detaly/domain';
import type { PartCategory } from '@/components/icons/category';
import { vinRequestHref } from './vin-link';

export interface PartCategoryTile {
  /** Stable key: React key, test id, the future image file name. */
  key: string;
  /** Tile caption, also the alt of a photo. */
  title: string;
  /** Text for «Что нужно» of the VIN request. */
  need: string;
  /** Glyph shown while there is no photo. */
  icon: PartCategory;
  /** Price group of the parts of this tile (markup adjustments, docs/pricing.md). */
  priceGroup: PriceGroup;
  image?: { src: string; alt: string };
}

export const PART_CATEGORIES: readonly PartCategoryTile[] = [
  {
    key: 'filters',
    title: 'Фильтры',
    need: 'Фильтры для ТО: масляный, воздушный, салонный',
    icon: 'filter',
    priceGroup: 'filters',
  },
  // The pad glyph, as on the pads' offer cards: three round glyphs (disc, hub, clutch) side by
  // side could not be told apart.
  {
    key: 'brakes',
    title: 'Тормоза',
    need: 'Тормозные колодки и диски',
    icon: 'pads',
    priceGroup: 'brakes',
  },
  {
    key: 'suspension',
    title: 'Подвеска',
    need: 'Подвеска: амортизаторы, стойки, рычаги',
    icon: 'shock',
    priceGroup: 'suspension',
  },
  {
    key: 'ignition',
    title: 'Зажигание',
    need: 'Свечи и катушки зажигания',
    icon: 'plug',
    priceGroup: 'ignition',
  },
  {
    key: 'timing',
    title: 'Ремни ГРМ',
    need: 'Комплект ГРМ: ремень, ролики',
    icon: 'belt',
    priceGroup: 'timing',
  },
  {
    key: 'hubs',
    title: 'Ступицы и подшипники',
    need: 'Ступица или ступичный подшипник',
    icon: 'bearing',
    priceGroup: 'bearings',
  },
  {
    key: 'clutch',
    title: 'Сцепление',
    need: 'Комплект сцепления',
    icon: 'clutch',
    priceGroup: 'clutch',
  },
  {
    key: 'cooling',
    title: 'Охлаждение',
    need: 'Охлаждение: радиатор, помпа, термостат',
    icon: 'cooling',
    priceGroup: 'cooling',
  },
  {
    key: 'wipers',
    title: 'Щётки',
    need: 'Щётки стеклоочистителя',
    icon: 'wiper',
    priceGroup: 'wipers',
  },
  {
    key: 'lighting',
    title: 'Освещение',
    need: 'Лампы и фары',
    icon: 'bulb',
    priceGroup: 'lighting',
  },
  {
    key: 'engine',
    title: 'Двигатель',
    need: 'Двигатель: прокладки, опоры, датчики',
    icon: 'engine',
    priceGroup: 'engine',
  },
  { key: 'body', title: 'Кузов', need: 'Кузовные детали', icon: 'body', priceGroup: 'body' },
];

/** Where a category tile leads: the VIN request with «Что нужно» filled in. */
export function partCategoryHref(category: Pick<PartCategoryTile, 'need'>): string {
  return vinRequestHref({ need: category.need });
}
