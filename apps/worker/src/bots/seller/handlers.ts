// Seller bot middleware. Strangers get silence: no reply, no "access denied", nothing that
// confirms the bot exists or what it can do. A button press from a stranger (or from a chat the
// bot does not serve) is answered with an empty answerCallbackQuery: Telegram keeps a spinner on
// the button until the query is answered, and an empty answer shows nothing.
import type { PingData } from '@detaly/notify';
import { renderPing } from '@detaly/notify';
import type { Context, Middleware } from 'grammy';
import type { IsStaff } from './staff';

/** Silence for a press: an empty answer, so the client stops the spinner and shows nothing. */
async function silentAnswer(ctx: Context): Promise<void> {
  if (!ctx.callbackQuery) return;
  try {
    await ctx.answerCallbackQuery();
  } catch {
    // an expired query cannot be answered
  }
}

/**
 * Lets through private chats and the sellers' group (TG_SELLER_CHAT_ID). Updates from any
 * other group or channel stop here without a reply.
 */
export function allowedChats(sellerChatId: number | undefined): Middleware<Context> {
  return async (ctx, next) => {
    const chat = ctx.chat;
    if (
      chat &&
      (chat.type === 'private' || (sellerChatId !== undefined && chat.id === sellerChatId))
    ) {
      await next();
      return;
    }
    await silentAnswer(ctx);
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
    if (userId === undefined || ctx.from?.is_bot || !(await isStaff(userId))) {
      await silentAnswer(ctx);
      return;
    }
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
