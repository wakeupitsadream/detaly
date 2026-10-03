// Client bot on the `_worker` database (docs/phase-1c-implementation.md section 8; PLAN
// Verification 1C rows V1, V2, V6): grammY's transport is replaced through bot.api.config.use and
// updates are fed with bot.handleUpdate (botInfo is pre-filled: no getMe, no network).
// Telegram ids and phones are random per run.
import { randomBytes, randomInt } from 'node:crypto';
import { Writable } from 'node:stream';
import { createLogger } from '@detaly/config';
import {
  and,
  eq,
  installBookings,
  messengerBindings,
  notifications,
  orderEvents,
  orderItems,
  orders,
  sql,
  users,
  type Db,
} from '@detaly/db';
import type { OrderStatus, PaymentScheme } from '@detaly/domain';
import { INSTALL_LIFTS } from '@detaly/domain/install-params';
import { buildCallbackData, createSmsDriver, newNonce } from '@detaly/notify';
import { createLinkToken } from '@detaly/orders';
import type { Job } from 'bullmq';
import type { Bot } from 'grammy';
import type { Update, UserFromGetMe } from 'grammy/types';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';
import { bindKey } from '../src/bots/client/bind';
import { createClientBot } from '../src/bots/client/bot';
import { slotKey } from '../src/bots/client/menu';
import { TEXTS } from '../src/bots/client/texts';
import { processNotify } from '../src/jobs/notify';
import { createTestDeps, type TestDeps } from './helpers/test-deps';

const BOT_INFO: UserFromGetMe = {
  id: 7_000_000_002,
  is_bot: true,
  first_name: 'Детали · статусы',
  username: 'detaly_client_test_bot',
  can_join_groups: false,
  can_read_all_group_messages: false,
  supports_inline_queries: false,
  can_connect_to_business: false,
  has_main_web_app: false,
  has_topics_enabled: false,
  allows_users_to_create_topics: false,
} as UserFromGetMe;

const TOKEN = '777000:client-bot-test-token-not-real';
const PICKUP_PHONE = '+7 (3532) 00-00-00';
const ENV = {
  APP_BASE_URL: 'https://detaly.test',
  BRAND_NAME: 'Детали',
  SMS_PROVIDER: 'smsaero',
  PICKUP_POINT_NAME: 'Пункт выдачи',
  PICKUP_ADDRESS: 'ул. Тестовая, 1',
  PICKUP_HOURS: 'Пн-Сб 9:00-19:00',
  PICKUP_PHONE,
  INSTALL_PARTNER_NAME: 'Тестовый сервис',
  INSTALL_PARTNER_REQUISITES: 'ИП Сервисов С. С., ИНН 560011122233',
  TG_CLIENT_BOT_TOKEN: TOKEN,
  TG_CLIENT_BOT_USERNAME: 'detaly_client_test_bot',
};

/** Tuesday 4 March 2031, 12:00 in Orenburg: far from the bookings of other test files. */
const NOW = new Date('2031-03-04T12:00:00+05:00');

interface ApiCall {
  method: string;
  payload: Record<string, unknown>;
}

interface Button {
  text: string;
  callback_data?: string;
  url?: string;
}

/** The SMS Aero gateway on a fake fetch: records the requests. */
function fakeGateway() {
  const gateway = {
    calls: [] as URL[],
    fetch: (async (input: string | URL | Request) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      gateway.calls.push(url);
      return new Response(
        JSON.stringify({ success: true, data: { id: gateway.calls.length, cost: '3.69' } }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as typeof fetch,
  };
  return gateway;
}

const tgId = () => randomInt(1_000_000_000, 2_000_000_000);
const randomPhone = () => `+79${String(randomInt(0, 1_000_000_000)).padStart(9, '0')}`;
const date = () => Math.floor(Date.now() / 1000);

describe.skipIf(!inject('workerDatabaseUrl'))('client bot', () => {
  const gateway = fakeGateway();
  const logs: string[] = [];
  /** Every phone of this file: no outgoing text may carry one. */
  const phones: string[] = [];
  let t: TestDeps;
  let db: Db;
  let bot: Bot;
  let calls: ApiCall[];
  let updateId = 1;

  beforeAll(async () => {
    t = await createTestDeps({
      envOverrides: ENV,
      now: () => NOW,
      smsDriver: createSmsDriver({
        provider: 'smsaero',
        login: 'shop@example.test',
        apiKey: 'test-key',
        sender: 'Shop',
        apiUrl: 'https://sms.test/v2',
        fetch: gateway.fetch,
      }),
      logger: createLogger('worker', {
        level: 'info',
        destination: new Writable({
          write(chunk, _encoding, callback) {
            logs.push(String(chunk));
            callback();
          },
        }),
      }),
    });
    db = t.deps.db;
    calls = [];
    bot = createClientBot({ token: TOKEN, botInfo: BOT_INFO, deps: t.deps });
    bot.api.config.use(async (_prev, method, payload) => {
      const p = (payload ?? {}) as Record<string, unknown>;
      calls.push({ method, payload: p });
      const result =
        method === 'answerCallbackQuery'
          ? true
          : {
              message_id: 5000 + calls.length,
              date: date(),
              chat: { id: Number(p.chat_id ?? 0), type: 'private' },
              text: p.text,
            };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return { ok: true, result } as any;
    });
  });

  afterAll(async () => {
    await t?.close();
  });

  let mark = 0;
  beforeEach(() => {
    mark = calls.length;
  });
  /** Calls since the test started. */
  const recent = () => calls.slice(mark);
  const sent = (chatId?: number) =>
    recent().filter(
      (c) => c.method === 'sendMessage' && (chatId === undefined || c.payload.chat_id === chatId),
    );
  const texts = (chatId?: number) => sent(chatId).map((c) => String(c.payload.text));
  const answers = () =>
    recent()
      .filter((c) => c.method === 'answerCallbackQuery')
      .map((c) => (c.payload.text as string | undefined) ?? '');
  const inlineKeyboard = (call: ApiCall | undefined): Button[][] =>
    ((call?.payload.reply_markup as { inline_keyboard?: Button[][] } | undefined)
      ?.inline_keyboard ?? []) as Button[][];

  // --- updates -------------------------------------------------------------------------------

  function messageUpdate(from: number, extra: Record<string, unknown>, chatType = 'private') {
    const chat =
      chatType === 'private'
        ? { id: from, type: 'private', first_name: 'Иван' }
        : { id: -100_777_000, type: 'supergroup', title: 'Группа' };
    return {
      update_id: updateId++,
      message: {
        message_id: updateId,
        date: date(),
        chat,
        from: { id: from, is_bot: false, first_name: 'Иван', last_name: 'Петров' },
        ...extra,
      },
    } as unknown as Update;
  }

  function text(from: number, value: string, chatType = 'private') {
    const command = value.startsWith('/') ? (value.split(' ')[0] ?? value) : null;
    return bot.handleUpdate(
      messageUpdate(
        from,
        {
          text: value,
          ...(command
            ? { entities: [{ type: 'bot_command', offset: 0, length: command.length }] }
            : {}),
        },
        chatType,
      ),
    );
  }

  /** `owner` null: a card without a Telegram account (no user_id). */
  function contact(from: number, phone: string, owner: number | null = from) {
    return bot.handleUpdate(
      messageUpdate(from, {
        contact: {
          phone_number: phone,
          first_name: 'Иван',
          ...(owner !== null ? { user_id: owner } : {}),
        },
      }),
    );
  }

  function press(from: number, data: string, keyboard: Button[][] = []) {
    return bot.handleUpdate({
      update_id: updateId++,
      callback_query: {
        id: String(updateId),
        from: { id: from, is_bot: false, first_name: 'Иван' },
        chat_instance: 'ci',
        data,
        message: {
          message_id: 900,
          date: date(),
          chat: { id: from, type: 'private', first_name: 'Иван' },
          text: 'уведомление',
          ...(keyboard.length > 0 ? { reply_markup: { inline_keyboard: keyboard } } : {}),
        },
      },
    } as unknown as Update);
  }

  function kicked(from: number) {
    return bot.handleUpdate({
      update_id: updateId++,
      my_chat_member: {
        chat: { id: from, type: 'private', first_name: 'Иван' },
        from: { id: from, is_bot: false, first_name: 'Иван' },
        date: date(),
        old_chat_member: { status: 'member', user: BOT_INFO },
        new_chat_member: { status: 'kicked', user: BOT_INFO, until_date: 0 },
      },
    } as unknown as Update);
  }

  // --- data ----------------------------------------------------------------------------------

  async function seedOrder(
    input: { status?: OrderStatus; scheme?: PaymentScheme; phone?: string; userId?: string } = {},
  ) {
    let userId = input.userId;
    let phone = input.phone ?? randomPhone();
    if (userId === undefined) {
      const [user] = await db.insert(users).values({ phone, name: 'Иван Петров' }).returning();
      userId = user!.id;
    } else {
      const [user] = await db.select().from(users).where(eq(users.id, userId));
      phone = user!.phone;
    }
    phones.push(phone);
    const [order] = await db
      .insert(orders)
      .values({
        userId,
        accessToken: randomBytes(32).toString('base64url'),
        status: input.status ?? 'ready',
        paymentScheme: input.scheme ?? 'prepay',
        subtotalKop: 128_000,
        totalKop: 128_000,
        itemsHash: 'test',
        pickupCode: '4821',
        promisedDate: '2031-03-04',
      })
      .returning();
    await db.insert(orderItems).values({
      orderId: order!.id,
      offerKey: 'W9142:MANN:ORB1',
      searchArticleNorm: 'W9142',
      brand: 'MANN',
      article: 'W 914/2',
      name: 'Фильтр масляный',
      qty: 1,
      stockId: 'ORB1',
      isLocal: true,
      priceSupplierAtOrderKop: 100_000,
      priceClientKop: 128_000,
      markupBp: 2800,
      etaDate: '2031-03-04',
      offerSnapshot: {
        source: 'rossko',
        brand: 'MANN',
        article: 'W 914/2',
        articleNorm: 'W9142',
        name: 'Фильтр масляный',
        group: null,
        isCross: false,
        priceSupplierKop: 100_000,
        stock: {
          stockId: 'ORB1',
          isLocal: true,
          count: 4,
          multiplicity: 1,
          type: null,
          deliveryDays: 2,
          deliveryStart: null,
          deliveryEnd: null,
          extra: null,
          description: null,
        },
      },
      state: input.status === 'ready' || input.status === undefined ? 'arrived' : 'ordered',
    });
    return {
      orderId: order!.id,
      number: order!.number,
      token: order!.accessToken,
      userId,
      phone,
    };
  }

  async function bindingOf(externalUserId: number) {
    const [row] = await db
      .select()
      .from(messengerBindings)
      .where(
        and(
          eq(messengerBindings.channel, 'telegram'),
          eq(messengerBindings.externalUserId, String(externalUserId)),
        ),
      );
    return row ?? null;
  }

  async function statusOf(orderId: string) {
    const [row] = await db
      .select({ status: orders.status })
      .from(orders)
      .where(eq(orders.id, orderId));
    return row!.status;
  }

  /** A bound Telegram account of the order's user (through the bot itself). */
  async function bindThroughBot(order: { orderId: string; userId: string; phone: string }) {
    const account = tgId();
    const { token } = await createLinkToken(db, {
      userId: order.userId,
      orderId: order.orderId,
      channel: 'telegram',
      now: NOW,
    });
    await text(account, `/start ${token}`);
    await contact(account, order.phone);
    expect((await bindingOf(account))?.userId).toBe(order.userId);
    return account;
  }

  const data = (action: string, orderId: string) => buildCallbackData(action, orderId, newNonce());

  // --- V1: binding ---------------------------------------------------------------------------

  it('V1: account A binds by the link and its own contact; B gets «устарела»; C with another number does not bind', async () => {
    const order = await seedOrder();
    const { token } = await createLinkToken(db, {
      userId: order.userId,
      orderId: order.orderId,
      channel: 'telegram',
      now: NOW,
    });
    const [a, b, c] = [tgId(), tgId(), tgId()];

    // A: /start <token> -> request_contact keyboard, the wait in Redis.
    await text(a, `/start ${token}`);
    const ask = sent(a)[0];
    expect(String(ask?.payload.text)).toBe(TEXTS.askContact(order.number));
    expect(ask?.payload.reply_markup).toMatchObject({
      keyboard: [[{ text: TEXTS.contactButton, request_contact: true }]],
      one_time_keyboard: true,
    });
    expect(await t.deps.redis.ttl(bindKey(t.deps.keyPrefix, a))).toBeGreaterThan(590);

    // A shares its own contact; Telegram sends the number without «+» (VERIFY).
    await contact(a, order.phone.slice(1));
    const binding = await bindingOf(a);
    expect(binding).toMatchObject({
      userId: order.userId,
      chatId: String(a),
      isPrimary: true,
      blockedAt: null,
    });
    expect(binding?.phoneConfirmedAt).toBeInstanceOf(Date);
    expect(await t.deps.redis.exists(bindKey(t.deps.keyPrefix, a))).toBe(0);
    const journal = await db
      .select()
      .from(orderEvents)
      .where(and(eq(orderEvents.orderId, order.orderId), eq(orderEvents.type, 'messenger_bound')));
    expect(journal).toHaveLength(1);
    expect(JSON.stringify(journal[0]?.payload)).not.toContain(String(a));
    const afterBind = sent(a).slice(1);
    expect(afterBind[0]?.payload).toMatchObject({
      text: TEXTS.bound,
      reply_markup: { remove_keyboard: true },
    });
    expect(String(afterBind[1]?.payload.text)).toContain(order.number);
    expect(String(afterBind[1]?.payload.text)).toContain('MANN W 914/2');

    // B presses the same link: it was taken by A.
    await text(b, `/start ${token}`);
    expect(texts(b)).toEqual([TEXTS.staleLink]);
    expect(await t.deps.redis.exists(bindKey(t.deps.keyPrefix, b))).toBe(0);
    await contact(b, order.phone);
    expect(texts(b).at(-1)).toBe(TEXTS.noPendingBind);
    expect(await bindingOf(b)).toBeNull();

    // C: a new link, but the contact has a different number -> no binding, the link is burnt.
    const second = await createLinkToken(db, {
      userId: order.userId,
      orderId: order.orderId,
      channel: 'telegram',
      now: NOW,
    });
    await text(c, `/start ${second.token}`);
    const stranger = randomPhone();
    phones.push(stranger);
    await contact(c, stranger);
    expect(texts(c).at(-1)).toBe(TEXTS.phoneMismatch);
    expect(await bindingOf(c)).toBeNull();
    expect(await t.deps.redis.exists(bindKey(t.deps.keyPrefix, c))).toBe(0);
    await contact(c, order.phone);
    expect(texts(c).at(-1)).toBe(TEXTS.noPendingBind);
    expect(await bindingOf(c)).toBeNull();
  });

  it('accepts the number as +79…, 79… and 89…', async () => {
    for (const format of [
      (p: string) => p,
      (p: string) => p.slice(1),
      (p: string) => `8${p.slice(2)}`,
    ]) {
      const order = await seedOrder();
      const account = tgId();
      const { token } = await createLinkToken(db, {
        userId: order.userId,
        orderId: order.orderId,
        channel: 'telegram',
        now: NOW,
      });
      await text(account, `/start ${token}`);
      await contact(account, format(order.phone));
      expect((await bindingOf(account))?.userId).toBe(order.userId);
    }
  });

  it('refuses a contact of another user (user_id ≠ from.id) and waits for the own one', async () => {
    const order = await seedOrder();
    const account = tgId();
    const { token } = await createLinkToken(db, {
      userId: order.userId,
      orderId: order.orderId,
      channel: 'telegram',
      now: NOW,
    });
    await text(account, `/start ${token}`);
    // The client's own number, but as somebody else's card (or a card without a Telegram user).
    await contact(account, order.phone, tgId());
    await contact(account, order.phone, null);
    expect(texts(account).slice(1)).toEqual([TEXTS.notOwnContact, TEXTS.notOwnContact]);
    expect(await bindingOf(account)).toBeNull();
    await contact(account, order.phone);
    expect((await bindingOf(account))?.userId).toBe(order.userId);
  });

  it('an expired or malformed link is «устарела»', async () => {
    const order = await seedOrder();
    const account = tgId();
    const { token } = await createLinkToken(db, {
      userId: order.userId,
      orderId: order.orderId,
      channel: 'telegram',
      now: new Date(NOW.getTime() - 25 * 3_600_000),
    });
    await text(account, `/start ${token}`);
    await text(account, '/start не-токен!');
    expect(texts(account)).toEqual([TEXTS.staleLink, TEXTS.staleLink]);
  });

  // --- V2: /stop, kicked, /start ---------------------------------------------------------------

  it('V2: /stop blocks the binding, the next «arrived» goes by SMS; /start switches it back on', async () => {
    const order = await seedOrder();
    const account = await bindThroughBot(order);

    await text(account, '/stop');
    expect(texts(account).at(-1)).toBe(TEXTS.stopped);
    expect((await bindingOf(account))?.blockedAt).toBeInstanceOf(Date);

    const [event] = await db
      .insert(orderEvents)
      .values({ orderId: order.orderId, type: 'reminder', actorType: 'system', payload: {} })
      .returning({ id: orderEvents.id });
    const telegramBefore = t.fakes.clientTelegram.sent().length;
    const smsBefore = gateway.calls.length;
    const result = await processNotify(
      {
        name: 'order',
        data: { orderEventId: event!.id, audience: 'client', template: 'arrived' },
        attemptsMade: 0,
        opts: { attempts: 5 },
      } as unknown as Job,
      t.deps,
    );
    expect(result).toEqual({ status: 'sent', channel: 'sms' });
    expect(t.fakes.clientTelegram.sent().length).toBe(telegramBefore);
    expect(gateway.calls.length).toBe(smsBefore + 1);
    const [row] = await db
      .select()
      .from(notifications)
      .where(sql`starts_with(${notifications.dedupeKey}, ${`${event!.id}:arrived:`})`);
    expect(row).toMatchObject({ status: 'sent', channel: 'sms' });

    // Buttons of a blocked account do nothing.
    await press(account, data('confirm', order.orderId));
    expect(answers().at(-1)).toBe(TEXTS.blocked);

    await text(account, '/start');
    expect((await bindingOf(account))?.blockedAt).toBeNull();
    expect(texts(account).slice(-2)[0]).toBe(TEXTS.unblocked);
    expect(texts(account).at(-1)).toContain(order.number);
  });

  it('«Отключить уведомления» and a kicked bot block the binding', async () => {
    const order = await seedOrder();
    const account = await bindThroughBot(order);
    await press(account, data('unsub', 'me'));
    expect(answers()).toEqual([TEXTS.stopped]);
    expect((await bindingOf(account))?.blockedAt).toBeInstanceOf(Date);

    await text(account, '/start');
    expect((await bindingOf(account))?.blockedAt).toBeNull();

    const before = calls.length;
    await kicked(account);
    expect(calls.length).toBe(before); // silently
    expect((await bindingOf(account))?.blockedAt).toBeInstanceOf(Date);
  });

  it('/start and /orders without a binding explain how to connect', async () => {
    const account = tgId();
    await text(account, '/start');
    await text(account, '/orders');
    await text(account, '/stop');
    expect(texts(account)).toEqual([
      TEXTS.howToConnect('Детали'),
      TEXTS.notConnected('Детали'),
      TEXTS.notConnected('Детали'),
    ]);
  });

  // --- С5: presses -----------------------------------------------------------------------------

  it('«Подтверждаю» from a stranger is «Это не ваш заказ»; from the owner it confirms the order', async () => {
    const order = await seedOrder({ status: 'awaiting_confirmation', scheme: 'pay_on_handover' });
    const other = await seedOrder({ status: 'ready' });
    const outsider = tgId();
    const foreign = await bindThroughBot(other);
    const owner = await bindThroughBot(order);
    const keyboard: Button[][] = [
      [{ text: 'Подтверждаю', callback_data: data('confirm', order.orderId) }],
      [{ text: 'Открыть заказ', url: `https://detaly.test/o/${order.token}` }],
    ];

    mark = calls.length;
    await press(outsider, data('confirm', order.orderId), keyboard);
    await press(foreign, data('confirm', order.orderId), keyboard);
    expect(answers()).toEqual([TEXTS.notYours, TEXTS.notYours]);
    expect(await statusOf(order.orderId)).toBe('awaiting_confirmation');

    mark = calls.length;
    await press(owner, data('confirm', order.orderId), keyboard);
    expect(await statusOf(order.orderId)).toBe('confirmed');
    expect(answers()).toEqual([TEXTS.confirmed]);
    // The buttons of the question are gone, the link stays.
    const edit = recent().find((c) => c.method === 'editMessageReplyMarkup');
    expect(inlineKeyboard(edit)).toEqual([
      [{ text: 'Открыть заказ', url: `https://detaly.test/o/${order.token}` }],
    ]);

    // A second press: the question is closed, the status does not move.
    mark = calls.length;
    await press(owner, data('confirm', order.orderId), keyboard);
    expect(answers()[0]).toBe(TEXTS.notActual('Подтверждён'));
    expect(await statusOf(order.orderId)).toBe('confirmed');
  });

  it('«Вернуть деньги» and «Отказаться» only link to the order page; the status stays', async () => {
    const order = await seedOrder({ status: 'awaiting_client_approval' });
    const owner = await bindThroughBot(order);

    mark = calls.length;
    await press(owner, data('refund', order.orderId));
    expect(answers()).toEqual([TEXTS.confirmOnPage]);
    const reply = sent(owner).at(-1);
    expect(inlineKeyboard(reply)).toEqual([
      [{ text: TEXTS.confirmOnPage, url: `https://detaly.test/o/${order.token}#decision` }],
    ]);
    expect(await statusOf(order.orderId)).toBe('awaiting_client_approval');

    mark = calls.length;
    await press(owner, data('refused', order.orderId));
    expect(inlineKeyboard(sent(owner).at(-1))[0]?.[0]?.url).toBe(
      `https://detaly.test/o/${order.token}#refuse`,
    );
    expect(await statusOf(order.orderId)).toBe('awaiting_client_approval');
    const events = await db
      .select({ type: orderEvents.type })
      .from(orderEvents)
      .where(eq(orderEvents.orderId, order.orderId));
    expect(events.map((e) => e.type)).toEqual(['messenger_bound']);
  });

  it('staff codes and malformed data are refused without effects', async () => {
    const order = await seedOrder({ status: 'ready' });
    const owner = await bindThroughBot(order);
    mark = calls.length;
    await press(owner, data('handed', order.orderId));
    await press(owner, 'garbage');
    expect(answers()).toEqual([TEXTS.staleButton, TEXTS.staleButton]);
    expect(await statusOf(order.orderId)).toBe('ready');
  });

  // --- С6: installation ------------------------------------------------------------------------

  it('booking through the slot buttons; a repeated press does not book twice', async () => {
    const order = await seedOrder({ status: 'ready' });
    const owner = await bindThroughBot(order);

    mark = calls.length;
    await press(owner, data('install', order.orderId));
    const menu = sent(owner).at(-1);
    expect(String(menu?.payload.text)).toContain(order.number);
    expect(String(menu?.payload.text)).toContain('оплачивается в сервисе по его чеку');
    expect(String(menu?.payload.text)).not.toMatch(/₽|руб/);
    const rows = inlineKeyboard(menu);
    const slots = rows.flat().filter((b) => b.callback_data?.startsWith('a:islot:'));
    expect(slots.length).toBeGreaterThan(0);
    expect(slots.length).toBeLessThanOrEqual(6);
    expect(rows.at(-1)).toEqual([
      { text: TEXTS.installOther, url: `https://detaly.test/o/${order.token}#install` },
    ]);
    for (const slot of slots)
      expect(Buffer.byteLength(slot.callback_data!)).toBeLessThanOrEqual(64);
    const nonce = slots[0]!.callback_data!.split(':')[3]!;
    expect(await t.deps.redis.ttl(slotKey(t.deps.keyPrefix, nonce))).toBeGreaterThan(890);

    mark = calls.length;
    await press(owner, slots[0]!.callback_data!, rows);
    const bookings = await db
      .select()
      .from(installBookings)
      .where(eq(installBookings.orderId, order.orderId));
    expect(bookings).toHaveLength(1);
    expect(bookings[0]).toMatchObject({ status: 'requested', createdVia: 'bot' });
    expect(answers()).toEqual([TEXTS.installDoneShort]);
    const edited = recent().find((c) => c.method === 'editMessageText');
    expect(String(edited?.payload.text)).toContain(`${order.number}: записали на`);
    expect(String(edited?.payload.text)).toContain('Тестовый сервис');

    // The same button again (a double tap): the same booking, nothing new.
    await press(owner, slots[0]!.callback_data!, rows);
    // Another slot of the same list: the order already has its booking.
    mark = calls.length;
    await press(owner, slots[1]!.callback_data!, rows);
    expect(answers()).toEqual([TEXTS.installBooked]);
    const after = await db
      .select()
      .from(installBookings)
      .where(eq(installBookings.orderId, order.orderId));
    expect(after).toHaveLength(1);

    // «Записаться» again: the reason in words.
    mark = calls.length;
    await press(owner, data('install', order.orderId));
    expect(texts(owner).at(-1)).toBe(TEXTS.installBooked);
  });

  it('a slot taken meanwhile gives a fresh list; a stale nonce too', async () => {
    const order = await seedOrder({ status: 'ready' });
    const owner = await bindThroughBot(order);
    await press(owner, data('install', order.orderId));
    const slots = inlineKeyboard(sent(owner).at(-1))
      .flat()
      .filter((b) => b.callback_data?.startsWith('a:islot:'));
    const nonce = slots[0]!.callback_data!.split(':')[3]!;
    const slotAt = JSON.parse((await t.deps.redis.get(slotKey(t.deps.keyPrefix, nonce)))!)
      .startAt as string;
    // Other clients take every lift of that hour.
    for (let i = 0; i < INSTALL_LIFTS; i += 1) {
      const rival = await seedOrder({ status: 'ready' });
      await db.insert(installBookings).values({
        orderId: rival.orderId,
        userId: rival.userId,
        slotAt: new Date(slotAt),
        status: 'confirmed',
      });
    }

    mark = calls.length;
    await press(owner, slots[0]!.callback_data!);
    expect(answers()).toEqual([TEXTS.installSlotTaken]);
    const fresh = sent(owner).at(-1);
    expect(String(fresh?.payload.text)).toContain(TEXTS.installSlotTaken);
    const freshSlots = inlineKeyboard(fresh)
      .flat()
      .filter((b) => b.callback_data?.startsWith('a:islot:'));
    expect(freshSlots.length).toBeGreaterThan(0);
    const freshTimes = await Promise.all(
      freshSlots.map(async (b) => {
        const key = slotKey(t.deps.keyPrefix, b.callback_data!.split(':')[3]!);
        return JSON.parse((await t.deps.redis.get(key))!).startAt as string;
      }),
    );
    expect(freshTimes).not.toContain(slotAt);
    expect(
      await db.select().from(installBookings).where(eq(installBookings.orderId, order.orderId)),
    ).toHaveLength(0);

    // A nonce Redis no longer knows (15 minutes passed).
    mark = calls.length;
    await press(owner, buildCallbackData('islot', order.orderId, 'gone0000'));
    expect(answers()).toEqual([TEXTS.installSlotStale]);
  });

  it('a slot of somebody else’s order is «Это не ваш заказ»', async () => {
    const order = await seedOrder({ status: 'ready' });
    const owner = await bindThroughBot(order);
    await press(owner, data('install', order.orderId));
    const slot = inlineKeyboard(sent(owner).at(-1))
      .flat()
      .find((b) => b.callback_data?.startsWith('a:islot:'))!;
    const other = await seedOrder({ status: 'ready' });
    const intruder = await bindThroughBot(other);
    mark = calls.length;
    await press(intruder, slot.callback_data!);
    expect(answers()).toEqual([TEXTS.notYours]);
    expect(
      await db.select().from(installBookings).where(eq(installBookings.orderId, order.orderId)),
    ).toHaveLength(0);
  });

  // --- lists, auto reply, groups ---------------------------------------------------------------

  it('/orders shows at most five orders with buttons by status', async () => {
    const first = await seedOrder({ status: 'awaiting_confirmation', scheme: 'pay_on_handover' });
    for (const status of [
      'ready',
      'handed',
      'ordered_at_supplier',
      'cancelled',
      'completed',
    ] as const) {
      await seedOrder({ status, userId: first.userId });
    }
    const owner = await bindThroughBot(first);
    mark = calls.length;
    await text(owner, '/orders');
    const list = sent(owner).at(-1);
    const body = String(list?.payload.text);
    expect(body.match(/DT-\d+/g)).toHaveLength(5);
    expect(body).not.toContain(first.number); // the oldest of six
    const buttons = inlineKeyboard(list).flat();
    expect(buttons.some((b) => b.text.endsWith('Претензия') && b.url?.endsWith('#claim'))).toBe(
      true,
    );
    expect(buttons.some((b) => b.text.endsWith('Записаться на установку'))).toBe(true);
    expect(buttons.at(-1)?.callback_data).toMatch(/^a:unsub:me:/);
  });

  it('other messages get the auto reply with the pickup phone; groups get silence', async () => {
    const account = tgId();
    await text(account, 'Здравствуйте, когда приедет фильтр?');
    await bot.handleUpdate(
      messageUpdate(account, {
        photo: [{ file_id: 'x', file_unique_id: 'y', width: 1, height: 1 }],
      }),
    );
    await text(account, '/help');
    expect(texts(account)).toEqual([
      TEXTS.autoReply(PICKUP_PHONE),
      TEXTS.autoReply(PICKUP_PHONE),
      TEXTS.autoReply(PICKUP_PHONE),
    ]);

    mark = calls.length;
    await text(account, '/start', 'group');
    await text(account, 'привет', 'group');
    expect(recent()).toEqual([]);
  });

  // --- V6: PD in outgoing texts and logs -------------------------------------------------------

  it('V6: no outgoing text or button carries a client phone or name; logs carry no phone, token or Telegram id', () => {
    const outgoing = calls
      .filter((c) => ['sendMessage', 'editMessageText', 'answerCallbackQuery'].includes(c.method))
      .map((c) =>
        [c.payload.text ?? '', ...inlineKeyboard(c).flatMap((row) => row.map((b) => b.text))].join(
          '\n',
        ),
      );
    expect(outgoing.length).toBeGreaterThan(30);
    for (const message of outgoing) {
      const digits = message.replace(/\D/g, '');
      for (const phone of phones) {
        const own = phone.replace(/\D/g, '');
        for (let i = 0; i + 7 <= own.length; i += 1) {
          expect(digits, message).not.toContain(own.slice(i, i + 7));
        }
      }
      expect(message).not.toContain('Иван');
      expect(message).not.toContain('Петров');
    }

    const log = logs.join('');
    expect(log).toContain('client bot');
    for (const phone of phones) expect(log).not.toContain(phone.slice(2));
    expect(log).not.toContain(TOKEN);
    expect(log).not.toMatch(/"(from|tgUserId|externalUserId|chatId)"/);
    expect(log).not.toMatch(/\b1\d{9}\b/); // the Telegram ids of this file
  });
});
