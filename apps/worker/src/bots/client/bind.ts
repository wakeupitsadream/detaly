// Binding the client bot to a user (docs/phase-1c-implementation.md decisions С3, С4; PLAN
// section 4 «Привязка»): `/start <link token>` takes the one-time token, the bot asks for the
// phone with a request_contact keyboard and waits in Redis `<prefix>client:bind:<tg user id>`
// (10 minutes, value {userId, orderId}); the contact counts only when it is the sender's own
// (contact.user_id === from.id) and its number, normalised, equals users.phone. A binding is a
// subscription to order statuses, not an authorization.
//
// Never logged: the token, the contact, the phone, the Telegram user id.
import { eq, orders, users } from '@detaly/db';
import { normalizePhone } from '@detaly/domain';
import {
  bindMessenger,
  consumeLinkToken,
  findBindingUser,
  isLinkToken,
  isUuid,
  setMessengerBlocked,
} from '@detaly/orders';
import type { Context } from 'grammy';
import type { WorkerDeps } from '../../deps';
import { sendOrdersList } from './menu';
import { TEXTS } from './texts';

export const BIND_WAIT_TTL_SEC = 10 * 60;

/** `<prefix>client:bind:<tg_user_id>` (decision С3). */
export function bindKey(keyPrefix: string, tgUserId: number): string {
  return `${keyPrefix}client:bind:${tgUserId}`;
}

interface BindWait {
  userId: string;
  orderId: string | null;
}

function parseWait(raw: string | null): BindWait | null {
  if (raw === null) return null;
  try {
    const value = JSON.parse(raw) as Partial<BindWait>;
    if (!isUuid(value.userId)) return null;
    return { userId: value.userId, orderId: isUuid(value.orderId) ? value.orderId : null };
  } catch {
    return null;
  }
}

const REMOVE_KEYBOARD = { remove_keyboard: true } as const;

function contactKeyboard() {
  return {
    keyboard: [[{ text: TEXTS.contactButton, request_contact: true }]],
    one_time_keyboard: true,
    resize_keyboard: true,
  };
}

/** `/start <token>`: takes the link token once and asks for the phone. */
export async function startWithToken(ctx: Context, deps: WorkerDeps, token: string): Promise<void> {
  const from = ctx.from;
  if (from === undefined) return;
  const taken = isLinkToken(token)
    ? await consumeLinkToken(deps.db, {
        token,
        externalUserId: String(from.id),
        now: deps.now(),
      })
    : null;
  // Unknown, used (another account pressed it first) or expired: one answer for all three.
  if (taken === null || taken.channel !== 'telegram') {
    deps.logger.info({ updateId: ctx.update.update_id, action: 'start', ok: false }, 'client bot');
    await ctx.reply(TEXTS.staleLink, { reply_markup: REMOVE_KEYBOARD });
    return;
  }
  const wait: BindWait = { userId: taken.userId, orderId: taken.orderId };
  await deps.redis.set(
    bindKey(deps.keyPrefix, from.id),
    JSON.stringify(wait),
    'EX',
    BIND_WAIT_TTL_SEC,
  );
  let orderNumber: string | null = null;
  if (taken.orderId !== null) {
    const [order] = await deps.db
      .select({ number: orders.number })
      .from(orders)
      .where(eq(orders.id, taken.orderId));
    orderNumber = order?.number ?? null;
  }
  deps.logger.info(
    { updateId: ctx.update.update_id, orderNumber, action: 'start', ok: true },
    'client bot',
  );
  await ctx.reply(TEXTS.askContact(orderNumber), { reply_markup: contactKeyboard() });
}

/**
 * `/start` without a token: a bound account sees its orders, a blocked one is switched back on
 * (the person came back, decision С4), a stranger learns how to connect.
 */
export async function startPlain(ctx: Context, deps: WorkerDeps): Promise<void> {
  const from = ctx.from;
  if (from === undefined) return;
  const binding = await findBindingUser(deps.db, {
    channel: 'telegram',
    externalUserId: String(from.id),
  });
  if (binding === null) {
    await ctx.reply(TEXTS.howToConnect(deps.env.BRAND_NAME));
    return;
  }
  if (binding.blocked) {
    await setMessengerBlocked(deps.db, {
      channel: 'telegram',
      externalUserId: String(from.id),
      blocked: false,
      now: deps.now(),
    });
    deps.logger.info({ updateId: ctx.update.update_id, action: 'unblock' }, 'client bot');
    await ctx.reply(TEXTS.unblocked);
  }
  await sendOrdersList(ctx, deps, binding.userId);
}

/** A shared contact: binds the account when it is the sender's own number of the order. */
export async function contactReceived(ctx: Context, deps: WorkerDeps): Promise<void> {
  const from = ctx.from;
  const chat = ctx.chat;
  const contact = ctx.message?.contact;
  if (from === undefined || chat === undefined || contact === undefined) return;
  const key = bindKey(deps.keyPrefix, from.id);
  // Someone else's card from the address book (or a contact without a Telegram account).
  // VERIFY: a contact shared with the request_contact button carries user_id = the sender's id;
  // a card forwarded from the address book has another user_id or none.
  if (contact.user_id !== from.id) {
    const pending = (await deps.redis.exists(key)) === 1;
    await ctx.reply(
      pending ? TEXTS.notOwnContact : TEXTS.noPendingBind,
      pending ? { reply_markup: contactKeyboard() } : { reply_markup: REMOVE_KEYBOARD },
    );
    return;
  }
  // GETDEL: one contact per link (a mismatch burns it too, decision С3).
  const wait = parseWait(await deps.redis.getdel(key));
  if (wait === null) {
    await ctx.reply(TEXTS.noPendingBind, { reply_markup: REMOVE_KEYBOARD });
    return;
  }
  // VERIFY: Telegram sends phone_number with or without the leading «+» (79…, +79…):
  // normalizePhone accepts both, and 8… too.
  const shared = normalizePhone(contact.phone_number);
  const [user] = await deps.db
    .select({ phone: users.phone })
    .from(users)
    .where(eq(users.id, wait.userId));
  const expected = user ? normalizePhone(user.phone) : null;
  if (shared === null || expected === null || shared !== expected) {
    deps.logger.info({ updateId: ctx.update.update_id, action: 'bind', ok: false }, 'client bot');
    await ctx.reply(TEXTS.phoneMismatch, { reply_markup: REMOVE_KEYBOARD });
    return;
  }
  await bindMessenger(deps.db, {
    userId: wait.userId,
    orderId: wait.orderId,
    channel: 'telegram',
    externalUserId: String(from.id),
    chatId: String(chat.id),
    now: deps.now(),
  });
  deps.logger.info({ updateId: ctx.update.update_id, action: 'bind', ok: true }, 'client bot');
  await ctx.reply(TEXTS.bound, { reply_markup: REMOVE_KEYBOARD });
  await sendOrdersList(ctx, deps, wait.userId);
}

/** /stop and «Отключить уведомления»: blocked_at, no journal (decision С4). */
export async function unsubscribe(ctx: Context, deps: WorkerDeps): Promise<boolean> {
  const from = ctx.from;
  if (from === undefined) return false;
  const changed = await setMessengerBlocked(deps.db, {
    channel: 'telegram',
    externalUserId: String(from.id),
    blocked: true,
    now: deps.now(),
  });
  deps.logger.info({ updateId: ctx.update.update_id, action: 'stop', ok: changed }, 'client bot');
  return changed;
}
