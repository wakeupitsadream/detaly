/**
 * POST /api/admin/pricing (step 2, docs/pricing.md): «Сохранить поправки» of /admin/pricing.
 *
 * The form carries the draft in bp (`lbp_<group>`, `obp_<group>`), the version of the
 * adjustments row it was previewed against and the «подтверждаю» tick. The adjustments are
 * validated (validateGroupAdjustments) and stored in normal form by the audited settings writer
 * (settings-writer.ts): in one transaction under the row lock the version must still match (409
 * otherwise: another tab saved meanwhile), `settings` gets updated_by 'admin' and
 * `settings_audit` the old and the new value. After the commit the settings cache of this
 * process is dropped, so the next search, cart and checkout use the new markups at once (the
 * worker reads settings per job).
 *
 * Order of checks as in the other admin handlers: Basic auth -> Origin (403) -> urlencoded body
 * (400/413) -> action and tick (400) -> values (422) -> version (409).
 */
import type { Env } from '@detaly/config';
import type { Database } from '@detaly/db';
import {
  formatPercentPoints,
  GroupAdjustmentsError,
  normalizeGroupAdjustments,
  parseGroupAdjustments,
  PRICE_GROUP_LABELS,
  PRICE_GROUPS,
  validateGroupAdjustments,
  type GroupAdjustment,
} from '@detaly/domain';
import { readBoundedText } from '../body';
import { errorInfo } from '../errors';
import { isSameOrigin } from '../request-guards';
import { CONFIRM_FIELD, CONFIRM_VALUE } from './destructive';
import { formField } from './form-fields';
import { adminAuthFailure, adminDone, adminPage } from './http';
import { ADJUSTMENTS_KEY, bpField, sameAdjustments } from './pricing';
import { writeAuditedSetting } from './settings-writer';

export const MAX_ADMIN_PRICING_BODY_BYTES = 8 * 1024;

export interface AdminPricingDeps {
  db: Database;
  env: Pick<Env, 'ADMIN_BASIC_AUTH' | 'APP_BASE_URL'>;
  /** Drops the settings cache of this process (SettingsReader.invalidate). */
  invalidateSettings?: () => void;
  logger?: {
    info(details: Record<string, unknown>, message: string): void;
    error(details: Record<string, unknown>, message: string): void;
  };
  now?: () => Date;
}

const BP_RE = /^-?\d{1,5}$/;

/** The bp fields of the save form -> adjustments; null when a value is not an integer. */
export function parseAdjustmentsForm(form: URLSearchParams): GroupAdjustment[] | null {
  const list: GroupAdjustment[] = [];
  for (const group of PRICE_GROUPS) {
    const deltas = { local: 0, order: 0 };
    for (const side of ['local', 'order'] as const) {
      const raw = (form.get(bpField(side, group)) ?? '').trim();
      if (raw === '') continue;
      if (!BP_RE.test(raw)) return null;
      deltas[side] = Number(raw);
    }
    list.push({ group, localDeltaBp: deltas.local, orderDeltaBp: deltas.order });
  }
  return list;
}

/** «Фильтры: в Оренбурге +3, под заказ 0» for every group of the list; «без поправок» if none. */
export function adjustmentsSummary(list: readonly GroupAdjustment[]): string {
  const normal = normalizeGroupAdjustments(list);
  if (normal.length === 0) return 'без поправок';
  return normal
    .map(
      (a) =>
        `${PRICE_GROUP_LABELS[a.group]}: в Оренбурге ${formatPercentPoints(a.localDeltaBp)}, под заказ ${formatPercentPoints(a.orderDeltaBp)}`,
    )
    .join('; ');
}

export async function handleAdminPricingAction(
  request: Request,
  deps: AdminPricingDeps,
): Promise<Response> {
  try {
    return await handle(request, deps);
  } catch (error) {
    // Names and SQLSTATE only: a driver message carries the query parameters.
    deps.logger?.error({ ...errorInfo(error) }, 'admin pricing action failed');
    return adminPage(500, 'Не удалось сохранить — попробуйте ещё раз', {
      href: '/admin/pricing',
      label: 'К наценке по группам',
    });
  }
}

async function handle(request: Request, deps: AdminPricingDeps): Promise<Response> {
  const denied = adminAuthFailure(request, deps.env);
  if (denied) return denied;
  const back = { href: '/admin/pricing', label: 'К наценке по группам' };
  if (!isSameOrigin(request.headers, deps.env.APP_BASE_URL)) {
    return adminPage(
      403,
      'Запрос отклонён: форма открыта не с этого сайта. Обновите страницу',
      back,
    );
  }
  const type = (request.headers.get('content-type') ?? '').toLowerCase();
  if (!type.includes('application/x-www-form-urlencoded')) {
    return adminPage(400, 'Не удалось прочитать форму', back);
  }
  const body = await readBoundedText(request, MAX_ADMIN_PRICING_BODY_BYTES);
  if (!body.ok) return adminPage(413, 'Форма слишком большая', back);
  const form = new URLSearchParams(body.text);
  if (formField(form, 'action', 16) !== 'save') {
    return adminPage(400, 'Неизвестное действие', back);
  }
  if (form.get(CONFIRM_FIELD) !== CONFIRM_VALUE) {
    return adminPage(400, 'Отметьте «подтверждаю», чтобы сохранить поправки', back);
  }
  const parsed = parseAdjustmentsForm(form);
  if (parsed === null) return adminPage(422, 'Поправка — целое число базисных пунктов', back);
  try {
    validateGroupAdjustments(parsed);
  } catch (error) {
    if (error instanceof GroupAdjustmentsError) {
      return adminPage(422, 'Поправка — от −50 до +50 п.п. для каждой группы', back);
    }
    throw error;
  }
  const next = normalizeGroupAdjustments(parsed);
  const version = formField(form, 'version', 64);
  const now = (deps.now ?? (() => new Date()))();

  const outcome = await writeAuditedSetting(deps.db, {
    key: ADJUSTMENTS_KEY,
    value: next,
    version,
    same: (stored) => sameAdjustments(parseGroupAdjustments(stored) ?? [], next),
    at: now,
  });

  deps.logger?.info({ action: 'save', outcome, groups: next.length }, 'admin pricing action');
  if (outcome === 'conflict') {
    return adminPage(
      409,
      'Поправки уже изменили (в другой вкладке?) — откройте страницу заново и проверьте',
      back,
    );
  }
  if (outcome === 'unchanged') return adminDone('/admin/pricing', 'Без изменений');
  deps.invalidateSettings?.();
  return adminDone('/admin/pricing', `Сохранено: ${adjustmentsSummary(next)}`);
}
