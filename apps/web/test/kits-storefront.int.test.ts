// Step 5 (docs/kits.md) on the storefront against PG and Redis with the Rossko fixtures: only
// published kits are public (a draft's model is a 404, its make has no page), /to and the home
// make tiles follow them, the sitemap lists exactly the published pages and is empty in the demo
// and on a stage, and the demo shows its labelled samples without a database. A database of its
// own (`<web db>_kitpages`); the process-wide db, supplier and kit list are this file's.
import { parseEnv, type Env, createRedis, type Redis } from '@detaly/config';
import { deleteKeysByPrefix, testKeyPrefix, testRedisUrl } from '@detaly/config/testing';
import { createDb, kits, type Db } from '@detaly/db';
import { prepareTestDb } from '@detaly/db/testing';
import { KIT_DEMO_LABEL } from '@detaly/domain';
import type * as Navigation from 'next/navigation';
import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { changeKitStatus, saveKit, type SaveKitInput } from '@/server/admin/kits-handler';
import { resetSingleton, singleton } from '@/server/globals';
import { publishedKits } from '@/server/kits/catalog';
import { createSupplierDeps } from '@/server/supplier';
import { intEnv, webDatabaseUrl } from './helpers';

const state = vi.hoisted(() => ({ env: null as unknown }));
vi.mock('@/server/env', () => ({ serverEnv: () => state.env }));
vi.mock('next/navigation', async (importOriginal) => ({
  ...(await importOriginal<typeof Navigation>()),
  useRouter: () => ({ refresh: () => undefined, push: () => undefined }),
}));

const APP = 'https://shop.example';
const NOW = new Date('2026-10-08T05:00:00Z');
const prefix = testKeyPrefix();
let db: Db;
let redis: Redis;
let liveEnv: Env;

beforeAll(async () => {
  const base = new URL(webDatabaseUrl());
  base.pathname = `${base.pathname}_kitpages`;
  const { url } = await prepareTestDb({ url: base.toString() });
  db = createDb(url, { max: 4 });
  redis = createRedis(testRedisUrl());
  liveEnv = intEnv({ DATABASE_URL: url, APP_BASE_URL: APP });
  state.env = liveEnv;
  // The page factories (getDb, getSupplier) take these instead of opening their own.
  resetSingleton('db');
  resetSingleton('supplier');
  singleton('db', () => db);
  singleton('supplier', () => createSupplierDeps({ env: liveEnv, db, redis, keyPrefix: prefix }));
});

beforeEach(async () => {
  state.env = liveEnv;
  resetSingleton('kit-catalog');
  await db.delete(kits);
});

afterAll(async () => {
  resetSingleton('db');
  resetSingleton('supplier');
  resetSingleton('kit-catalog');
  await deleteKeysByPrefix(redis, prefix);
  await redis?.quit();
  await db?.close();
});

const LINES: SaveKitInput['lines'] = [
  { alternative: false, brand: 'MANN', article: 'W914/2', qty: 1, role: 'Фильтр масляный' },
  { alternative: true, brand: 'KNECHT', article: 'OC90', qty: 1, role: null },
  { alternative: false, brand: 'NGK', article: 'BKR6E', qty: 4, role: 'Свечи зажигания' },
];

async function kit(header: Partial<SaveKitInput['header']> = {}, publish = true): Promise<string> {
  const saved = await saveKit(db, {
    id: null,
    version: '',
    header: {
      makeSlug: 'lada',
      model: 'Vesta',
      modelSlug: 'vesta',
      engine: '1.6 16V, 106 л.с.',
      yearsFrom: 2015,
      yearsTo: null,
      note: null,
      ...header,
    },
    lines: LINES,
    actor: 'admin',
    now: NOW,
  });
  if (!saved.ok) throw new Error(saved.reason);
  if (publish) {
    const outcome = await changeKitStatus(db, {
      id: saved.id,
      // the writer stamps updated_at with `now`: the version of the saved kit
      version: NOW.toISOString(),
      change: 'publish',
      actor: 'admin',
      now: NOW,
    });
    if (!outcome.ok) throw new Error(outcome.reason);
  }
  return saved.id;
}

function text(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

async function digestOf(promise: Promise<unknown>): Promise<string | undefined> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  return (error as { digest?: string } | undefined)?.digest;
}

async function modelPage(make: string, model: string, query: Record<string, string> = {}) {
  const { default: Page } = await import('@/app/(site)/to/[make]/[model]/page');
  return Page({ params: Promise.resolve({ make, model }), searchParams: Promise.resolve(query) });
}

async function makePage(make: string) {
  const { default: Page } = await import('@/app/(site)/to/[make]/page');
  return Page({ params: Promise.resolve({ make }) });
}

async function indexPage() {
  const { default: Page } = await import('@/app/(site)/to/page');
  return Page();
}

async function sitemapUrls(): Promise<string[]> {
  const { default: sitemap } = await import('@/app/sitemap');
  return (await sitemap()).map((entry) => entry.url);
}

describe('only published kits are public', () => {
  it('the catalogue has the published kit and not the draft', async () => {
    const published = await kit();
    await kit(
      { makeSlug: 'hyundai', model: 'Solaris', modelSlug: 'solaris', engine: '1.6' },
      false,
    );
    expect((await publishedKits())?.map((k) => k.id)).toEqual([published]);
  });

  it('the model page of a published kit shows it; a draft-only model and a stranger are 404', async () => {
    await kit();
    await kit(
      { makeSlug: 'hyundai', model: 'Solaris', modelSlug: 'solaris', engine: '1.6' },
      false,
    );
    const html = renderToStaticMarkup((await modelPage('lada', 'vesta')) as ReactElement);
    expect(text(html)).toContain('ТО Lada Vesta 1.6 16V, 106 л.с.');
    expect(text(html)).toContain('Весь набор: 2 позиции');
    expect(html).toContain('id="1-6-16v"');
    expect(text(html)).not.toContain(KIT_DEMO_LABEL);
    expect(await digestOf(modelPage('hyundai', 'solaris'))).toMatch(
      /^NEXT_HTTP_ERROR_FALLBACK;404/,
    );
    expect(await digestOf(modelPage('lada', 'granta'))).toMatch(/^NEXT_HTTP_ERROR_FALLBACK;404/);
    expect(await digestOf(modelPage('zaz', 'vesta'))).toMatch(/^NEXT_HTTP_ERROR_FALLBACK;404/);
    expect(await digestOf(makePage('hyundai'))).toMatch(/^NEXT_HTTP_ERROR_FALLBACK;404/);
  });

  it('a kit taken off the site is a 404 at once (the admin drops the cached list)', async () => {
    const id = await kit();
    renderToStaticMarkup((await modelPage('lada', 'vesta')) as ReactElement);
    await changeKitStatus(db, {
      id,
      version: NOW.toISOString(),
      change: 'unpublish',
      actor: 'admin',
      now: NOW,
    });
    const { invalidateKitCatalog } = await import('@/server/kits/catalog');
    invalidateKitCatalog();
    expect(await digestOf(modelPage('lada', 'vesta'))).toMatch(/^NEXT_HTTP_ERROR_FALLBACK;404/);
  });

  it('/to and /to/<make> list what is published', async () => {
    await kit();
    await kit(
      { makeSlug: 'hyundai', model: 'Solaris', modelSlug: 'solaris', engine: '1.6' },
      false,
    );
    const index = renderToStaticMarkup((await indexPage()) as ReactElement);
    expect(index).toContain('href="/to/lada"');
    expect(index).not.toContain('href="/to/hyundai"');
    const make = renderToStaticMarkup((await makePage('lada')) as ReactElement);
    expect(make).toContain('href="/to/lada/vesta"');
    expect(text(make)).toContain('1.6 16V, 106 л.с. · с 2015 г.');
  });

  it('/to without published kits says so and offers the VIN request', async () => {
    await kit({}, false);
    const html = renderToStaticMarkup((await indexPage()) as ReactElement);
    expect(text(html)).toContain('Наборов пока нет');
    expect(html).toContain('href="/vin?need=');
  });
});

describe('the home make tiles', () => {
  it('a make with a published kit leads to its kits, the others to the VIN request', async () => {
    await kit();
    await kit(
      { makeSlug: 'hyundai', model: 'Solaris', modelSlug: 'solaris', engine: '1.6' },
      false,
    );
    const { default: HomePage } = await import('@/app/(site)/page');
    const html = renderToStaticMarkup((await HomePage()) as ReactElement);
    const tag = (slug: string) =>
      new RegExp(`<a[^>]*data-testid="home-brand-${slug}"[^>]*>`).exec(html)?.[0] ?? '';
    expect(tag('lada')).toContain('href="/to/lada"');
    expect(tag('hyundai')).toContain('href="/vin?car=Hyundai"');
    expect(text(html)).toContain('С пометкой «ТО» — готовые наборы для ТО');
  });
});

describe('the sitemap', () => {
  it('lists /to, the makes and the models with published kits, never a draft', async () => {
    await kit();
    await kit({ model: 'Granta', modelSlug: 'granta', engine: '1.6 8V' }, false);
    await kit(
      { makeSlug: 'hyundai', model: 'Solaris', modelSlug: 'solaris', engine: '1.6' },
      false,
    );
    const urls = await sitemapUrls();
    expect(urls.filter((url) => url.includes('/to'))).toEqual([
      `${APP}/to`,
      `${APP}/to/lada`,
      `${APP}/to/lada/vesta`,
    ]);
    expect(urls).toContain(`${APP}/`);
  });

  it('has no kit pages without published kits', async () => {
    await kit({}, false);
    expect((await sitemapUrls()).some((url) => url.includes('/to'))).toBe(false);
  });

  it('is empty in the demo and on a stage', async () => {
    await kit();
    for (const overrides of [{ DEMO_MODE: 'true' }, { NOINDEX_ALL: 'true' }]) {
      state.env = parseEnv({
        SESSION_SECRET: 'test-session-secret-0123456789abcdef',
        APP_BASE_URL: APP,
        ...(overrides.DEMO_MODE ? {} : { DATABASE_URL: 'postgres://x', REDIS_URL: 'redis://x' }),
        ...overrides,
      });
      expect(await sitemapUrls(), JSON.stringify(overrides)).toEqual([]);
    }
  });
});

describe('the demo', () => {
  it('shows the labelled samples without a database', async () => {
    state.env = parseEnv({
      SESSION_SECRET: 'test-session-secret-0123456789abcdef',
      DEMO_MODE: 'true',
    });
    resetSingleton('demo-supplier');
    const kitsNow = await publishedKits();
    expect(kitsNow?.map((k) => [k.makeSlug, k.modelSlug, k.demo])).toEqual([
      ['lada', 'vesta', true],
      ['hyundai', 'solaris', true],
    ]);
    const html = renderToStaticMarkup((await modelPage('lada', 'vesta')) as ReactElement);
    // the label in the title area and on the kit section
    expect(html.match(new RegExp(KIT_DEMO_LABEL, 'g'))?.length).toBe(2);
    expect(html).toContain('name="kit" value="demo-lada-vesta"');
    const index = renderToStaticMarkup((await indexPage()) as ReactElement);
    expect(text(index)).toContain(KIT_DEMO_LABEL);
    resetSingleton('demo-supplier');
  });
});
