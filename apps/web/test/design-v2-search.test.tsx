// Search page of redesign 2 (docs/design-v2.md, «Поиск», package P2): stock chips, the offer
// card, the empty result, the one-line demo note and the VIN redirect, rendered without Next.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { OfferView } from '@detaly/domain';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { DemoDataBanner } from '@/components/DemoDataBanner';
import { EmptyState } from '@/components/EmptyState';
import { OfferRow } from '@/components/OfferRow';
import {
  FilterChips,
  filterByStock,
  parseStockFilter,
  searchHref,
} from '@/components/search/FilterChips';
import { OfferGroup } from '@/components/search/OfferGroup';
import { ResultsHeader } from '@/components/search/ResultsHeader';

vi.mock('next/navigation', () => ({
  redirect: (url: string) => {
    throw new Error(`REDIRECT ${url}`);
  },
  usePathname: () => '/search',
  useSearchParams: () => null,
}));

function text(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function offer(over: Partial<OfferView> & Pick<OfferView, 'id'>): OfferView {
  return {
    brand: 'Knecht',
    article: 'OC 90',
    articleNorm: 'OC90',
    name: 'Фильтр масляный',
    isCross: false,
    isLocal: true,
    stockId: 'ORB1',
    available: 6,
    multiplicity: 1,
    priceClientKop: 52_800,
    priceText: '528 ₽',
    etaDate: '2026-10-02',
    promiseText: 'к сб 3 октября',
    excluded: false,
    excludedReason: null,
    ...over,
  } as OfferView;
}

const local = offer({ id: 'local' });
const toOrder = offer({ id: 'order', isLocal: false, stockId: 'MSK7', available: 24 });
const cross = offer({ id: 'cross', brand: 'MAHLE', isCross: true, isLocal: false });

const PLAN = {
  partText: 'к сб 3 октября',
  slotText: 'сб 3 окт с 14:00',
  carReadyText: 'к 16:00',
  demo: true,
  slotStartIso: '2026-10-03T14:00:00+05:00',
};

describe('stock chips', () => {
  it('local wins over order, anything else is all', () => {
    expect(parseStockFilter('1', '1')).toBe('local');
    expect(parseStockFilter('', 'on')).toBe('order');
    expect(parseStockFilter('', '')).toBe('all');
    expect(parseStockFilter('0', 'no')).toBe('all');
  });

  it('filters by where the part is', () => {
    const all = [local, toOrder, cross];
    expect(filterByStock(all, 'all').map((o) => o.id)).toEqual(['local', 'order', 'cross']);
    expect(filterByStock(all, 'local').map((o) => o.id)).toEqual(['local']);
    expect(filterByStock(all, 'order').map((o) => o.id)).toEqual(['order', 'cross']);
  });

  it('builds plain /search links that keep the brand', () => {
    expect(searchHref('OC90')).toBe('/search?q=OC90');
    expect(searchHref('OC90', { stock: 'local' })).toBe('/search?q=OC90&local=1');
    expect(searchHref('OC 90', { brand: 'MAHLE', stock: 'order' })).toBe(
      '/search?q=OC+90&brand=MAHLE&order=1',
    );
  });

  it('three round chips with counts, the active one marked; brands only when several', () => {
    const html = renderToStaticMarkup(
      createElement(FilterChips, {
        query: 'OC90',
        brand: null,
        stock: 'local',
        offers: [local, toOrder, cross],
        brands: ['Knecht'],
      }),
    );
    expect(text(html)).toBe('Все 3 В Оренбурге 1 Под заказ 2');
    expect(html).toMatch(/href="\/search\?q=OC90&amp;local=1" aria-current="true"/);
    expect(html).toContain('rounded-full');
    expect(html).not.toContain('Все бренды');

    // An empty stock chip is left out unless it is the one chosen.
    const onlyLocal = (stock: 'all' | 'order') =>
      text(
        renderToStaticMarkup(
          createElement(FilterChips, {
            query: 'OC90',
            brand: null,
            stock,
            offers: [local],
            brands: [],
          }),
        ),
      );
    expect(onlyLocal('all')).toBe('Все 1 В Оренбурге 1');
    expect(onlyLocal('order')).toBe('Все 1 В Оренбурге 1 Под заказ 0');

    const brands = renderToStaticMarkup(
      createElement(FilterChips, {
        query: 'OC90',
        brand: 'mahle',
        stock: 'all',
        offers: [local],
        brands: ['Knecht', 'MAHLE'],
      }),
    );
    expect(brands).toContain('Все бренды');
    expect(brands).toMatch(/href="\/search\?q=OC90&amp;brand=MAHLE" aria-current="true"/);
  });

  it('the title is the article with the count', () => {
    const html = renderToStaticMarkup(createElement(ResultsHeader, { query: 'oc90', count: 5 }));
    expect(html).toContain('data-testid="results-summary"');
    expect(html).toMatch(/<h1[^>]*>.*OC90<\/h1>/);
    expect(text(html)).toContain('Найдено 5 предложений');
  });
});

describe('offer card', () => {
  it('tile, brand and article, name, stock, arrival date and the install line', () => {
    const html = renderToStaticMarkup(
      createElement(OfferRow, { offer: local, searchArticleNorm: 'OC90', install: PLAN }),
    );
    expect(html).toContain('data-testid="offer-row"');
    expect(html).toContain('data-category="filter"');
    expect(html).toContain('data-testid="stock-badge"');
    expect(html).toContain('data-testid="offer-price"');
    expect(html).toContain('data-testid="add-to-cart"');
    expect(html).toContain('data-testid="install-line"');
    const t = text(html);
    expect(t).toContain('Knecht OC 90');
    expect(t).toContain('Фильтр масляный');
    expect(t).toContain('Привезём к сб 3 октября');
    expect(t).toContain('Машина готова сб 3 окт к 16:00');
    expect(t).toContain('528 ₽');
    // No «как мы считаем» and no table.
    expect(html).not.toContain('<table');
  });

  it('one install line at most: none without a planned window', () => {
    for (const install of [null, undefined]) {
      const html = renderToStaticMarkup(
        createElement(OfferRow, { offer: local, searchArticleNorm: 'OC90', install }),
      );
      expect(html).not.toContain('data-testid="install-line"');
    }
  });

  it('marked goods say so and show no price', () => {
    const html = renderToStaticMarkup(
      createElement(OfferRow, {
        offer: { ...local, excluded: true, excludedReason: 'Масла' },
        searchArticleNorm: 'EDGE5W40',
      }),
    );
    expect(text(html)).toContain('Не продаём онлайн');
    expect(html).not.toContain('data-testid="offer-price"');
    expect(html).not.toContain('data-testid="stock-badge"');
  });

  it('groups sit under the section marker with their count', () => {
    const html = renderToStaticMarkup(
      createElement(OfferGroup, {
        id: 'offers-cross',
        title: 'Аналоги',
        offers: [cross, toOrder],
        searchArticleNorm: 'OC90',
        orderingOpen: true,
      }),
    );
    expect(html).toMatch(/<h2 id="offers-cross"[^>]*>Аналоги <span[^>]*>2<\/span><\/h2>/);
    expect(html).toContain('bg-brand');
    expect(html.match(/data-testid="offer-row"/g)).toHaveLength(2);
  });
});

describe('nothing found', () => {
  it('a heading with the query, the VIN button and «Изменить запрос»', () => {
    const html = renderToStaticMarkup(createElement(EmptyState, { query: 'NOTFOUND' }));
    expect(html).toContain('data-testid="empty-state"');
    expect(text(html)).toContain('Ничего не нашли по «NOTFOUND»');
    expect(html).toContain('href="/vin"');
    expect(html).toContain('href="#header-q"');
    expect(text(html)).toContain('Изменить запрос');
    expect(html).not.toContain('data-testid="demo-banner"');
  });

  it('the demo note is one line of plain links', () => {
    const empty = renderToStaticMarkup(
      createElement(EmptyState, { query: 'NOTFOUND', demoData: true }),
    );
    expect(empty).toContain('data-testid="demo-banner"');
    const html = renderToStaticMarkup(createElement(DemoDataBanner));
    expect(html).toContain('bg-wait-soft');
    expect(text(html)).toContain('В демо работают:');
    expect(text(html)).toMatch(/OC 90 W 914\/2 GDB1330$/);
    expect(html).not.toMatch(/<(p|ul|dl)\b/);
  });
});

describe('VIN in the query', () => {
  it('goes to the request form instead of a search', async () => {
    const { default: SearchPage } = await import('@/app/(site)/search/page');
    await expect(
      SearchPage({ searchParams: Promise.resolve({ q: ' xta 210990y2765432 ' }) }),
    ).rejects.toThrow('REDIRECT /vin?vin=XTA210990Y2765432');
  });
});

describe('client paths of the package', () => {
  const webDir = path.resolve(import.meta.dirname, '..');
  const files = [
    'src/app/(site)/search/page.tsx',
    'src/components/search/FilterChips.tsx',
    'src/components/search/OfferGroup.tsx',
    'src/components/search/ResultsHeader.tsx',
    'src/components/search/EditQueryLink.tsx',
    'src/components/OfferRow.tsx',
    'src/components/StockBadge.tsx',
    'src/components/EmptyState.tsx',
    'src/components/AddToCartForm.tsx',
    'src/components/DemoDataBanner.tsx',
    'src/components/DemoStrip.tsx',
  ];

  it.each(files)('%s: no «Техкарта» names, no raw colours, nothing under 14 px', (file) => {
    const source = readFileSync(path.join(webDir, file), 'utf8');
    expect(source).not.toMatch(
      /\b(?:graphite|steel)-\d+|\b(?:bg|text|border)-(?:paper|card|accent|signal)\b|font-(?:mono|display)|text-label|text-article|rounded(?:-sm)?\b(?!-)|bg-tread/,
    );
    expect(source).not.toMatch(/#[0-9a-f]{6}\b/i);
    expect(source).not.toMatch(/text-(?:xs|\[0\.[0-7]\d*rem\]|\[1[0-3]px\])/);
    expect(source).not.toContain('SearchBar');
  });
});
