// Telegram driver of phase 1C (docs/phase-1c-implementation.md section 7.1 item 1): the
// packaging photo through sendPhoto (caption <= 1024, otherwise the photo and a message), the
// photo loader, 403 and «chat not found» -> ChannelBlockedError, 429 -> TelegramRateLimitError.
// grammY's own Api runs on a transformer that answers instead of the network.
import { Api, InputFile } from 'grammy';
import { describe, expect, it } from 'vitest';
import {
  ChannelBlockedError,
  createNotifier,
  createTelegramDriver,
  isTelegramBlockedError,
  type OrderTemplateData,
  TELEGRAM_CAPTION_MAX,
  TelegramRateLimitError,
  telegramRateLimit,
} from '../src';

const ORDER_ID = '0192f0c4-7b1a-7cde-8f00-0123456789ab';
const PHOTO_KEY = `order/${ORDER_ID}/0192f0c4-7b1a-7cde-8f00-00000000beef.jpg`;
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 0xff, 0xd9]);

interface Call {
  method: string;
  payload: Record<string, unknown>;
}

/** grammY Api whose transport records calls and answers `respond(method)` (no network). */
function recordingApi(
  respond: (method: string) => Record<string, unknown> = () => ({
    ok: true,
    result: { message_id: 7, date: 0, chat: { id: 1, type: 'private' } },
  }),
) {
  const api = new Api('123456:test-token-not-real');
  const calls: Call[] = [];
  api.config.use(async (_prev, method, payload) => {
    calls.push({ method, payload: (payload ?? {}) as Record<string, unknown> });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return respond(method) as any;
  });
  return { api, calls };
}

const arrivedData: OrderTemplateData = {
  brandName: 'Тестовый бренд',
  orderId: ORDER_ID,
  orderNumber: 'DT-000123',
  orderUrl: 'https://detaly56.ru/o/token',
  scheme: 'prepay',
  items: [{ brand: 'MANN', article: 'W 914/2' }],
  pickup: { name: 'Пункт выдачи', address: 'ул. Тестовая, 1', hours: 'пн–сб 9–19' },
  pickupCode: '4821',
  installPartner: 'Тестовый сервис',
  photos: [PHOTO_KEY],
};

const telegramClient = {
  kind: 'client' as const,
  bindings: [{ channel: 'telegram' as const, chatId: '555', isPrimary: true, blocked: false }],
  phone: null,
};

describe('telegram driver: photos', () => {
  it('V5: arrived with a packaging photo goes by sendPhoto with the code and the booking button', async () => {
    const { api, calls } = recordingApi();
    const loaded: string[] = [];
    const driver = createTelegramDriver({
      api,
      nonce: () => 'N0nce123',
      loadPhoto: async (key) => {
        loaded.push(key);
        return JPEG;
      },
    });
    const result = await createNotifier({ drivers: [driver] }).send(
      telegramClient,
      'arrived',
      arrivedData,
    );
    expect(result).toMatchObject({ status: 'sent', channel: 'telegram', externalId: '7' });
    expect(loaded).toEqual([PHOTO_KEY]);
    expect(calls.map((c) => c.method)).toEqual(['sendPhoto']);
    const payload = calls[0]!.payload as {
      chat_id: string;
      photo: unknown;
      caption: string;
      reply_markup: { inline_keyboard: { text: string; callback_data?: string; url?: string }[][] };
    };
    expect(payload.chat_id).toBe('555');
    expect(payload.photo).toBeInstanceOf(InputFile);
    expect(payload.caption).toContain('Код выдачи: 4821');
    expect(payload.caption).toContain('Пункт выдачи, ул. Тестовая, 1.');
    expect(payload.reply_markup.inline_keyboard).toEqual([
      [{ text: 'Записаться на установку', callback_data: `a:install:${ORDER_ID}:N0nce123` }],
      [{ text: 'Открыть заказ', url: 'https://detaly56.ru/o/token' }],
    ]);
  });

  it('a caption over 1024 characters: the photo alone, then the text with the buttons', async () => {
    const { api, calls } = recordingApi();
    const driver = createTelegramDriver({ api, loadPhoto: async () => JPEG });
    const text = 'x'.repeat(TELEGRAM_CAPTION_MAX + 1);
    await driver.send('1', {
      text,
      photos: [PHOTO_KEY],
      buttons: [[{ kind: 'url', text: 'Открыть заказ', url: 'https://detaly56.ru/o/t' }]],
    });
    expect(calls.map((c) => c.method)).toEqual(['sendPhoto', 'sendMessage']);
    expect(calls[0]!.payload).not.toHaveProperty('caption');
    expect(calls[0]!.payload).not.toHaveProperty('reply_markup');
    expect(calls[1]!.payload).toMatchObject({
      text,
      reply_markup: { inline_keyboard: [[{ url: 'https://detaly56.ru/o/t' }]] },
    });

    calls.length = 0;
    await driver.send('1', {
      text: 'y'.repeat(TELEGRAM_CAPTION_MAX),
      photos: [PHOTO_KEY],
      buttons: [],
    });
    expect(calls.map((c) => c.method)).toEqual(['sendPhoto']);
  });

  it('no loader, a missing photo or a store error -> plain sendMessage', async () => {
    for (const loadPhoto of [
      undefined,
      async () => null,
      async () => {
        throw new Error('s3 down');
      },
    ]) {
      const { api, calls } = recordingApi();
      const driver = createTelegramDriver({ api, ...(loadPhoto ? { loadPhoto } : {}) });
      await driver.send('1', { text: 'Заказ приехал.', photos: [PHOTO_KEY], buttons: [] });
      expect(calls.map((c) => c.method)).toEqual(['sendMessage']);
    }
  });

  it('a photo Telegram refuses (400) does not hold back the text', async () => {
    const { api, calls } = recordingApi((method) =>
      method === 'sendPhoto'
        ? { ok: false, error_code: 400, description: 'Bad Request: IMAGE_PROCESS_FAILED' }
        : { ok: true, result: { message_id: 9, date: 0, chat: { id: 1, type: 'private' } } },
    );
    const driver = createTelegramDriver({ api, loadPhoto: async () => JPEG });
    await expect(
      driver.send('1', { text: 'Заказ приехал.', photos: [PHOTO_KEY], buttons: [] }),
    ).resolves.toEqual({ externalId: '9' });
    expect(calls.map((c) => c.method)).toEqual(['sendPhoto', 'sendMessage']);
  });

  it('a sender without sendPhoto (alerts) ignores photos', async () => {
    const sent: string[] = [];
    const driver = createTelegramDriver({
      api: {
        async sendMessage(_chat, text) {
          sent.push(text);
          return { message_id: 1 };
        },
      },
      loadPhoto: async () => JPEG,
    });
    await driver.send('1', { text: 'hi', photos: [PHOTO_KEY], buttons: [] });
    expect(sent).toEqual(['hi']);
  });
});

describe('telegram driver: errors', () => {
  const failing = (answer: Record<string, unknown>) =>
    createTelegramDriver({
      api: recordingApi(() => ({ ok: false, ...answer })).api,
      loadPhoto: async () => JPEG,
    });

  it('V2: 403 (bot blocked) -> ChannelBlockedError, for sendMessage and sendPhoto', async () => {
    const driver = failing({
      error_code: 403,
      description: 'Forbidden: bot was blocked by the user',
    });
    await expect(driver.send('1', { text: 'x', buttons: [] })).rejects.toBeInstanceOf(
      ChannelBlockedError,
    );
    await expect(
      driver.send('1', { text: 'x', buttons: [], photos: [PHOTO_KEY] }),
    ).rejects.toBeInstanceOf(ChannelBlockedError);
  });

  it('400 «chat not found» -> ChannelBlockedError; another 400 passes through', async () => {
    await expect(
      failing({ error_code: 400, description: 'Bad Request: chat not found' }).send('1', {
        text: 'x',
        buttons: [],
      }),
    ).rejects.toBeInstanceOf(ChannelBlockedError);
    const other = failing({ error_code: 400, description: 'Bad Request: message is too long' });
    const error = await other.send('1', { text: 'x', buttons: [] }).catch((e: unknown) => e);
    expect(error).not.toBeInstanceOf(ChannelBlockedError);
    expect(error).toMatchObject({ error_code: 400 });
  });

  it('429 -> TelegramRateLimitError with retry_after (retryable, not blocked)', async () => {
    const driver = failing({
      error_code: 429,
      description: 'Too Many Requests: retry after 5',
      parameters: { retry_after: 5 },
    });
    const error = await driver.send('1', { text: 'x', buttons: [] }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TelegramRateLimitError);
    expect((error as TelegramRateLimitError).retryAfterSec).toBe(5);
    expect((error as Error).message).not.toContain('test-token');
    // The Notifier does not fall back to SMS on a rate limit: the queue retries the job.
    const notifier = createNotifier({ drivers: [driver] });
    await expect(
      notifier.send({ ...telegramClient, phone: '+79123456789' }, 'arrived', arrivedData),
    ).rejects.toBeInstanceOf(TelegramRateLimitError);
  });

  it('classifiers', () => {
    expect(isTelegramBlockedError({ error_code: 403 })).toBe(true);
    expect(isTelegramBlockedError({ error_code: 400, description: 'chat not found' })).toBe(true);
    expect(isTelegramBlockedError(new Error('x'))).toBe(false);
    expect(isTelegramBlockedError(null)).toBe(false);
    expect(telegramRateLimit({ error_code: 429 })?.retryAfterSec).toBeNull();
    expect(
      telegramRateLimit({ error_code: 429, parameters: { retry_after: 'x' } })?.retryAfterSec,
    ).toBeNull();
    expect(telegramRateLimit({ error_code: 500 })).toBeNull();
  });
});
