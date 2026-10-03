// «Мои заказы» of the client bot (docs/phase-1c-implementation.md section 8): up to five latest
// orders of the bound user with the number, the status in the client's words, «Бренд Артикул»,
// the nearest action and buttons by status. No phone, name or address (PLAN section 4).
import type { Env } from '@detaly/config';
import {
  and,
  asc,
  desc,
  eq,
  inArray,
  installBookings,
  orderItems,
  orders,
  sql,
  type Db,
} from '@detaly/db';
import {
  DROPPED_ORDER_ITEM_STATES,
  INSTALL_BOOKABLE_STATUSES,
  INSTALL_HOLDING_STATUSES,
  type InstallBookingStatus,
  type OrderItemState,
  type OrderStatus,
} from '@detaly/domain';
import { buildCallbackData, itemsLine, newNonce, type CallbackAction } from '@detaly/notify';
import { bookingSlot } from '@detaly/orders';
import type { InlineKeyboardButton } from 'grammy/types';
import { orderUrl } from '../../jobs/notify/template-data';
import { CLIENT_STATUS_LABELS, TEXTS } from './texts';

/** How many orders /orders shows. */
export const CLIENT_ORDERS_SHOWN = 5;

/**
 * The `<id>` of list-level buttons («Мои заказы», «Отключить уведомления»): they act on the
 * pressing user, not on an order (actionTarget of @detaly/notify says the same).
 */
export const LIST_TARGET = 'me';

const DROPPED: readonly OrderItemState[] = DROPPED_ORDER_ITEM_STATES;
const BOOKABLE: readonly OrderStatus[] = INSTALL_BOOKABLE_STATUSES;
const HOLDING: readonly InstallBookingStatus[] = INSTALL_HOLDING_STATUSES;
/** The pickup code is shown from `ready` on, as on the order page (decision Д13). */
const CODE_SHOWN: readonly OrderStatus[] = ['ready', 'awaiting_handover_payment'];
/** «Претензия» opens the claim form of the order page (decision С5). */
const CLAIM_SHOWN: readonly OrderStatus[] = ['handed', 'completed'];

export interface ClientOrderView {
  id: string;
  number: string;
  status: OrderStatus;
  accessToken: string;
  pickupCode: string | null;
  items: { brand: string; article: string }[];
  booking: { slotAt: Date; status: InstallBookingStatus } | null;
}

/** The user's latest orders (drafts excluded), newest first. */
export async function loadClientOrders(
  db: Db,
  userId: string,
  limit: number = CLIENT_ORDERS_SHOWN,
): Promise<ClientOrderView[]> {
  const rows = await db
    .select({
      id: orders.id,
      number: orders.number,
      status: orders.status,
      accessToken: orders.accessToken,
      pickupCode: orders.pickupCode,
    })
    .from(orders)
    .where(and(eq(orders.userId, userId), sql`${orders.status} <> 'draft'`))
    .orderBy(desc(orders.createdAt), desc(orders.id))
    .limit(limit);
  if (rows.length === 0) return [];
  const ids = rows.map((row) => row.id);
  const items = await db
    .select({
      orderId: orderItems.orderId,
      brand: orderItems.brand,
      article: orderItems.article,
      state: orderItems.state,
    })
    .from(orderItems)
    .where(inArray(orderItems.orderId, ids))
    .orderBy(asc(orderItems.createdAt), asc(orderItems.id));
  const bookings = await db
    .select({
      orderId: installBookings.orderId,
      slotAt: installBookings.slotAt,
      status: installBookings.status,
    })
    .from(installBookings)
    .where(
      and(inArray(installBookings.orderId, ids), inArray(installBookings.status, [...HOLDING])),
    );
  return rows.map((row) => {
    const booking = bookings.find((b) => b.orderId === row.id) ?? null;
    return {
      ...row,
      items: items
        .filter((item) => item.orderId === row.id && !DROPPED.includes(item.state))
        .map((item) => ({ brand: item.brand, article: item.article })),
      booking: booking ? { slotAt: booking.slotAt, status: booking.status } : null,
    };
  });
}

export function callbackButton(
  text: string,
  action: CallbackAction,
  id: string,
  nonce: () => string = newNonce,
): InlineKeyboardButton {
  return { text, callback_data: buildCallbackData(action, id, nonce()) };
}

export function urlButton(text: string, url: string): InlineKeyboardButton {
  return { text, url };
}

/** The installation booking of the client bot is on (decision С6). */
export function installEnabled(env: Pick<Env, 'INSTALL_PARTNER_NAME'>): boolean {
  return Boolean(env.INSTALL_PARTNER_NAME);
}

/** The nearest step of an order in the client's words (statuses without a step are absent). */
const NEXT_STEPS: Partial<Record<OrderStatus, string>> = {
  awaiting_payment: 'Оплатите заказ на странице заказа.',
  awaiting_confirmation: 'Подтвердите заказ.',
  awaiting_client_approval: 'Нужно ваше решение — подробности на странице заказа.',
  ready: 'Можно забирать.',
  awaiting_handover_payment: 'Оплата при получении.',
  handed: '7 дней на отказ — памятка на странице заказа.',
};

function nextStep(order: ClientOrderView): string | null {
  if (order.booking !== null) {
    const slot = bookingSlot(order.booking.slotAt);
    const state = order.booking.status === 'confirmed' ? 'подтверждена' : 'ждём подтверждения';
    return `${TEXTS.installRequested(`${slot.dayText} ${slot.timeText}`)} — ${state}.`;
  }
  const step = NEXT_STEPS[order.status] ?? null;
  // The pickup code is not PD (decision С2); it is shown from `ready` on.
  if (order.pickupCode && CODE_SHOWN.includes(order.status)) {
    return `${step ?? ''} Код выдачи: ${order.pickupCode}`.trim();
  }
  return step;
}

/** Buttons of one order; `prefix` labels them with the order number in a list of several. */
export function orderButtons(
  order: ClientOrderView,
  env: Pick<Env, 'APP_BASE_URL' | 'INSTALL_PARTNER_NAME'>,
  prefix: string,
  nonce: () => string = newNonce,
): InlineKeyboardButton[][] {
  const rows: InlineKeyboardButton[][] = [];
  const url = orderUrl(env, order.accessToken);
  if (order.status === 'awaiting_confirmation') {
    rows.push([callbackButton(`${prefix}Подтверждаю`, 'confirm', order.id, nonce)]);
  }
  if (order.status === 'awaiting_client_approval') {
    rows.push([
      callbackButton(`${prefix}Согласен`, 'approve', order.id, nonce),
      callbackButton(`${prefix}Вернуть деньги`, 'refund', order.id, nonce),
    ]);
  }
  if (installEnabled(env) && order.booking === null && BOOKABLE.includes(order.status)) {
    rows.push([callbackButton(`${prefix}Записаться на установку`, 'install', order.id, nonce)]);
  }
  const links: InlineKeyboardButton[] = [];
  if (CLAIM_SHOWN.includes(order.status))
    links.push(urlButton(`${prefix}Претензия`, `${url}#claim`));
  links.push(urlButton(`${prefix}Открыть заказ`, url));
  rows.push(links);
  return rows;
}

export interface RenderedList {
  text: string;
  keyboard: InlineKeyboardButton[][];
}

/** «Мои заказы»: one message, a block per order, buttons labelled by order when there are several. */
export function renderOrdersList(
  views: readonly ClientOrderView[],
  env: Pick<Env, 'APP_BASE_URL' | 'INSTALL_PARTNER_NAME'>,
  nonce: () => string = newNonce,
): RenderedList {
  const unsub = [callbackButton('Отключить уведомления', 'unsub', LIST_TARGET, nonce)];
  if (views.length === 0) return { text: TEXTS.noOrders, keyboard: [unsub] };
  const blocks = views.map((order) => {
    const what = itemsLine(order.items);
    const step = nextStep(order);
    return [
      `${order.number} — ${CLIENT_STATUS_LABELS[order.status]}`,
      what === '' ? null : what,
      step,
    ]
      .filter((line): line is string => line !== null)
      .join('\n');
  });
  const several = views.length > 1;
  const keyboard = views.flatMap((order) =>
    orderButtons(order, env, several ? `${order.number} · ` : '', nonce),
  );
  keyboard.push(unsub);
  return { text: [TEXTS.ordersHead, ...blocks].join('\n\n'), keyboard };
}
