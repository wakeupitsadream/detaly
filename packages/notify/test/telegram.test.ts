import { Api } from 'grammy';
import { describe, expect, it } from 'vitest';
import {
  buildCallbackData,
  CALLBACK_DATA_MAX_BYTES,
  CallbackDataError,
  CALLBACK_ACTIONS,
  ChannelBlockedError,
  createTelegramDriver,
  newNonce,
  parseCallbackData,
  type TelegramSendOptions,
  type TelegramSender,
  toInlineKeyboard,
} from '../src';

const ORDER_ID = '0192f0c4-7b1a-7cde-8f00-0123456789ab'; // uuid v7, 36 characters

describe('buildCallbackData', () => {
  it('builds a:<action>:<orderId>:<nonce> within 64 bytes', () => {
    const data = buildCallbackData('recheck', ORDER_ID, 'AbC-12_x');
    expect(data).toBe(`a:recheck:${ORDER_ID}:AbC-12_x`);
    expect(Buffer.byteLength(data)).toBeLessThanOrEqual(CALLBACK_DATA_MAX_BYTES);
  });

  it('every button action fits with a uuid and an 8-char nonce', () => {
    for (const action of Object.keys(CALLBACK_ACTIONS)) {
      const data = buildCallbackData(action, ORDER_ID, newNonce());
      expect(Buffer.byteLength(data), action).toBeLessThanOrEqual(64);
    }
  });

  it('accepts exactly 64 bytes and rejects 65', () => {
    const prefix = `a:x:${ORDER_ID}:`; // 41 bytes
    expect(buildCallbackData('x', ORDER_ID, 'n'.repeat(64 - prefix.length))).toHaveLength(64);
    expect(() => buildCallbackData('x', ORDER_ID, 'n'.repeat(65 - prefix.length))).toThrow(
      CallbackDataError,
    );
  });

  it('rejects separators and non-ASCII that would break parsing or the byte limit', () => {
    expect(() => buildCallbackData('re:check', ORDER_ID, 'n')).toThrow(CallbackDataError);
    expect(() => buildCallbackData('recheck', 'a:b', 'n')).toThrow(CallbackDataError);
    expect(() => buildCallbackData('recheck', ORDER_ID, 'нонс')).toThrow(CallbackDataError);
    expect(() => buildCallbackData('', ORDER_ID, 'n')).toThrow(CallbackDataError);
  });

  it('round-trips through parseCallbackData', () => {
    const nonce = newNonce();
    expect(nonce).toMatch(/^[A-Za-z0-9_-]{8}$/);
    expect(parseCallbackData(buildCallbackData('handed', ORDER_ID, nonce))).toEqual({
      action: 'handed',
      orderId: ORDER_ID,
      nonce,
    });
  });

  it.each([
    '',
    'a:x',
    `b:x:${ORDER_ID}:n`,
    `a:x:${ORDER_ID}:n:extra`,
    `a:X:${ORDER_ID}:n`,
    'a:x:id:' + 'n'.repeat(70),
  ])('parseCallbackData rejects %j', (data) => {
    expect(parseCallbackData(data)).toBeNull();
  });
});

describe('telegram driver', () => {
  function fakeApi(fail?: unknown) {
    const calls: { chatId: number | string; text: string; other?: TelegramSendOptions }[] = [];
    const api: TelegramSender = {
      sendMessage(chatId, text, other) {
        calls.push({ chatId, text, ...(other ? { other } : {}) });
        if (fail !== undefined) return Promise.reject(fail);
        return Promise.resolve({ message_id: 42 });
      },
    };
    return { api, calls };
  }

  it('converts abstract buttons into an inline keyboard', async () => {
    const { api, calls } = fakeApi();
    const driver = createTelegramDriver({ api, nonce: () => 'N0nce' });
    const result = await driver.send('-1001', {
      text: 'hello',
      buttons: [
        [{ kind: 'action', text: 'Проверить и заказать', action: 'recheck', orderId: ORDER_ID }],
        [],
        [{ kind: 'url', text: 'Открыть в админке', url: 'https://example.test/admin/o/1' }],
      ],
    });
    expect(result).toEqual({ externalId: '42' });
    expect(calls).toEqual([
      {
        chatId: '-1001',
        text: 'hello',
        other: {
          link_preview_options: { is_disabled: true },
          reply_markup: {
            inline_keyboard: [
              [{ text: 'Проверить и заказать', callback_data: `a:recheck:${ORDER_ID}:N0nce` }],
              [{ text: 'Открыть в админке', url: 'https://example.test/admin/o/1' }],
            ],
          },
        },
      },
    ]);
  });

  it('omits reply_markup without buttons', async () => {
    const { api, calls } = fakeApi();
    await createTelegramDriver({ api }).send('1', { text: 'pong', buttons: [] });
    expect(calls[0]?.other).toEqual({ link_preview_options: { is_disabled: true } });
  });

  it('maps 403 (bot blocked) to ChannelBlockedError, other errors pass through', async () => {
    const blocked = createTelegramDriver({
      api: fakeApi({ error_code: 403, description: 'Forbidden: bot was blocked by the user' }).api,
    });
    await expect(blocked.send('1', { text: 'x', buttons: [] })).rejects.toBeInstanceOf(
      ChannelBlockedError,
    );
    const failing = createTelegramDriver({ api: fakeApi(new Error('boom')).api });
    await expect(failing.send('1', { text: 'x', buttons: [] })).rejects.toThrow('boom');
  });

  it('grammY Api satisfies TelegramSender (no network: nothing is called)', () => {
    const api: TelegramSender = new Api('123:test');
    expect(typeof api.sendMessage).toBe('function');
  });

  it('toInlineKeyboard fails loudly on an oversized action', () => {
    expect(() =>
      toInlineKeyboard([
        [{ kind: 'action', text: 'x', action: 'a'.repeat(30), orderId: ORDER_ID }],
      ]),
    ).toThrow(CallbackDataError);
  });
});
