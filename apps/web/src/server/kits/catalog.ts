/**
 * Step 5 (docs/kits.md): the maintenance kits as the storefront reads them — the published ones
 * for /to, /to/<make>, /to/<make>/<model>, the make tiles of the home page, the footer link and
 * the sitemap. A kit is public only once staff published it; nothing here invents a kit.
 *
 * The list is small (tens of kits), so it is read whole and kept for a minute in the process
 * (single-flight, like the rating line of step 3); the admin drops it after every save. A
 * database failure keeps the last good list or gives null (pages then fail, the home tiles and
 * the footer show no kits). DEMO_MODE has no database: the two sample kits of demo-kits.ts,
 * marked as samples, are the whole catalogue.
 *
 * No prices here: the kit page prices every line from the supplier search of the moment
 * (kit-view.ts).
 */
import { and, asc, eq, inArray, kitLines, kits, type Executor } from '@detaly/db';
import type { KitStatus } from '@detaly/domain';
import { CAR_BRANDS, type CarBrand } from '@/lib/brands';
import { getDb } from '../db';
import { singleton } from '../globals';
import { getLogger } from '../logger';
import { isDemoMode } from '../mode';
import { DEMO_KITS } from './demo-kits';

export interface KitLineRecord {
  id: string;
  /** 1-based order inside the kit. */
  position: number;
  /** «Фильтр масляный»; null: the supplier's offer name stands in. */
  role: string | null;
  /** As the master typed them. */
  brand: string;
  article: string;
  qty: number;
  /** The main line this one is an alternative of; null for a main line. */
  alternativeOf: string | null;
}

export interface KitRecord {
  id: string;
  makeSlug: string;
  model: string;
  modelSlug: string;
  engine: string;
  yearsFrom: number;
  yearsTo: number | null;
  slug: string;
  note: string | null;
  status: KitStatus;
  publishedAt: Date | null;
  updatedAt: Date;
  /** The version a form carries (kits.updated_at as ISO; a constant for a sample). */
  version: string;
  /** A sample of the demo: shown with «Пример набора», never real applicability. */
  demo: boolean;
  /** In position order. */
  lines: KitLineRecord[];
}

/** The display order of kits: make, model, then the years and the engine. */
export function compareKits(a: KitRecord, b: KitRecord): number {
  return (
    a.makeSlug.localeCompare(b.makeSlug) ||
    a.modelSlug.localeCompare(b.modelSlug) ||
    a.yearsFrom - b.yearsFrom ||
    a.engine.localeCompare(b.engine, 'ru') ||
    a.slug.localeCompare(b.slug)
  );
}

type KitRow = typeof kits.$inferSelect;

function recordOf(row: KitRow, lines: KitLineRecord[]): KitRecord {
  return {
    id: row.id,
    makeSlug: row.makeSlug,
    model: row.model,
    modelSlug: row.modelSlug,
    engine: row.engine,
    yearsFrom: row.yearsFrom,
    yearsTo: row.yearsTo,
    slug: row.slug,
    note: row.note,
    status: row.status as KitStatus,
    publishedAt: row.publishedAt,
    updatedAt: row.updatedAt,
    version: row.updatedAt.toISOString(),
    demo: false,
    lines,
  };
}

/** Lines of these kits by kit id, in position order. */
async function linesOf(
  db: Executor,
  ids: readonly string[],
): Promise<Map<string, KitLineRecord[]>> {
  const out = new Map<string, KitLineRecord[]>();
  if (ids.length === 0) return out;
  const rows = await db
    .select()
    .from(kitLines)
    .where(inArray(kitLines.kitId, [...ids]))
    .orderBy(asc(kitLines.kitId), asc(kitLines.position));
  for (const row of rows) {
    const list = out.get(row.kitId) ?? [];
    list.push({
      id: row.id,
      position: row.position,
      role: row.role,
      brand: row.brand,
      article: row.article,
      qty: row.qty,
      alternativeOf: row.alternativeOf,
    });
    out.set(row.kitId, list);
  }
  return out;
}

/** Every published kit with its lines, in display order. */
export async function loadPublishedKits(db: Executor): Promise<KitRecord[]> {
  const rows = await db.select().from(kits).where(eq(kits.status, 'published'));
  const lines = await linesOf(
    db,
    rows.map((row) => row.id),
  );
  return rows.map((row) => recordOf(row, lines.get(row.id) ?? [])).sort(compareKits);
}

/** One kit with its lines (any status: the admin; `published` for the cart button). */
export async function loadKit(
  db: Executor,
  id: string,
  options: { published?: boolean } = {},
): Promise<KitRecord | null> {
  const [row] = await db
    .select()
    .from(kits)
    .where(
      options.published ? and(eq(kits.id, id), eq(kits.status, 'published')) : eq(kits.id, id),
    );
  if (!row) return null;
  const lines = await linesOf(db, [row.id]);
  return recordOf(row, lines.get(row.id) ?? []);
}

export const KIT_CATALOG_TTL_MS = 60_000;

export interface KitCatalogReader {
  /** null: the database failed before anything was read. */
  get(): Promise<KitRecord[] | null>;
  /** The admin saved a kit: the next get() reads the database. */
  invalidate(): void;
}

export function createKitCatalogReader({
  load,
  ttlMs = KIT_CATALOG_TTL_MS,
  now = Date.now,
  onError,
}: {
  load: () => Promise<KitRecord[]>;
  ttlMs?: number;
  now?: () => number;
  onError?: (error: unknown) => void;
}): KitCatalogReader {
  let cached: { value: KitRecord[]; at: number } | null = null;
  let inflight: Promise<KitRecord[] | null> | null = null;
  let generation = 0;

  async function read(started: number): Promise<KitRecord[] | null> {
    try {
      const value = await load();
      if (started === generation) cached = { value, at: now() };
      return value;
    } catch (error) {
      onError?.(error);
      return cached?.value ?? null;
    }
  }

  return {
    get() {
      if (cached && now() - cached.at < ttlMs) return Promise.resolve(cached.value);
      if (inflight === null) {
        const pending = read(generation).finally(() => {
          if (inflight === pending) inflight = null;
        });
        inflight = pending;
      }
      return inflight;
    },
    invalidate() {
      generation += 1;
      if (cached) cached = { value: cached.value, at: Number.NEGATIVE_INFINITY };
      inflight = null;
    },
  };
}

/** The reader of this process; DEMO_MODE never has one (no database). */
function catalogReader(): KitCatalogReader {
  return singleton('kit-catalog', () =>
    createKitCatalogReader({
      load: () => loadPublishedKits(getDb()),
      onError: (error) =>
        getLogger().warn(
          { err: error instanceof Error ? error.name : typeof error },
          'kit catalogue unavailable',
        ),
    }),
  );
}

/**
 * The published kits now, in display order: the samples in DEMO_MODE; null when the database
 * failed and nothing was read before.
 */
export async function publishedKits(): Promise<readonly KitRecord[] | null> {
  if (isDemoMode()) return DEMO_KITS;
  try {
    return await catalogReader().get();
  } catch (error) {
    // getDb() itself may throw (a broken DATABASE_URL): no kits rather than a broken page.
    getLogger().warn(
      { err: error instanceof Error ? error.name : typeof error },
      'kit catalogue unavailable',
    );
    return null;
  }
}

/** After an admin save: the storefront shows the change at once (this process). */
export function invalidateKitCatalog(): void {
  if (isDemoMode()) return;
  catalogReader().invalidate();
}

const BRANDS = new Map(CAR_BRANDS.map((brand) => [brand.slug, brand]));

/** The make of a kit as the storefront knows it, or null (a make no longer in CAR_BRANDS). */
export function kitBrand(makeSlug: string): CarBrand | null {
  return BRANDS.get(makeSlug) ?? null;
}

export interface KitMakeEntry {
  brand: CarBrand;
  /** Names of the models with published kits, by name. */
  models: string[];
  kits: number;
}

/** Makes with published kits, in the order of the home page (CAR_BRANDS). */
export function kitMakes(list: readonly KitRecord[]): KitMakeEntry[] {
  return CAR_BRANDS.flatMap((brand) => {
    const ofMake = list.filter((kit) => kit.makeSlug === brand.slug);
    if (ofMake.length === 0) return [];
    return [
      {
        brand,
        models: kitModels(ofMake, brand.slug).map((entry) => entry.model),
        kits: ofMake.length,
      },
    ];
  });
}

export interface KitModelEntry {
  modelSlug: string;
  /** The model as the first of its kits names it. */
  model: string;
  kits: KitRecord[];
}

/** Models of a make with published kits, by name. */
export function kitModels(list: readonly KitRecord[], makeSlug: string): KitModelEntry[] {
  const byModel = new Map<string, KitModelEntry>();
  for (const kit of list) {
    if (kit.makeSlug !== makeSlug) continue;
    const entry = byModel.get(kit.modelSlug);
    if (entry) entry.kits.push(kit);
    else byModel.set(kit.modelSlug, { modelSlug: kit.modelSlug, model: kit.model, kits: [kit] });
  }
  return [...byModel.values()].sort((a, b) => a.model.localeCompare(b.model, 'ru'));
}

/** The make slugs with published kits (home tiles lead there instead of the VIN request). */
export function kitMakeSlugs(list: readonly KitRecord[] | null): ReadonlySet<string> {
  return new Set(kitMakes(list ?? []).map((entry) => entry.brand.slug));
}
