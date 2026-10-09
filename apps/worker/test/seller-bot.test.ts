// Seller bot without network: grammY's transport is replaced via bot.api.config.use and
// updates are fed with bot.handleUpdate (botInfo is pre-filled, so no getMe call either).
import type { PingData } from '@detaly/notify';
import type { Bot } from 'grammy';
import type { Update, UserFromGetMe } from 'grammy/types';
import { beforeEach, describe, expect, it } from 'vitest';
import { createSellerBot } from '../src/bots/seller/bot';

const FAKE_BOT_INFO: UserFromGetMe = {
  id: 7_000_000_001,
  is_bot: true,
  first_name: 'Детали · продавцы',
  username: 'detaly_seller_test_bot',
  can_join_groups: true,
  can_read_all_group_messages: false,
  supports_inline_queries: false,
  can_connect_to_business: false,
  has_main_web_app: false,
  has_topics_enabled: false,
  allows_users_to_create_topics: false,
} as UserFromGetMe;

const STAFF_ID = 111_111;
const STRANGER_ID = 222_222;
const SELLER_CHAT_ID = -100_123_456;
const OTHER_GROUP_ID = -100_999_999;
const HEALTH: PingData = { heartbeatAgeSec: 12, dbOk: true, gitSha: 'abcdef0123456789' };

interface ApiCall {
  method: string;
  payload: Record<string, unknown>;
}

let calls: ApiCall[];
let bot: Bot;
let updateId = 1;

function setup(health: () => Promise<PingData> = async () => HEALTH, appBaseUrl?: string) {
  calls = [];
  bot = createSellerBot({
    token: 'test:x',
    botInfo: FAKE_BOT_INFO,
    isStaff: async (id) => id === STAFF_ID,
    health,
    sellerChatId: SELLER_CHAT_ID,
    ...(appBaseUrl ? { appBaseUrl } : {}),
  });
  bot.api.config.use(async (_prev, method, payload) => {
    calls.push({ method, payload: payload as Record<string, unknown> });
    const p = payload as { chat_id?: number; text?: string };
    const result = {
      message_id: 1000 + calls.length,
      date: Math.floor(Date.now() / 1000),
      chat: { id: p.chat_id ?? 0, type: 'private' },
      text: p.text,
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return { ok: true, result } as any;
  });
}

type ChatKind = 'private' | 'seller' | 'other';

function commandUpdate(
  text: string,
  { from = STAFF_ID, chat = 'private' as ChatKind, withFrom = true } = {},
): Update {
  const chatObj =
    chat === 'private'
      ? { id: from, type: 'private' as const, first_name: 'Тест' }
      : {
          id: chat === 'seller' ? SELLER_CHAT_ID : OTHER_GROUP_ID,
          type: 'supergroup' as const,
          title: 'Продавцы',
        };
  const command = text.split(' ')[0] ?? text;
  const message = {
    message_id: updateId,
    date: Math.floor(Date.now() / 1000),
    chat: chatObj,
    text,
    entities: text.startsWith('/')
      ? [{ type: 'bot_command' as const, offset: 0, length: command.length }]
      : undefined,
    ...(withFrom ? { from: { id: from, is_bot: false, first_name: 'Тест' } } : {}),
  } as Update['message'];
  return { update_id: updateId++, message } as Update;
}

const sendMessages = () => calls.filter((call) => call.method === 'sendMessage');

describe('seller bot /ping', () => {
  beforeEach(() => setup());

  it('answers staff in a private chat with exactly one sendMessage', async () => {
    await bot.handleUpdate(commandUpdate('/ping'));
    expect(calls).toHaveLength(1);
    expect(sendMessages()).toHaveLength(1);
    expect(calls[0]?.payload).toMatchObject({
      chat_id: STAFF_ID,
      text: 'pong · heartbeat 12s · db ok · abcdef0',
    });
  });

  it('answers staff in TG_SELLER_CHAT_ID', async () => {
    await bot.handleUpdate(commandUpdate('/ping', { chat: 'seller' }));
    expect(calls).toHaveLength(1);
    expect(calls[0]?.payload).toMatchObject({ chat_id: SELLER_CHAT_ID });
  });

  it('answers /ping@<bot username> in the sellers chat', async () => {
    await bot.handleUpdate(commandUpdate('/ping@detaly_seller_test_bot', { chat: 'seller' }));
    expect(calls).toHaveLength(1);
    expect(sendMessages()).toHaveLength(1);
  });

  it('reports a missing heartbeat and a failed database', async () => {
    setup(async () => ({ heartbeatAgeSec: null, dbOk: false, gitSha: null }));
    await bot.handleUpdate(commandUpdate('/ping'));
    expect(calls[0]?.payload.text).toBe('pong · heartbeat нет · db fail · dev');
  });
});

describe('seller bot silence', () => {
  beforeEach(() => setup());

  it('ignores a non-staff user in a private chat', async () => {
    await bot.handleUpdate(commandUpdate('/ping', { from: STRANGER_ID }));
    expect(calls).toHaveLength(0);
  });

  it('ignores a non-staff user in the sellers chat', async () => {
    await bot.handleUpdate(commandUpdate('/ping', { from: STRANGER_ID, chat: 'seller' }));
    expect(calls).toHaveLength(0);
  });

  it('ignores an unknown command from staff', async () => {
    await bot.handleUpdate(commandUpdate('/start'));
    await bot.handleUpdate(commandUpdate('/orders'));
    expect(calls).toHaveLength(0);
  });

  it('ignores plain text from staff', async () => {
    await bot.handleUpdate(commandUpdate('привет'));
    expect(calls).toHaveLength(0);
  });

  it('ignores an update without from', async () => {
    await bot.handleUpdate(commandUpdate('/ping', { chat: 'seller', withFrom: false }));
    expect(calls).toHaveLength(0);
  });

  it('ignores /ping addressed to another bot', async () => {
    await bot.handleUpdate(commandUpdate('/ping@some_other_bot', { chat: 'seller' }));
    expect(calls).toHaveLength(0);
  });

  it('ignores staff in a group other than TG_SELLER_CHAT_ID', async () => {
    await bot.handleUpdate(commandUpdate('/ping', { chat: 'other' }));
    expect(calls).toHaveLength(0);
  });

  it('answers a press outside the served chats with an empty answer only', async () => {
    await bot.handleUpdate({
      update_id: updateId++,
      callback_query: {
        id: 'cb1',
        from: { id: STAFF_ID, is_bot: false, first_name: 'Тест' },
        chat_instance: 'x',
        data: 'a:ping:1:n',
      },
    } as Update);
    // Telegram keeps a spinner on the button until the query is answered: the answer is empty.
    expect(calls).toEqual([
      { method: 'answerCallbackQuery', payload: { callback_query_id: 'cb1' } },
    ]);
  });
});

describe('seller bot staff check', () => {
  it('does not ask isStaff for updates outside allowed chats', async () => {
    const asked: number[] = [];
    const localCalls: string[] = [];
    const localBot = createSellerBot({
      token: 'test:x',
      botInfo: FAKE_BOT_INFO,
      isStaff: async (id) => {
        asked.push(id);
        return true;
      },
      health: async () => HEALTH,
      sellerChatId: SELLER_CHAT_ID,
    });
    localBot.api.config.use(async (_prev, method) => {
      localCalls.push(method);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return { ok: true, result: true } as any;
    });
    await localBot.handleUpdate(commandUpdate('/ping', { chat: 'other' }));
    expect(asked).toEqual([]);
    expect(localCalls).toEqual([]);
  });
});

// Step 5 (docs/kits.md): the master makes the maintenance kits in the admin.
describe('seller bot /kits', () => {
  beforeEach(() => setup(async () => HEALTH, 'https://shop.example/'));

  it('answers staff with the link to /admin/kits', async () => {
    await bot.handleUpdate(commandUpdate('/kits'));
    expect(sendMessages()).toHaveLength(1);
    expect(calls[0]?.payload).toMatchObject({
      chat_id: STAFF_ID,
      text: 'Наборы для ТО — в админке: https://shop.example/admin/kits',
    });
  });

  it('answers in the sellers chat too', async () => {
    await bot.handleUpdate(commandUpdate('/kits@detaly_seller_test_bot', { chat: 'seller' }));
    expect(calls[0]?.payload).toMatchObject({ chat_id: SELLER_CHAT_ID });
  });

  it('says nothing to a stranger', async () => {
    await bot.handleUpdate(commandUpdate('/kits', { from: STRANGER_ID }));
    await bot.handleUpdate(commandUpdate('/kits', { from: STRANGER_ID, chat: 'seller' }));
    expect(calls).toHaveLength(0);
  });

  it('is not there without APP_BASE_URL', async () => {
    setup();
    await bot.handleUpdate(commandUpdate('/kits'));
    expect(calls).toHaveLength(0);
  });
});
