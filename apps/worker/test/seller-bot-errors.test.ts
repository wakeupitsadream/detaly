// The bot token and request payloads must never reach the logs, and a failed bot.start()
// (401/409) must not leave the seller bot dead until the next deploy. No network: the only
// socket is a refused connection to 127.0.0.1:1.
import { createLogger } from '@detaly/config';
import type { PingData } from '@detaly/notify';
import { Bot, BotError, GrammyError, HttpError } from 'grammy';
import type { Update, UserFromGetMe } from 'grammy/types';
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest';
import { createSellerBot, startSellerBot } from '../src/bots/seller/bot';
import { describeBotError, redactToken } from '../src/bots/seller/errors';

const TOKEN = '123456789:AAH-secret_TOKEN-value';
const BOT_INFO = {
  id: 123456789,
  is_bot: true,
  first_name: 'Детали · продавцы',
  username: 'detaly_seller_test_bot',
} as UserFromGetMe;

function fetchErrorWithToken(): Error {
  const error = new Error(
    `request to https://api.telegram.org/bot${TOKEN}/sendMessage failed, reason: connect ETIMEDOUT`,
  ) as Error & { code: string };
  error.name = 'FetchError';
  error.code = 'ETIMEDOUT';
  return error;
}

const logged = (fn: Mock) => JSON.stringify(fn.mock.calls);

afterEach(() => {
  vi.useRealTimers();
});

describe('describeBotError', () => {
  it('drops the token from a real grammY HttpError (node-fetch puts the URL in the message)', async () => {
    const bot = new Bot(TOKEN, { client: { apiRoot: 'http://127.0.0.1:1' } });
    const error = await bot.api.getMe().then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(HttpError);
    // The raw error does leak it: this is what the sanitizer is for.
    expect(String((error as HttpError).error)).toContain(TOKEN);

    const safe = describeBotError(error, TOKEN);
    expect(JSON.stringify(safe)).not.toContain(TOKEN);
    expect(JSON.stringify(safe)).not.toContain('secret_TOKEN');
    expect(safe).toMatchObject({ name: 'HttpError', code: 'ECONNREFUSED' });
    expect(safe.cause).toContain('bot[redacted]/getMe');
  });

  it('keeps method and code of a GrammyError but not its payload', () => {
    const error = new GrammyError(
      "Call to 'sendMessage' failed!",
      { ok: false, error_code: 403, description: 'Forbidden: bot was blocked by the user' },
      'sendMessage',
      { chat_id: 42, text: 'Заказ 1001: Иванов, +79990000000' },
    );
    const safe = describeBotError(error, TOKEN);
    expect(safe).toMatchObject({ name: 'GrammyError', method: 'sendMessage', errorCode: 403 });
    expect(JSON.stringify(safe)).not.toContain('+7999');
  });

  it('redacts any bot<id>:<secret> path even without the configured token', () => {
    expect(redactToken('GET /bot987:other-Secret_1/getMe')).toBe('GET /bot[redacted]/getMe');
  });
});

describe('seller bot handler errors', () => {
  it('logs a failed sendMessage without the token or the message text', async () => {
    // The real pino logger: its err serializer walks nested errors (HttpError.error).
    const lines: string[] = [];
    const logger = createLogger('worker-test', {
      destination: { write: (line: string) => void lines.push(line) },
    });
    const health = async (): Promise<PingData> => ({ heartbeatAgeSec: 1, dbOk: true, gitSha: 'x' });
    const bot = createSellerBot({
      token: TOKEN,
      botInfo: BOT_INFO,
      isStaff: async () => true,
      health,
      logger,
    });
    bot.api.config.use(async (_prev, method) => {
      throw new HttpError(`Network request for '${method}' failed!`, fetchErrorWithToken());
    });

    // Long polling routes a BotError from handleUpdate to the bot.catch handler; do the same.
    const update = {
      update_id: 1,
      message: {
        message_id: 1,
        date: 0,
        chat: { id: 5, type: 'private', first_name: 'Тест' },
        from: { id: 5, is_bot: false, first_name: 'Тест' },
        text: '/ping',
        entities: [{ type: 'bot_command', offset: 0, length: 5 }],
      },
    } as Update;
    await bot.handleUpdate(update).catch((error: unknown) => {
      if (!(error instanceof BotError)) throw error;
      return bot.errorHandler(error);
    });

    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('seller bot handler failed');
    expect(lines[0]).toContain('ETIMEDOUT');
    expect(lines[0]).not.toContain(TOKEN);
    expect(lines[0]).not.toContain('secret_TOKEN');
  });
});

interface FakeBot {
  start: Mock<(options?: unknown) => Promise<void>>;
  stop: Mock<() => Promise<void>>;
}

function fakeBot(): FakeBot {
  return {
    start: vi.fn<(options?: unknown) => Promise<void>>(),
    stop: vi.fn(() => Promise.resolve()),
  };
}

const conflict = () =>
  new GrammyError(
    "Call to 'getUpdates' failed!",
    { ok: false, error_code: 409, description: 'Conflict: terminated by other getUpdates request' },
    'getUpdates',
    {},
  );

describe('startSellerBot', () => {
  it('restarts polling with a growing delay after bot.start() rejects', async () => {
    vi.useFakeTimers();
    const bot = fakeBot();
    bot.start
      .mockRejectedValueOnce(conflict())
      .mockRejectedValueOnce(conflict())
      .mockReturnValueOnce(new Promise(() => {}));
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

    startSellerBot(bot as unknown as Bot, {
      logger,
      token: TOKEN,
      retryDelayMs: 1_000,
      maxRetryDelayMs: 1_500,
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(bot.start).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(bot.start.mock.calls[0]?.[0]).toMatchObject({
      allowed_updates: ['message', 'callback_query'],
    });

    await vi.advanceTimersByTimeAsync(999);
    expect(bot.start).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(bot.start).toHaveBeenCalledTimes(2);

    // Second delay is capped at 1500 ms.
    await vi.advanceTimersByTimeAsync(1_499);
    expect(bot.start).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(bot.start).toHaveBeenCalledTimes(3);
    expect(logged(logger.error)).toContain('409');
  });

  it('stop() cancels a pending restart', async () => {
    vi.useFakeTimers();
    const bot = fakeBot();
    bot.start.mockRejectedValue(conflict());
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

    const runner = startSellerBot(bot as unknown as Bot, { logger, retryDelayMs: 1_000 });
    await vi.advanceTimersByTimeAsync(0);
    await runner.stop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(bot.start).toHaveBeenCalledTimes(1);
    expect(bot.stop).toHaveBeenCalledTimes(1);
  });

  it('does not log or restart when polling ends because of stop()', async () => {
    const bot = fakeBot();
    let reject!: (error: unknown) => void;
    bot.start.mockReturnValueOnce(new Promise((_, r) => (reject = r)));
    bot.stop.mockImplementation(() => {
      reject(new Error('aborted'));
      return Promise.resolve();
    });
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

    const runner = startSellerBot(bot as unknown as Bot, { logger, retryDelayMs: 1 });
    await runner.stop();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(logger.error).not.toHaveBeenCalled();
    expect(bot.start).toHaveBeenCalledTimes(1);
  });

  it('stop() rejects with a token-free error when the final getUpdates fails', async () => {
    const bot = fakeBot();
    bot.start.mockReturnValueOnce(new Promise(() => {}));
    bot.stop.mockRejectedValueOnce(
      new HttpError("Network request for 'getUpdates' failed!", fetchErrorWithToken()),
    );
    const runner = startSellerBot(bot as unknown as Bot, {
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      token: TOKEN,
    });
    const error = await runner.stop().then(
      () => null,
      (e: unknown) => e as Error,
    );
    expect(error).toBeInstanceOf(Error);
    expect(error?.message).toContain("'getUpdates' failed");
    expect(
      JSON.stringify({ ...error, message: error?.message, stack: error?.stack }),
    ).not.toContain(TOKEN);
  });
});
