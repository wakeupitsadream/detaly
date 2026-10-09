import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { testDatabaseUrl } from '@detaly/config/testing';
import { DOCUMENT_KINDS } from '@detaly/domain/statuses';
import { asc, eq, inArray, like } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type Db } from '../src/client';
import { documentVersions, excludedGroups, settings, staff } from '../src/schema';
import { isNoopSeed, seed } from '../src/seed';
import { EXCLUDED_SEED } from '../src/seed/excluded';
import { LegalSeedError, sha256Hex } from '../src/seed/legal';
import { testEnv } from '../src/testing';

let db: Db;

beforeAll(() => {
  db = createDb(testDatabaseUrl(), { max: 4 });
});

afterAll(async () => {
  await db?.close();
});

async function snapshot() {
  return {
    settings: await db.select().from(settings).orderBy(asc(settings.key)),
    staff: await db.select().from(staff).orderBy(asc(staff.id)),
    excluded: await db.select().from(excludedGroups).orderBy(asc(excludedGroups.id)),
    documents: await db.select().from(documentVersions).orderBy(asc(documentVersions.id)),
  };
}

describe('seed (globalSetup already ran it once)', () => {
  it('seeded every settings key, excluded keyword and legal draft', async () => {
    const rows = await db.select().from(settings);
    const byKey = Object.fromEntries(rows.map((r) => [r.key, r.value]));
    expect(Object.keys(byKey).sort()).toEqual(
      [
        'approval.timeout_h',
        'courier.fee_kop',
        'eta.buffer_days',
        'eta.supplier_invoice_lag_days',
        'fit_check.sla_minutes',
        'handed.complete_days',
        'handover.qr_ttl_min',
        'no_show.limit',
        'order.on_pickup_confirm_ttl_h',
        'order.on_pickup_max_total_kop',
        'order.payment_ttl_min',
        'pickup.window_cod_days',
        'pickup.window_prepaid_days',
        'pricing.drift_tolerance_pct',
        'pricing.group_adjustments',
        'pricing.margin_floor_pct',
        'pricing.markup_rules',
        'pricing.max_markup_bp',
        'pricing.min_markup_bp',
        'pricing.min_margin_kop',
        'pricing.min_order_total_kop',
        'reminder.days',
        'reviews.max_age_days',
        'reviews.min_count',
        'reviews.reminder_days',
        'rossko.local_stock_ids',
        'rossko.prepay_invoice',
        'supplier.return_days',
      ].sort(),
    );
    expect(byKey['pricing.markup_rules']).toEqual([
      { fromKop: 0, toKop: 100_000, localBp: 2800, orderBp: 2800 },
      { fromKop: 100_000, toKop: 500_000, localBp: 2800, orderBp: 2800 },
      { fromKop: 500_000, toKop: null, localBp: 2800, orderBp: 2800 },
    ]);
    expect(byKey['order.on_pickup_max_total_kop']).toBe(1_500_000);
    // step 2: no group adjustments, the floor and the ceiling of the adjustments in bp
    expect(byKey['pricing.group_adjustments']).toEqual([]);
    expect(byKey['pricing.min_markup_bp']).toBe(1000);
    expect(byKey['pricing.max_markup_bp']).toBe(6000);
    expect(byKey['reminder.days']).toEqual([3, 6, 9]);
    // step 3: the review reminder and the storefront rating line; no snapshot is seeded
    expect(byKey['reviews.reminder_days']).toBe(3);
    expect(byKey['reviews.min_count']).toBe(5);
    expect(byKey['reviews.max_age_days']).toBe(45);
    expect(byKey['reviews.snapshot']).toBeUndefined();
    // step 4: the master's SLA for fit checks, minutes of working time
    expect(byKey['fit_check.sla_minutes']).toBe(60);
    expect(byKey['rossko.prepay_invoice']).toBe(false);
    // Stored as real jsonb, not a JSON string.
    const [typed] = await db.$client<{ t: string }[]>`
      select jsonb_typeof(value) as t from settings where key = 'pricing.markup_rules'`;
    expect(typed?.t).toBe('array');

    const patterns = (await db.select().from(excludedGroups)).map((r) => r.pattern).sort();
    expect(patterns).toEqual(EXCLUDED_SEED.map((r) => r.pattern).sort());
    expect(patterns).not.toContain('масл');

    const docs = await db.select().from(documentVersions);
    for (const kind of DOCUMENT_KINDS) {
      const doc = docs.find((d) => d.kind === kind && d.version === '2026-10-d1');
      expect(doc, kind).toBeDefined();
      expect(doc?.publishedAt).toBeNull();
      expect(doc?.sha256).toBe(sha256Hex(doc!.bodyMd));
      expect(doc?.sourcePath).toBe(`legal/${kind}/2026-10-d1.md`);
    }
  });

  it('is idempotent: a second run changes nothing', async () => {
    const before = await snapshot();
    const report = await seed(db, testEnv());
    expect(isNoopSeed(report)).toBe(true);
    expect(await snapshot()).toEqual(before);
  });

  it('keeps admin edits of settings and excluded rules', async () => {
    await db
      .update(settings)
      .set({ value: 15, updatedBy: 'admin' })
      .where(eq(settings.key, 'pricing.margin_floor_pct'));
    await db
      .update(excludedGroups)
      .set({ active: false })
      .where(eq(excludedGroups.pattern, 'тосол'));
    try {
      const report = await seed(db, testEnv({ MARGIN_FLOOR_PCT: '12' }));
      expect(isNoopSeed(report)).toBe(true);
      const [margin] = await db
        .select()
        .from(settings)
        .where(eq(settings.key, 'pricing.margin_floor_pct'));
      expect(margin?.value).toBe(15);
      const [tosol] = await db
        .select()
        .from(excludedGroups)
        .where(eq(excludedGroups.pattern, 'тосол'));
      expect(tosol?.active).toBe(false);
    } finally {
      await db
        .update(settings)
        .set({ value: 10, updatedBy: 'seed' })
        .where(eq(settings.key, 'pricing.margin_floor_pct'));
      await db
        .update(excludedGroups)
        .set({ active: true })
        .where(eq(excludedGroups.pattern, 'тосол'));
    }
  });

  it('upserts staff from STAFF_SEED_JSON by Telegram id', async () => {
    const base = 8_000_000_000 + Math.floor(Math.random() * 1_000_000) * 10;
    const tgIds = [base + 1, base + 2];
    const maxOnly = base + 3;
    const json = (ownerName: string) =>
      JSON.stringify([
        { name: ownerName, role: 'owner', tgUserId: tgIds[0] },
        { name: 'Лёша', role: 'seller', tgUserId: tgIds[1], maxUserId: base + 4 },
        { name: 'Только MAX', role: 'seller', maxUserId: maxOnly },
      ]);
    try {
      const first = await seed(db, testEnv({ STAFF_SEED_JSON: json('Максим') }));
      expect(first.staff).toEqual({ inserted: 3, updated: 0 });

      const again = await seed(db, testEnv({ STAFF_SEED_JSON: json('Максим') }));
      expect(isNoopSeed(again)).toBe(true);

      const renamed = await seed(db, testEnv({ STAFF_SEED_JSON: json('Максим Б.') }));
      expect(renamed.staff).toEqual({ inserted: 0, updated: 1 });

      const rows = await db.select().from(staff).where(inArray(staff.tgUserId, tgIds));
      expect(rows.map((r) => [r.name, r.role, r.isActive]).sort()).toEqual(
        [
          ['Максим Б.', 'owner', true],
          ['Лёша', 'seller', true],
        ].sort(),
      );
      const [maxRow] = await db.select().from(staff).where(eq(staff.maxUserId, maxOnly));
      expect(maxRow?.tgUserId).toBeNull();
    } finally {
      await db.delete(staff).where(inArray(staff.tgUserId, tgIds));
      await db.delete(staff).where(eq(staff.maxUserId, maxOnly));
    }
  });
});

describe('legal documents', () => {
  let dir: string;
  const version = `test-${Date.now().toString(36)}`;
  const file = () => path.join(dir, 'offer', `${version}.md`);
  const write = (body: string, title = 'Оферта {{BRAND_NAME}}') =>
    writeFile(file(), `---\ntitle: ${title}\nkind: offer\nversion: ${version}\n---\n\n${body}`);
  const requisites = {
    BRAND_NAME: 'Тестовый бренд',
    SELLER_REQUISITES_NAME: 'Тестов Т. Т.',
    SELLER_REQUISITES_INN: '123456789012',
  };

  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'detaly-legal-'));
    await mkdir(path.join(dir, 'offer'));
    await mkdir(path.join(dir, 'privacy'));
  });

  afterAll(async () => {
    await db.delete(documentVersions).where(like(documentVersions.version, 'test-%'));
    await rm(dir, { recursive: true, force: true });
  });

  it('publishes the selected version with requisites substituted and hashed', async () => {
    await write('Продавец: {{SELLER_NAME}}, ИНН {{ SELLER_INN }}.\r\nБренд: {{BRAND_NAME}}.\n');
    const env = testEnv({ ...requisites, LEGAL_OFFER_VERSION: version });
    const report = await seed(db, env, { legalDir: dir });
    expect(report.legal.inserted).toEqual([`offer/${version}`]);
    expect(report.legal.published).toEqual([`offer/${version}`]);

    const [doc] = await db
      .select()
      .from(documentVersions)
      .where(eq(documentVersions.version, version));
    expect(doc?.title).toBe('Оферта Тестовый бренд');
    expect(doc?.bodyMd).toBe('Продавец: Тестов Т. Т., ИНН 123456789012.\nБренд: Тестовый бренд.\n');
    expect(doc?.sha256).toBe(sha256Hex(doc!.bodyMd));
    expect(doc?.publishedAt).toBeInstanceOf(Date);

    const again = await seed(db, env, { legalDir: dir });
    expect(isNoopSeed(again)).toBe(true);
  });

  it('fails when the text of a published version changes, and rolls back the whole seed', async () => {
    await write('Продавец: {{SELLER_NAME}}, ИНН {{SELLER_INN}}. Новый пункт.\n');
    const tgUserId = 7_000_000_000 + Math.floor(Math.random() * 1_000_000);
    const env = testEnv({
      ...requisites,
      LEGAL_OFFER_VERSION: version,
      STAFF_SEED_JSON: JSON.stringify([{ name: 'Откат', role: 'seller', tgUserId }]),
    });
    const error = await seed(db, env, { legalDir: dir }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(LegalSeedError);
    expect((error as LegalSeedError).message).toMatch(/offer\/test-.*text changed/);
    // Same failure when only the requisites in env change.
    await write('Продавец: {{SELLER_NAME}}, ИНН {{ SELLER_INN }}.\r\nБренд: {{BRAND_NAME}}.\n');
    await expect(
      seed(
        db,
        testEnv({
          ...requisites,
          SELLER_REQUISITES_INN: '1234567890',
          LEGAL_OFFER_VERSION: version,
        }),
        {
          legalDir: dir,
        },
      ),
    ).rejects.toThrow(LegalSeedError);
    // Nothing from the failed runs was written.
    expect(await db.select().from(staff).where(eq(staff.tgUserId, tgUserId))).toHaveLength(0);
    // Publication stays even when the env no longer selects the version.
    const [doc] = await db
      .select()
      .from(documentVersions)
      .where(eq(documentVersions.version, version));
    expect(doc?.publishedAt).toBeInstanceOf(Date);
  });

  it('updates drafts in place and marks missing requisites', async () => {
    const draft = `${version}-draft`;
    const draftFile = path.join(dir, 'privacy', `${draft}.md`);
    await writeFile(
      draftFile,
      `---\ntitle: Политика\nkind: privacy\nversion: ${draft}\n---\nАдрес: {{PICKUP_ADDRESS}}\n`,
    );
    const env = testEnv({ ...requisites, LEGAL_OFFER_VERSION: version });
    const first = await seed(db, env, { legalDir: dir });
    expect(first.legal.inserted).toEqual([`privacy/${draft}`]);
    const [row] = await db
      .select()
      .from(documentVersions)
      .where(eq(documentVersions.version, draft));
    expect(row?.bodyMd).toBe('Адрес: [не задано: PICKUP_ADDRESS]\n');
    expect(row?.publishedAt).toBeNull();

    const second = await seed(
      db,
      testEnv({ ...requisites, PICKUP_ADDRESS: 'Оренбург, ул. Тестовая, 1' }),
      {
        legalDir: dir,
      },
    );
    expect(second.legal.updated).toEqual([`privacy/${draft}`]);
    const [updated] = await db
      .select()
      .from(documentVersions)
      .where(eq(documentVersions.version, draft));
    expect(updated?.bodyMd).toBe('Адрес: Оренбург, ул. Тестовая, 1\n');
    expect(updated?.id).toBe(row?.id);
    await rm(draftFile);
  });

  it('refuses to publish without requisites, a missing version or an unknown placeholder', async () => {
    const next = `${version}-2`;
    const nextFile = path.join(dir, 'offer', `${next}.md`);
    await writeFile(
      nextFile,
      `---\ntitle: Оферта\nkind: offer\nversion: ${next}\n---\nИНН {{SELLER_INN}}\n`,
    );
    await expect(
      seed(db, testEnv({ LEGAL_OFFER_VERSION: next }), { legalDir: dir }),
    ).rejects.toThrow(/SELLER_REQUISITES_INN is required to publish/);
    await expect(
      seed(db, testEnv({ ...requisites, LEGAL_PRIVACY_VERSION: 'nope' }), { legalDir: dir }),
    ).rejects.toThrow(/LEGAL_PRIVACY_VERSION=nope: no file privacy\/nope\.md/);
    await writeFile(
      nextFile,
      `---\ntitle: Оферта\nkind: offer\nversion: ${next}\n---\n{{SELLER_KPP}}\n`,
    );
    await expect(seed(db, testEnv(requisites), { legalDir: dir })).rejects.toThrow(
      /unknown placeholder \{\{SELLER_KPP\}\}/,
    );
    await rm(nextFile);
    expect(
      await db.select().from(documentVersions).where(eq(documentVersions.version, next)),
    ).toHaveLength(0);
  });
});
