// Redesign 2 foundation (docs/design-v2.md, package F): the category tiles, the VIN request
// link, the header search routing and the brand header/footer contracts, rendered without Next.
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Footer } from '@/components/Footer';
import { headerSearchTarget } from '@/components/HeaderSearch';
import { CATEGORY_LABEL, IconMax, IconTelegram } from '@/components/icons';
import { installDateText } from '@/components/install/InstallLine';
import { PageBand } from '@/components/page/PageBand';
import { SiteHeader } from '@/components/SiteHeader';
import { InfoCard } from '@/components/ui/Card';
import { ChoiceCard } from '@/components/ui/ChoiceCard';
import { CtaCard } from '@/components/ui/CtaCard';
import { FeatureRow } from '@/components/ui/FeatureRow';
import { SectionHeading } from '@/components/ui/Section';
import { Tile } from '@/components/ui/Tile';
import { Wordmark, wordmarkInitial } from '@/components/ui/Wordmark';
import { PART_CATEGORIES, partCategoryHref } from '@/lib/part-categories';
import { vinRequestHref } from '@/lib/vin-link';
import { brandFromEnv, type Brand } from '@/server/brand';
import { parseEnv } from '@detaly/config';

function text(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const BRAND: Brand = {
  name: 'Тестовый бренд',
  siteUrl: 'http://localhost:3000',
  seller: {
    name: 'Тестов Тест Тестович',
    inn: '0000',
    ogrnip: null,
    address: 'г. Оренбург',
    email: 'shop@example.test',
    phone: '+7 (3532) 00-00-00',
  },
  pickup: {
    name: 'Тестовый сервис',
    address: 'Оренбург, ул. Тестовая, 1',
    hours: 'пн–пт 9–19',
    phone: '+7 (3532) 11-11-11',
  },
  pickupLinks: { yandexMap: null, twoGisMap: null, telegram: 'https://t.me/test_point' },
  pickupLogo: { color: '/images/partner/test-color.webp', emblemWhite: null },
  contactPhone: '+7 (3532) 11-11-11',
  demoData: false,
  noindexAll: true,
};

describe('vinRequestHref', () => {
  it('is the bare form without values', () => {
    expect(vinRequestHref()).toBe('/vin');
    expect(vinRequestHref({ vin: '  ', car: null, need: undefined })).toBe('/vin');
  });

  it('keeps the vin, car, need order, trims and encodes', () => {
    const href = vinRequestHref({ need: ' Колодки & диски ', car: 'Škoda Octavia', vin: 'xta' });
    expect(href).toBe(
      `/vin?vin=xta&car=${encodeURIComponent('Škoda Octavia').replace(/%20/g, '+')}&need=${encodeURIComponent('Колодки & диски').replace(/%20/g, '+')}`,
    );
    const params = new URL(href, 'http://x').searchParams;
    expect(params.get('car')).toBe('Škoda Octavia');
    expect(params.get('need')).toBe('Колодки & диски');
  });

  it('cannot be used to inject another parameter or path', () => {
    const href = vinRequestHref({ car: 'Lada?need=x#y', need: '/admin' });
    expect(href.startsWith('/vin?')).toBe(true);
    const params = new URL(href, 'http://x').searchParams;
    expect([...params.keys()]).toEqual(['car', 'need']);
    expect(params.get('car')).toBe('Lada?need=x#y');
  });

  it('caps a value at 200 characters', () => {
    const params = new URL(vinRequestHref({ need: 'а'.repeat(500) }), 'http://x').searchParams;
    expect(params.get('need')).toHaveLength(200);
  });
});

describe('PART_CATEGORIES', () => {
  it('the twelve tiles of the spec, in order, no oils or fluids', () => {
    expect(PART_CATEGORIES.map((c) => c.title)).toEqual([
      'Фильтры',
      'Тормоза',
      'Подвеска',
      'Зажигание',
      'Ремни ГРМ',
      'Ступицы и подшипники',
      'Сцепление',
      'Охлаждение',
      'Щётки',
      'Освещение',
      'Двигатель',
      'Кузов',
    ]);
    expect(PART_CATEGORIES.some((c) => c.icon === 'oil')).toBe(false);
  });

  it('keys are unique and every icon is a known glyph', () => {
    expect(new Set(PART_CATEGORIES.map((c) => c.key)).size).toBe(PART_CATEGORIES.length);
    for (const category of PART_CATEGORIES) {
      expect(CATEGORY_LABEL[category.icon]).toBeTruthy();
      expect(category.need.length).toBeGreaterThan(3);
      if (category.image) expect(category.image.alt).not.toBe('');
    }
  });

  it('a tile leads to the VIN request with «Что нужно» filled in', () => {
    const brakes = PART_CATEGORIES.find((c) => c.key === 'brakes')!;
    const href = partCategoryHref(brakes);
    expect(href.startsWith('/vin?need=')).toBe(true);
    expect(new URL(href, 'http://x').searchParams.get('need')).toBe(brakes.need);
  });
});

describe('header search', () => {
  it('a VIN goes to the request form, normalized', () => {
    expect(headerSearchTarget('XTA21099071234567')).toBe('/vin?vin=XTA21099071234567');
    // Lower case, spaces and Cyrillic look-alikes are what people type.
    expect(headerSearchTarget(' хта 21099071234567 ')).toBe('/vin?vin=XTA21099071234567');
  });

  it('anything else is an article search', () => {
    expect(headerSearchTarget('oc 90')).toBe('/search?q=oc+90');
    // 17 characters with an O is not a VIN: searched as an article.
    expect(headerSearchTarget('XTA2109O071234567')).toBe('/search?q=XTA2109O071234567');
  });

  it('SiteHeader keeps the e2e contracts: menu, search form, cart', () => {
    const html = renderToStaticMarkup(
      createElement(SiteHeader, {
        brandName: 'Тест',
        cartCount: 2,
        phone: '+7 (3532) 11-11-11',
        hours: 'пн–пт 9–19',
        pickupName: 'Тестовый сервис',
        emblemSrc: '/images/partner/test-white.webp',
      }),
    );
    expect(html).toContain('aria-label="Основное меню"');
    expect(html).toContain('href="/about"');
    expect(html).toContain('action="/search"');
    expect(html).toContain('method="get"');
    expect(html).toContain('name="q"');
    expect(html).toMatch(/aria-label="Артикул детали[^"]*"/);
    expect(html).toContain('aria-label="Найти"');
    expect(text(html)).toContain('Найти');
    expect(html).toContain('href="tel:+73532111111"');
    expect(html).toContain('aria-label="Корзина: 2 позиции"');
    expect(html).toContain('data-testid="header-cart-count"');
    expect(text(html)).toContain('Оренбург · Тестовый сервис');
    expect(html).toContain('src="/images/partner/test-white.webp"');
    expect(html).toContain('href="/about#pickup"');
    // The brand plate is drawn by tokens only.
    expect(html).toContain('bg-brand');
    expect(html).not.toMatch(/#[0-9a-f]{6}/i);
  });

  it('SiteHeader without a phone or emblem: no call button, a pin instead', () => {
    const html = renderToStaticMarkup(
      createElement(SiteHeader, { brandName: 'Тест', cartCount: 0 }),
    );
    expect(html).not.toContain('href="tel:');
    expect(html).not.toContain('<img');
    expect(html).toContain('aria-label="Корзина пуста"');
  });
});

describe('footer v2', () => {
  it('phone, pickup point, messengers and requisites', () => {
    const html = renderToStaticMarkup(createElement(Footer, { brand: BRAND, year: 2026 }));
    expect(html).toContain('href="tel:+73532111111"');
    // The partner's full logo stays on the pickup card only: a pin marks the point here.
    expect(html).not.toContain('src="/images/partner/test-color.webp"');
    expect(text(html)).toContain('Оренбург, ул. Тестовая, 1');
    expect(html).toContain('aria-label="Написать в Telegram"');
    expect(html).toContain('href="https://t.me/test_point"');
    expect(html).toContain('data-testid="pickup-routes"');
    expect(html).toContain('aria-label="Покупателям"');
    expect(html).toContain('href="/vin"');
    expect(html).toMatch(/data-testid="footer-inn">ИНН 0000/);
  });

  it('without the point and the phone the footer still has the requisites', () => {
    const html = renderToStaticMarkup(
      createElement(Footer, {
        brand: {
          ...BRAND,
          pickup: { name: null, address: null, hours: null, phone: null },
          pickupLinks: undefined,
          pickupLogo: undefined,
          contactPhone: null,
        },
        year: 2026,
      }),
    );
    expect(html).not.toContain('href="tel:');
    expect(html).not.toContain('<img');
    expect(html).toContain('data-testid="footer-inn"');
  });
});

describe('UI kit v2', () => {
  it('SectionHeading: marker bar and a left h2; center has no marker', () => {
    const html = renderToStaticMarkup(
      createElement(SectionHeading, { id: 's', children: 'Выберите марку' }),
    );
    expect(html).toContain('<h2 id="s"');
    expect(html).toContain('bg-brand');
    const center = renderToStaticMarkup(
      createElement(SectionHeading, { center: true, children: 'Популярные категории' }),
    );
    expect(center).toContain('text-center');
    expect(center).not.toContain('bg-brand');
  });

  it('Tile: a photo when given, otherwise the glyph; a link either way', () => {
    const glyph = renderToStaticMarkup(
      createElement(Tile, { href: '/vin?need=x', title: 'Фильтры', icon: 'filter', testId: 't' }),
    );
    expect(glyph).toContain('href="/vin?need=x"');
    expect(glyph).toContain('data-testid="t"');
    expect(glyph).toContain('<svg');
    expect(text(glyph)).toBe('Фильтры');
    const photo = renderToStaticMarkup(
      createElement(Tile, {
        href: '/vin',
        title: 'Фильтры',
        icon: 'filter',
        image: { src: '/images/categories/filters.webp', alt: 'Масляный фильтр' },
      }),
    );
    expect(photo).toContain('alt="Масляный фильтр"');
    expect(photo).toContain('loading="lazy"');
    expect(photo).not.toContain('<svg');
  });

  it('InfoCard, FeatureRow and CtaCard render their parts', () => {
    const info = renderToStaticMarkup(
      createElement(InfoCard, { title: 'Точка выдачи', id: 'pickup' }, 'Адрес'),
    );
    expect(info).toContain('id="pickup"');
    expect(info).toContain('rounded-panel');
    expect(text(info)).toBe('Точка выдачи Адрес');
    const row = renderToStaticMarkup(
      createElement(FeatureRow, { icon: 'i', title: 'Без контрафакта' }, 'Одна строка.'),
    );
    expect(text(row)).toBe('i Без контрафакта Одна строка.');
    const cta = renderToStaticMarkup(
      createElement(CtaCard, {
        title: 'Не знаете артикул?',
        text: 'Мастер подберёт деталь по VIN бесплатно.',
        action: { href: '/vin', label: 'Подобрать по VIN' },
      }),
    );
    expect(cta).toContain('href="/vin"');
    expect(cta).toContain('bg-brand');
    expect(text(cta)).toContain('Подобрать по VIN');
  });

  it('PageBand: light for restyled pages, dark stays the compatibility default', () => {
    const light = renderToStaticMarkup(
      createElement(PageBand, { tone: 'light', title: 'Корзина', titleTestId: 'h' }),
    );
    expect(light).toContain('bg-bg');
    expect(light).toContain('data-testid="h"');
    expect(light).toMatch(/<h1[^>]*class="text-h1/);
    const dark = renderToStaticMarkup(createElement(PageBand, { title: 'Корзина' }));
    expect(dark).toContain('bg-dark');
  });

  it('installDateText writes the slot day as a date, never «завтра»', () => {
    expect(installDateText('2026-10-08T14:00:00+05:00')).toBe('чт 8 окт');
    expect(installDateText('2026-10-03T09:30:00+05:00')).toBe('сб 3 окт');
    expect(installDateText('2027-01-01T10:00:00+05:00')).toBe('пт 1 янв');
  });
});

describe('partner logo env', () => {
  const base = { SESSION_SECRET: 'x'.repeat(32), DEMO_MODE: 'true', ROSSKO_MODE: 'fixtures' };

  it('site paths reach the brand, absent ones are null', () => {
    const env = parseEnv({
      ...base,
      PICKUP_LOGO_SRC: '/images/partner/logo.webp',
      PICKUP_EMBLEM_WHITE_SRC: '/images/partner/emblem-white.webp',
    });
    expect(brandFromEnv(env).pickupLogo).toEqual({
      color: '/images/partner/logo.webp',
      emblemWhite: '/images/partner/emblem-white.webp',
    });
    expect(brandFromEnv(parseEnv(base)).pickupLogo).toEqual({ color: null, emblemWhite: null });
  });

  it('only site paths to images: no hosts, no parent dirs, no scripts', () => {
    for (const bad of [
      'https://cdn.example.com/logo.webp',
      '//cdn.example.com/logo.webp',
      'images/logo.webp',
      '/images/../secret.webp',
      '/images/logo.html',
      'javascript:alert(1)',
    ]) {
      expect(() => parseEnv({ ...base, PICKUP_LOGO_SRC: bad }), bad).toThrow(/PICKUP_LOGO_SRC/);
    }
  });
});

describe('round 2 shared pieces', () => {
  it('Wordmark: the first letter of BRAND_NAME in a token tile and the name, linking home', () => {
    expect(wordmarkInitial(' тестовый бренд')).toBe('Т');
    expect(wordmarkInitial('')).toBe('');
    const html = renderToStaticMarkup(
      createElement(Wordmark, { name: 'Тестовый бренд', tone: 'onBrand' }),
    );
    expect(html).toContain('href="/"');
    expect(html).toContain('bg-on-brand text-brand');
    expect(text(html)).toBe('Т Тестовый бренд');
    const light = renderToStaticMarkup(
      createElement(Wordmark, { name: 'Тестовый бренд', tone: 'onLight' }),
    );
    expect(light).toContain('bg-brand text-on-brand');
  });

  it('ChoiceCard: «скоро» is disabled and never checked; a live card has a 3:1 frame', () => {
    const soon = renderToStaticMarkup(
      createElement(ChoiceCard, {
        name: 'channel',
        value: 'max',
        label: 'MAX',
        Icon: IconMax,
        soon: true,
        defaultChecked: true,
      }),
    );
    expect(soon).toMatch(/<input[^>]*disabled=""/);
    expect(soon).not.toMatch(/<input[^>]*checked=""/);
    expect(text(soon)).toBe('MAX скоро');
    const live = renderToStaticMarkup(
      createElement(ChoiceCard, {
        name: 'channel',
        value: 'telegram',
        label: 'Telegram',
        Icon: IconTelegram,
        defaultChecked: true,
      }),
    );
    expect(live).toMatch(/<input[^>]*checked=""/);
    expect(live).toContain('border-faint');
    expect(live).not.toContain('border-line-strong');
  });
});
