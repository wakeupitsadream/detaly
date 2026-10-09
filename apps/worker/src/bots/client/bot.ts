// Client bot (Telegram, grammY, long polling, TG_CLIENT_BOT_TOKEN; docs/phase-1c-implementation.md
// section 8, decisions С3–С6, С24). Private chats only: groups and channels get silence.
//
//   /start <token>  -> link token -> request_contact -> binding (bind.ts)
//   /start          -> orders of a bound account; a blocked one is switched back on
//   /orders         -> «Мои заказы»
//   /stop, «Отключить уведомления», my_chat_member kicked -> blocked_at
//   /garage         -> «Мои машины» (step 6, docs/garage.md; only with GARAGE_ENABLED, otherwise
//                      the auto reply like any unknown command)
//   buttons         -> callbacks.ts
//   anything else   -> «Бот присылает статусы заказов. Вопрос мастеру — по телефону …» (С24)
//
// Outgoing texts never carry the client's phone, name or address; logs never carry the contact,
// the Telegram user id or a token.
import type { Logger } from '@detaly/config';
import { findBindingUser, setMessengerBlocked } from '@detaly/orders';
import { Bot, type ApiClientOptions, type Context, type Middleware } from 'grammy';
import type { UserFromGetMe } from 'grammy/types';
import type { WorkerDeps } from '../../deps';
import { describeBotError } from '../seller/errors';
import { contactReceived, startPlain, startWithToken, unsubscribe } from './bind';
import { clientCallbackHandler } from './callbacks';
import { garageEnabled, sendGarage } from './garage';
import { sendOrdersList } from './menu';
import { TEXTS } from './texts';

export interface ClientBotOptions {
  token: string;
  deps: WorkerDeps;
  /** Pre-filled getMe result: skips the startup getMe call (tests, offline runs). */
  botInfo?: UserFromGetMe;
  client?: ApiClientOptions;
  logger?: Pick<Logger, 'error'>;
}

/**
 * Lets through private chats with a human sender. A press anywhere else gets an empty answer
 * (the spinner stops, nothing is said); other updates stop here without a reply.
 */
export function privateOnly(): Middleware<Context> {
  return async (ctx, next) => {
    if (ctx.chat?.type === 'private' && ctx.from !== undefined && !ctx.from.is_bot) {
      await next();
      return;
    }
    if (ctx.callbackQuery) await ctx.answerCallbackQuery().catch(() => undefined);
  };
}

export function createClientBot({ token, deps, botInfo, client, logger }: ClientBotOptions): Bot {
  const bot = new Bot(token, { botInfo, client });
  bot.use(privateOnly());

  // The person blocked the bot (decision С4): no reply is possible, the binding is switched off.
  // VERIFY: in a private chat Telegram reports «Stop and block bot» as my_chat_member with
  // new_chat_member.status 'kicked' (unblocking gives 'member', then /start arrives as a message).
  bot.on('my_chat_member', async (ctx) => {
    if (ctx.myChatMember.new_chat_member.status !== 'kicked') return;
    const changed = await setMessengerBlocked(deps.db, {
      channel: 'telegram',
      externalUserId: String(ctx.myChatMember.from.id),
      blocked: true,
      now: deps.now(),
    });
    deps.logger.info(
      { updateId: ctx.update.update_id, action: 'kicked', ok: changed },
      'client bot',
    );
  });

  // VERIFY: a deep link t.me/<bot>?start=<payload> arrives as the text «/start <payload>»;
  // the payload is at most 64 characters of [A-Za-z0-9_-] (the link token is 32).
  bot.command('start', async (ctx) => {
    const payload = typeof ctx.match === 'string' ? ctx.match.trim() : '';
    if (payload === '') return startPlain(ctx, deps);
    return startWithToken(ctx, deps, payload);
  });

  bot.command('orders', async (ctx) => {
    const binding = await findBindingUser(deps.db, {
      channel: 'telegram',
      externalUserId: String(ctx.from?.id ?? ''),
    });
    if (binding === null) return void (await ctx.reply(TEXTS.notConnected(deps.env.BRAND_NAME)));
    if (binding.blocked) return void (await ctx.reply(TEXTS.blocked));
    await sendOrdersList(ctx, deps, binding.userId);
  });

  // Step 6 (docs/garage.md): the client's cars with their orders, «Купить снова».
  if (garageEnabled(deps.env)) {
    bot.command('garage', async (ctx) => {
      const binding = await findBindingUser(deps.db, {
        channel: 'telegram',
        externalUserId: String(ctx.from?.id ?? ''),
      });
      if (binding === null) return void (await ctx.reply(TEXTS.notConnected(deps.env.BRAND_NAME)));
      if (binding.blocked) return void (await ctx.reply(TEXTS.blocked));
      const cars = await sendGarage(ctx, deps, binding.userId);
      deps.logger.info(
        { updateId: ctx.update.update_id, action: 'garage', ok: true, cars },
        'client bot',
      );
    });
  }

  bot.command('stop', async (ctx) => {
    const changed = await unsubscribe(ctx, deps);
    await ctx.reply(changed ? TEXTS.stopped : TEXTS.notConnected(deps.env.BRAND_NAME));
  });

  bot.on('message:contact', (ctx) => contactReceived(ctx, deps));
  bot.on('callback_query:data', clientCallbackHandler(deps));
  // A game or an inline-mode button: stop the spinner, say nothing.
  bot.on('callback_query', async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => undefined);
  });

  // Text, photos, unknown commands: the bot is not a chat with the master (С24, chat_messages
  // is phase 2).
  bot.on('message', async (ctx) => {
    await ctx.reply(TEXTS.autoReply(deps.env.PICKUP_PHONE ?? null));
  });

  // Without bot.catch an error in a handler stops long polling. The raw grammY error carries
  // the token and the request payload (texts, chat ids): log the safe description only.
  bot.catch((error) => {
    (logger ?? deps.logger).error(
      { err: describeBotError(error.error, token), updateId: error.ctx.update.update_id },
      'client bot handler failed',
    );
  });
  return bot;
}
