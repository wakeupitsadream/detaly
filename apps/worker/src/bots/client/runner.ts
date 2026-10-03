// Long polling of the client bot with a growing restart delay (docs/phase-1c-implementation.md
// section 8; the same contract as startSellerBot, whose files this package does not touch).
import type { Logger } from '@detaly/config';
import type { Bot } from 'grammy';
import { describeBotError, toSafeError } from '../seller/errors';

/**
 * Update types the client bot consumes: commands, contacts and other messages; button presses;
 * my_chat_member (the user blocked the bot: status `kicked`, decision С4).
 */
export const CLIENT_BOT_UPDATES = ['message', 'callback_query', 'my_chat_member'] as const;

export interface ClientBotRunner {
  /** Stops long polling (or a pending restart). Rejects with a token-free error. */
  stop(): Promise<void>;
}

export interface StartClientBotOptions {
  logger: Pick<Logger, 'info' | 'warn' | 'error'>;
  /** Used only to scrub the token from logged errors. */
  token?: string;
  /** First restart delay after bot.start() fails; doubles up to maxRetryDelayMs. */
  retryDelayMs?: number;
  maxRetryDelayMs?: number;
}

/**
 * Starts long polling in the background. bot.start() rejects for good on 401 (bad token) and
 * 409 (another getUpdates consumer, e.g. the old container during a deploy): the failure is
 * logged without the token and polling restarts with a growing delay. The client bot never takes
 * the worker down, and it restarts independently of the seller bot.
 */
export function startClientBot(
  bot: Bot,
  { logger, token, retryDelayMs = 30_000, maxRetryDelayMs = 15 * 60_000 }: StartClientBotOptions,
): ClientBotRunner {
  let stopping = false;
  let delayMs = retryDelayMs;
  let retryTimer: NodeJS.Timeout | undefined;

  const run = (): void => {
    bot
      .start({
        allowed_updates: CLIENT_BOT_UPDATES,
        onStart: (info) => {
          delayMs = retryDelayMs;
          logger.info({ username: info.username }, 'client bot started');
        },
      })
      .catch((error: unknown) => {
        if (stopping) return;
        logger.error(
          { err: describeBotError(error, token), retryInMs: delayMs },
          'client bot stopped with an error, restarting',
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
