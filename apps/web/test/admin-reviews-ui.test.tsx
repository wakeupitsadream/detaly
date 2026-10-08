// Step 3 (docs/reviews.md): the server-rendered /admin/reviews, the printable counter sign and the
// QR file (plain forms and links, no client JavaScript but the print button).
import { parseEnv, type Env } from '@detaly/config';
import type { ReviewFunnel } from '@/server/admin/reviews';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ env: null as unknown }));
vi.mock('@/server/env', () => ({ serverEnv: () => state.env }));

const { AdminReviews } = await import('@/components/admin/AdminReviews');
const { ReviewSign } = await import('@/components/admin/ReviewSign');
const AdminLayout = (await import('@/app/admin/layout')).default;
const { GET: qrRoute } = await import('@/app/api/admin/reviews/qr/route');
const { qrSvg } = await import('@/server/admin/qr');

const YANDEX = 'https://yandex.ru/maps/org/test/1/reviews/';
const ADMIN = 'admin:ui-test-password';

function env(overrides: Record<string, string> = {}): Env {
  return parseEnv({
    SESSION_SECRET: 'test-session-secret-0123456789abcdef',
    DATABASE_URL: 'postgres://u:p@127.0.0.1:5432/x',
    REDIS_URL: 'redis://127.0.0.1:6379/0',
    APP_BASE_URL: 'https://shop.test',
    ADMIN_BASIC_AUTH: ADMIN,
    ...overrides,
  });
}

beforeEach(() => {
  state.env = env({ REVIEW_URL_YANDEX: YANDEX });
});

function funnel(days: number, n: number): ReviewFunnel {
  return {
    days,
    howIsItSent: 10 * n,
    reminderSent: 4 * n,
    opened: { yandex: 3 * n, '2gis': n },
    openedOrders: 3 * n,
    claimsAfterHandover: n,
  };
}

const DATA = {
  links: [
    { platform: 'yandex' as const, label: 'Яндекс Карты', url: YANDEX },
    { platform: '2gis' as const, label: '2ГИС', url: null },
  ],
  enabled: true,
  snapshot: { asOf: '2026-10-19', ratings: { yandex: { ratingX10: 49, count: 37 } } },
  version: '2026-10-19T05:00:00.000Z',
  updatedAt: new Date('2026-10-19T05:00:00Z'),
  updatedBy: 'admin',
  today: '2026-10-20',
  minCount: 5,
  maxAgeDays: 45,
  reminderDays: 3,
  storefront: {
    asOf: '2026-10-19',
    lines: [{ platform: 'yandex' as const, ratingX10: 49, count: 37, url: YANDEX }],
  },
  hiddenReason: null,
  audit: [
    {
      id: 'a1',
      changedAt: new Date('2026-10-19T05:00:00Z'),
      changedBy: 'admin',
      oldValue: null,
      newValue: { asOf: '2026-10-19', ratings: { yandex: { ratingX10: 49, count: 37 } } },
    },
  ],
  funnel: [funnel(30, 1), funnel(90, 2)],
  reviewPageUrl: 'https://shop.test/review',
};

describe('/admin/reviews', () => {
  it('links, the storefront line, the form, the history, the funnel and the sign', () => {
    const html = renderToStaticMarkup(
      createElement(AdminReviews, { data: DATA, done: 'Сохранено: Яндекс Карты 4,9 · 37' }),
    );
    expect(html).toContain('data-testid="admin-done"');
    expect(html).toMatch(/data-testid="reviews-link-yandex" data-set="true"/);
    expect(html).toMatch(/data-testid="reviews-link-2gis" data-set="false"/);
    expect(html).toContain('не задана');
    expect(html).toContain('data-testid="reviews-storefront-line"');
    // The form: the current numbers with a comma, the date today at most, the version.
    expect(html).toContain('name="rating_yandex"');
    expect(html).toContain('value="4,9"');
    expect(html).toContain('name="count_yandex"');
    expect(html).toContain('value="37"');
    expect(html).toContain('name="rating_2gis"');
    const asOf = /<input[^>]*name="as_of"[^>]*>/.exec(html)?.[0] ?? '';
    expect(asOf).toContain('type="date"');
    expect(asOf).toContain('value="2026-10-20"');
    expect(asOf).toContain('max="2026-10-20"');
    expect(html).toContain('name="version" value="2026-10-19T05:00:00.000Z"');
    expect(html).toContain('action="/api/admin/reviews"');
    expect(html).toContain('data-testid="reviews-audit-row"');
    // The funnel: 30 and 90 days.
    expect(html).toContain('«Как деталь?» отправлено');
    expect(html).toContain('Претензий после выдачи');
    expect(html).toContain('>10<');
    expect(html).toContain('>20<');
    expect(html).toContain('href="/admin/reviews/sign"');
    expect(html).toContain('href="/api/admin/reviews/qr"');
    expect(html).toContain('https://shop.test/review');
  });

  it('says why the storefront shows no rating', () => {
    const html = renderToStaticMarkup(
      createElement(AdminReviews, {
        data: { ...DATA, storefront: null, hiddenReason: 'too_old' },
        done: null,
      }),
    );
    expect(html).toContain('data-reason="too_old"');
    expect(html).toContain('данные устарели');
  });

  it('the admin menu links to it', () => {
    const html = renderToStaticMarkup(createElement(AdminLayout, { children: 'x' }));
    expect(html).toContain('href="/admin/reviews"');
    expect(html).toContain('Отзывы');
    // The admin chrome is not printed with the sign.
    expect(html).toContain('data-print-hide');
  });
});

describe('the counter sign', () => {
  it('the brand, the call to act, a big QR and the services under it', () => {
    const html = renderToStaticMarkup(
      createElement(ReviewSign, {
        brandName: 'Тестовый бренд',
        qrSrc: 'data:image/svg+xml;base64,AAAA',
        platforms: ['Яндекс Карты', '2ГИС'],
        url: 'https://shop.test/review',
        size: 'a5',
      }),
    );
    expect(html).toContain('Тестовый бренд');
    expect(html).toContain('Оставьте отзыв — наведите камеру');
    expect(html).toContain('src="data:image/svg+xml;base64,AAAA"');
    expect(html).toContain('Яндекс Карты · 2ГИС');
    expect(html).toContain('size: A5 portrait');
    const a4 = renderToStaticMarkup(
      createElement(ReviewSign, {
        brandName: 'Тестовый бренд',
        qrSrc: 'data:image/svg+xml;base64,AAAA',
        platforms: ['2ГИС'],
        url: 'https://shop.test/review',
        size: 'a4',
      }),
    );
    expect(a4).toContain('size: A4 portrait');
  });

  it('the QR encodes APP_BASE_URL/review as an SVG file', async () => {
    const svg = await qrSvg('https://shop.test/review');
    expect(svg).toMatch(/^<svg[^>]*xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
    const ok = await qrRoute(
      new Request('https://shop.test/api/admin/reviews/qr', {
        headers: { authorization: `Basic ${Buffer.from(ADMIN).toString('base64')}` },
      }),
    );
    expect(ok.status).toBe(200);
    expect(ok.headers.get('content-type')).toContain('image/svg+xml');
    expect(ok.headers.get('content-disposition')).toBe('attachment; filename="review-qr.svg"');
    expect(ok.headers.get('cache-control')).toBe('no-store');
    expect(await ok.text()).toBe(svg);
    const anonymous = await qrRoute(new Request('https://shop.test/api/admin/reviews/qr'));
    expect(anonymous.status).toBe(401);
    state.env = env({ DEMO_MODE: 'true', DATABASE_URL: '', REDIS_URL: '' });
    const demo = await qrRoute(new Request('https://shop.test/api/admin/reviews/qr'));
    expect(demo.status).toBe(404);
  });
});
