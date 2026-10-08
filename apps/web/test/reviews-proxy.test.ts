// Step 3 (docs/reviews.md) in src/proxy.ts: the review redirect of the sample order exists in the
// demo, /review is never indexed and without a review link it is the site's 404, the redirect
// gets the private headers of every /o/ path.
import { parseEnv, type Env } from '@detaly/config';
import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ env: null as unknown }));

vi.mock('@/server/env', () => ({ serverEnv: () => state.env }));
vi.mock('@/server/redis', () => ({
  getRedis: () => {
    throw new Error('no rate limit is spent on these GETs');
  },
}));
vi.mock('@/server/logger', () => ({ getLogger: () => ({ warn: () => undefined }) }));

const { demoBlockedPath, proxy } = await import('@/proxy');

const LINKS = {
  REVIEW_URL_YANDEX: 'https://yandex.ru/maps/org/test/1/reviews/',
  REVIEW_URL_2GIS: 'https://2gis.ru/orenburg/firm/1',
};
const TOKEN = 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8S9t0U1v';

function env(overrides: Record<string, string> = {}): Env {
  return parseEnv({
    SESSION_SECRET: 'test-session-secret-0123456789abcdef',
    DATABASE_URL: 'postgres://u:p@127.0.0.1:5432/x',
    REDIS_URL: 'redis://127.0.0.1:6379/0',
    ...overrides,
  });
}

function get(path: string): NextRequest {
  return new NextRequest(new URL(path, 'http://localhost:3000'), { method: 'GET' });
}

beforeEach(() => {
  state.env = env();
});

describe('the review redirect of the sample order in the demo', () => {
  it('/o/demo/review/<platform> is not hidden; anything else under /o is', () => {
    expect(demoBlockedPath('/o/demo/review/yandex')).toBeNull();
    expect(demoBlockedPath('/o/demo/review/2gis')).toBeNull();
    // The handler decides the platform; the proxy lets one segment through.
    expect(demoBlockedPath('/o/demo/review/google')).toBeNull();
    expect(demoBlockedPath('/o/demo/review')).toBe('page');
    expect(demoBlockedPath('/o/demo/review/yandex/x')).toBe('page');
    expect(demoBlockedPath(`/o/${TOKEN}/review/yandex`)).toBe('page');
    expect(demoBlockedPath('/o/demo')).toBeNull();
  });

  it('goes on to the handler with the private headers', async () => {
    state.env = env({ DEMO_MODE: 'true', ...LINKS, DATABASE_URL: '', REDIS_URL: '' });
    const response = await proxy(get('/o/demo/review/yandex'));
    expect(response.headers.get('x-middleware-next')).toBe('1');
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('x-robots-tag')).toBe('noindex, nofollow');
    const hidden = await proxy(get(`/o/${TOKEN}/review/yandex`));
    expect(hidden.headers.get('x-middleware-rewrite')).toMatch(/\/_demo\/not-found$/);
  });
});

describe('the admin of step 3 in the demo', () => {
  it('/admin/reviews, the sign and their API do not exist without a database', async () => {
    expect(demoBlockedPath('/admin/reviews')).toBe('page');
    expect(demoBlockedPath('/admin/reviews/sign')).toBe('page');
    expect(demoBlockedPath('/api/admin/reviews')).toBe('api');
    expect(demoBlockedPath('/api/admin/reviews/qr')).toBe('api');
    state.env = env({ DEMO_MODE: 'true', ...LINKS, DATABASE_URL: '', REDIS_URL: '' });
    const api = await proxy(
      new NextRequest(new URL('/api/admin/reviews', 'http://localhost:3000'), { method: 'POST' }),
    );
    expect(api.status).toBe(404);
    const page = await proxy(get('/admin/reviews/sign'));
    expect(page.headers.get('x-middleware-rewrite')).toMatch(/\/_demo\/not-found$/);
  });
});

describe('the redirect of a real order', () => {
  it('gets Referrer-Policy no-referrer, no-store and noindex', async () => {
    state.env = env(LINKS);
    const response = await proxy(get(`/o/${TOKEN}/review/2gis`));
    expect(response.headers.get('x-middleware-next')).toBe('1');
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('x-robots-tag')).toBe('noindex, nofollow');
  });
});

describe('/review', () => {
  it('without a review link: the site not-found page', async () => {
    const variants: Record<string, string>[] = [
      {},
      { DEMO_MODE: 'true', DATABASE_URL: '', REDIS_URL: '' },
    ];
    for (const overrides of variants) {
      state.env = env(overrides);
      const response = await proxy(get('/review'));
      expect(response.headers.get('x-middleware-rewrite'), JSON.stringify(overrides)).toMatch(
        /\/_demo\/not-found$/,
      );
      expect(response.headers.get('x-robots-tag')).toBe('noindex, nofollow');
      expect(response.headers.get('content-security-policy')).toContain("'strict-dynamic'");
    }
  });

  it('with a link: the page, never indexed (also in production)', async () => {
    const variants: Record<string, string>[] = [
      { REVIEW_URL_YANDEX: LINKS.REVIEW_URL_YANDEX },
      { REVIEW_URL_2GIS: LINKS.REVIEW_URL_2GIS },
      { ...LINKS, DEMO_MODE: 'true', DATABASE_URL: '', REDIS_URL: '' },
    ];
    for (const overrides of variants) {
      state.env = env(overrides);
      const response = await proxy(get('/review'));
      expect(response.headers.get('x-middleware-next'), JSON.stringify(overrides)).toBe('1');
      expect(response.headers.get('x-robots-tag')).toBe('noindex, nofollow');
    }
    // The storefront itself stays indexable in production.
    state.env = env(LINKS);
    expect((await proxy(get('/'))).headers.get('x-robots-tag')).toBeNull();
  });
});
