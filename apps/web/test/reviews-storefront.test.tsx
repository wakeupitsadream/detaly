// Step 3 (docs/reviews.md) on the storefront: the rating line (when it is shown, how it reads),
// the dark panel of the home page with it, the public /review page and its absence from the
// sitemap. The env and the database are fakes: no PG here.
import { parseEnv, type Env } from '@detaly/config';
import { ratingBlock, type RatingBlock } from '@detaly/domain';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  env: null as unknown,
  rows: [] as { key: string; value: unknown }[],
  queries: 0,
  fail: false,
}));

vi.mock('@/server/env', () => ({ serverEnv: () => state.env }));
vi.mock('@/server/db', () => ({
  getDb: () => ({
    query: {
      settings: {
        findMany: async () => {
          state.queries += 1;
          if (state.fail) throw new Error('database down');
          return state.rows;
        },
      },
    },
  }),
}));
vi.mock('@/server/logger', () => ({ getLogger: () => ({ warn: () => undefined }) }));

const { RatingLine, ratingLineText, reviewsCountText } =
  await import('@/components/reviews/RatingLine');
const { WhyUs } = await import('@/components/home/WhyUs');
const { createRatingReader, resolveRatingSettings, storefrontRating } =
  await import('@/server/reviews/rating');
const { publicReviewLinks, orderReviewLinks } = await import('@/server/reviews/links');
const { resetSingleton } = await import('@/server/globals');
const ReviewPage = (await import('@/app/(site)/review/page')).default;
const { metadata: reviewMetadata } = await import('@/app/(site)/review/page');
const sitemap = (await import('@/app/sitemap')).default;

const YANDEX = 'https://yandex.ru/maps/org/test/1/reviews/';
const TWO_GIS = 'https://2gis.ru/orenburg/firm/1';
const LINKS = { REVIEW_URL_YANDEX: YANDEX, REVIEW_URL_2GIS: TWO_GIS };

function env(overrides: Record<string, string> = {}): Env {
  return parseEnv({
    SESSION_SECRET: 'test-session-secret-0123456789abcdef',
    DATABASE_URL: 'postgres://u:p@127.0.0.1:5432/x',
    REDIS_URL: 'redis://127.0.0.1:6379/0',
    APP_BASE_URL: 'https://shop.test',
    BRAND_NAME: 'Тестовый бренд',
    ...overrides,
  });
}

function text(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const BLOCK: RatingBlock = {
  asOf: '2026-10-20',
  lines: [
    { platform: 'yandex', ratingX10: 49, count: 37, url: YANDEX },
    { platform: '2gis', ratingX10: 48, count: 12, url: TWO_GIS },
  ],
};

beforeEach(() => {
  state.env = env(LINKS);
  state.rows = [];
  state.queries = 0;
  state.fail = false;
  resetSingleton('rating-reader');
});

describe('the rating line', () => {
  it('«★ 4,9 на Яндекс Картах · 37 отзывов», «2ГИС 4,8 · 12», «на 20 октября»', () => {
    const html = renderToStaticMarkup(createElement(RatingLine, { block: BLOCK }));
    const plain = text(html);
    expect(plain).toContain('4,9 на Яндекс Картах · 37 отзывов');
    expect(plain).toContain('2ГИС 4,8 · 12');
    expect(plain).toContain('на 20 октября');
    expect(ratingLineText(BLOCK)).toBe('4,9 на Яндекс Картах · 37 отзывов   2ГИС 4,8 · 12');
    // The text itself has the spaces (the flex gaps only draw them): what a screen reader reads.
    const content = html
      .replace(/<[^>]+>/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    expect(content).toBe(
      'Рейтинг магазина: 4,9 на Яндекс Картах · 37 отзывов 2ГИС 4,8 · 12 отзывов на 20 октября',
    );
    // The names of the services link to their review pages (the env links), in a new tab.
    expect(html).toContain(`href="${YANDEX}"`);
    expect(html).toContain(`href="${TWO_GIS}"`);
    expect(html).toContain('target="_blank"');
    // No schema.org rating: a shop's own rating of itself is not allowed by search engines.
    expect(html).not.toMatch(/schema\.org|itemprop|itemscope|AggregateRating|ld\+json/i);
  });

  it('only 2ГИС: the long form for it', () => {
    const html = renderToStaticMarkup(
      createElement(RatingLine, {
        block: { asOf: '2026-10-01', lines: [{ ...BLOCK.lines[1]!, count: 21 }] },
        compact: true,
      }),
    );
    expect(text(html)).toContain('4,8 в 2ГИС · 21 отзыв');
    expect(text(html)).toContain('на 1 октября');
  });

  it('Russian plural forms of «отзыв»', () => {
    expect(reviewsCountText(1)).toBe('1 отзыв');
    expect(reviewsCountText(3)).toBe('3 отзыва');
    expect(reviewsCountText(5)).toBe('5 отзывов');
    expect(reviewsCountText(11)).toBe('11 отзывов');
    expect(reviewsCountText(21)).toBe('21 отзыв');
    expect(reviewsCountText(37)).toBe('37 отзывов');
    expect(reviewsCountText(104)).toBe('104 отзыва');
  });

  it('the dark panel of the home page carries it under the title, or nothing', () => {
    const withRating = renderToStaticMarkup(
      createElement(WhyUs, { brandName: 'Тестовый бренд', rating: BLOCK }),
    );
    expect(withRating).toContain('data-testid="rating-line"');
    expect(withRating.indexOf('rating-line')).toBeGreaterThan(withRating.indexOf('why-title'));
    const without = renderToStaticMarkup(createElement(WhyUs, { brandName: 'Тестовый бренд' }));
    expect(without).not.toContain('rating-line');
    expect(without).not.toContain('отзыв');
  });
});

describe('what the storefront shows (settings over the defaults)', () => {
  it('defaults: from 5 reviews, at most 45 days, no snapshot', () => {
    expect(resolveRatingSettings(new Map(), env())).toEqual({
      snapshot: null,
      minCount: 5,
      maxAgeDays: 45,
    });
  });

  it('valid settings win, malformed ones fall back', () => {
    const snapshot = { asOf: '2026-10-20', ratings: { yandex: { ratingX10: 49, count: 37 } } };
    expect(
      resolveRatingSettings(
        new Map<string, unknown>([
          ['reviews.snapshot', snapshot],
          ['reviews.min_count', 10],
          ['reviews.max_age_days', 30],
        ]),
        env(),
      ),
    ).toEqual({ snapshot, minCount: 10, maxAgeDays: 30 });
    expect(
      resolveRatingSettings(
        new Map<string, unknown>([
          ['reviews.snapshot', { asOf: 'вчера', ratings: {} }],
          ['reviews.min_count', -1],
          ['reviews.max_age_days', '30'],
        ]),
        env(),
      ),
    ).toEqual({ snapshot: null, minCount: 5, maxAgeDays: 45 });
  });

  it('the reader caches for a minute, drops the cache on invalidate, survives an outage', async () => {
    let clock = 0;
    const reader = createRatingReader({
      db: (await import('@/server/db')).getDb() as never,
      env: env(),
      now: () => clock,
    });
    state.rows = [{ key: 'reviews.min_count', value: 7 }];
    expect((await reader.get())?.minCount).toBe(7);
    state.rows = [{ key: 'reviews.min_count', value: 8 }];
    clock = 30_000;
    expect((await reader.get())?.minCount).toBe(7);
    reader.invalidate();
    expect((await reader.get())?.minCount).toBe(8);
    state.fail = true;
    reader.invalidate();
    // The last good values while the database is down.
    expect((await reader.get())?.minCount).toBe(8);
    const fresh = createRatingReader({
      db: (await import('@/server/db')).getDb() as never,
      env: env(),
    });
    expect(await fresh.get()).toBeNull();
  });

  it('storefrontRating: shown under the rules; never in the demo or without a link', async () => {
    const now = new Date('2026-10-25T06:00:00Z');
    state.rows = [
      {
        key: 'reviews.snapshot',
        value: {
          asOf: '2026-10-20',
          ratings: { yandex: { ratingX10: 49, count: 37 }, '2gis': { ratingX10: 48, count: 3 } },
        },
      },
    ];
    expect(await storefrontRating(now)).toEqual({
      asOf: '2026-10-20',
      lines: [{ platform: 'yandex', ratingX10: 49, count: 37, url: YANDEX }],
    });
    // Too old.
    resetSingleton('rating-reader');
    expect(await storefrontRating(new Date('2026-12-06T06:00:00Z'))).toBeNull();

    // Without a link and in the demo the database is not even asked.
    const asked = state.queries;
    state.env = env();
    resetSingleton('rating-reader');
    expect(await storefrontRating(now)).toBeNull();
    state.env = env({ ...LINKS, DEMO_MODE: 'true', DATABASE_URL: '', REDIS_URL: '' });
    resetSingleton('rating-reader');
    expect(await storefrontRating(now)).toBeNull();
    expect(state.queries).toBe(asked);
  });

  it('ratingBlock never invents a rating for a platform without numbers', () => {
    expect(
      ratingBlock(
        { asOf: '2026-10-20', ratings: {} },
        { urls: { yandex: YANDEX }, minCount: 5, maxAgeDays: 45, today: '2026-10-20' },
      ),
    ).toBeNull();
  });
});

describe('review links of the site', () => {
  it('the order page uses our redirect, /review the cards themselves', () => {
    expect(orderReviewLinks(env(LINKS), 'TOKEN').map((link) => link.href)).toEqual([
      '/o/TOKEN/review/yandex',
      '/o/TOKEN/review/2gis',
    ]);
    expect(publicReviewLinks(env(LINKS)).map((link) => [link.label, link.href])).toEqual([
      ['Яндекс Карты', YANDEX],
      ['2ГИС', TWO_GIS],
    ]);
    expect(publicReviewLinks(env())).toEqual([]);
    expect(orderReviewLinks(env(), 'TOKEN')).toEqual([]);
  });
});

describe('/review', () => {
  it('a heading, one line, a big button per card and the way out for a problem', () => {
    state.env = env({ ...LINKS, PICKUP_PHONE: '+7 900 000-00-01' });
    const html = renderToStaticMarkup(createElement(ReviewPage));
    const plain = text(html);
    expect(plain).toContain('Оставьте отзыв о Тестовый бренд');
    expect(plain).toContain('Отзыв помогает другим водителям найти нас');
    expect(html).toContain(`href="${YANDEX}"`);
    expect(html).toContain(`href="${TWO_GIS}"`);
    expect(plain).toContain('Яндекс Карты');
    expect(plain).toContain('2ГИС');
    expect(plain).toContain(
      'Что-то не так с заказом? Откройте заказ по ссылке из сообщения или позвоните:',
    );
    expect(html).toContain('href="tel:+79000000001"');
    // Big buttons (min-h-16: 64 px) and no form, no personal data asked.
    expect(html).toContain('min-h-16');
    expect(html).not.toContain('<form');
    expect(html).not.toContain('<input');
    expect(reviewMetadata.robots).toEqual({ index: false, follow: false });
  });

  it('one platform only; no phone: no call link', () => {
    state.env = env({ REVIEW_URL_2GIS: TWO_GIS });
    const html = renderToStaticMarkup(createElement(ReviewPage));
    expect(html).toContain(`href="${TWO_GIS}"`);
    expect(html).not.toContain('yandex.ru');
    expect(html).not.toContain('tel:');
    expect(text(html)).toContain('Откройте заказ по ссылке из сообщения.');
  });

  it('404 without a review link', () => {
    state.env = env();
    expect(() => renderToStaticMarkup(createElement(ReviewPage))).toThrow(
      /NEXT_HTTP_ERROR_FALLBACK;404/,
    );
  });

  it('is not in the sitemap', async () => {
    state.env = env(LINKS);
    const urls = (await sitemap()).map((entry) => entry.url);
    expect(urls.length).toBeGreaterThan(0);
    expect(urls.some((url) => url.includes('/review'))).toBe(false);
  });
});
