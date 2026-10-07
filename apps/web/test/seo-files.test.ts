// Search-engine files of the audit (perf-1, perf-3, perf-7, perf-10): /sitemap.xml and its line
// in robots.txt only in production, canonical URLs without the query of /vin links, the web
// manifest with the site icons, and a week of browser cache for the files of /public.
import { existsSync, readFileSync } from 'node:fs';
import { parseEnv, type Env } from '@detaly/config';
import { minimalEnvSource } from '@detaly/config/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ env: null as unknown }));
vi.mock('@/server/env', () => ({ serverEnv: () => state.env }));

const env = (overrides: Record<string, string> = {}): Env =>
  parseEnv(minimalEnvSource({ APP_BASE_URL: 'https://detaly.example', ...overrides }));

beforeEach(() => {
  state.env = env();
});

describe('/sitemap.xml and robots.txt (perf-7)', () => {
  it('lists the public pages in production and names the sitemap in robots.txt', async () => {
    const { default: sitemap } = await import('@/app/sitemap');
    const urls = sitemap().map((entry) => entry.url);
    expect(urls).toContain('https://detaly.example/');
    expect(urls).toContain('https://detaly.example/vin');
    expect(urls).toContain('https://detaly.example/returns');
    expect(urls).toContain('https://detaly.example/docs/offer');
    expect(urls.some((url) => /\/(search|cart|checkout|o|p)(\/|$|\?)/.test(url))).toBe(false);
    const { default: robots } = await import('@/app/robots');
    expect(robots().sitemap).toBe('https://detaly.example/sitemap.xml');
  });

  it('is empty on a stage and in the demo, and robots.txt has no sitemap there', async () => {
    const { default: sitemap } = await import('@/app/sitemap');
    const { default: robots } = await import('@/app/robots');
    const closed: Record<string, string>[] = [{ NOINDEX_ALL: 'true' }, { DEMO_MODE: 'true' }];
    for (const overrides of closed) {
      state.env = env(overrides);
      expect(sitemap()).toEqual([]);
      expect(robots().sitemap).toBeUndefined();
    }
  });
});

describe('canonical URLs (perf-3)', () => {
  it('the pages linked with a query or found by a slug declare their clean address', async () => {
    const pages = {
      '/': await import('@/app/(site)/page'),
      '/vin': await import('@/app/(site)/vin/page'),
      '/about': await import('@/app/(site)/about/page'),
      '/returns': await import('@/app/(site)/returns/page'),
    };
    for (const [path, page] of Object.entries(pages)) {
      expect(page.metadata.alternates?.canonical, path).toBe(path);
    }
    const docs = await import('@/app/(site)/docs/[slug]/page');
    const offer = await docs.generateMetadata({ params: Promise.resolve({ slug: 'offer' }) });
    expect(offer.alternates?.canonical).toBe('/docs/offer');
    const nope = await docs.generateMetadata({ params: Promise.resolve({ slug: 'nope' }) });
    expect(nope.alternates).toBeUndefined();
  });
});

describe('icons and the manifest (perf-1)', () => {
  it('has favicon.ico, an SVG icon drawn without a font and the touch icon', () => {
    const app = new URL('../src/app/', import.meta.url);
    const ico = readFileSync(new URL('favicon.ico', app));
    // ICONDIR: reserved 0, type 1 (icon), two images (16 and 32 px).
    expect([ico.readUInt16LE(0), ico.readUInt16LE(2), ico.readUInt16LE(4)]).toEqual([0, 1, 2]);
    const svg = readFileSync(new URL('icon.svg', app), 'utf8');
    expect(svg).toContain('<path');
    expect(svg).not.toContain('<text');
    expect(existsSync(new URL('apple-icon.png', app))).toBe(true);
  });

  it('names the shortcut after BRAND_NAME', async () => {
    state.env = env({ BRAND_NAME: 'Детали' });
    const { default: manifest } = await import('@/app/manifest');
    const result = manifest();
    expect(result.short_name).toBe('Детали');
    expect(result.icons?.map((icon) => icon.src)).toEqual(['/icon.svg', '/apple-icon.png']);
  });
});

describe('browser cache of /public (perf-10)', () => {
  it('keeps the logos and printable forms for a week, without immutable', async () => {
    const { default: nextConfig } = await import('../next.config');
    const rules = (await nextConfig.headers?.()) ?? [];
    for (const source of ['/images/:path*', '/print/:path*']) {
      const value = rules
        .find((rule) => rule.source === source)
        ?.headers.find((h) => h.key === 'Cache-Control')?.value;
      expect(value, source).toBe('public, max-age=604800, stale-while-revalidate=86400');
    }
  });
});
