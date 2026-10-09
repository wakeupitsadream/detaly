/**
 * What search engines and messengers show for the storefront (audit perf-5 and perf-2, decision
 * of 08.10): the visible line of the home page, the titles and descriptions of the pages and the
 * share card — all wording in this one file. The brand is never written here (BRAND_NAME comes
 * from env, test no-hardcoded-brand): the (site) layout's title template adds « — {BRAND_NAME}»
 * to every title below, and the card's site name is BRAND_NAME. Pages without a description of
 * their own get none: no single description for every page.
 */
import type { Metadata } from 'next';
import { PICKUP_CITY, shortPickupAddress } from './pickup-text';

/** The home page's visible h1 under the search (audit ux-10). */
export const HOME_HEADLINE = 'Автозапчасти в Оренбурге — по артикулу и VIN';

export interface PageSeo {
  /** Without the brand: the layout's template adds « — {BRAND_NAME}». */
  title: string;
  description?: string;
}

/** «{title} — {BRAND_NAME}»: how every page title ends. */
export function brandedTitle(title: string, brandName: string): string {
  return `${title} — ${brandName}`;
}

/**
 * The (site) layout's title template. Next applies it to the pages of child segments only: the
 * home page shares the layout's segment, so it sets brandedTitle() itself (`absolute`).
 */
export function titleTemplate(brandName: string): string {
  return brandedTitle('%s', brandName);
}

/** Titles and descriptions of the public pages. */
export const PAGE_SEO = {
  home: {
    title: 'Автозапчасти в Оренбурге по артикулу и VIN',
    description:
      'Найдите деталь по артикулу или пришлите VIN — подберём бесплатно. Дата получения заранее, оплата при получении для деталей со склада в Оренбурге.',
  },
  vin: {
    title: 'Подбор запчастей по VIN в Оренбурге',
    description: 'Пришлите VIN и что нужно — подберём детали и пришлём цены. Бесплатно.',
  },
  /** Its description names the pickup point from env: aboutDescription(). */
  about: { title: 'О магазине и пункте выдачи в Оренбурге' },
  returns: {
    title: 'Возврат и обмен запчастей',
    description:
      '7 дней на возврат, деньги — в течение 10 дней. Как вернуть деталь и куда обращаться с браком.',
  },
} as const satisfies Record<string, PageSeo>;

/**
 * /about: the shop and its pickup point with the address and hours from env, when they are set:
 * «Независимый магазин автозапчастей в Оренбурге. Пункт выдачи — автосервис <PICKUP_POINT_NAME>,
 * <PICKUP_ADDRESS without the city>. Часы работы: <PICKUP_HOURS>.»
 */
export function aboutDescription(pickup: {
  name: string | null;
  address: string | null;
  hours: string | null;
}): string {
  const parts = [`Независимый магазин автозапчастей в ${PICKUP_CITY}е.`];
  const where = [
    pickup.name ? `автосервис ${pickup.name}` : null,
    pickup.address ? shortPickupAddress(pickup.address) : null,
  ].filter((part) => part !== null);
  if (where.length > 0) parts.push(`Пункт выдачи — ${where.join(', ')}.`);
  if (pickup.hours) parts.push(`Часы работы: ${pickup.hours}.`);
  // Before the launch (no point in env yet): what the page has, without empty promises.
  if (parts.length === 1) parts.push('Пункт выдачи, часы работы и реквизиты продавца.');
  return parts.join(' ');
}

/**
 * The maintenance kit pages (step 5, docs/kits.md): /to, /to/<make>, /to/<make>/<model>. No
 * prices in a description: they change with the supplier every day.
 */
export const KITS_SEO: PageSeo = {
  title: `Наборы для ТО в ${PICKUP_CITY}е`,
  description:
    'Готовые наборы запчастей для ТО популярных машин: фильтры, свечи и другие детали одной кнопкой в корзину. Дата получения заранее.',
};

/** /to/<make>: «ТО Lada в Оренбурге — наборы запчастей». */
export function kitMakeSeo(make: string, models: readonly string[]): PageSeo {
  return {
    title: `ТО ${make} в ${PICKUP_CITY}е — наборы запчастей`,
    description: `Наборы запчастей для ТО ${make}: ${models.join(', ')}. Фильтры, свечи и другие детали одной кнопкой в корзину, дата получения заранее.`,
  };
}

/** /to/<make>/<model>: «ТО Lada Vesta в Оренбурге — набор запчастей». */
export function kitModelSeo(make: string, model: string, engines: readonly string[]): PageSeo {
  return {
    title: `ТО ${make} ${model} в ${PICKUP_CITY}е — набор запчастей`,
    description: `Набор запчастей для ТО ${make} ${model} (${engines.join('; ')}): фильтры, свечи и другие детали одной кнопкой в корзину. Дата получения заранее, оплата при получении для деталей со склада в ${PICKUP_CITY}е.`,
  };
}

/** /search (never indexed): «OC90 — цены и сроки в Оренбурге». */
export function searchTitle(query: string): string {
  return query ? `${query} — цены и сроки в ${PICKUP_CITY}е` : 'Поиск по артикулу';
}

/**
 * The share card's picture (public/images/og.png, 1200×630, drawn by scripts/gen-og-image.mjs):
 * the brand red with «Автозапчасти в Оренбурге» and no brand name on it, so a new BRAND_NAME
 * needs no new picture.
 */
export const OG_IMAGE = {
  url: '/images/og.png',
  width: 1200,
  height: 630,
  type: 'image/png',
  alt: 'Автозапчасти в Оренбурге — по артикулу и VIN, дата получения заранее',
} as const;

/**
 * Open Graph and the Twitter card (perf-2): the site name from BRAND_NAME, Russian, a website;
 * the title and description are the page's own (Next fills og:title and og:description from
 * them). `image: false` for the pages behind a token or a cart (/o, /p, /cart, /checkout).
 */
export function shareCard(
  siteName: string,
  { image = true }: { image?: boolean } = {},
): Pick<Metadata, 'openGraph' | 'twitter'> {
  return {
    openGraph: {
      type: 'website',
      locale: 'ru_RU',
      siteName,
      ...(image ? { images: [OG_IMAGE] } : {}),
    },
    twitter: { card: image ? 'summary_large_image' : 'summary' },
  };
}
