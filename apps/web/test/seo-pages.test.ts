// Titles, descriptions and the share card of the storefront (audit perf-5 and perf-2, decision
// of 08.10): every public page names itself with «Оренбург», the brand closes the title from env
// (never written in lib/seo.ts), there is no single description for every page, and the Open
// Graph card carries the brand as the site name and a 1200×630 picture — except on the pages
// behind a token or a cart.
import { readFileSync } from 'node:fs';
import { parseEnv, type Env } from '@detaly/config';
import { minimalEnvSource } from '@detaly/config/testing';
import type { Metadata } from 'next';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  aboutDescription,
  HOME_HEADLINE,
  OG_IMAGE,
  PAGE_SEO,
  searchTitle,
  shareCard,
} from '@/lib/seo';

const state = vi.hoisted(() => ({ env: null as unknown }));
vi.mock('@/server/env', () => ({ serverEnv: () => state.env }));

const BRAND = 'Тестовый бренд';
const env = (overrides: Record<string, string> = {}): Env =>
  parseEnv(
    minimalEnvSource({ APP_BASE_URL: 'https://shop.example', BRAND_NAME: BRAND, ...overrides }),
  );

beforeEach(() => {
  state.env = env();
});

/**
 * The title a page ends up with, as Next resolves it: an `absolute` title as it is; otherwise
 * the layout's template around the page's own title — but only for a page of a child segment.
 * The home page shares the layout's segment, where the template does not apply (a plain title
 * there loses the brand: the regression this models).
 */
function finalTitle(
  metadata: Metadata,
  template: string,
  { sameSegment = false }: { sameSegment?: boolean } = {},
): string {
  const title = metadata.title;
  if (title && typeof title === 'object' && 'absolute' in title) return title.absolute;
  if (typeof title !== 'string') throw new Error('a page title is a string or absolute');
  return sameSegment ? title : template.replace('%s', title);
}

async function layoutMetadata(): Promise<Metadata> {
  const { generateMetadata } = await import('@/app/(site)/layout');
  return generateMetadata();
}

describe('titles and descriptions (perf-5)', () => {
  it('the brand closes every title from env; the layout has no description for all pages', async () => {
    const layout = await layoutMetadata();
    const title = layout.title as { template: string; default: string };
    expect(title.template).toBe(`%s — ${BRAND}`);
    expect(layout.description).toBeUndefined();
  });

  it('the public pages: their own title with «Оренбург» and their own description', async () => {
    const { template } = (await layoutMetadata()).title as { template: string };
    const home = (await import('@/app/(site)/page')).generateMetadata();
    const vin = (await import('@/app/(site)/vin/page')).metadata;
    const about = (await import('@/app/(site)/about/page')).generateMetadata();
    const returns = (await import('@/app/(site)/returns/page')).metadata;

    expect(finalTitle(home, template, { sameSegment: true })).toBe(
      `Автозапчасти в Оренбурге по артикулу и VIN — ${BRAND}`,
    );
    expect(home.description).toBe(
      'Найдите деталь по артикулу или пришлите VIN — подберём бесплатно. Дата получения заранее, оплата при получении для деталей со склада в Оренбурге.',
    );
    expect(finalTitle(vin, template)).toBe(`Подбор запчастей по VIN в Оренбурге — ${BRAND}`);
    expect(vin.description).toBe(
      'Пришлите VIN и что нужно — подберём детали и пришлём цены. Бесплатно.',
    );
    expect(finalTitle(about, template)).toBe(`О магазине и пункте выдачи в Оренбурге — ${BRAND}`);
    expect(finalTitle(returns, template)).toBe(`Возврат и обмен запчастей — ${BRAND}`);
    expect(returns.description).toBe(
      '7 дней на возврат, деньги — в течение 10 дней. Как вернуть деталь и куда обращаться с браком.',
    );
    const descriptions = [home, vin, about, returns].map((page) => page.description);
    expect(new Set(descriptions).size).toBe(4);
  });

  it('/about describes the pickup point with the address and hours from env, when set', async () => {
    state.env = env({
      PICKUP_POINT_NAME: 'Тестовый пункт',
      PICKUP_ADDRESS: 'г. Оренбург, ул. Тестовая, 1',
      PICKUP_HOURS: 'Пн–Сб 9:00–19:00',
    });
    const about = (await import('@/app/(site)/about/page')).generateMetadata();
    expect(about.description).toBe(
      'Независимый магазин автозапчастей в Оренбурге. Пункт выдачи — автосервис Тестовый пункт, ул. Тестовая, 1. Часы работы: Пн–Сб 9:00–19:00.',
    );
    // Before the launch nothing is invented.
    expect(aboutDescription({ name: null, address: null, hours: null })).toBe(
      'Независимый магазин автозапчастей в Оренбурге. Пункт выдачи, часы работы и реквизиты продавца.',
    );
    expect(aboutDescription({ name: null, address: 'ул. Тестовая, 1', hours: null })).toBe(
      'Независимый магазин автозапчастей в Оренбурге. Пункт выдачи — ул. Тестовая, 1.',
    );
  });

  it('/search: the query with prices and terms in Orenburg, never indexed', async () => {
    expect(searchTitle('OC90')).toBe('OC90 — цены и сроки в Оренбурге');
    expect(searchTitle('')).toBe('Поиск по артикулу');
    const { generateMetadata } = await import('@/app/(site)/search/page');
    const search = await generateMetadata({ searchParams: Promise.resolve({ q: ' OC90 ' }) });
    expect(search.title).toBe('OC90 — цены и сроки в Оренбурге');
    expect(search.robots).toEqual({ index: false, follow: false });
  });

  it('the visible home line and every title name the city; lib/seo.ts holds them all', () => {
    expect(HOME_HEADLINE).toBe('Автозапчасти в Оренбурге — по артикулу и VIN');
    for (const page of Object.values(PAGE_SEO)) expect(page.title).toMatch(/Оренбург|запчаст/);
  });
});

describe('the share card (perf-2)', () => {
  it('every page: a website in Russian, the brand as the site name, the 1200×630 picture', async () => {
    const layout = await layoutMetadata();
    expect(layout.openGraph).toEqual({
      type: 'website',
      locale: 'ru_RU',
      siteName: BRAND,
      images: [OG_IMAGE],
    });
    expect(layout.twitter).toEqual({ card: 'summary_large_image' });
    expect(OG_IMAGE).toMatchObject({ url: '/images/og.png', width: 1200, height: 630 });
    // Absolute URLs come from metadataBase = APP_BASE_URL.
    expect(layout.metadataBase?.toString()).toBe('https://shop.example/');
  });

  it('the picture is a 1200×630 PNG in public/', () => {
    const png = readFileSync(new URL(`../public${OG_IMAGE.url}`, import.meta.url));
    expect(png.subarray(1, 4).toString('ascii')).toBe('PNG');
    // IHDR: width and height right after the chunk header.
    expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([1200, 630]);
  });

  it('no picture on the pages behind a token or a cart, the text card stays', async () => {
    const pages: Record<string, () => Promise<Metadata>> = {
      '/cart': async () => (await import('@/app/(site)/cart/page')).generateMetadata(),
      '/checkout': async () => (await import('@/app/(site)/checkout/page')).generateMetadata(),
      '/o/demo': async () => (await import('@/app/(site)/o/demo/page')).generateMetadata(),
      '/p/<token>': async () => (await import('@/app/(site)/p/[token]/page')).generateMetadata(),
      '/o/<token>': async () =>
        (await import('@/app/(site)/o/[token]/page')).generateMetadata({
          params: Promise.resolve({ token: 'short' }),
        }),
    };
    for (const [path, load] of Object.entries(pages)) {
      const metadata = await load();
      expect(metadata.openGraph, path).toEqual({
        type: 'website',
        locale: 'ru_RU',
        siteName: BRAND,
      });
      expect(metadata.twitter, path).toEqual({ card: 'summary' });
      expect(metadata.robots, path).toEqual({ index: false, follow: false });
    }
    expect(shareCard(BRAND, { image: false }).openGraph).not.toHaveProperty('images');
  });
});
