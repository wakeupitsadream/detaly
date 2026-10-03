// Client bot units without a database: the polling runner (restart with a growing delay, no
// token in logs), button helpers, the slot request key and the orders list rendering.
import { buildCallbackData, parseCallbackData } from '@detaly/notify';
import { GrammyError, type Bot } from 'grammy';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { withoutButtons } from '../src/bots/client/callbacks';
import { slotRequestKey } from '../src/bots/client/menu';
import { renderOrdersList, type ClientOrderView } from '../src/bots/client/orders';
import { CLIENT_BOT_UPDATES, startClientBot } from '../src/bots/client/runner';
import { CLIENT_STATUS_LABELS, TEXTS } from '../src/bots/client/texts';

const TOKEN = '123456:secret-client-token';
const ORDER = '0192a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b';
const OTHER = '0192a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5c';
const ENV = { APP_BASE_URL: 'https://detaly.test/', INSTALL_PARTNER_NAME: 'Сервис' };

afterEach(() => {
  vi.useRealTimers();
});

describe('startClientBot', () => {
  it('polls message, callback_query and my_chat_member; restarts after 409 without the token in logs', async () => {
    vi.useFakeTimers();
    const conflict = new GrammyError(
      `Call to 'getUpdates' failed! (409: Conflict) bot${TOKEN}`,
      { ok: false, error_code: 409, description: 'Conflict' },
      'getUpdates',
      {},
    );
    const starts: unknown[] = [];
    const fake = {
      start: vi.fn(async (options: { allowed_updates: readonly string[] }) => {
        starts.push(options.allowed_updates);
        throw conflict;
      }),
      stop: vi.fn(async () => undefined),
    };
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const runner = startClientBot(fake as unknown as Bot, {
      logger,
      token: TOKEN,
      retryDelayMs: 1_000,
      maxRetryDelayMs: 3_000,
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(starts).toEqual([CLIENT_BOT_UPDATES]);
    expect(CLIENT_BOT_UPDATES).toEqual(['message', 'callback_query', 'my_chat_member']);
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.advanceTimersByTimeAsync(2_000);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(fake.start).toHaveBeenCalledTimes(4);
    const delays = logger.error.mock.calls.map(
      (call) => (call[0] as { retryInMs: number }).retryInMs,
    );
    expect(delays).toEqual([1_000, 2_000, 3_000, 3_000]);
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain('secret-client-token');

    await runner.stop();
    expect(fake.stop).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fake.start).toHaveBeenCalledTimes(4);
  });

  it('stop() rejects with a token-free error', async () => {
    const fake = {
      start: () => new Promise(() => {}),
      stop: async () => {
        throw new Error(`request to https://api.telegram.org/bot${TOKEN}/getUpdates failed`);
      },
    };
    const runner = startClientBot(fake as unknown as Bot, {
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      token: TOKEN,
    });
    const error = await runner.stop().catch((e: unknown) => e as Error);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).not.toContain('secret-client-token');
  });
});

describe('client bot helpers', () => {
  it('withoutButtons drops the pressed order’s question buttons and keeps links and other orders', () => {
    const keyboard = [
      [{ text: 'Подтверждаю', callback_data: buildCallbackData('confirm', ORDER, 'n1') }],
      [{ text: 'Подтверждаю', callback_data: buildCallbackData('confirm', OTHER, 'n2') }],
      [
        { text: 'Записаться', callback_data: buildCallbackData('install', ORDER, 'n3') },
        { text: 'Открыть заказ', url: 'https://detaly.test/o/x' },
      ],
    ];
    expect(withoutButtons({ inline_keyboard: keyboard }, ORDER, ['confirm', 'approve'])).toEqual([
      keyboard[1],
      keyboard[2],
    ]);
    expect(withoutButtons({ inline_keyboard: keyboard }, ORDER, ['confirm', 'install'])).toEqual([
      keyboard[1],
      [{ text: 'Открыть заказ', url: 'https://detaly.test/o/x' }],
    ]);
    expect(withoutButtons(undefined, ORDER, ['confirm'])).toEqual([]);
  });

  it('slotRequestKey is a stable uuid per nonce', () => {
    const key = slotRequestKey('AbCd_-12');
    expect(key).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(slotRequestKey('AbCd_-12')).toBe(key);
    expect(slotRequestKey('AbCd_-13')).not.toBe(key);
  });
});

describe('renderOrdersList', () => {
  const view = (patch: Partial<ClientOrderView>): ClientOrderView => ({
    id: ORDER,
    number: 'DT-000042',
    status: 'ready',
    accessToken: 'page-token',
    pickupCode: '4821',
    items: [{ brand: 'MANN', article: 'W 914/2' }],
    booking: null,
    ...patch,
  });

  it('one order: status words, brand and article, the code, buttons without a prefix', () => {
    const list = renderOrdersList([view({})], ENV, () => 'nonce000');
    expect(list.text).toBe(
      `${TEXTS.ordersHead}\n\nDT-000042 — ${CLIENT_STATUS_LABELS.ready}\nMANN W 914/2\nМожно забирать. Код выдачи: 4821`,
    );
    expect(list.keyboard).toEqual([
      [
        {
          text: 'Записаться на установку',
          callback_data: `a:install:${ORDER}:nonce000`,
        },
      ],
      [{ text: 'Открыть заказ', url: 'https://detaly.test/o/page-token' }],
      [{ text: 'Отключить уведомления', callback_data: 'a:unsub:me:nonce000' }],
    ]);
  });

  it('several orders: buttons labelled by order; no install without the partner; claim link after handover', () => {
    const list = renderOrdersList(
      [
        view({ status: 'awaiting_confirmation', number: 'DT-000043' }),
        view({ id: OTHER, status: 'handed', number: 'DT-000041', accessToken: 'second' }),
      ],
      { APP_BASE_URL: 'https://detaly.test', INSTALL_PARTNER_NAME: undefined },
      () => 'nonce000',
    );
    const buttons = list.keyboard.flat();
    expect(buttons.map((b) => b.text)).toEqual([
      'DT-000043 · Подтверждаю',
      'DT-000043 · Открыть заказ',
      'DT-000041 · Претензия',
      'DT-000041 · Открыть заказ',
      'Отключить уведомления',
    ]);
    expect(buttons[2]).toMatchObject({ url: 'https://detaly.test/o/second#claim' });
    for (const button of buttons) {
      if ('callback_data' in button && button.callback_data) {
        expect(parseCallbackData(button.callback_data)).not.toBeNull();
      }
    }
  });

  it('an active booking is shown instead of «Записаться»', () => {
    const list = renderOrdersList(
      [view({ booking: { slotAt: new Date('2031-03-05T14:00:00+05:00'), status: 'confirmed' } })],
      ENV,
    );
    expect(list.text).toContain('Запись на установку: ср 5 мар 14:00 — подтверждена.');
    expect(list.keyboard.flat().some((b) => b.text.includes('Записаться'))).toBe(false);
  });

  it('no orders', () => {
    expect(renderOrdersList([], ENV).text).toBe(TEXTS.noOrders);
  });
});
