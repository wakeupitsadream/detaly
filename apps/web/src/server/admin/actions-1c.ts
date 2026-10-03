/**
 * Phase 1C forms of the admin order card (docs/phase-1c-implementation.md decisions С7–С9, С17,
 * С26): claims («Принял возврат» with a mandatory photo, the decision with a mandatory answer
 * text, the owner's refund without the return with a reason, «Замена выдана», compensation for
 * a delay, opening a claim on the client's behalf), installation bookings and the packaging
 * photo. The admin acts as the owner (decision Б19: staff id null, via admin).
 *
 * Targets are checked against the order of the URL: a claim or booking id of another order is
 * refused. A photo is re-encoded (readPhotoForm) and stored under order/<order id>/<uuid>.jpg
 * before the engine call; a refused action deletes it again.
 */
import { and, claims, eq, installBookings, orderItems } from '@detaly/db';
import {
  CLAIM_DECISION_TEXT_MAX,
  CLAIM_KINDS,
  CLAIM_TEXT_MAX,
  type ClaimKind,
} from '@detaly/domain';
import { newFileKey, type FileStore } from '@detaly/files';
import {
  openClaim,
  performStaffAction,
  recordClaimCompensation,
  type EngineDeps,
  type StaffActionCode1C,
  type StaffActionInput,
  type StaffRef,
} from '@detaly/orders';
import { isUuid } from './queries';
import { formField, parseRubToKop } from './form-fields';

/** Engine buttons of 1C (availableStaffActions1C) and the admin-only claim forms. */
export const ADMIN_ACTION_CODES_1C = [
  'cret',
  'cref',
  'crepl',
  'crej',
  'cclose',
  'bconf',
  'bdecl',
  'bdone',
  'bnoshow',
  'pphoto',
  'claim_open',
  'claim_comp',
] as const satisfies readonly (StaffActionCode1C | 'claim_open' | 'claim_comp')[];
export type AdminAction1C = (typeof ADMIN_ACTION_CODES_1C)[number];

export function isAdminAction1C(value: string): value is AdminAction1C {
  return (ADMIN_ACTION_CODES_1C as readonly string[]).includes(value);
}

/** Actions that need a photo in the post (multipart/form-data). */
export const PHOTO_ACTIONS_1C: ReadonlySet<AdminAction1C> = new Set(['cret', 'pphoto']);

/** Irreversible 1C actions: the form carries the «подтверждаю» tick. */
export const DESTRUCTIVE_ACTIONS_1C: ReadonlySet<AdminAction1C> = new Set(['cref']);

const CLAIM_TARGET: ReadonlySet<AdminAction1C> = new Set([
  'cret',
  'cref',
  'crepl',
  'crej',
  'cclose',
  'claim_comp',
]);
const BOOKING_TARGET: ReadonlySet<AdminAction1C> = new Set(['bconf', 'bdecl', 'bdone', 'bnoshow']);

/** The admin as the engine sees it (decision Б19). */
export const ADMIN_STAFF: StaffRef = { id: null, role: 'owner', via: 'admin' };

export type Admin1CResult =
  { ok: true; message: string } | { ok: false; status: number; message: string };

export interface Admin1CContext {
  engine: EngineDeps;
  files: FileStore;
  orderId: string;
  form: URLSearchParams;
  /** Re-encoded JPEGs of the post (at most one). */
  photos: readonly Uint8Array[];
  confirmed: boolean;
}

function refused(status: number, message: string): Admin1CResult {
  return { ok: false, status, message };
}

async function claimOfOrder(ctx: Admin1CContext): Promise<string | null> {
  const claimId = formField(ctx.form, 'claimId', 64);
  if (!isUuid(claimId)) return null;
  const [row] = await ctx.engine.db
    .select({ id: claims.id })
    .from(claims)
    .where(and(eq(claims.id, claimId), eq(claims.orderId, ctx.orderId)));
  return row?.id ?? null;
}

async function bookingOfOrder(ctx: Admin1CContext): Promise<string | null> {
  const bookingId = formField(ctx.form, 'bookingId', 64);
  if (!isUuid(bookingId)) return null;
  const [row] = await ctx.engine.db
    .select({ id: installBookings.id })
    .from(installBookings)
    .where(and(eq(installBookings.id, bookingId), eq(installBookings.orderId, ctx.orderId)));
  return row?.id ?? null;
}

/** Stores the posted photo; null without one. Throws when the store fails. */
async function storePhoto(ctx: Admin1CContext): Promise<string | null> {
  const photo = ctx.photos[0];
  if (photo === undefined) return null;
  const key = newFileKey('order', ctx.orderId);
  await ctx.files.put(key, photo, 'image/jpeg');
  return key;
}

export async function performAdmin1CAction(
  action: AdminAction1C,
  ctx: Admin1CContext,
): Promise<Admin1CResult> {
  if (DESTRUCTIVE_ACTIONS_1C.has(action) && !ctx.confirmed) {
    return refused(400, 'Поставьте галочку «подтверждаю»: возврат денег не отменить');
  }
  let targetId = ctx.orderId;
  if (CLAIM_TARGET.has(action)) {
    const claimId = await claimOfOrder(ctx);
    if (claimId === null) return refused(404, 'Претензия не найдена в этом заказе');
    targetId = claimId;
  } else if (BOOKING_TARGET.has(action)) {
    const bookingId = await bookingOfOrder(ctx);
    if (bookingId === null) return refused(404, 'Запись не найдена в этом заказе');
    targetId = bookingId;
  }

  if (action === 'claim_comp') {
    const amountKop = parseRubToKop(formField(ctx.form, 'amountRub', 20));
    if (amountKop === null) return refused(422, 'Сумма компенсации: например 1234,50');
    const result = await recordClaimCompensation(ctx.engine, {
      claimId: targetId,
      amountKop,
      staff: ADMIN_STAFF,
    });
    return result.ok ? { ok: true, message: result.message } : refused(409, result.message);
  }
  if (action === 'claim_open') {
    const kind = formField(ctx.form, 'kind', 16);
    if (!(CLAIM_KINDS as readonly string[]).includes(kind)) {
      return refused(422, 'Выберите вид претензии');
    }
    const itemRaw = formField(ctx.form, 'itemId', 64);
    let itemId: string | null = null;
    if (itemRaw !== '') {
      if (!isUuid(itemRaw)) return refused(422, 'Позиция не найдена');
      const [item] = await ctx.engine.db
        .select({ id: orderItems.id })
        .from(orderItems)
        .where(and(eq(orderItems.id, itemRaw), eq(orderItems.orderId, ctx.orderId)));
      if (!item) return refused(404, 'Позиция не найдена в этом заказе');
      itemId = item.id;
    }
    const requestKey = formField(ctx.form, 'requestKey', 64).toLowerCase();
    if (!isUuid(requestKey)) return refused(400, 'Форма устарела — обновите карточку заказа');
    const text = formField(ctx.form, 'text', CLAIM_TEXT_MAX + 1);
    if (text.length > CLAIM_TEXT_MAX) {
      return refused(422, `Текст претензии — до ${CLAIM_TEXT_MAX} символов`);
    }
    const result = await openClaim(ctx.engine, {
      orderId: ctx.orderId,
      itemId,
      kind: kind as ClaimKind,
      text: text === '' ? null : text,
      photoKeys: [],
      via: 'admin',
      requestKey,
      actor: { type: 'staff', id: 'admin', staffRole: 'owner' },
    });
    if (result.ok) {
      return {
        ok: true,
        message: result.duplicate ? 'Претензия уже открыта' : 'Претензия открыта',
      };
    }
    return refused(result.reason === 'bad_input' ? 422 : 409, result.message);
  }

  const input: StaffActionInput = {};
  const note = formField(ctx.form, 'note');
  if (note !== '') input.note = note;
  if (action === 'cref' || action === 'crepl' || action === 'crej') {
    const text = formField(ctx.form, 'text', CLAIM_DECISION_TEXT_MAX + 1);
    if (text === '' || text.length > CLAIM_DECISION_TEXT_MAX) {
      return refused(
        422,
        `Напишите ответ клиенту — до ${CLAIM_DECISION_TEXT_MAX} символов: он увидит его на странице заказа`,
      );
    }
    input.text = text;
    const reason = formField(ctx.form, 'reason');
    if (action === 'cref' && reason !== '') input.reason = reason;
  }
  if (action === 'pphoto') {
    const kind = formField(ctx.form, 'photoKind', 16) || 'packaging';
    if (kind !== 'packaging' && kind !== 'handover') return refused(422, 'Неизвестный вид фото');
    input.photoKind = kind;
  }

  let photoKey: string | null = null;
  if (PHOTO_ACTIONS_1C.has(action)) {
    if (ctx.files.kind === 'none') {
      return refused(409, 'Хранилище фото не настроено (FILES_STORAGE)');
    }
    if (ctx.photos.length === 0) {
      return refused(
        422,
        action === 'cret' ? 'Приложите фото возвращённой детали' : 'Приложите фото упаковки',
      );
    }
    photoKey = await storePhoto(ctx);
    if (photoKey !== null) input.photoKey = photoKey;
  }

  const result = await performStaffAction(ctx.engine, {
    staff: ADMIN_STAFF,
    action,
    targetId,
    input,
  });
  if (!result.ok && photoKey !== null) {
    await ctx.files.delete(photoKey).catch(() => undefined);
  }
  return result.ok ? { ok: true, message: result.message } : refused(409, result.message);
}
