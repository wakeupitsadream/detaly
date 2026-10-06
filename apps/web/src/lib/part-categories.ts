/**
 * «Популярные категории» on the home page (docs/design-v2.md, section 4): twelve tiles that lead
 * to a VIN request with the category already written in «Что нужно» (there is no catalogue by
 * category: a master picks the part). No oils, tyres or fluids. Plain data, so server
 * components and tests import it without React; the tile draws `icon` with CategoryIcon until
 * a photo is set in `image` (WebP in public/images/categories/).
 */
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
  image?: { src: string; alt: string };
}

export const PART_CATEGORIES: readonly PartCategoryTile[] = [
  {
    key: 'filters',
    title: 'Фильтры',
    need: 'Фильтры для ТО: масляный, воздушный, салонный',
    icon: 'filter',
  },
  { key: 'brakes', title: 'Тормоза', need: 'Тормозные колодки и диски', icon: 'disc' },
  {
    key: 'suspension',
    title: 'Подвеска',
    need: 'Подвеска: амортизаторы, стойки, рычаги',
    icon: 'shock',
  },
  { key: 'ignition', title: 'Зажигание', need: 'Свечи и катушки зажигания', icon: 'plug' },
  { key: 'timing', title: 'Ремни ГРМ', need: 'Комплект ГРМ: ремень, ролики', icon: 'belt' },
  {
    key: 'hubs',
    title: 'Ступицы и подшипники',
    need: 'Ступица или ступичный подшипник',
    icon: 'bearing',
  },
  { key: 'clutch', title: 'Сцепление', need: 'Комплект сцепления', icon: 'clutch' },
  {
    key: 'cooling',
    title: 'Охлаждение',
    need: 'Охлаждение: радиатор, помпа, термостат',
    icon: 'cooling',
  },
  { key: 'wipers', title: 'Щётки', need: 'Щётки стеклоочистителя', icon: 'wiper' },
  { key: 'lighting', title: 'Освещение', need: 'Лампы и фары', icon: 'bulb' },
  {
    key: 'engine',
    title: 'Двигатель',
    need: 'Двигатель: прокладки, опоры, датчики',
    icon: 'engine',
  },
  { key: 'body', title: 'Кузов', need: 'Кузовные детали', icon: 'body' },
];

/** Where a category tile leads: the VIN request with «Что нужно» filled in. */
export function partCategoryHref(category: Pick<PartCategoryTile, 'need'>): string {
  return vinRequestHref({ need: category.need });
}
