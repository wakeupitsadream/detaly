// Step 5 (docs/kits.md): /admin/kits against PG and Redis with the Rossko fixtures — the lines in
// the VIN-answer format, the roles from the supplier, the publish rule (an unknown article or a
// marked good is refused, an alternative the supplier lacks is fine), the version check, delete
// of drafts only, and the read models of the list and the editor. A database of its own
// (`<web db>_kits`): the storefront tests count published kits in theirs.
import { createRedis, type Redis } from '@detaly/config';
import { deleteKeysByPrefix, testKeyPrefix, testRedisUrl } from '@detaly/config/testing';
import { asc, createDb, eq, kitLines, kits, type Db } from '@detaly/db';
import { prepareTestDb } from '@detaly/db/testing';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { handleAdminKitsAction, type AdminKitsDeps } from '@/server/admin/kits-handler';
import {
  checkKitDraft,
  kitFormOf,
  kitFormValues,
  loadAdminKits,
  readKitDraft,
} from '@/server/admin/kits';
import { loadKit, loadPublishedKits } from '@/server/kits/catalog';
import { createSupplierDeps, type Supplier } from '@/server/supplier';
import { intEnv, webDatabaseUrl } from './helpers';

const APP = 'http://127.0.0.1:3100';
const ADMIN = 'admin:kits-test-password';
const AUTH = `Basic ${Buffer.from(ADMIN, 'utf8').toString('base64')}`;
const env = intEnv({ ADMIN_BASIC_AUTH: ADMIN, APP_BASE_URL: APP });
const NOW = new Date('2026-10-08T05:00:00Z');

let db: Db;
let redis: Redis;
let supplier: Supplier;
const prefixes: string[] = [];
let invalidated = 0;

beforeAll(async () => {
  const base = new URL(webDatabaseUrl());
  base.pathname = `${base.pathname}_kits`;
  const { url } = await prepareTestDb({ url: base.toString() });
  db = createDb(url, { max: 4 });
  redis = createRedis(testRedisUrl());
});

beforeEach(async () => {
  const prefix = testKeyPrefix();
  prefixes.push(prefix);
  supplier = createSupplierDeps({ env, db, redis, keyPrefix: prefix });
  invalidated = 0;
  await db.delete(kits);
});

afterEach(async () => {
  for (const prefix of prefixes.splice(0)) await deleteKeysByPrefix(redis, prefix);
});

afterAll(async () => {
  await redis?.quit();
  await db?.close();
});

function deps(overrides: Partial<AdminKitsDeps> = {}): AdminKitsDeps {
  return {
    db,
    env,
    supplier: { rossko: supplier.rossko, settings: supplier.settings },
    invalidateCatalog: () => {
      invalidated += 1;
    },
    now: () => NOW,
    ...overrides,
  };
}

function post(fields: Record<string, string>, headers: Record<string, string> = {}): Request {
  const all: Record<string, string> = {
    'content-type': 'application/x-www-form-urlencoded',
    origin: APP,
    authorization: AUTH,
    ...headers,
  };
  for (const [key, value] of Object.entries(all)) if (value === '') delete all[key];
  return new Request(`${APP}/api/admin/kits`, {
    method: 'POST',
    headers: all,
    body: new URLSearchParams(fields).toString(),
  });
}

const VESTA = {
  make: 'lada',
  model: 'Vesta',
  engine: '1.6 16V, 106 л.с.',
  years_from: '2015',
  years_to: '',
  note: 'замена ≈ 1 ч',
  lines: [
    'MANN W914/2 1 — Фильтр масляный',
    'или KNECHT OC90',
    'MANN C26003 1',
    'NGK BKR6E 4 — Свечи зажигания',
    'или BOSCH FR7DCX+',
  ].join('\n'),
};

function location(response: Response): URL {
  return new URL(response.headers.get('location') ?? '', APP);
}

async function save(fields: Record<string, string> = {}): Promise<Response> {
  return handleAdminKitsAction(post({ action: 'save', ...VESTA, ...fields }), deps());
}

/** Saves the Vesta kit and returns its id and version. */
async function savedKit(
  fields: Record<string, string> = {},
): Promise<{ id: string; version: string }> {
  const response = await save(fields);
  expect(response.status).toBe(303);
  const id = /\/admin\/kits\/([0-9a-f-]{36})$/.exec(location(response).pathname)?.[1];
  if (!id) throw new Error(`not saved: ${location(response).toString()}`);
  const kit = await loadKit(db, id);
  return { id, version: kit!.version };
}

async function action(
  name: 'publish' | 'unpublish' | 'delete',
  kit: { id: string; version: string },
  extra: Record<string, string> = {},
): Promise<Response> {
  return handleAdminKitsAction(
    post({ action: name, id: kit.id, version: kit.version, ...extra }),
    deps(),
  );
}

describe('POST /api/admin/kits: the gate', () => {
  it('asks for the password, refuses a foreign origin and an unknown action', async () => {
    const anonymous = await handleAdminKitsAction(
      post({ action: 'save' }, { authorization: '' }),
      deps(),
    );
    expect(anonymous.status).toBe(401);
    const foreign = await handleAdminKitsAction(
      post({ action: 'save', ...VESTA }, { origin: 'https://evil.example' }),
      deps(),
    );
    expect(foreign.status).toBe(403);
    const unknown = await handleAdminKitsAction(post({ action: 'publish-all' }), deps());
    expect(unknown.status).toBe(400);
    const noAdmin = await handleAdminKitsAction(
      post({ action: 'save', ...VESTA }),
      deps({ env: { ...env, ADMIN_BASIC_AUTH: undefined } }),
    );
    expect(noAdmin.status).toBe(404);
    expect(await db.select().from(kits)).toEqual([]);
  });
});

describe('save', () => {
  it('stores the header and the lines: alternatives linked, roles from the supplier, a draft', async () => {
    const response = await save();
    expect(response.status).toBe(303);
    expect(location(response).searchParams.get('done')).toBe('Сохранено');
    expect(invalidated).toBe(1);
    const [row] = await db.select().from(kits);
    expect(row).toMatchObject({
      makeSlug: 'lada',
      model: 'Vesta',
      modelSlug: 'vesta',
      engine: '1.6 16V, 106 л.с.',
      yearsFrom: 2015,
      yearsTo: null,
      slug: '1-6-16v',
      note: 'замена ≈ 1 ч',
      status: 'draft',
      publishedAt: null,
      createdBy: 'admin',
      updatedBy: 'admin',
    });
    const lines = await db
      .select()
      .from(kitLines)
      .where(eq(kitLines.kitId, row!.id))
      .orderBy(asc(kitLines.position));
    expect(
      lines.map((line) => [line.position, line.brand, line.article, line.qty, line.role]),
    ).toEqual([
      [1, 'MANN', 'W914/2', 1, 'Фильтр масляный'],
      [2, 'KNECHT', 'OC90', 1, null],
      // no role typed: the supplier's name of the part
      [3, 'MANN', 'C26003', 1, 'Фильтр воздушный'],
      [4, 'NGK', 'BKR6E', 4, 'Свечи зажигания'],
      // an alternative takes the main line's quantity
      [5, 'BOSCH', 'FR7DCX+', 4, null],
    ]);
    expect(lines[1]?.alternativeOf).toBe(lines[0]?.id);
    expect(lines[4]?.alternativeOf).toBe(lines[3]?.id);
    expect(lines[2]?.alternativeOf).toBeNull();
  });

  it('a field or a line that cannot be read goes back with the draft and saves nothing', async () => {
    const response = await save({ make: 'zaz', lines: `${VESTA.lines}\nMANN` });
    expect(response.status).toBe(303);
    const back = location(response);
    expect(back.pathname).toBe('/admin/kits/new');
    expect(back.searchParams.get('check')).toBe('1');
    expect(back.searchParams.get('error')).toBe(
      'Не сохранено: исправьте поля и строки, отмеченные ниже',
    );
    // the draft travels back whole
    expect(back.searchParams.get('lines')).toBe(`${VESTA.lines}\nMANN`);
    expect(back.searchParams.get('model')).toBe('Vesta');
    expect(await db.select().from(kits)).toEqual([]);
    expect(invalidated).toBe(0);
    // the editor reads the same draft from the query and shows the reasons
    const values = kitFormValues((name) => back.searchParams.get(name));
    const draft = readKitDraft(values, NOW);
    expect(draft.fieldErrors.make).toBe('Выберите марку из списка');
    expect(draft.lineErrors).toEqual([
      {
        line: 6,
        raw: 'MANN',
        message: 'Нужно «БРЕНД АРТИКУЛ [КОЛ-ВО]», например «MANN W914/2 1»',
      },
    ]);
  });

  it('an empty lines field is refused', async () => {
    const response = await save({ lines: '# только комментарий' });
    expect(location(response).searchParams.get('error')).toContain('Не сохранено');
    expect(await db.select().from(kits)).toEqual([]);
  });

  it('a second kit of the model gets a slug of its own; the engine of a draft moves its slug', async () => {
    const first = await savedKit();
    const second = await savedKit({ engine: '1.6 16V, 113 л.с.', years_from: '2019' });
    const rows = await db.select({ id: kits.id, slug: kits.slug }).from(kits);
    expect(new Map(rows.map((row) => [row.id, row.slug]))).toEqual(
      new Map([
        [first.id, '1-6-16v'],
        [second.id, '1-6-16v-113-l-s'],
      ]),
    );
    const resaved = await handleAdminKitsAction(
      post({
        action: 'save',
        ...VESTA,
        engine: '1.8 16V, 122 л.с.',
        id: first.id,
        version: first.version,
      }),
      deps(),
    );
    expect(resaved.status).toBe(303);
    expect((await loadKit(db, first.id))?.slug).toBe('1-8-16v');
  });

  it('a stale version is a conflict (another tab saved meanwhile)', async () => {
    const kit = await savedKit();
    const fresh = await handleAdminKitsAction(
      post({ action: 'save', ...VESTA, note: '', id: kit.id, version: kit.version }),
      deps({ now: () => new Date(NOW.getTime() + 60_000) }),
    );
    expect(fresh.status).toBe(303);
    const stale = await handleAdminKitsAction(
      post({ action: 'save', ...VESTA, note: 'старая вкладка', id: kit.id, version: kit.version }),
      deps(),
    );
    expect(stale.status).toBe(409);
    expect((await loadKit(db, kit.id))?.note).toBeNull();
    expect(await action('publish', kit).then((r) => r.status)).toBe(409);
  });
});

describe('publish, unpublish, delete', () => {
  it('publishes a kit whose main lines are all on offer; an alternative may be missing', async () => {
    const kit = await savedKit({ lines: `${VESTA.lines}\nили ACME NOPE123` });
    const response = await action('publish', kit);
    expect(response.status).toBe(303);
    expect(location(response).searchParams.get('done')).toBe(
      'Опубликовано: /to/lada/vesta#1-6-16v',
    );
    const row = await loadKit(db, kit.id);
    expect(row?.status).toBe('published');
    expect(row?.publishedAt?.toISOString()).toBe(NOW.toISOString());
    expect(invalidated).toBe(2);
    expect((await loadPublishedKits(db)).map((k) => k.id)).toEqual([kit.id]);
  });

  it('refuses an unknown article in a main line', async () => {
    const kit = await savedKit({ lines: `${VESTA.lines}\nACME NOPE123 1 — Фильтр топливный` });
    const response = await action('publish', kit);
    expect(response.status).toBe(303);
    const back = location(response);
    expect(back.pathname).toBe(`/admin/kits/${kit.id}`);
    expect(back.searchParams.get('error')).toBe('Не опубликовано: Строка 6: нет у поставщика');
    expect((await loadKit(db, kit.id))?.status).toBe('draft');
  });

  it('refuses marked goods anywhere in the kit, an alternative included', async () => {
    const main = await savedKit({ lines: `${VESTA.lines}\nCASTROL EDGE5W40 1 — Масло` });
    const refused = await action('publish', main);
    expect(location(refused).searchParams.get('error')).toBe(
      'Не опубликовано: Строка 6: маркируемый товар — в набор нельзя',
    );
    await db.delete(kits);
    const alternative = await savedKit({
      lines: 'MANN W914/2 1 — Фильтр масляный\nили CASTROL EDGE5W40 1',
    });
    const alsoRefused = await action('publish', alternative);
    expect(location(alsoRefused).searchParams.get('error')).toBe(
      'Не опубликовано: Строка 2: маркируемый товар — в набор нельзя',
    );
    expect(await loadPublishedKits(db)).toEqual([]);
  });

  it('a published kit is saved only with lines it could be published with', async () => {
    const kit = await savedKit();
    await action('publish', kit);
    const published = await loadKit(db, kit.id);
    const broken = await handleAdminKitsAction(
      post({
        action: 'save',
        ...VESTA,
        lines: `${VESTA.lines}\nACME NOPE123 1`,
        id: kit.id,
        version: published!.version,
      }),
      deps({ now: () => new Date(NOW.getTime() + 60_000) }),
    );
    expect(location(broken).searchParams.get('error')).toContain(
      'Набор опубликован — сохраняется только состав, с которым его можно показывать: Строка 6: нет у поставщика',
    );
    expect((await loadKit(db, kit.id))?.lines).toHaveLength(5);
    const fine = await handleAdminKitsAction(
      post({
        action: 'save',
        ...VESTA,
        engine: '1.6 16V, 106 л.с. (21129)',
        lines: 'MANN W914/2 1 — Фильтр масляный',
        id: kit.id,
        version: published!.version,
      }),
      deps({ now: () => new Date(NOW.getTime() + 120_000) }),
    );
    expect(location(fine).searchParams.get('done')).toBe('Сохранено, набор на сайте обновлён');
    const after = await loadKit(db, kit.id);
    // still on the site, at the same address
    expect(after).toMatchObject({ status: 'published', slug: '1-6-16v' });
    expect(after?.lines).toHaveLength(1);
  });

  it('unpublish takes it off the site; delete takes only drafts and needs the tick', async () => {
    const kit = await savedKit();
    await action('publish', kit);
    const published = await loadKit(db, kit.id);
    const tryDelete = await action('delete', published!, { confirm: 'on' });
    expect(tryDelete.status).toBe(409);
    const unpublish = await action('unpublish', published!);
    expect(location(unpublish).searchParams.get('done')).toBe(
      'Снят с публикации: на сайте его больше нет',
    );
    const draft = await loadKit(db, kit.id);
    expect(draft).toMatchObject({ status: 'draft', publishedAt: null });
    expect(await loadPublishedKits(db)).toEqual([]);
    const noTick = await action('delete', draft!);
    expect(noTick.status).toBe(400);
    const deleted = await action('delete', draft!, { confirm: 'on' });
    expect(location(deleted).pathname).toBe('/admin/kits');
    expect(location(deleted).searchParams.get('done')).toBe('Набор удалён');
    expect(await db.select().from(kits)).toEqual([]);
    expect(await db.select().from(kitLines)).toEqual([]);
  });

  it('an unknown kit is a 404', async () => {
    const missing = await handleAdminKitsAction(
      post({ action: 'publish', id: '01900000-0000-7000-8000-000000000000', version: 'x' }),
      deps(),
    );
    expect(missing.status).toBe(404);
    const bad = await handleAdminKitsAction(
      post({ action: 'publish', id: 'nope', version: 'x' }),
      deps(),
    );
    expect(bad.status).toBe(404);
  });
});

describe('read models', () => {
  it('the list: make, model, engine, years, status, lines and who changed it', async () => {
    const kit = await savedKit();
    await savedKit({
      make: 'hyundai',
      model: 'Solaris',
      engine: '1.6',
      years_from: '2017',
      years_to: '2022',
      lines: 'KNECHT OC90 1',
    });
    await action('publish', kit);
    const rows = await loadAdminKits(db);
    expect(
      rows.map((row) => [
        row.makeName,
        row.model,
        row.engine,
        row.years,
        row.status,
        row.mainLines,
        row.alternatives,
        row.updatedBy,
      ]),
    ).toEqual([
      ['Hyundai', 'Solaris', '1.6', '2017–2022', 'draft', 1, 0, 'admin'],
      ['Lada', 'Vesta', '1.6 16V, 106 л.с.', 'с 2015 г.', 'published', 3, 2, 'admin'],
    ]);
  });

  it('the editor: the saved kit back in the text format and its live check', async () => {
    const kit = await savedKit({ lines: `${VESTA.lines}\nCASTROL EDGE5W40 1\nACME NOPE123 1` });
    const record = await loadKit(db, kit.id);
    const values = kitFormOf(record!);
    expect(values.lines).toBe(
      [
        'MANN W914/2 1 — Фильтр масляный',
        'или KNECHT OC90 1',
        'MANN C26003 1 — Фильтр воздушный',
        'NGK BKR6E 4 — Свечи зажигания',
        'или BOSCH FR7DCX+ 4',
        // no role: neither is on offer to take a name from
        'CASTROL EDGE5W40 1',
        'ACME NOPE123 1',
      ].join('\n'),
    );
    const check = await checkKitDraft(readKitDraft(values, NOW), {
      rossko: supplier.rossko,
      settings: await supplier.settings.get(),
      now: NOW,
    });
    expect(check.lines.map((line) => [line.line, line.state])).toEqual([
      [1, 'ok'],
      [2, 'ok'],
      [3, 'ok'],
      [4, 'ok'],
      [5, 'ok'],
      [6, 'excluded'],
      [7, 'unavailable'],
    ]);
    expect(check.problems).toEqual([
      'Строка 6: маркируемый товар — в набор нельзя',
      'Строка 7: нет у поставщика',
    ]);
    // 798 + 884 + 4 × 314 ₽: the main lines on offer
    expect(check.totalText).toBe('2 938 ₽');
    expect(check.lines[0]?.offer).toMatchObject({
      title: 'MANN-FILTER W 914/2',
      priceText: '798 ₽',
      supplierPriceText: '623,40 ₽',
    });
  });
});
