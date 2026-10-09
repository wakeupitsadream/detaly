/**
 * POST /api/admin/kits (step 5, docs/kits.md): «Сохранить», «Опубликовать», «Снять с
 * публикации» and «Удалить» of /admin/kits, as the owner (one Basic auth account).
 *
 * The writes follow the audited writer of the admin settings (settings-writer.ts): one
 * transaction under the row lock of the kit, the optimistic version the editor was opened with
 * (kits.updated_at; 409 when another tab saved meanwhile), `updated_by` / `updated_at` set on
 * every change. No journal table: a kit keeps who changed it last and when.
 *
 * - save: the header (validateKitHeader: a CAR_BRANDS make, the model, the engine, the years,
 *   the note) and the lines in the VIN-answer format (parseKitText); every line is checked at the
 *   supplier by the VIN preview rule, and a main line without a role takes the supplier's name
 *   of the part. A field or a line that cannot be read sends the editor back with the draft in
 *   the query (`?check=1&…&error=`), so nothing typed is lost. A published kit is saved only with
 *   lines it could be published with. Lines are rewritten as a whole; the slug of a published
 *   kit stays (its address), a draft's follows its engine.
 * - publish: only when every main line is found at the supplier now and no line is marked goods
 *   (kitPublishProblems); otherwise back to the editor with the reasons.
 * - unpublish: back to a draft (the page is gone at once).
 * - delete: drafts only, with the «подтверждаю» tick.
 *
 * Order of checks as in the other admin handlers: Basic auth -> Origin (403) -> urlencoded body
 * within 16 KB (400/413) -> action (400) -> the kit (404) -> values (303 back with the reasons)
 * -> version (409). After a write the storefront's kit list of this process is dropped.
 */
import type { Env } from '@detaly/config';
import { and, eq, kitLines, kits, ne, type Database } from '@detaly/db';
import {
  KIT_ROLE_MAX,
  kitLineState,
  kitPublishProblems,
  pickKitSlug,
  type KitHeader,
  type KitStatus,
  type VinPreviewLine,
} from '@detaly/domain';
import type { RosskoClient } from '@detaly/rossko';
import type { KitTextLine } from '@detaly/vin';
import { kitPath } from '@/lib/kit-paths';
import { readBoundedText } from '../body';
import { errorInfo, pgErrorOf } from '../errors';
import { loadKit, type KitRecord } from '../kits/catalog';
import { isSameOrigin } from '../request-guards';
import type { SearchSettings } from '../settings';
import { CONFIRM_FIELD, CONFIRM_VALUE } from './destructive';
import { formField } from './form-fields';
import { adminAuthFailure, adminDone, adminPage } from './http';
import {
  checkDraftLines,
  KIT_FIELDS,
  kitFormValues,
  readKitDraft,
  type KitFormValues,
} from './kits';
import { isUuid } from './queries';
import { ADMIN_ACTOR } from './settings-writer';

/** The lines field (2000 characters, Cyrillic roles take six bytes each encoded) and the rest. */
export const MAX_ADMIN_KITS_BODY_BYTES = 32 * 1024;

export const ADMIN_KIT_ACTIONS = ['save', 'publish', 'unpublish', 'delete'] as const;
export type AdminKitAction = (typeof ADMIN_KIT_ACTIONS)[number];

export interface AdminKitsDeps {
  db: Database;
  env: Pick<Env, 'ADMIN_BASIC_AUTH' | 'APP_BASE_URL'>;
  supplier: {
    rossko: Pick<RosskoClient, 'search'>;
    settings: { get(): Promise<SearchSettings> };
  };
  /** Drops the storefront's kit list of this process (invalidateKitCatalog). */
  invalidateCatalog?: () => void;
  logger?: {
    info(details: Record<string, unknown>, message: string): void;
    error(details: Record<string, unknown>, message: string): void;
  };
  now?: () => Date;
}

/** The editor of a kit; `new` for a kit not saved yet. */
export function kitEditorPath(id: string | null): string {
  return `/admin/kits/${id ?? 'new'}`;
}

/** The editor again with the draft in the query and a message: nothing typed is lost. */
export function backWithDraft(id: string | null, values: KitFormValues, error: string): Response {
  const query = new URLSearchParams({ check: '1' });
  for (const key of Object.keys(KIT_FIELDS) as (keyof KitFormValues)[]) {
    query.set(KIT_FIELDS[key], values[key]);
  }
  query.set('error', error.slice(0, 600));
  return new Response(null, {
    status: 303,
    headers: {
      Location: `${kitEditorPath(id)}?${query.toString()}`,
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer',
      'X-Robots-Tag': 'noindex, nofollow',
    },
  });
}

/** The editor of a saved kit with an error line (`?error=`), the draft being the saved kit. */
function backWithError(id: string, error: string): Response {
  return new Response(null, {
    status: 303,
    headers: {
      Location: `${kitEditorPath(id)}?error=${encodeURIComponent(error.slice(0, 600))}`,
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer',
      'X-Robots-Tag': 'noindex, nofollow',
    },
  });
}

/** A role from the supplier's name of the part: one line, at most KIT_ROLE_MAX characters. */
export function roleFromOfferName(name: string): string | null {
  const clean = name.replace(/\s+/gu, ' ').trim();
  if (clean === '') return null;
  return clean.length <= KIT_ROLE_MAX ? clean : `${clean.slice(0, KIT_ROLE_MAX - 1).trimEnd()}…`;
}

export interface SaveKitInput {
  /** null: a new kit. */
  id: string | null;
  /** kits.updated_at of the kit the editor opened (ISO); ignored for a new kit. */
  version: string;
  header: KitHeader;
  lines: readonly (Pick<KitTextLine, 'alternative' | 'brand' | 'article' | 'qty'> & {
    role: string | null;
  })[];
  actor: string;
  now: Date;
}

export type SaveKitOutcome =
  | { ok: true; id: string; slug: string; status: KitStatus }
  | { ok: false; reason: 'not_found' | 'conflict' };

/**
 * Writes a kit and all its lines in one transaction under the kit's row lock (see the module
 * comment): the version must still match; the slug is kept for a published kit of the same
 * model, picked among the free ones otherwise.
 */
export async function saveKit(db: Database, input: SaveKitInput): Promise<SaveKitOutcome> {
  const { header } = input;
  try {
    return await db.transaction(async (tx): Promise<SaveKitOutcome> => {
      let row: typeof kits.$inferSelect | undefined;
      if (input.id !== null) {
        [row] = await tx.select().from(kits).where(eq(kits.id, input.id)).for('update');
        if (!row) return { ok: false, reason: 'not_found' };
        if (row.updatedAt.toISOString() !== input.version) return { ok: false, reason: 'conflict' };
      }
      const sameModel =
        row !== undefined && row.makeSlug === header.makeSlug && row.modelSlug === header.modelSlug;
      let slug: string;
      if (row !== undefined && row.status === 'published' && sameModel) {
        slug = row.slug;
      } else {
        const taken = await tx
          .select({ slug: kits.slug })
          .from(kits)
          .where(
            and(
              eq(kits.makeSlug, header.makeSlug),
              eq(kits.modelSlug, header.modelSlug),
              row ? ne(kits.id, row.id) : undefined,
            ),
          );
        slug = pickKitSlug(header.engine, header.yearsFrom, new Set(taken.map((t) => t.slug)));
      }
      const values = {
        makeSlug: header.makeSlug,
        model: header.model,
        modelSlug: header.modelSlug,
        engine: header.engine,
        yearsFrom: header.yearsFrom,
        yearsTo: header.yearsTo,
        note: header.note,
        slug,
        updatedBy: input.actor,
        updatedAt: input.now,
      };
      let id: string;
      let status: KitStatus;
      if (row !== undefined) {
        id = row.id;
        status = row.status as KitStatus;
        await tx.update(kits).set(values).where(eq(kits.id, id));
        await tx.delete(kitLines).where(eq(kitLines.kitId, id));
      } else {
        const [inserted] = await tx
          .insert(kits)
          .values({ ...values, status: 'draft', createdBy: input.actor, createdAt: input.now })
          .returning({ id: kits.id });
        if (!inserted) throw new Error('kit insert returned nothing');
        id = inserted.id;
        status = 'draft';
      }
      // Main lines first (their ids come from the schema default, uuid v7), then the
      // alternatives pointing to them: the position of its main line -> its id.
      let mainPosition = 0;
      const rows = input.lines.map((line, index) => {
        if (!line.alternative) mainPosition = index + 1;
        return {
          main: line.alternative ? mainPosition : null,
          values: {
            kitId: id,
            position: index + 1,
            role: line.role,
            brand: line.brand,
            article: line.article,
            qty: line.qty,
          },
        };
      });
      const mains = rows.filter((row) => row.main === null).map((row) => row.values);
      const inserted =
        mains.length > 0
          ? await tx
              .insert(kitLines)
              .values(mains)
              .returning({ id: kitLines.id, position: kitLines.position })
          : [];
      const idOf = new Map(inserted.map((line) => [line.position, line.id]));
      const alternatives = rows.flatMap((row) => {
        const alternativeOf = row.main === null ? undefined : idOf.get(row.main);
        return alternativeOf === undefined ? [] : [{ ...row.values, alternativeOf }];
      });
      if (alternatives.length > 0) await tx.insert(kitLines).values(alternatives);
      return { ok: true, id, slug, status };
    });
  } catch (error) {
    // Two saves picked the same free slug of a model at once: the second one is a conflict
    // (409, «saved meanwhile»), and saving again picks the next free slug.
    if (pgErrorOf(error)?.code === '23505') return { ok: false, reason: 'conflict' };
    throw error;
  }
}

export type StatusChange = 'publish' | 'unpublish' | 'delete';

export type StatusChangeOutcome =
  | { ok: true; kit: { makeSlug: string; modelSlug: string; slug: string } }
  | { ok: false; reason: 'not_found' | 'conflict' | 'published' };

/**
 * Publishes, unpublishes or deletes a kit under its row lock with the version check. Publishing
 * also fills the roles the supplier's offers gave (`roles`: line id -> role) for main lines that
 * had none.
 */
export async function changeKitStatus(
  db: Database,
  input: {
    id: string;
    version: string;
    change: StatusChange;
    actor: string;
    now: Date;
    roles?: ReadonlyMap<string, string>;
  },
): Promise<StatusChangeOutcome> {
  return db.transaction(async (tx): Promise<StatusChangeOutcome> => {
    const [row] = await tx.select().from(kits).where(eq(kits.id, input.id)).for('update');
    if (!row) return { ok: false, reason: 'not_found' };
    if (row.updatedAt.toISOString() !== input.version) return { ok: false, reason: 'conflict' };
    const kit = { makeSlug: row.makeSlug, modelSlug: row.modelSlug, slug: row.slug };
    if (input.change === 'delete') {
      if (row.status !== 'draft') return { ok: false, reason: 'published' };
      await tx.delete(kits).where(eq(kits.id, row.id));
      return { ok: true, kit };
    }
    const publish = input.change === 'publish';
    await tx
      .update(kits)
      .set({
        status: publish ? 'published' : 'draft',
        publishedAt: publish ? input.now : null,
        updatedBy: input.actor,
        updatedAt: input.now,
      })
      .where(eq(kits.id, row.id));
    for (const [lineId, role] of input.roles ?? []) {
      await tx
        .update(kitLines)
        .set({ role })
        .where(and(eq(kitLines.id, lineId), eq(kitLines.kitId, row.id)));
    }
    return { ok: true, kit };
  });
}

/** The lines of a saved kit as the check reads them. */
function textLinesOf(kit: KitRecord) {
  return kit.lines.map((line) => ({
    alternative: line.alternativeOf !== null,
    brand: line.brand,
    article: line.article,
    qty: line.qty,
  }));
}

export async function handleAdminKitsAction(
  request: Request,
  deps: AdminKitsDeps,
): Promise<Response> {
  const denied = adminAuthFailure(request, deps.env);
  if (denied) return denied;
  const list = { href: '/admin/kits', label: 'К наборам ТО' };
  if (!isSameOrigin(request.headers, deps.env.APP_BASE_URL)) {
    return adminPage(
      403,
      'Запрос отклонён: форма открыта не с этого сайта. Обновите страницу',
      list,
    );
  }
  try {
    const type = (request.headers.get('content-type') ?? '').toLowerCase();
    if (!type.includes('application/x-www-form-urlencoded')) {
      return adminPage(400, 'Не удалось прочитать форму', list);
    }
    const body = await readBoundedText(request, MAX_ADMIN_KITS_BODY_BYTES);
    if (!body.ok) return adminPage(413, 'Форма слишком большая', list);
    const form = new URLSearchParams(body.text);
    const action = formField(form, 'action', 16);
    if (!(ADMIN_KIT_ACTIONS as readonly string[]).includes(action)) {
      return adminPage(400, 'Неизвестное действие', list);
    }
    const now = (deps.now ?? (() => new Date()))();
    const id = formField(form, 'id', 64);
    const version = formField(form, 'version', 64);
    if (id !== '' && !isUuid(id)) return adminPage(404, 'Набор не найден', list);
    const log = (details: Record<string, unknown>) =>
      deps.logger?.info({ action, kit: id || null, ...details }, 'admin kits action');
    const conflict = (kitId: string) =>
      adminPage(409, 'Набор уже изменили (в другой вкладке?) — откройте его заново и проверьте', {
        href: kitEditorPath(kitId),
        label: 'Открыть набор',
      });

    if (action === 'save') {
      const existing = id === '' ? null : await loadKit(deps.db, id);
      if (id !== '' && existing === null) return adminPage(404, 'Набор не найден', list);
      const values = kitFormValues((name) => form.get(name));
      const draft = readKitDraft(values, now);
      if (draft.header === null || draft.lineErrors.length > 0 || draft.linesError !== null) {
        log({ ok: false, reason: 'invalid' });
        return backWithDraft(
          existing?.id ?? null,
          values,
          'Не сохранено: исправьте поля и строки, отмеченные ниже',
        );
      }
      const settings = await deps.supplier.settings.get();
      const checks = await checkDraftLines(draft.lines, {
        rossko: deps.supplier.rossko,
        settings,
        now,
      });
      if (existing?.status === 'published') {
        const problems = kitPublishProblems(
          draft.lines.map((line, index) => ({
            line: line.line,
            alternative: line.alternative,
            state: kitLineState(checks[index] as VinPreviewLine),
          })),
        );
        if (problems.length > 0) {
          log({ ok: false, reason: 'published', problems: problems.length });
          return backWithDraft(
            existing.id,
            values,
            `Набор опубликован — сохраняется только состав, с которым его можно показывать: ${problems.join('; ')}. Исправьте строки или сначала снимите набор с публикации`,
          );
        }
      }
      const lines = draft.lines.map((line, index) => {
        const check = checks[index];
        const role =
          line.role ??
          (!line.alternative && check?.status === 'ok'
            ? roleFromOfferName(check.offer.name)
            : null);
        return { ...line, role };
      });
      const outcome = await saveKit(deps.db, {
        id: existing?.id ?? null,
        version,
        header: draft.header,
        lines,
        actor: ADMIN_ACTOR,
        now,
      });
      log({
        ok: outcome.ok,
        ...(outcome.ok ? {} : { reason: outcome.reason }),
        lines: lines.length,
      });
      if (!outcome.ok) {
        return outcome.reason === 'not_found'
          ? adminPage(404, 'Набор не найден', list)
          : conflict(existing?.id ?? 'new');
      }
      deps.invalidateCatalog?.();
      return adminDone(
        kitEditorPath(outcome.id),
        outcome.status === 'published' ? 'Сохранено, набор на сайте обновлён' : 'Сохранено',
      );
    }

    if (id === '') return adminPage(404, 'Набор не найден', list);
    const kit = await loadKit(deps.db, id);
    if (kit === null) return adminPage(404, 'Набор не найден', list);
    if (kit.version !== version) return conflict(kit.id);

    if (action === 'publish') {
      if (kit.status === 'published') return adminDone(kitEditorPath(kit.id), 'Набор уже на сайте');
      const settings = await deps.supplier.settings.get();
      const lines = textLinesOf(kit);
      const checks = await checkDraftLines(lines, { rossko: deps.supplier.rossko, settings, now });
      const problems = kitPublishProblems(
        lines.map((line, index) => ({
          line: index + 1,
          alternative: line.alternative,
          state: kitLineState(checks[index] as VinPreviewLine),
        })),
      );
      if (problems.length > 0) {
        log({ ok: false, reason: 'problems', problems: problems.length });
        return backWithError(kit.id, `Не опубликовано: ${problems.join('; ')}`);
      }
      const roles = new Map<string, string>();
      kit.lines.forEach((line, index) => {
        const check = checks[index];
        if (line.alternativeOf !== null || line.role !== null || check?.status !== 'ok') return;
        const role = roleFromOfferName(check.offer.name);
        if (role !== null) roles.set(line.id, role);
      });
      const outcome = await changeKitStatus(deps.db, {
        id: kit.id,
        version,
        change: 'publish',
        actor: ADMIN_ACTOR,
        now,
        roles,
      });
      log({ ok: outcome.ok });
      if (!outcome.ok) return conflict(kit.id);
      deps.invalidateCatalog?.();
      return adminDone(kitEditorPath(kit.id), `Опубликовано: ${kitPath(outcome.kit)}`);
    }

    if (action === 'delete' && form.get(CONFIRM_FIELD) !== CONFIRM_VALUE) {
      return adminPage(400, 'Отметьте «подтверждаю», чтобы удалить набор', {
        href: kitEditorPath(kit.id),
        label: 'Вернуться к набору',
      });
    }
    if (action === 'unpublish' && kit.status !== 'published') {
      return adminDone(kitEditorPath(kit.id), 'Набор и так не на сайте');
    }
    const outcome = await changeKitStatus(deps.db, {
      id: kit.id,
      version,
      change: action as 'unpublish' | 'delete',
      actor: ADMIN_ACTOR,
      now,
    });
    log({ ok: outcome.ok, ...(outcome.ok ? {} : { reason: outcome.reason }) });
    if (!outcome.ok) {
      if (outcome.reason === 'published') {
        return adminPage(
          409,
          'Опубликованный набор не удалить — сначала снимите его с публикации',
          {
            href: kitEditorPath(kit.id),
            label: 'Вернуться к набору',
          },
        );
      }
      return outcome.reason === 'not_found'
        ? adminPage(404, 'Набор не найден', list)
        : conflict(kit.id);
    }
    deps.invalidateCatalog?.();
    return action === 'delete'
      ? adminDone('/admin/kits', 'Набор удалён')
      : adminDone(kitEditorPath(kit.id), 'Снят с публикации: на сайте его больше нет');
  } catch (error) {
    // Names and SQLSTATE only: a driver message carries the query parameters.
    deps.logger?.error(errorInfo(error), 'admin kits action failed');
    return adminPage(500, 'Не удалось сохранить — попробуйте ещё раз', list);
  }
}
