// Step 2 (docs/pricing.md): /admin/prices and /admin/pricing against PG and Redis with the
// Rossko fixtures. A database of its own (`<web db>_pricing`): saving group adjustments changes
// the prices of every reader of that database, so the shared web database is never touched.
import { createRedis, type Redis } from '@detaly/config';
import { deleteKeysByPrefix, testKeyPrefix, testRedisUrl } from '@detaly/config/testing';
import { asc, createDb, eq, priceBenchmarks, settings, settingsAudit, type Db } from '@detaly/db';
import { prepareTestDb } from '@detaly/db/testing';
import type { RosskoClient } from '@detaly/rossko';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { handleAdminPricesAction, type AdminPricesDeps } from '@/server/admin/prices-handler';
import { loadAdminPrices, parseAdminPricesQuery } from '@/server/admin/prices';
import { handleAdminPricingAction } from '@/server/admin/pricing-handler';
import { ADJUSTMENTS_KEY, loadAdminPricing } from '@/server/admin/pricing';
import { createSearchService } from '@/server/search-service';
import { createSupplierDeps, type Supplier } from '@/server/supplier';
import { intEnv, webDatabaseUrl } from './helpers';

const APP = 'http://127.0.0.1:3100';
const ADMIN = 'admin:pricing-test-password';
const AUTH = `Basic ${Buffer.from(ADMIN, 'utf8').toString('base64')}`;
const env = intEnv({ ADMIN_BASIC_AUTH: ADMIN, APP_BASE_URL: APP });

let db: Db;
let redis: Redis;
let supplier: Supplier;
const prefixes: string[] = [];

beforeAll(async () => {
  const base = new URL(webDatabaseUrl());
  base.pathname = `${base.pathname}_pricing`;
  const { url } = await prepareTestDb({ url: base.toString() });
  db = createDb(url, { max: 4 });
  redis = createRedis(testRedisUrl());
});

beforeEach(async () => {
  const prefix = testKeyPrefix();
  prefixes.push(prefix);
  supplier = createSupplierDeps({ env, db, redis, keyPrefix: prefix });
  await db.delete(priceBenchmarks);
  await db.delete(settingsAudit);
  await db
    .update(settings)
    .set({ value: [], updatedBy: 'seed' })
    .where(eq(settings.key, ADJUSTMENTS_KEY));
});

afterEach(async () => {
  for (const prefix of prefixes.splice(0)) await deleteKeysByPrefix(redis, prefix);
});

afterAll(async () => {
  await redis?.quit();
  await db?.close();
});

function formRequest(
  path: string,
  fields: Record<string, string>,
  headers: Record<string, string> = {},
): Request {
  const all: Record<string, string> = {
    'content-type': 'application/x-www-form-urlencoded',
    origin: APP,
    authorization: AUTH,
    ...headers,
  };
  for (const [key, value] of Object.entries(all)) if (value === '') delete all[key];
  return new Request(`${APP}${path}`, {
    method: 'POST',
    headers: all,
    body: new URLSearchParams(fields).toString(),
  });
}

function pricesDeps(overrides: Partial<AdminPricesDeps> = {}): AdminPricesDeps {
  return {
    db,
    env,
    supplier: { rossko: supplier.rossko, settings: supplier.settings },
    now: () => new Date('2026-10-08T05:00:00Z'),
    ...overrides,
  };
}

const KNECHT = {
  action: 'record',
  brand: 'Knecht',
  article: 'OC 90',
  competitor: 'emex',
  price: '600',
  delivery: '0',
  eta: '2',
  url: 'https://emex.example/part/oc90',
  note: 'тест',
};

function doneOf(response: Response): string {
  const location = response.headers.get('location') ?? '';
  return new URL(location, APP).searchParams.get('done') ?? '';
}

async function searchPrices(): Promise<Record<string, number>> {
  const service = createSearchService({
    rossko: supplier.rossko,
    limiter: supplier.limiter,
    loadSettings: () => supplier.settings.get(),
  });
  const result = await service.search({ q: 'OC90' });
  return Object.fromEntries(result.offers.map((offer) => [offer.id, offer.priceClientKop]));
}

describe('/admin/prices: recording a comparison', () => {
  it('finds our cheapest exact offer and stores its snapshot', async () => {
    const response = await handleAdminPricesAction(
      formRequest('/api/admin/prices', KNECHT),
      pricesDeps(),
    );
    expect(response.status).toBe(303);
    // Knecht OC 90: 389.00 ₽ at MSK7 -> 498 ₽ (to order) is cheaper than 528 ₽ in Orenburg.
    expect(doneOf(response)).toBe('Записано: Knecht OC90 — у нас 498\u00a0₽, Emex 600\u00a0₽');
    const [row] = await db.select().from(priceBenchmarks);
    expect(row).toMatchObject({
      brand: 'Knecht',
      article: 'OC90',
      priceGroup: 'filters',
      competitor: 'emex',
      competitorPriceKop: 60_000,
      competitorDeliveryKop: 0,
      competitorEtaDays: 2,
      sourceUrl: 'https://emex.example/part/oc90',
      note: 'тест',
      ourSupplierKop: 38_900,
      ourPriceKop: 49_800,
      ourIsLocal: false,
      capturedBy: 'admin',
    });
    // 3 days at MSK7 from Thursday 8 October + 1 buffer day -> Monday 12 October
    expect(row?.ourEtaDays).toBe(4);
  });

  it('matches the brand like the VIN preview (short brand, any case)', async () => {
    const response = await handleAdminPricesAction(
      formRequest('/api/admin/prices', { ...KNECHT, brand: 'mann', article: 'W914/2' }),
      pricesDeps(),
    );
    expect(response.status).toBe(303);
    const [row] = await db.select().from(priceBenchmarks);
    expect(row).toMatchObject({ brand: 'mann', article: 'W9142', ourSupplierKop: 62_340 });
  });

  it('stores the comparison without our side when the supplier has no such offer', async () => {
    const response = await handleAdminPricesAction(
      formRequest('/api/admin/prices', {
        ...KNECHT,
        brand: 'NONAME',
        group: 'brakes',
        delivery: '350',
      }),
      pricesDeps(),
    );
    expect(response.status).toBe(303);
    expect(doneOf(response)).toBe(
      'Записано без нашей цены: у поставщика нет NONAME OC90. Emex 950\u00a0₽ с доставкой',
    );
    const [row] = await db.select().from(priceBenchmarks);
    expect(row).toMatchObject({
      priceGroup: 'brakes',
      competitorDeliveryKop: 35_000,
      ourSupplierKop: null,
      ourPriceKop: null,
      ourIsLocal: null,
      ourEtaDays: null,
    });
  });

  it('stores the comparison without our side when the supplier fails', async () => {
    const failing: Pick<RosskoClient, 'search'> = {
      search: () => Promise.reject(new Error('rossko down')),
    };
    const response = await handleAdminPricesAction(
      formRequest('/api/admin/prices', KNECHT),
      pricesDeps({ supplier: { rossko: failing, settings: supplier.settings } }),
    );
    expect(response.status).toBe(303);
    expect(doneOf(response)).toMatch(/^Записано без нашей цены: поставщик не ответил/);
    const [row] = await db.select().from(priceBenchmarks);
    expect(row).toMatchObject({ priceGroup: 'other', ourPriceKop: null });
  });

  it.each<[string, Record<string, string>, string]>([
    ['no brand', { brand: ' ' }, 'Укажите бренд'],
    ['a short article', { article: 'ab' }, 'Введите артикул: не меньше 3 букв или цифр'],
    ['an unknown competitor', { competitor: 'ozon' }, 'Выберите, где смотрели цену'],
    ['a price in words', { price: 'шестьсот' }, 'Цена конкурента'],
    ['a zero price', { price: '0' }, 'Цена конкурента'],
    ['a negative delivery', { delivery: '-5' }, 'Доставка'],
    ['a fractional term', { eta: '2.5' }, 'Срок'],
    ['a script link', { url: 'javascript:alert(1)' }, 'Ссылка'],
    ['a long note', { note: 'x'.repeat(301) }, 'Заметка'],
  ])('refuses %s with 422 and stores nothing', async (_name, change, message) => {
    const response = await handleAdminPricesAction(
      formRequest('/api/admin/prices', { ...KNECHT, ...change }),
      pricesDeps(),
    );
    expect(response.status).toBe(422);
    expect(await response.text()).toContain(message);
    expect(await db.select().from(priceBenchmarks)).toEqual([]);
  });

  it('answers 500 with a short page when the database fails', async () => {
    const broken = {
      insert: () => {
        throw new Error('connection refused');
      },
    } as unknown as AdminPricesDeps['db'];
    const response = await handleAdminPricesAction(
      formRequest('/api/admin/prices', KNECHT),
      pricesDeps({ db: broken }),
    );
    expect(response.status).toBe(500);
    expect(await response.text()).toContain('Не удалось сохранить');
  });

  it('checks Basic auth and the Origin first', async () => {
    const anonymous = await handleAdminPricesAction(
      formRequest('/api/admin/prices', KNECHT, { authorization: '' }),
      pricesDeps(),
    );
    expect(anonymous.status).toBe(401);
    const foreign = await handleAdminPricesAction(
      formRequest('/api/admin/prices', KNECHT, { origin: 'https://evil.example' }),
      pricesDeps(),
    );
    expect(foreign.status).toBe(403);
    const disabled = await handleAdminPricesAction(
      formRequest('/api/admin/prices', KNECHT),
      pricesDeps({ env: { ...env, ADMIN_BASIC_AUTH: undefined } }),
    );
    expect(disabled.status).toBe(404);
    expect(await db.select().from(priceBenchmarks)).toEqual([]);
  });

  it('deletes a record only with the «подтверждаю» tick', async () => {
    await handleAdminPricesAction(formRequest('/api/admin/prices', KNECHT), pricesDeps());
    const [row] = await db.select().from(priceBenchmarks);
    const without = await handleAdminPricesAction(
      formRequest('/api/admin/prices', { action: 'delete', id: row!.id }),
      pricesDeps(),
    );
    expect(without.status).toBe(400);
    const deleted = await handleAdminPricesAction(
      formRequest('/api/admin/prices', {
        action: 'delete',
        id: row!.id,
        confirm: 'on',
        back_days: '7',
      }),
      pricesDeps(),
    );
    expect(deleted.status).toBe(303);
    expect(deleted.headers.get('location')).toBe(
      `/admin/prices?days=7&done=${encodeURIComponent('Запись удалена').replace(/%20/g, '+')}`,
    );
    expect(await db.select().from(priceBenchmarks)).toEqual([]);
  });
});

describe('/admin/prices: list and report', () => {
  it('lists the period filtered by group and reports every group with a hint', async () => {
    const now = new Date('2026-10-08T05:00:00Z');
    const day = 86_400_000;
    const base = {
      brand: 'Knecht',
      competitor: 'emex',
      competitorDeliveryKop: 0,
      competitorEtaDays: 3,
      ourIsLocal: true,
      ourEtaDays: 1,
      capturedBy: 'admin',
    };
    await db.insert(priceBenchmarks).values([
      // filters: we sell at 1280 ₽ (1000 ₽ wholesale at 28%), they ask 1400–1500 ₽
      {
        ...base,
        article: 'F1',
        priceGroup: 'filters',
        competitorPriceKop: 140_000,
        ourSupplierKop: 100_000,
        ourPriceKop: 128_000,
        capturedAt: new Date(now.getTime() - day),
      },
      {
        ...base,
        article: 'F2',
        priceGroup: 'filters',
        competitorPriceKop: 150_000,
        ourSupplierKop: 100_000,
        ourPriceKop: 128_000,
        capturedAt: new Date(now.getTime() - 2 * day),
      },
      {
        ...base,
        article: 'F3',
        priceGroup: 'filters',
        competitorPriceKop: 145_000,
        ourSupplierKop: 100_000,
        ourPriceKop: 128_000,
        capturedAt: new Date(now.getTime() - 3 * day),
      },
      {
        ...base,
        article: 'B1',
        priceGroup: 'brakes',
        competitorPriceKop: 120_000,
        ourSupplierKop: 100_000,
        ourPriceKop: 128_000,
        capturedAt: new Date(now.getTime() - 10 * day),
      },
      // outside 28 days
      {
        ...base,
        article: 'OLD',
        priceGroup: 'filters',
        competitorPriceKop: 90_000,
        ourSupplierKop: 100_000,
        ourPriceKop: 128_000,
        capturedAt: new Date(now.getTime() - 40 * day),
      },
    ]);
    const pricing = (await supplier.settings.get()).pricing;
    const all = await loadAdminPrices(db, parseAdminPricesQuery({}), pricing, now);
    expect(all.rows.map((r) => r.article)).toEqual(['F1', 'F2', 'F3', 'B1']);
    expect(all.lastWeek).toBe(3);
    expect(all.periodRecords).toBe(4);
    expect(all.report.map((r) => r.group)).toEqual(['filters', 'brakes']);
    expect(all.report[0]?.local.hint).toEqual({ kind: 'raise', byBp: 1700, newDeltaBp: 1700 });
    expect(all.rows[0]?.diff).toEqual({ totalKop: 140_000, diffKop: -12_000, diffBp: -857 });

    const brakes = await loadAdminPrices(
      db,
      parseAdminPricesQuery({ group: 'brakes', days: '7' }),
      pricing,
      now,
    );
    expect(brakes.rows).toEqual([]);
    expect(brakes.report.map((r) => r.group)).toEqual(['filters']);
    const brakes28 = await loadAdminPrices(
      db,
      parseAdminPricesQuery({ group: 'brakes' }),
      pricing,
      now,
    );
    expect(brakes28.rows.map((r) => r.article)).toEqual(['B1']);
  });
});

describe('/admin/pricing: saving group adjustments', () => {
  function save(fields: Record<string, string>, invalidations?: { count: number }) {
    return handleAdminPricingAction(formRequest('/api/admin/pricing', fields), {
      db,
      env,
      invalidateSettings: () => {
        if (invalidations) invalidations.count += 1;
        supplier.settings.invalidate();
      },
      now: () => new Date('2026-10-08T05:00:00Z'),
    });
  }

  async function version(): Promise<string> {
    return (await loadAdminPricing(db, env, {}, new Date())).version;
  }

  it('writes settings and the audit, and the search prices follow at once', async () => {
    const before = await searchPrices();
    expect(before['OC90:Knecht:ORB1']).toBe(52_800);
    expect(before['OC90:Knecht:MSK7']).toBe(49_800);
    expect(before['W71275:MANN-FILTER:ORB1']).toBe(58_300);

    const invalidations = { count: 0 };
    const response = await save(
      {
        action: 'save',
        version: await version(),
        lbp_filters: '300',
        obp_filters: '200',
        confirm: 'on',
      },
      invalidations,
    );
    expect(response.status).toBe(303);
    expect(doneOf(response)).toBe('Сохранено: Фильтры: в Оренбурге +3, под заказ +2');
    expect(invalidations.count).toBe(1);
    const [row] = await db.select().from(settings).where(eq(settings.key, ADJUSTMENTS_KEY));
    expect(row).toMatchObject({
      value: [{ group: 'filters', localDeltaBp: 300, orderDeltaBp: 200 }],
      updatedBy: 'admin',
    });
    const audit = await db.select().from(settingsAudit).orderBy(asc(settingsAudit.changedAt));
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      key: ADJUSTMENTS_KEY,
      oldValue: [],
      newValue: [{ group: 'filters', localDeltaBp: 300, orderDeltaBp: 200 }],
      changedBy: 'admin',
    });

    // Exactly the formula: 412.50 ₽ × 1.31 -> 541 ₽; 389.00 ₽ × 1.30 -> 506 ₽.
    const adjusted = await searchPrices();
    expect(adjusted['OC90:Knecht:ORB1']).toBe(54_100);
    expect(adjusted['OC90:Knecht:MSK7']).toBe(50_600);

    // Removing the adjustment brings the prices back exactly.
    const back = await save({ action: 'save', version: await version(), confirm: 'on' });
    expect(doneOf(back)).toBe('Сохранено: без поправок');
    expect(await searchPrices()).toEqual(before);
    const [cleared] = await db.select().from(settings).where(eq(settings.key, ADJUSTMENTS_KEY));
    expect(cleared?.value).toEqual([]);
    expect(await db.select().from(settingsAudit)).toHaveLength(2);
  });

  it('refuses a stale version (another tab saved meanwhile) with 409', async () => {
    const stale = await version();
    await save({ action: 'save', version: stale, lbp_body: '100', confirm: 'on' });
    const conflict = await save({ action: 'save', version: stale, lbp_body: '500', confirm: 'on' });
    expect(conflict.status).toBe(409);
    const [row] = await db.select().from(settings).where(eq(settings.key, ADJUSTMENTS_KEY));
    expect(row?.value).toEqual([{ group: 'body', localDeltaBp: 100, orderDeltaBp: 0 }]);
    expect(await db.select().from(settingsAudit)).toHaveLength(1);
  });

  it.each<[string, Record<string, string>, number]>([
    ['without the tick', { lbp_filters: '300' }, 400],
    ['above 50 p.p.', { lbp_filters: '5001', confirm: 'on' }, 422],
    ['a fraction', { obp_filters: '2.5', confirm: 'on' }, 422],
    ['another action', { action: 'drop', confirm: 'on' }, 400],
  ])('refuses a save %s', async (_name, fields, status) => {
    const response = await save({ action: 'save', version: await version(), ...fields });
    expect(response.status).toBe(status);
    expect(await db.select().from(settingsAudit)).toEqual([]);
  });

  it('a save without changes writes nothing', async () => {
    const response = await save({ action: 'save', version: await version(), confirm: 'on' });
    expect(doneOf(response)).toBe('Без изменений');
    expect(await db.select().from(settingsAudit)).toEqual([]);
  });

  it('checks Basic auth and the Origin first', async () => {
    const foreign = await handleAdminPricingAction(
      formRequest(
        '/api/admin/pricing',
        { action: 'save', confirm: 'on' },
        { origin: 'https://evil.example' },
      ),
      { db, env },
    );
    expect(foreign.status).toBe(403);
    const anonymous = await handleAdminPricingAction(
      formRequest('/api/admin/pricing', { action: 'save' }, { authorization: '' }),
      { db, env },
    );
    expect(anonymous.status).toBe(401);
  });
});

describe('/admin/pricing: the page model', () => {
  it('shows the base table, the bounds, the draft and its preview on recent comparisons', async () => {
    await handleAdminPricesAction(formRequest('/api/admin/prices', KNECHT), pricesDeps());
    await handleAdminPricesAction(
      formRequest('/api/admin/prices', {
        ...KNECHT,
        brand: 'TRW',
        article: 'GDB1330',
        price: '2500',
      }),
      pricesDeps(),
    );
    const now = new Date();
    const plain = await loadAdminPricing(db, env, {}, now);
    expect(plain.draft).toBeNull();
    expect(plain.bounds).toEqual({
      configuredMinBp: 1000,
      marginFloorMarkupBp: 1112,
      minMarkupBp: 1112,
      maxMarkupBp: 6000,
    });
    expect(plain.config.markupRules).toHaveLength(3);
    expect(plain.version).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    const draft = await loadAdminPricing(
      db,
      env,
      { draft: '1', o_filters: '+2', l_filters: '3', o_brakes: '\u22121,5' },
      now,
    );
    expect(draft.draftConfig?.groupAdjustments).toEqual([
      { group: 'filters', localDeltaBp: 300, orderDeltaBp: 200 },
      { group: 'brakes', localDeltaBp: 0, orderDeltaBp: -150 },
    ]);
    // Both comparisons are to order (the cheapest offers): both change.
    expect(
      draft.examples.map((e) => [e.title, e.current.priceClientKop, e.draft.priceClientKop]),
    ).toEqual(
      expect.arrayContaining([
        ['Knecht OC90', 49_800, 50_600],
        // TRW at SPB3: 1712.40 ₽ × 1.265 -> 2167 ₽
        ['TRW GDB1330', 219_200, 216_700],
      ]),
    );
    const trw = draft.examples.find((e) => e.title === 'TRW GDB1330');
    expect(trw?.draft.markupBp).toBe(2650);

    const invalid = await loadAdminPricing(db, env, { draft: '1', l_filters: 'abc' }, now);
    expect(invalid.draftConfig).toBeNull();
    expect(invalid.draft?.fields.l_filters?.error).toBe('Число п.п., например +3 или \u22121,5');
  });
});
