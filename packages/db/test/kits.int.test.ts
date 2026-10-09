// Step 5 (docs/kits.md): kits and kit_lines constraints (migration 0008).
import { testDatabaseUrl } from '@detaly/config/testing';
import { asc, eq } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type Db } from '../src/client';
import { kitLines, kits } from '../src/schema';
import { expectPgError } from './helpers';

const CHECK = '23514';
const UNIQUE = '23505';
const FOREIGN_KEY = '23503';

let db: Db;

beforeAll(() => {
  db = createDb(testDatabaseUrl(), { max: 4 });
});

afterAll(async () => {
  await db?.close();
});

type KitInsert = typeof kits.$inferInsert;
type LineInsert = typeof kitLines.$inferInsert;

/** A unique model per call, so the slug constraint never meets another test's row. */
function kit(over: Partial<KitInsert> = {}): KitInsert {
  const model = `m-${uuidv7().slice(-12)}`;
  return {
    makeSlug: 'lada',
    model: 'Vesta',
    modelSlug: model,
    engine: '1.6 16V, 106 л.с.',
    yearsFrom: 2015,
    yearsTo: null,
    slug: '1-6-16v',
    createdBy: 'admin',
    updatedBy: 'admin',
    ...over,
  };
}

async function insertKit(over: Partial<KitInsert> = {}) {
  const [row] = await db.insert(kits).values(kit(over)).returning();
  if (!row) throw new Error('kit not inserted');
  return row;
}

function line(kitId: string, over: Partial<LineInsert> = {}): LineInsert {
  return { kitId, position: 1, brand: 'MANN', article: 'W914/2', qty: 1, ...over };
}

describe('kits', () => {
  it('stores a draft with a uuid v7 id, the times and no publication', async () => {
    const row = await insertKit();
    expect(row.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(row.status).toBe('draft');
    expect(row.publishedAt).toBeNull();
    expect(row.createdAt).toBeInstanceOf(Date);
    expect(row.updatedAt).toBeInstanceOf(Date);
    await db.delete(kits).where(eq(kits.id, row.id));
  });

  it('a published kit has its publication time, a draft has none', async () => {
    const row = await insertKit({ status: 'published', publishedAt: new Date() });
    expect(row.status).toBe('published');
    await expectPgError(
      db.update(kits).set({ status: 'draft' }).where(eq(kits.id, row.id)),
      CHECK,
      'kits_published_at_check',
    );
    await expectPgError(insertKit({ status: 'published' }), CHECK, 'kits_published_at_check');
    await expectPgError(
      insertKit({ status: 'draft', publishedAt: new Date() }),
      CHECK,
      'kits_published_at_check',
    );
    await db.delete(kits).where(eq(kits.id, row.id));
  });

  it('one slug per make and model; another model or make may reuse it', async () => {
    const first = await insertKit();
    await expectPgError(
      insertKit({ modelSlug: first.modelSlug }),
      UNIQUE,
      'kits_make_slug_model_slug_slug_unique',
    );
    const other = await insertKit({ modelSlug: first.modelSlug, makeSlug: 'hyundai' });
    const second = await insertKit({ modelSlug: first.modelSlug, slug: '1-6-16v-2019' });
    await db.delete(kits).where(eq(kits.modelSlug, first.modelSlug));
    expect([other.slug, second.slug]).toEqual(['1-6-16v', '1-6-16v-2019']);
  });

  it.each<[string, Partial<KitInsert>, string]>([
    ['an unknown status', { status: 'hidden' }, 'kits_status_check'],
    ['a make slug with capitals', { makeSlug: 'Lada' }, 'kits_make_slug_check'],
    ['a make slug with spaces', { makeSlug: 'land rover' }, 'kits_make_slug_check'],
    ['a model slug ending with a hyphen', { modelSlug: 'vesta-' }, 'kits_model_slug_check'],
    ['a kit slug with a dot', { slug: '1.6' }, 'kits_slug_check'],
    ['a long kit slug', { slug: 'a'.repeat(65) }, 'kits_slug_check'],
    ['an empty model', { model: '  ' }, 'kits_model_check'],
    ['a long model', { model: 'x'.repeat(61) }, 'kits_model_check'],
    ['an empty engine', { engine: '' }, 'kits_engine_check'],
    ['a long engine', { engine: 'x'.repeat(81) }, 'kits_engine_check'],
    ['a year before 1970', { yearsFrom: 1969 }, 'kits_years_from_check'],
    ['the last year before the first', { yearsFrom: 2015, yearsTo: 2014 }, 'kits_years_to_check'],
    ['an empty note', { note: '' }, 'kits_note_check'],
    ['a long note', { note: 'x'.repeat(301) }, 'kits_note_check'],
    ['nobody created it', { createdBy: ' ' }, 'kits_created_by_check'],
    ['nobody updated it', { updatedBy: '' }, 'kits_updated_by_check'],
  ])('refuses %s', async (_what, over, constraint) => {
    await expectPgError(insertKit(over), CHECK, constraint);
  });
});

describe('kit_lines', () => {
  it('main lines and alternatives of the same kit; a removed kit takes its lines along', async () => {
    const row = await insertKit();
    const [main] = await db
      .insert(kitLines)
      .values(line(row.id, { role: 'Фильтр масляный' }))
      .returning();
    if (!main) throw new Error('line not inserted');
    await db
      .insert(kitLines)
      .values(
        line(row.id, { position: 2, brand: 'KNECHT', article: 'OC90', alternativeOf: main.id }),
      );
    const stored = await db
      .select()
      .from(kitLines)
      .where(eq(kitLines.kitId, row.id))
      .orderBy(asc(kitLines.position));
    expect(stored.map((l) => [l.position, l.role, l.alternativeOf])).toEqual([
      [1, 'Фильтр масляный', null],
      [2, null, main.id],
    ]);
    await db.delete(kits).where(eq(kits.id, row.id));
    expect(await db.select().from(kitLines).where(eq(kitLines.kitId, row.id))).toEqual([]);
  });

  it('removing a main line removes its alternatives', async () => {
    const row = await insertKit();
    const [main] = await db.insert(kitLines).values(line(row.id)).returning();
    if (!main) throw new Error('line not inserted');
    await db
      .insert(kitLines)
      .values([
        line(row.id, { position: 2, brand: 'KNECHT', article: 'OC90', alternativeOf: main.id }),
        line(row.id, { position: 3, brand: 'NGK', article: 'BKR6E', qty: 4 }),
      ]);
    await db.delete(kitLines).where(eq(kitLines.id, main.id));
    const left = await db.select().from(kitLines).where(eq(kitLines.kitId, row.id));
    expect(left.map((l) => l.position)).toEqual([3]);
    await db.delete(kits).where(eq(kits.id, row.id));
  });

  it('an alternative stays inside its kit', async () => {
    const one = await insertKit();
    const two = await insertKit();
    const [main] = await db.insert(kitLines).values(line(one.id)).returning();
    if (!main) throw new Error('line not inserted');
    await expectPgError(
      db.insert(kitLines).values(line(two.id, { alternativeOf: main.id })),
      FOREIGN_KEY,
      'kit_lines_alternative_of_fk',
    );
    await expectPgError(
      db.insert(kitLines).values(line(one.id, { position: 2, alternativeOf: uuidv7() })),
      FOREIGN_KEY,
      'kit_lines_alternative_of_fk',
    );
    await db.delete(kits).where(eq(kits.id, one.id));
    await db.delete(kits).where(eq(kits.id, two.id));
  });

  it('one line per position of a kit', async () => {
    const row = await insertKit();
    await db.insert(kitLines).values(line(row.id));
    await expectPgError(
      db.insert(kitLines).values(line(row.id, { brand: 'KNECHT', article: 'OC90' })),
      UNIQUE,
      'kit_lines_kit_id_position_unique',
    );
    await db.delete(kits).where(eq(kits.id, row.id));
  });

  it.each<[string, Partial<LineInsert>, string]>([
    ['position 0', { position: 0 }, 'kit_lines_position_check'],
    ['quantity 0', { qty: 0 }, 'kit_lines_qty_check'],
    ['quantity 100', { qty: 100 }, 'kit_lines_qty_check'],
    ['an empty brand', { brand: ' ' }, 'kit_lines_brand_check'],
    ['a long brand', { brand: 'B'.repeat(65) }, 'kit_lines_brand_check'],
    ['an empty article', { article: '' }, 'kit_lines_article_check'],
    ['an empty role', { role: '  ' }, 'kit_lines_role_check'],
    ['a long role', { role: 'Р'.repeat(61) }, 'kit_lines_role_check'],
  ])('refuses %s', async (_what, over, constraint) => {
    const row = await insertKit();
    await expectPgError(db.insert(kitLines).values(line(row.id, over)), CHECK, constraint);
    await db.delete(kits).where(eq(kits.id, row.id));
  });

  it('a line is not its own alternative', async () => {
    const row = await insertKit();
    const id = uuidv7();
    await expectPgError(
      db.insert(kitLines).values(line(row.id, { id, alternativeOf: id })),
      CHECK,
      'kit_lines_alternative_of_check',
    );
    await db.delete(kits).where(eq(kits.id, row.id));
  });
});
