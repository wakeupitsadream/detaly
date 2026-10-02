// Seller bot middleware. Strangers get silence: no reply, no "access denied", nothing that
// confirms the bot exists or what it can do.
import type { PingData } from '@detaly/notify';
import { renderPing } from '@detaly/notify';
import type { Context, Middleware } from 'grammy';
import type { IsStaff } from './staff';

/**
 * Lets through private chats and the sellers' group (TG_SELLER_CHAT_ID). Updates from any
 * other group or channel stop here without a reply.
 */
export function allowedChats(sellerChatId: number | undefined): Middleware<Context> {
  return async (ctx, next) => {
    const chat = ctx.chat;
    if (!chat) return;
    if (chat.type === 'private' || (sellerChatId !== undefined && chat.id === sellerChatId)) {
      await next();
    }
  };
}

/**
 * Calls next() only for active staff. Updates without `from` (channel posts), bots and
 * non-staff users (anonymous group admins included: they appear as a service account) stop
 * here: silence.
 */
export function staffOnly(isStaff: IsStaff): Middleware<Context> {
  return async (ctx, next) => {
    const userId = ctx.from?.id;
    if (userId === undefined || ctx.from?.is_bot) return;
    if (!(await isStaff(userId))) return;
    await next();
  };
}

/** /ping → "pong · heartbeat Ns · db ok · <GIT_SHA>". */
export function pingHandler(health: () => Promise<PingData>): Middleware<Context> {
  return async (ctx) => {
    const message = renderPing(await health());
    await ctx.reply(message.text);
  };
}
