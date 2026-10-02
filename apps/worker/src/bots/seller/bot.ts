// Seller bot (Telegram, grammY, long polling). Phase 0: /ping for staff only.
import type { Logger } from '@detaly/config';
import type { PingData } from '@detaly/notify';
import { Bot, type ApiClientOptions } from 'grammy';
import type { UserFromGetMe } from 'grammy/types';
import { allowedChats, pingHandler, staffOnly } from './handlers';
import type { IsStaff } from './staff';

export interface SellerBotOptions {
  token: string;
  isStaff: IsStaff;
  health: () => Promise<PingData>;
  /** Pre-filled getMe result: skips the startup getMe call (tests, offline runs). */
  botInfo?: UserFromGetMe;
  /** TG_SELLER_CHAT_ID: the sellers' group where staff commands also work. */
  sellerChatId?: number;
  logger?: Pick<Logger, 'error'>;
  client?: ApiClientOptions;
}

export function createSellerBot({
  token,
  isStaff,
  health,
  botInfo,
  sellerChatId,
  logger,
  client,
}: SellerBotOptions): Bot {
  const bot = new Bot(token, { botInfo, client });
  bot.use(allowedChats(sellerChatId));
  bot.use(staffOnly(isStaff));
  bot.command('ping', pingHandler(health));
  // Without bot.catch an error in a handler stops long polling.
  bot.catch((error) => {
    logger?.error(
      { err: error.error, updateId: error.ctx.update.update_id },
      'seller bot handler failed',
    );
  });
  return bot;
}

/** Update types the seller bot consumes (commands arrive as messages). */
export const SELLER_BOT_UPDATES = ['message'] as const;

/**
 * Starts long polling in the background. A startup failure (no network, bad token) is
 * logged and does not take the worker down: queues and the heartbeat keep running.
 */
export function startSellerBot(bot: Bot, logger: Pick<Logger, 'info' | 'error'>): void {
  bot
    .start({
      allowed_updates: SELLER_BOT_UPDATES,
      onStart: (info) => logger.info({ username: info.username }, 'seller bot started'),
    })
    .catch((error: unknown) => {
      logger.error({ err: error }, 'seller bot stopped with an error');
    });
}
