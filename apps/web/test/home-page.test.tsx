// Redesign 2, package P1: the home sections (docs/design-v2.md, section 4 «Главная») rendered
// without Next: makes and categories lead to the VIN request, the dark panel and the pickup card
// take the brand and the point from env, «Все марки» works without JS.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { BrandGrid, PHONE_BRANDS_COUNT, phoneBrandName } from '@/components/home/BrandGrid';
import { CategoryGrid } from '@/components/home/CategoryGrid';
import { PickupCard } from '@/components/home/PickupCard';
import { WhyUs } from '@/components/home/WhyUs';
import { CAR_BRANDS, FEATURED_BRANDS_COUNT } from '@/lib/brands';
import { PART_CATEGORIES, partCategoryHref } from '@/lib/part-categories';
import { vinRequestHref } from '@/lib/vin-link';
import type { Brand } from '@/server/brand';

function text(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/\u00a0/g, ' ')
    .replace(/\u00ad/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** href="…" values in order, entities decoded. */
function hrefs(html: string): string[] {
  return [...html.matchAll(/href="([^"]*)"/g)].map((m) => (m[1] ?? '').replace(/&amp;/g, '&'));
}

/** The opening tag of the element with this data-testid. */
function tagOf(html: string, testId: string): string {
  return new RegExp(`<[^>]*data-testid="${testId}"[^>]*>`).exec(html)?.[0] ?? '';
}

const BRAND: Pick<Brand, 'pickup' | 'pickupLinks' | 'pickupLogo' | 'contactPhone'> = {
  pickup: {
    name: 'Тестовый сервис',
    address: 'Оренбург, ул. Тестовая, 1',
    hours: 'пн–пт 9–19',
    phone: '+7 (3532) 11-11-11',
  },
  pickupLinks: { yandexMap: null, twoGisMap: null, telegram: null },
  pickupLogo: { color: '/images/partner/test-color.webp', emblemWhite: null },
  contactPhone: '+7 (3532) 11-11-11',
};

describe('home: «Выберите марку»', () => {
  const html = renderToStaticMarkup(createElement(BrandGrid));

  it('links every make to the VIN request with the make filled in', () => {
    const links = new Set(hrefs(html));
    for (const brand of CAR_BRANDS) {
      expect(links.has(vinRequestHref({ car: brand.name })), brand.slug).toBe(true);
      expect(html).toContain(`src="/images/brands/${brand.slug}.webp"`);
    }
  });

  it('shows 12 makes on phones and FEATURED_BRANDS_COUNT from md, the rest under «Все марки»', () => {
    const [grid = '', more = ''] = html.split('<details');
    expect(more).toContain('<summary');
    expect(text(more)).toContain('Все марки');
    CAR_BRANDS.forEach((brand, index) => {
      const tile = new RegExp(`<li class="([^"]*)"><a[^>]*data-testid="home-brand-${brand.slug}"`);
      const inGrid = tile.exec(grid);
      const inMore = tile.exec(more);
      if (index < PHONE_BRANDS_COUNT) {
        expect(inGrid?.[1], brand.slug).not.toContain('hidden');
        expect(inMore, brand.slug).toBeNull();
      } else if (index < FEATURED_BRANDS_COUNT) {
        expect(inGrid?.[1], brand.slug).toContain('max-md:hidden');
        expect(inMore?.[1], brand.slug).toContain('md:hidden');
      } else {
        expect(inGrid, brand.slug).toBeNull();
        expect(inMore?.[1], brand.slug).not.toContain('hidden');
      }
    });
  });

  it('never hyphenates a make inside the word; the two longest are shortened on phones', () => {
    expect(html).not.toContain('\u00ad');
    expect(phoneBrandName({ slug: 'volkswagen', name: 'Volkswagen' })).toBe('VW');
    expect(phoneBrandName({ slug: 'mitsubishi', name: 'Mitsubishi' })).toBe('Mitsubishi');
    expect(phoneBrandName({ slug: 'land-rover', name: 'Land Rover' })).toBe('Land Rover');
    expect(phoneBrandName({ slug: 'mercedes-benz', name: 'Mercedes-Benz' })).toBe('Mercedes');
  });
});

describe('home: «Популярные категории»', () => {
  const html = renderToStaticMarkup(createElement(CategoryGrid));

  it('renders the twelve tiles in order, each opening the VIN request with «Что нужно»', () => {
    expect(PART_CATEGORIES).toHaveLength(12);
    for (const category of PART_CATEGORIES) {
      const tag = tagOf(html, `home-category-${category.key}`);
      expect(tag, category.key).not.toBe('');
      expect(tag.replace(/&amp;/g, '&')).toContain(`href="${partCategoryHref(category)}"`);
    }
    const order = PART_CATEGORIES.map((c) => text(html).indexOf(c.title));
    expect(order.every((at, i) => at >= 0 && (i === 0 || at > (order[i - 1] ?? 0)))).toBe(true);
    expect(text(html)).toContain('Популярные категории');
  });
});

describe('home: the dark panel', () => {
  it('takes the brand and the pickup point from props, six advantages', () => {
    const html = renderToStaticMarkup(
      createElement(WhyUs, {
        brandName: 'Тестовый бренд',
        pickupName: 'Тестовый сервис',
      }),
    );
    const t = text(html);
    expect(t).toContain('Тестовый бренд — запчасти от тех, кто их ставит');
    for (const caption of [
      'Оплата при получении',
      'Точная дата прибытия',
      'Подбор по VIN бесплатно',
      'Установка в Тестовый сервис',
      'Возврат 7 дней',
      'Чек на каждую покупку',
    ]) {
      expect(t).toContain(caption);
    }
    expect(html.match(/data-testid="home-why-/g)).toHaveLength(6);
    // Line glyphs only: the partner's filled emblem is not on the panel.
    expect(html).not.toContain('<img');
  });

  it('falls back to a generic caption without the point', () => {
    const html = renderToStaticMarkup(
      createElement(WhyUs, { brandName: 'Тестовый бренд', pickupName: null }),
    );
    expect(text(html)).toContain('Установка в автосервисе');
    expect(html).not.toContain('<img');
  });
});

describe('home: «Точка выдачи»', () => {
  it('is the #pickup anchor with the address, hours, phone, routes and the partner logo', () => {
    const html = renderToStaticMarkup(createElement(PickupCard, { brand: BRAND }));
    expect(tagOf(html, 'home-pickup')).toContain('id="pickup"');
    const t = text(html);
    expect(t).toContain('Точка выдачи');
    expect(t).toContain('Оренбург, ул. Тестовая, 1');
    expect(t).toContain('пн–пт 9–19');
    expect(hrefs(html)).toContain('tel:+73532111111');
    expect(html).toContain('data-testid="pickup-routes"');
    expect(t).toContain('Яндекс Карты');
    expect(t).toContain('2ГИС');
    expect(html).toContain('src="/images/partner/test-color.webp"');
    expect(html).toContain('alt="Логотип: Тестовый сервис"');
  });

  it('names the point in text and shows a pin without the logo', () => {
    const html = renderToStaticMarkup(
      createElement(PickupCard, {
        brand: { ...BRAND, pickupLogo: { color: null, emblemWhite: null } },
      }),
    );
    expect(html).not.toContain('<img');
    expect(tagOf(html, 'home-pickup-name')).not.toBe('');
    expect(text(html)).toContain('Тестовый сервис');
  });
});

describe('home: the «Техкарта» blocks are gone', () => {
  it('has no old home components left', () => {
    const dir = join(import.meta.dirname, '..', 'src', 'components', 'home');
    for (const name of [
      'Hero',
      'HeroFacts',
      'InstallChain',
      'InstallFormulaSheet',
      'InstallWindowDemo',
      'LiftLoadStrip',
      'OrderRoute',
      'PickupSchematic',
      'ArticleOrVin',
      'PickupPointSection',
    ]) {
      expect(existsSync(join(dir, `${name}.tsx`)), name).toBe(false);
    }
  });
});
