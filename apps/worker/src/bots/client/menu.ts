// Menus of the client bot: «Мои заказы» and the installation slots (docs/phase-1c-implementation.md
// section 8, decision С6). A slot button carries a random nonce; the slot it stands for lives in
// Redis `<prefix>client:slot:<nonce>` for 15 minutes (callback_data has no room for an ISO time).
import { createHash } from 'node:crypto';
import { eq, orders } from '@detaly/db';
import { parseWorkHours, type OrderStatus } from '@detaly/domain';
import { newNonce } from '@detaly/notify';
import { installSlotsForOrder, isUuid, type InstallSlotsReason } from '@detaly/orders';
import type { Context } from 'grammy';
import type { InlineKeyboardButton } from 'grammy/types';
import type { WorkerDeps } from '../../deps';
import { orderUrl } from '../../jobs/notify/template-data';
import {
  callbackButton,
  installEnabled,
  loadClientOrders,
  renderOrdersList,
  urlButton,
} from './orders';
import { CLIENT_STATUS_LABELS, TEXTS } from './texts';

export const SLOT_CHOICE_TTL_SEC = 15 * 60;
const SLOTS_PER_ROW = 2;

/** `<prefix>client:slot:<nonce>` (decision С6). */
export function slotKey(keyPrefix: string, nonce: string): string {
  return `${keyPrefix}client:slot:${nonce}`;
}

export interface SlotChoice {
  orderId: string;
  userId: string;
  /** InstallSlot.startAt: ISO with the offset. */
  startAt: string;
}

export function parseSlotChoice(raw: string | null): SlotChoice | null {
  if (raw === null) return null;
  try {
    const value = JSON.parse(raw) as Partial<SlotChoice>;
    if (!isUuid(value.orderId) || !isUuid(value.userId) || typeof value.startAt !== 'string') {
      return null;
    }
    return { orderId: value.orderId, userId: value.userId, startAt: value.startAt };
  } catch {
    return null;
  }
}

/**
 * bookInstall's request key of a slot button: the same nonce gives the same key, so a double
 * press (or a retried update) returns the booking already made instead of a second one.
 */
export function slotRequestKey(nonce: string): string {
  const hex = createHash('sha256').update(`client-slot:${nonce}`).digest('hex');
  // RFC 9562 layout: version 8 (custom), variant 10xx.
  const variant = ((parseInt(hex.charAt(16), 16) & 0x3) | 0x8).toString(16);
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    `8${hex.slice(13, 16)}`,
    `${variant}${hex.slice(17, 20)}`,
    hex.slice(20, 32),
  ].join('-');
}

export interface OwnedOrder {
  id: string;
  number: string;
  status: OrderStatus;
  accessToken: string;
  userId: string;
}

/** The order when it belongs to `userId` (decision С5), otherwise null. */
export async function loadOwnedOrder(
  deps: Pick<WorkerDeps, 'db'>,
  orderId: string,
  userId: string,
): Promise<OwnedOrder | null> {
  if (!isUuid(orderId)) return null;
  const [order] = await deps.db
    .select({
      id: orders.id,
      number: orders.number,
      status: orders.status,
      accessToken: orders.accessToken,
      userId: orders.userId,
    })
    .from(orders)
    .where(eq(orders.id, orderId));
  return order && order.userId === userId ? order : null;
}

/** «Мои заказы» as a new message. */
export async function sendOrdersList(
  ctx: Context,
  deps: WorkerDeps,
  userId: string,
): Promise<void> {
  const views = await loadClientOrders(deps.db, userId);
  const list = renderOrdersList(views, deps.env);
  await ctx.reply(list.text, {
    reply_markup: { inline_keyboard: list.keyboard },
    link_preview_options: { is_disabled: true },
  });
}

/** «Установка — услуга …, оплачивается в сервисе по его чеку» (no price, decision С6). */
export function installPaidText(deps: Pick<WorkerDeps, 'env'>): string {
  return TEXTS.installPaid(
    deps.env.INSTALL_PARTNER_NAME ?? '',
    deps.env.INSTALL_PARTNER_REQUISITES ?? null,
  );
}

function reasonText(reason: InstallSlotsReason | undefined, order: OwnedOrder): string {
  switch (reason) {
    case 'status':
      return TEXTS.installStatus(CLIENT_STATUS_LABELS[order.status]);
    case 'booked':
      return TEXTS.installBooked;
    case 'no_date':
      return TEXTS.installNoDate;
    case 'no_hours':
      return TEXTS.installNoHours;
    case 'full':
    case undefined:
      return TEXTS.installFull;
  }
}

/**
 * Up to six slot buttons of the order (installSlotsForOrder) plus «Другое время — на странице
 * заказа»; an empty list is explained in words. `lead` goes first (e.g. «Это время уже заняли»).
 */
export async function sendInstallSlots(
  ctx: Context,
  deps: WorkerDeps,
  order: OwnedOrder,
  lead: string | null = null,
): Promise<number> {
  const pageButton = urlButton(
    TEXTS.installOther,
    `${orderUrl(deps.env, order.accessToken)}#install`,
  );
  if (!installEnabled(deps.env)) {
    await ctx.reply(TEXTS.installOff);
    return 0;
  }
  const { slots, reason } = await installSlotsForOrder(deps.db, {
    orderId: order.id,
    now: deps.now(),
    schedule: parseWorkHours(deps.env.PICKUP_HOURS ?? null),
  });
  if (slots.length === 0) {
    await ctx.reply([lead, reasonText(reason, order)].filter(Boolean).join('\n'), {
      reply_markup: { inline_keyboard: [[pageButton]] },
    });
    return 0;
  }
  const buttons: InlineKeyboardButton[] = [];
  for (const slot of slots) {
    const nonce = newNonce();
    const choice: SlotChoice = { orderId: order.id, userId: order.userId, startAt: slot.startAt };
    await deps.redis.set(
      slotKey(deps.keyPrefix, nonce),
      JSON.stringify(choice),
      'EX',
      SLOT_CHOICE_TTL_SEC,
    );
    buttons.push(
      callbackButton(`${slot.dayText} · ${slot.timeText}`, 'islot', order.id, () => nonce),
    );
  }
  const rows: InlineKeyboardButton[][] = [];
  for (let i = 0; i < buttons.length; i += SLOTS_PER_ROW) {
    rows.push(buttons.slice(i, i + SLOTS_PER_ROW));
  }
  rows.push([pageButton]);
  await ctx.reply(
    [lead, TEXTS.installChoose(order.number), installPaidText(deps)].filter(Boolean).join('\n'),
    { reply_markup: { inline_keyboard: rows } },
  );
  return slots.length;
}
