// Seller bot (Telegram, grammY, long polling). Staff only: /ping (phase 0); with `deps` (phase
// 1B, docs/phase-1b-implementation.md section 13): order card buttons, «Счёт оплачен» with a
// ForceReply and /queues for the owner.
import type { Logger } from '@detaly/config';
import type { PingData } from '@detaly/notify';
import { Bot, type ApiClientOptions } from 'grammy';
import type { UserFromGetMe } from 'grammy/types';
import type { WorkerDeps } from '../../deps';
import { callbackHandler } from './callbacks';
import { createCardService } from './cards';
import { describeBotError, toSafeError } from './errors';
import { allowedChats, pingHandler, staffOnly } from './handlers';
import { invoiceReplyHandler } from './invoice';
import { queuesCommand } from './queues';
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
  /** Phase 1B: engine, cards and inspector for order buttons and /queues. */
  deps?: WorkerDeps;
}

export function createSellerBot({
  token,
  isStaff,
  health,
  botInfo,
  sellerChatId,
  logger,
  client,
  deps,
}: SellerBotOptions): Bot {
  const bot = new Bot(token, { botInfo, client });
  bot.use(allowedChats(sellerChatId));
  bot.use(staffOnly(isStaff));
  bot.command('ping', pingHandler(health));
  if (deps) {
    // Presses edit cards through the bot's own Api (the queue jobs use deps.telegram).
    const cards = createCardService(deps, bot.api);
    bot.command('queues', queuesCommand(deps));
    bot.on('callback_query:data', callbackHandler({ deps, cards }));
    bot.on('message:text', invoiceReplyHandler({ deps, cards }));
  }
  // Any other press (no deps, a game or inline button): stop the spinner, say nothing.
  bot.on('callback_query', async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => undefined);
  });
  // Without bot.catch an error in a handler stops long polling. The error is logged through
  // describeBotError: the raw grammY error carries the token and the request payload.
  bot.catch((error) => {
    logger?.error(
      { err: describeBotError(error.error, token), updateId: error.ctx.update.update_id },
      'seller bot handler failed',
    );
  });
  return bot;
}

/** Update types the seller bot consumes (commands and replies are messages, buttons callbacks). */
export const SELLER_BOT_UPDATES = ['message', 'callback_query'] as const;

export interface SellerBotRunner {
  /** Stops long polling (or a pending restart). Rejects with a token-free error. */
  stop(): Promise<void>;
}

export interface StartSellerBotOptions {
  logger: Pick<Logger, 'info' | 'warn' | 'error'>;
  /** Used only to scrub the token from logged errors. */
  token?: string;
  /** First restart delay after bot.start() fails; doubles up to maxRetryDelayMs. */
  retryDelayMs?: number;
  maxRetryDelayMs?: number;
}

/**
 * Starts long polling in the background. grammY retries network errors by itself, but
 * bot.start() rejects for good on 401 (bad token) and 409 (another getUpdates consumer, e.g.
 * the old container during a deploy). Such a failure is logged and polling is restarted with
 * a growing delay; it never takes the worker down (queues and the heartbeat keep running).
 */
export function startSellerBot(
  bot: Bot,
  { logger, token, retryDelayMs = 30_000, maxRetryDelayMs = 15 * 60_000 }: StartSellerBotOptions,
): SellerBotRunner {
  let stopping = false;
  let delayMs = retryDelayMs;
  let retryTimer: NodeJS.Timeout | undefined;

  const run = (): void => {
    bot
      .start({
        allowed_updates: SELLER_BOT_UPDATES,
        onStart: (info) => {
          delayMs = retryDelayMs;
          logger.info({ username: info.username }, 'seller bot started');
        },
      })
      .catch((error: unknown) => {
        if (stopping) return;
        logger.error(
          { err: describeBotError(error, token), retryInMs: delayMs },
          'seller bot stopped with an error, restarting',
        );
        retryTimer = setTimeout(run, delayMs);
        retryTimer.unref();
        delayMs = Math.min(delayMs * 2, maxRetryDelayMs);
      });
  };
  run();

  return {
    async stop() {
      stopping = true;
      clearTimeout(retryTimer);
      try {
        await bot.stop();
      } catch (error) {
        throw toSafeError(error, token);
      }
    },
  };
}
