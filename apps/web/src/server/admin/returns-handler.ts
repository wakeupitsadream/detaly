/**
 * POST /api/admin/returns (step 7, docs/month-close.md): the forms of /admin/returns and
 * /admin/stock, as the owner (decision Б19: actor staff 'admin', via 'admin').
 *
 * - `ship` — «Сдал водителю» (requested -> shipped);
 * - `reject` — «Не берут» (requested | shipped -> rejected, the part to stock_items at the cost
 *   of the order, «Не принят поставщиком»);
 * - `refunded` + `amountRub` — «Деньги вернулись» (-> refunded with the amount received);
 * - `write_off` + the «подтверждаю» tick — «Списать» a part in stock.
 *
 * Each goes through @detaly/orders (supplier-returns.ts) under the order row lock and is
 * idempotent: a repeated post answers «Уже отмечено». Order of checks as in the other admin
 * handlers: Basic auth -> Origin (403) -> urlencoded body (400/413) -> action and fields
 * (400/422) -> the engine (409 with its text when it refuses). Done: 303 back with `done`.
 */
import type { Env } from '@detaly/config';
import {
  markSupplierReturnRefunded,
  rejectSupplierReturn,
  shipSupplierReturn,
  writeOffStockItem,
  type EngineDeps,
  type StaffActionResult,
  type StaffRef,
} from '@detaly/orders';
import { readBoundedText } from '../body';
import { errorInfo } from '../errors';
import { isSameOrigin } from '../request-guards';
import { CONFIRM_FIELD, CONFIRM_VALUE } from './destructive';
import { formField, parseRubToKop } from './form-fields';
import { adminAuthFailure, adminDone, adminPage } from './http';
import { isUuid } from './queries';

export const MAX_ADMIN_RETURNS_BODY_BYTES = 4 * 1024;

export const RETURNS_ACTIONS = ['ship', 'reject', 'refunded', 'write_off'] as const;
export type ReturnsAction = (typeof RETURNS_ACTIONS)[number];

/** Where a form may send the admin back. */
const BACK_PATHS = ['/admin/returns', '/admin/stock'] as const;

const ADMIN_STAFF: StaffRef = { id: null, role: 'owner', via: 'admin' };

export interface AdminReturnsDeps {
  engine: EngineDeps;
  env: Pick<Env, 'ADMIN_BASIC_AUTH' | 'APP_BASE_URL'>;
  logger?: {
    info(details: Record<string, unknown>, message: string): void;
    error(details: Record<string, unknown>, message: string): void;
  };
}

export async function handleAdminReturnsAction(
  request: Request,
  deps: AdminReturnsDeps,
): Promise<Response> {
  try {
    return await handle(request, deps);
  } catch (error) {
    deps.logger?.error({ ...errorInfo(error) }, 'admin returns action failed');
    return adminPage(500, 'Не удалось выполнить — попробуйте ещё раз', {
      href: '/admin/returns',
      label: 'К возвратам поставщику',
    });
  }
}

function backOf(form: URLSearchParams): { href: string; label: string } {
  const raw = formField(form, 'back', 32);
  const href = (BACK_PATHS as readonly string[]).includes(raw) ? raw : '/admin/returns';
  return { href, label: href === '/admin/stock' ? 'К складу' : 'К возвратам поставщику' };
}

async function handle(request: Request, deps: AdminReturnsDeps): Promise<Response> {
  const denied = adminAuthFailure(request, deps.env);
  if (denied) return denied;
  const fallback = { href: '/admin/returns', label: 'К возвратам поставщику' };
  if (!isSameOrigin(request.headers, deps.env.APP_BASE_URL)) {
    return adminPage(
      403,
      'Запрос отклонён: форма открыта не с этого сайта. Обновите страницу',
      fallback,
    );
  }
  const type = (request.headers.get('content-type') ?? '').toLowerCase();
  if (!type.includes('application/x-www-form-urlencoded')) {
    return adminPage(400, 'Не удалось прочитать форму', fallback);
  }
  const body = await readBoundedText(request, MAX_ADMIN_RETURNS_BODY_BYTES);
  if (!body.ok) return adminPage(413, 'Форма слишком большая', fallback);
  const form = new URLSearchParams(body.text);
  const back = backOf(form);
  const action = formField(form, 'action', 16);
  if (!(RETURNS_ACTIONS as readonly string[]).includes(action)) {
    return adminPage(400, 'Неизвестное действие', back);
  }

  let result: StaffActionResult;
  if (action === 'write_off') {
    const stockItemId = formField(form, 'stockItemId', 64);
    if (!isUuid(stockItemId)) return adminPage(400, 'Деталь на складе не найдена', back);
    if (form.get(CONFIRM_FIELD) !== CONFIRM_VALUE) {
      return adminPage(400, 'Отметьте «подтверждаю», чтобы списать деталь', back);
    }
    result = await writeOffStockItem(deps.engine, { stockItemId, staff: ADMIN_STAFF });
  } else {
    const supplierReturnId = formField(form, 'supplierReturnId', 64);
    if (!isUuid(supplierReturnId)) return adminPage(400, 'Возврат поставщику не найден', back);
    if (action === 'ship') {
      result = await shipSupplierReturn(deps.engine, { supplierReturnId, staff: ADMIN_STAFF });
    } else if (action === 'reject') {
      result = await rejectSupplierReturn(deps.engine, {
        supplierReturnId,
        staff: ADMIN_STAFF,
        note: formField(form, 'note', 500) || null,
      });
    } else {
      const amountKop = parseRubToKop(formField(form, 'amountRub', 20));
      if (amountKop === null || amountKop <= 0) {
        return adminPage(422, 'Укажите, сколько вернулось, например 1234,50', back);
      }
      result = await markSupplierReturnRefunded(deps.engine, {
        supplierReturnId,
        amountKop,
        staff: ADMIN_STAFF,
      });
    }
  }
  deps.logger?.info({ action, ok: result.ok }, 'admin returns action');
  if (!result.ok) return adminPage(409, result.message, back);
  return adminDone(back.href, result.message);
}
