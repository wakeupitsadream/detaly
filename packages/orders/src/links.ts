/**
 * Messenger links (docs/phase-1c-implementation.md decisions С3, С4): a one-time deep-link token
 * from /o/<token>, its atomic consumption by the client bot and the binding written after the
 * phone in the shared contact matched users.phone. A binding is a subscription to order statuses,
 * not an authorization: it never opens the order page by itself.
 *
 * Never log a token, an external id or a phone.
 */
import { randomBytes } from 'node:crypto';
import {
  and,
  eq,
  gt,
  isNull,
  linkTokens,
  messengerBindings,
  orders,
  sql,
  users,
  type Executor,
} from '@detaly/db';
import { LINK_TOKEN_TTL_MS, type MessengerChannel } from '@detaly/domain';
import { recordJournalEvent } from './journal';
import { isUuid } from './snapshot';
import type { MessengerStatus } from './types';

/** link_tokens.token: base64url of 24 random bytes (32 characters, 192 bits). */
const TOKEN_BYTES = 24;
/** The database CHECK on link_tokens.token: Telegram allows 64 characters after /start. */
const TOKEN_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** A token as it may come from `/start <payload>`: anything else is not looked up. */
export function isLinkToken(value: unknown): value is string {
  return typeof value === 'string' && TOKEN_RE.test(value);
}

/**
 * A new one-time link token for the deep link `t.me/<bot>?start=<token>` (never the order page
 * token). The caller shows the button only when TG_CLIENT_BOT_USERNAME is set.
 */
export async function createLinkToken(
  db: Executor,
  input: { userId: string; orderId?: string | null; channel: MessengerChannel; now?: Date },
): Promise<{ token: string; expiresAt: Date }> {
  if (!isUuid(input.userId)) throw new TypeError('createLinkToken: bad user id');
  const orderId = input.orderId ?? null;
  if (orderId !== null) {
    if (!isUuid(orderId)) throw new TypeError('createLinkToken: bad order id');
    const [order] = await db
      .select({ id: orders.id })
      .from(orders)
      .where(and(eq(orders.id, orderId), eq(orders.userId, input.userId)));
    if (!order) throw new TypeError('createLinkToken: the order is not the user’s');
  }
  const now = input.now ?? new Date();
  const token = randomBytes(TOKEN_BYTES).toString('base64url');
  const expiresAt = new Date(now.getTime() + LINK_TOKEN_TTL_MS);
  await db.insert(linkTokens).values({
    token,
    userId: input.userId,
    orderId,
    channel: input.channel,
    expiresAt,
    createdAt: now,
  });
  return { token, expiresAt };
}

/**
 * Takes a token once: `update … where used_at is null and expires_at > now returning`, so two
 * accounts pressing the same link get it at most once. null: unknown, used or expired.
 */
export async function consumeLinkToken(
  db: Executor,
  input: { token: string; externalUserId: string; now?: Date },
): Promise<{ userId: string; orderId: string | null; channel: MessengerChannel } | null> {
  if (!isLinkToken(input.token)) return null;
  const externalUserId = String(input.externalUserId).slice(0, 64);
  if (externalUserId === '') return null;
  const now = input.now ?? new Date();
  const [row] = await db
    .update(linkTokens)
    .set({ usedAt: now, usedByExternalId: externalUserId })
    .where(
      and(
        eq(linkTokens.token, input.token),
        isNull(linkTokens.usedAt),
        gt(linkTokens.expiresAt, now),
      ),
    )
    .returning({
      userId: linkTokens.userId,
      orderId: linkTokens.orderId,
      channel: linkTokens.channel,
    });
  if (!row || row.userId === null) return null;
  return { userId: row.userId, orderId: row.orderId, channel: row.channel };
}

/**
 * Binds a messenger account to the user after the phone was confirmed (decision С3): upsert by
 * (channel, external_user_id) — the same account bound to another user moves over — with
 * is_primary (the user's other bindings lose it in the same transaction), phone_confirmed_at and
 * blocked_at cleared. Journal `messenger_bound` in the order of the link, without external ids.
 */
export async function bindMessenger(
  db: Executor,
  input: {
    userId: string;
    orderId?: string | null;
    channel: MessengerChannel;
    externalUserId: string;
    chatId: string;
    now?: Date;
  },
): Promise<{ bindingId: string }> {
  if (!isUuid(input.userId)) throw new TypeError('bindMessenger: bad user id');
  const externalUserId = String(input.externalUserId);
  const chatId = String(input.chatId);
  if (externalUserId === '' || chatId === '') throw new TypeError('bindMessenger: empty id');
  const now = input.now ?? new Date();
  return db.transaction(async (tx) => {
    // One binding at a time per user: the partial unique index allows one primary row.
    const [user] = await tx
      .select({ id: users.id })
      .from(users)
      .where(eq(users.id, input.userId))
      .for('update');
    if (!user) throw new TypeError('bindMessenger: unknown user');
    await tx
      .update(messengerBindings)
      .set({ isPrimary: false, updatedAt: now })
      .where(
        and(
          eq(messengerBindings.userId, input.userId),
          eq(messengerBindings.isPrimary, true),
          sql`not (${messengerBindings.channel} = ${input.channel} and ${messengerBindings.externalUserId} = ${externalUserId})`,
        ),
      );
    const [binding] = await tx
      .insert(messengerBindings)
      .values({
        userId: input.userId,
        channel: input.channel,
        externalUserId,
        chatId,
        phoneConfirmedAt: now,
        isPrimary: true,
        blockedAt: null,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [messengerBindings.channel, messengerBindings.externalUserId],
        set: {
          userId: input.userId,
          chatId,
          phoneConfirmedAt: now,
          isPrimary: true,
          blockedAt: null,
          updatedAt: now,
        },
      })
      .returning({ id: messengerBindings.id });
    const bindingId = (binding as { id: string }).id;
    const orderId = input.orderId ?? null;
    if (orderId !== null && isUuid(orderId)) {
      const [order] = await tx
        .select({ id: orders.id })
        .from(orders)
        .where(and(eq(orders.id, orderId), eq(orders.userId, input.userId)));
      if (order) {
        await recordJournalEvent(tx, {
          orderId,
          type: 'messenger_bound',
          actor: { type: 'client', id: input.userId },
          payload: { channel: input.channel, bindingId },
          at: now,
        });
      }
    }
    return { bindingId };
  });
}

/**
 * /stop, «Отключить уведомления» or a kicked bot set blocked_at; /start without a token from a
 * blocked account clears it (decision С4). No journal: it is the person's choice, not the
 * order's. false when the account has no binding.
 */
export async function setMessengerBlocked(
  db: Executor,
  input: { channel: MessengerChannel; externalUserId: string; blocked: boolean; now?: Date },
): Promise<boolean> {
  const now = input.now ?? new Date();
  const rows = await db
    .update(messengerBindings)
    .set({
      blockedAt: input.blocked
        ? sql`coalesce(${messengerBindings.blockedAt}, ${now.toISOString()}::timestamptz)`
        : null,
      updatedAt: now,
    })
    .where(
      and(
        eq(messengerBindings.channel, input.channel),
        eq(messengerBindings.externalUserId, String(input.externalUserId)),
      ),
    )
    .returning({ id: messengerBindings.id });
  return rows.length > 0;
}

/** The user an account is bound to (client bot presses, decision С5). */
export async function findBindingUser(
  db: Executor,
  input: { channel: MessengerChannel; externalUserId: string },
): Promise<{ userId: string; blocked: boolean } | null> {
  const [row] = await db
    .select({ userId: messengerBindings.userId, blockedAt: messengerBindings.blockedAt })
    .from(messengerBindings)
    .where(
      and(
        eq(messengerBindings.channel, input.channel),
        eq(messengerBindings.externalUserId, String(input.externalUserId)),
      ),
    );
  return row ? { userId: row.userId, blocked: row.blockedAt !== null } : null;
}

/** «Статусы в Telegram» on /o/<token>: active, switched off by the client, or none. */
export async function messengerStatus(db: Executor, userId: string): Promise<MessengerStatus> {
  if (!isUuid(userId)) return { telegram: 'none', max: 'none' };
  const rows = await db
    .select({ blockedAt: messengerBindings.blockedAt })
    .from(messengerBindings)
    .where(and(eq(messengerBindings.userId, userId), eq(messengerBindings.channel, 'telegram')));
  const telegram =
    rows.length === 0 ? 'none' : rows.some((row) => row.blockedAt === null) ? 'active' : 'blocked';
  return { telegram, max: 'none' };
}
