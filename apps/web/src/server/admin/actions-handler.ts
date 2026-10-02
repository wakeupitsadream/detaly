/**
 * POST /api/admin/orders/<id>/actions (docs/phase-1b-implementation.md 15.4): one form per
 * action of the order card. Order of checks: Basic auth (401/404, again after the proxy) ->
 * Origin (403; `Origin: null` of a no-referrer page passes with Sec-Fetch-Site: same-origin,
 * see isSameOrigin) -> order id (404) -> body (400) -> action and its fields, the «подтверждаю»
 * tick of an irreversible action included (400) ->
 * performStaffAction as the owner (decision Б19: actor staff 'admin', via 'admin').
 * Done: 303 back to the card with `?done=<message>`. Refused by the engine (for example
 * «Выдал» without a succeeded receipt): 409 with the engine's text and a link back.
 * Logs carry the order number, the action code and the outcome only.
 */
import type { Logger } from '@detaly/config';
import { and, eq, orderItems, orders, supplierReturns } from '@detaly/db';
import { isIsoDate } from '@detaly/domain';
import {
  performStaffAction,
  type EngineDeps,
  type ItemProblem,
  type StaffActionCode,
  type StaffActionInput,
  type StaffActionResult,
} from '@detaly/orders';
import { ADMIN_CHALLENGE, ADMIN_RESPONSE_HEADERS, checkAdminAuth } from '../admin-auth';
import { readBoundedText } from '../body';
import { errorInfo } from '../errors';
import { isSameOrigin } from '../request-guards';
import { CONFIRM_FIELD, CONFIRM_VALUE, DESTRUCTIVE_ADMIN_ACTIONS } from './destructive';
import { isUuid, latestRecheckItems } from './queries';

/** A card form is a handful of short fields. */
export const MAX_ADMIN_ACTION_BODY_BYTES = 8 * 1024;

export interface AdminActionDeps {
  engine: EngineDeps;
  logger?: Pick<Logger, 'info' | 'warn' | 'error'>;
}

/** Every code the card may post (seller bot table 13.2 plus the admin-only actions). */
export const ADMIN_ACTION_CODES = [
  'recheck',
  'refused',
  'cancel',
  'anyway',
  'ialt',
  'ieta',
  'icancel',
  'iprob',
  'iarr',
  'invpaid',
  'came',
  'rcpt',
  'qr',
  'handed',
  'noshow',
  'manual_supplier_order',
  'supplier_return_accept',
  'supplier_return_reject',
  'stock_item',
  'refund_payment',
  'retry_refund',
] as const satisfies readonly StaffActionCode[];

const ITEM_ACTIONS: ReadonlySet<StaffActionCode> = new Set([
  'ialt',
  'ieta',
  'icancel',
  'iprob',
  'iarr',
  'stock_item',
]);

const PROBLEMS: readonly ItemProblem[] = ['declined', 'wrong', 'damaged', 'delay'];

export const ADMIN_ACTION_MESSAGES = {
  unauthorized: 'Нужны логин и пароль администратора',
  forbidden: 'Запрос отклонён: форма открыта не с этого сайта. Обновите карточку заказа',
  notFound: 'Заказ не найден',
  badRequest: 'Не удалось прочитать форму',
  internal: 'Ошибка сервера, попробуйте ещё раз',
} as const;

function isActionCode(value: string): value is StaffActionCode {
  return (ADMIN_ACTION_CODES as readonly string[]).includes(value);
}

/** «1 234,50» / «1234.5» / «1234» -> kopecks; null for anything else. */
export function parseRubToKop(raw: string): number | null {
  const text = raw.replace(/\s/g, '').replace(',', '.');
  const match = /^(\d{1,9})(?:\.(\d{1,2}))?$/.exec(text);
  if (!match?.[1]) return null;
  return Number(match[1]) * 100 + Number((match[2] ?? '').padEnd(2, '0'));
}

/** «12345, 67890 / 555» -> ['12345', '67890', '555']. */
export function splitIds(raw: string): string[] {
  return raw
    .split(/[\s,;/]+/)
    .map((id) => id.trim())
    .filter((id) => id !== '');
}

const NO_STORE_HEADERS = ADMIN_RESPONSE_HEADERS;

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function cardPath(orderId: string): string {
  return `/admin/orders/${orderId}`;
}

/** A short HTML page: the admin posts plain forms, so errors are pages, not JSON. */
function page(status: number, message: string, backHref: string | null): Response {
  const back = backHref
    ? `<p><a href="${escapeHtml(backHref)}">Вернуться к заказу</a></p>`
    : '<p><a href="/admin">К списку заказов</a></p>';
  const html = `<!doctype html>
<html lang="ru"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Действие не выполнено</title>
<style>body{font-family:system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;margin:0;padding:48px 16px;color:#1c1917;background:#fafaf9}main{max-width:36rem;margin:0 auto}h1{font-size:1.5rem}a{color:#b45309}</style>
</head><body><main>
<h1>Действие не выполнено</h1>
<p data-testid="admin-action-error">${escapeHtml(message)}</p>
${back}
</main></body></html>`;
  return new Response(html, {
    status,
    headers: { ...NO_STORE_HEADERS, 'Content-Type': 'text/html; charset=utf-8' },
  });
}

function redirectDone(orderId: string, message: string): Response {
  const location = `${cardPath(orderId)}?done=${encodeURIComponent(message.slice(0, 300))}`;
  return new Response(null, { status: 303, headers: { ...NO_STORE_HEADERS, Location: location } });
}

type Form = URLSearchParams;

function field(form: Form, name: string, max = 500): string {
  return (form.get(name) ?? '').trim().slice(0, max);
}

type Built =
  { ok: true; targetId: string; input: StaffActionInput } | { ok: false; message: string };

/** Turns the posted form into performStaffAction arguments; checks targets belong to the order. */
async function buildAction(
  deps: AdminActionDeps,
  orderId: string,
  action: StaffActionCode,
  form: Form,
): Promise<Built> {
  const db = deps.engine.db;
  if (DESTRUCTIVE_ADMIN_ACTIONS.has(action) && form.get(CONFIRM_FIELD) !== CONFIRM_VALUE) {
    return { ok: false, message: 'Поставьте галочку «подтверждаю»: это действие не отменить' };
  }
  const input: StaffActionInput = {};
  const note = field(form, 'note');
  if (note !== '') input.note = note;
  let targetId = orderId;

  if (ITEM_ACTIONS.has(action)) {
    const itemId = field(form, 'itemId', 64);
    if (!isUuid(itemId)) return { ok: false, message: 'Позиция не выбрана' };
    const [item] = await db
      .select({ id: orderItems.id })
      .from(orderItems)
      .where(and(eq(orderItems.id, itemId), eq(orderItems.orderId, orderId)));
    if (!item) return { ok: false, message: 'Позиция не найдена в этом заказе' };
    targetId = item.id;
  }

  switch (action) {
    case 'ialt': {
      const offerKey = field(form, 'offerKey', 300);
      if (offerKey === '') return { ok: false, message: 'Выберите аналог' };
      // Only an alternative found by the last recheck (its offer snapshot and prices); no
      // GetSearch from the admin (section 15.3).
      const recheck = await latestRecheckItems(db, orderId);
      const alternative = recheck
        .find((result) => result.orderItemId === targetId)
        ?.alternatives.find((alt) => alt.offerKey === offerKey);
      if (!alternative) {
        return { ok: false, message: 'Аналог не найден в последней проверке цен' };
      }
      input.alternative = alternative;
      break;
    }
    case 'ieta': {
      const etaDate = field(form, 'etaDate', 10);
      if (!isIsoDate(etaDate)) return { ok: false, message: 'Укажите новую дату' };
      input.etaDate = etaDate;
      break;
    }
    case 'iprob': {
      const problem = field(form, 'problem', 16);
      if (!(PROBLEMS as readonly string[]).includes(problem)) {
        return { ok: false, message: 'Выберите, что случилось с позицией' };
      }
      input.problem = problem as ItemProblem;
      break;
    }
    case 'invpaid': {
      const number = field(form, 'ppNumber', 64);
      const date = field(form, 'ppDate', 10);
      if (number === '' || !isIsoDate(date)) {
        return { ok: false, message: 'Укажите номер и дату платёжного поручения' };
      }
      input.paymentRef = `№ ${number} от ${date}`;
      break;
    }
    case 'manual_supplier_order': {
      const ids = splitIds(field(form, 'rosskoOrderIds', 500));
      if (ids.length === 0) return { ok: false, message: 'Укажите номера заказов Rossko' };
      input.rosskoOrderIds = ids;
      break;
    }
    case 'supplier_return_accept':
    case 'supplier_return_reject': {
      const supplierReturnId = field(form, 'supplierReturnId', 64);
      if (!isUuid(supplierReturnId)) return { ok: false, message: 'Возврат не выбран' };
      const [found] = await db
        .select({ id: supplierReturns.id })
        .from(supplierReturns)
        .innerJoin(orderItems, eq(orderItems.id, supplierReturns.orderItemId))
        .where(and(eq(supplierReturns.id, supplierReturnId), eq(orderItems.orderId, orderId)));
      if (!found) return { ok: false, message: 'Возврат поставщику не найден в этом заказе' };
      input.supplierReturnId = found.id;
      const amount = field(form, 'amountRub', 20);
      if (amount !== '') {
        const kop = parseRubToKop(amount);
        if (kop === null) return { ok: false, message: 'Сумма: например 1234,50' };
        input.amountKop = kop;
      }
      const reason = field(form, 'reason');
      if (reason !== '') input.reason = reason;
      break;
    }
    case 'stock_item': {
      const amount = field(form, 'amountRub', 20);
      if (amount !== '') {
        const kop = parseRubToKop(amount);
        if (kop === null) return { ok: false, message: 'Сумма: например 1234,50' };
        input.amountKop = kop;
      }
      const reason = field(form, 'reason');
      if (reason !== '') input.reason = reason;
      break;
    }
    case 'refund_payment': {
      const paymentId = field(form, 'paymentId', 64);
      const reason = field(form, 'reason');
      if (!isUuid(paymentId)) return { ok: false, message: 'Платёж не выбран' };
      if (reason === '') return { ok: false, message: 'Укажите причину возврата' };
      input.paymentId = paymentId;
      input.reason = reason;
      break;
    }
    case 'retry_refund': {
      // Optional: one failed refund; without it every refund that can be retried is sent.
      const refundId = field(form, 'refundId', 64);
      if (refundId !== '') {
        if (!isUuid(refundId)) return { ok: false, message: 'Возврат не выбран' };
        input.refundId = refundId;
      }
      break;
    }
    // No fields: the button alone says it all.
    case 'recheck':
    case 'refused':
    case 'cancel':
    case 'anyway':
    case 'icancel':
    case 'iarr':
    case 'came':
    case 'rcpt':
    case 'qr':
    case 'handed':
    case 'noshow':
      break;
  }
  return { ok: true, targetId, input };
}

async function readForm(request: Request): Promise<Form | null> {
  const type = (request.headers.get('content-type') ?? '').toLowerCase();
  if (!type.includes('application/x-www-form-urlencoded')) return null;
  const body = await readBoundedText(request, MAX_ADMIN_ACTION_BODY_BYTES);
  return body.ok ? new URLSearchParams(body.text) : null;
}

export async function handleAdminAction(
  request: Request,
  orderId: string,
  deps: AdminActionDeps,
): Promise<Response> {
  const env = deps.engine.env;
  const auth = checkAdminAuth(request.headers, env.ADMIN_BASIC_AUTH);
  if (auth === 'disabled') {
    return new Response('Not Found', { status: 404, headers: NO_STORE_HEADERS });
  }
  if (auth !== 'ok') {
    return new Response(ADMIN_ACTION_MESSAGES.unauthorized, {
      status: 401,
      headers: {
        ...NO_STORE_HEADERS,
        'WWW-Authenticate': ADMIN_CHALLENGE,
        'Content-Type': 'text/plain; charset=utf-8',
      },
    });
  }
  if (!isSameOrigin(request.headers, env.APP_BASE_URL)) {
    return page(403, ADMIN_ACTION_MESSAGES.forbidden, null);
  }
  if (!isUuid(orderId)) return page(404, ADMIN_ACTION_MESSAGES.notFound, null);
  const back = cardPath(orderId);

  try {
    const form = await readForm(request);
    if (form === null) return page(400, ADMIN_ACTION_MESSAGES.badRequest, back);
    const action = field(form, 'action', 32);
    if (!isActionCode(action)) return page(400, 'Неизвестное действие', back);

    const [order] = await deps.engine.db
      .select({ id: orders.id, number: orders.number })
      .from(orders)
      .where(eq(orders.id, orderId));
    if (!order) return page(404, ADMIN_ACTION_MESSAGES.notFound, null);

    const built = await buildAction(deps, order.id, action, form);
    if (!built.ok) return page(400, built.message, back);

    const result: StaffActionResult = await performStaffAction(deps.engine, {
      staff: { id: null, role: 'owner', via: 'admin' },
      action,
      targetId: built.targetId,
      input: built.input,
    });
    deps.logger?.info({ order: order.number, action, ok: result.ok }, 'admin action');
    if (!result.ok) return page(409, result.message, back);
    return redirectDone(order.id, result.message);
  } catch (error) {
    // Names and SQLSTATE only (errorInfo): a driver message may carry query parameters.
    deps.logger?.error(errorInfo(error), 'admin action failed');
    return page(500, ADMIN_ACTION_MESSAGES.internal, back);
  }
}
