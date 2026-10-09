// Step 5 (docs/kits.md): maintenance kits by car model («Наборы ТО»), made by the shop's master
// on /admin/kits and shown on /to/<make>/<model> once published.
import { KIT_STATUSES } from '@detaly/domain/statuses';
import { sql } from 'drizzle-orm';
import { foreignKey, index, integer, pgTable, text, unique, uuid } from 'drizzle-orm/pg-core';
import { createdAt, id, namedCheck, sqlList, tstz, updatedAt } from './columns';

/**
 * One kit: a make (a CAR_BRANDS slug of the storefront, checked by the admin handler), a model
 * and an engine with their years. `slug` addresses the kit inside its model page
 * (/to/<make_slug>/<model_slug>#<slug>), unique within the make and model. Only a `published`
 * kit is public; `published_at` is set exactly while it is. No prices are stored: the page
 * prices every line from the supplier search of the moment.
 *
 * `created_by` / `updated_by`: 'admin' (the Basic auth account) or a staff id, as
 * settings.updated_by. `updated_at` is the optimistic version of the editor (409 when another
 * tab saved meanwhile).
 */
export const kits = pgTable(
  'kits',
  {
    id: id(),
    makeSlug: text().notNull(),
    /** As shown: «Vesta». */
    model: text().notNull(),
    modelSlug: text().notNull(),
    /** As shown: «1.6 16V, 106 л.с.». */
    engine: text().notNull(),
    yearsFrom: integer().notNull(),
    /** null: still produced. */
    yearsTo: integer(),
    slug: text().notNull(),
    /** For the staff; only a replacement time («замена ≈ 1 ч») reaches the page. */
    note: text(),
    /** KIT_STATUSES. */
    status: text().notNull().default('draft'),
    publishedAt: tstz(),
    createdBy: text().notNull(),
    updatedBy: text().notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique('kits_make_slug_model_slug_slug_unique').on(t.makeSlug, t.modelSlug, t.slug),
    index('kits_status_make_slug_model_slug_idx').on(t.status, t.makeSlug, t.modelSlug),
    index('kits_updated_at_idx').on(t.updatedAt),
    namedCheck('kits', 'status', sql`${t.status} in (${sqlList(KIT_STATUSES)})`),
    namedCheck(
      'kits',
      'published_at',
      // `is not null` spelled out: a comparison with NULL is NULL, which a CHECK lets through.
      sql`(${t.status} = 'published') = (${t.publishedAt} is not null)`,
    ),
    // URL slugs: lower-case latin words joined by hyphens (KIT_SLUG_RE of @detaly/domain).
    namedCheck(
      'kits',
      'make_slug',
      sql`${t.makeSlug} ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and length(${t.makeSlug}) <= 64`,
    ),
    namedCheck(
      'kits',
      'model_slug',
      sql`${t.modelSlug} ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and length(${t.modelSlug}) <= 64`,
    ),
    namedCheck(
      'kits',
      'slug',
      sql`${t.slug} ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and length(${t.slug}) <= 64`,
    ),
    namedCheck('kits', 'model', sql`length(btrim(${t.model})) between 1 and 60`),
    namedCheck('kits', 'engine', sql`length(btrim(${t.engine})) between 1 and 80`),
    namedCheck('kits', 'years_from', sql`${t.yearsFrom} between 1970 and 2100`),
    namedCheck(
      'kits',
      'years_to',
      sql`${t.yearsTo} is null or ${t.yearsTo} between ${t.yearsFrom} and 2100`,
    ),
    namedCheck('kits', 'note', sql`${t.note} is null or length(${t.note}) between 1 and 300`),
    namedCheck('kits', 'created_by', sql`length(btrim(${t.createdBy})) > 0`),
    namedCheck('kits', 'updated_by', sql`length(btrim(${t.updatedBy})) > 0`),
  ],
);

/**
 * One line of a kit: «БРЕНД АРТИКУЛ КОЛ-ВО» as the master typed it, with its role («Фильтр
 * масляный»; null until the supplier's offer name fills it). `alternative_of` points to the main
 * line of the same kit this line is an analog of (the client may pick it instead); the composite
 * key keeps an alternative inside its kit, and removing the main line removes its alternatives.
 * Lines are rewritten as a whole on every save.
 */
export const kitLines = pgTable(
  'kit_lines',
  {
    id: id(),
    kitId: uuid()
      .notNull()
      .references(() => kits.id, { onDelete: 'cascade' }),
    /** 1-based order of the lines in the kit (alternatives right after their main line). */
    position: integer().notNull(),
    role: text(),
    brand: text().notNull(),
    /** As typed; the supplier is searched by its normalized form. */
    article: text().notNull(),
    qty: integer().notNull(),
    alternativeOf: uuid(),
  },
  (t) => [
    unique('kit_lines_kit_id_position_unique').on(t.kitId, t.position),
    unique('kit_lines_kit_id_id_unique').on(t.kitId, t.id),
    index('kit_lines_kit_id_alternative_of_idx').on(t.kitId, t.alternativeOf),
    foreignKey({
      name: 'kit_lines_alternative_of_fk',
      columns: [t.kitId, t.alternativeOf],
      foreignColumns: [t.kitId, t.id],
    }).onDelete('cascade'),
    namedCheck('kit_lines', 'position', sql`${t.position} between 1 and 100`),
    namedCheck('kit_lines', 'qty', sql`${t.qty} between 1 and 99`),
    namedCheck('kit_lines', 'brand', sql`length(btrim(${t.brand})) between 1 and 64`),
    namedCheck('kit_lines', 'article', sql`length(btrim(${t.article})) between 1 and 64`),
    namedCheck(
      'kit_lines',
      'role',
      sql`${t.role} is null or length(btrim(${t.role})) between 1 and 60`,
    ),
    namedCheck(
      'kit_lines',
      'alternative_of',
      sql`${t.alternativeOf} is null or ${t.alternativeOf} <> ${t.id}`,
    ),
  ],
);
