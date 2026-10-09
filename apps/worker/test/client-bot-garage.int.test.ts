// Step 6 (docs/garage.md): «Мои машины» of the client bot on the `_worker` database, grammY without
// network (the transport is replaced, updates fed with bot.handleUpdate): /garage and the button
// list the bound client's cars with their latest orders and never more of a VIN than its last 4
// characters; «Купить снова» makes a fresh repeat proposal (today's prices by priceOffer, marked
// goods and missing parts left out with a note) and answers with the /p/<token> link; «Удалить
// машину» asks first and then deletes the car (the orders lose the link); another client's car or
// order is never touched; without GARAGE_ENABLED none of it exists. VINs are synthetic.
import { randomBytes, randomInt } from 'node:crypto';
import { Writable } from 'node:stream';
import { createLogger } from '@detaly/config';
import { carts, eq, orderItems, orders, userVehicles, users, type Db } from '@detaly/db';
import { type Offer, type OrderStatus } from '@detaly/domain';
import { buildCallbackData, newNonce } from '@detaly/notify';
import { bindMessenger, loadOrderSettings } from '@detaly/orders';
import { previewVinAnswer } from '@detaly/vin';
import type { Bot } from 'grammy';
import type { Update, UserFromGetMe } from 'grammy/types';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';
import { createClientBot } from '../src/bots/client/bot';
import { TEXTS } from '../src/bots/client/texts';
import { loadExcludedRules, vinSearch } from '../src/bots/seller/vin';
import { createTestDeps, type TestDeps } from './helpers/test-deps';

const BOT_INFO = {
  id: 7_000_000_012,
  is_bot: true,
  first_name: 'Детали · статусы',
  username: 'detaly_client_garage_test_bot',
  can_join_groups: false,
  can_read_all_group_messages: false,
  supports_inline_queries: false,
} as UserFromGetMe;

const TOKEN = '777001:client-garage-test-token-not-real';
const ENV = {
  APP_BASE_URL: 'https://detaly.test',
  BRAND_NAME: 'Детали',
  PICKUP_PHONE: '+7 (3532) 00-00-00',
  TG_CLIENT_BOT_TOKEN: TOKEN,
};
const VIN = 'XTA21099043456789';

interface ApiCall {
  method: string;
  payload: Record<string, unknown>;
}

interface Button {
  text: string;
  callback_data?: string;
  url?: string;
}

const tgId = () => randomInt(1_000_000_000, 2_000_000_000);
const randomPhone = () => `+79${String(randomInt(0, 1_000_000_000)).padStart(9, '0')}`;
const date = () => Math.floor(Date.now() / 1000);

function snapshot(brand: string, article: string, articleNorm: string): Offer {
  return {
    source: 'rossko',
    brand,
    article,
    articleNorm,
    name: 'Деталь',
    group: null,
    isCross: false,
    priceSupplierKop: 100,
    stock: {
      stockId: 'ORB1',
      isLocal: true,
      count: 10,
      multiplicity: 1,
      type: null,
      deliveryDays: 0,
      deliveryStart: null,
      deliveryEnd: null,
      extra: null,
      description: null,
    },
  };
}

describe.skipIf(!inject('workerDatabaseUrl'))('client bot: «Мои машины» (step 6)', () => {
  const logs: string[] = [];
  let t: TestDeps;
  let off: TestDeps;
  let db: Db;
  let bot: Bot;
  let botOff: Bot;
  let calls: ApiCall[];
  let updateId = 1;

  function transport(target: Bot) {
    target.api.config.use(async (_prev, method, payload) => {
      const p = (payload ?? {}) as Record<string, unknown>;
      calls.push({ method, payload: p });
      const result =
        method === 'answerCallbackQuery'
          ? true
          : {
              message_id: 6000 + calls.length,
              date: date(),
              chat: { id: Number(p.chat_id ?? 0), type: 'private' },
              text: p.text,
            };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return { ok: true, result } as any;
    });
  }

  beforeAll(async () => {
    calls = [];
    t = await createTestDeps({
      envOverrides: { ...ENV, GARAGE_ENABLED: 'true' },
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
    off = await createTestDeps({ db, envOverrides: { ...ENV, GARAGE_ENABLED: 'false' } });
    bot = createClientBot({ token: TOKEN, botInfo: BOT_INFO, deps: t.deps });
    botOff = createClientBot({ token: TOKEN, botInfo: BOT_INFO, deps: off.deps });
    transport(bot);
    transport(botOff);
  });

  afterAll(async () => {
    await off?.close();
    await t?.close();
  });

  let mark = 0;
  beforeEach(() => {
    mark = calls.length;
  });
  const recent = () => calls.slice(mark);
  const sent = () => recent().filter((c) => c.method === 'sendMessage');
  const texts = () => sent().map((c) => String(c.payload.text));
  const answers = () =>
    recent()
      .filter((c) => c.method === 'answerCallbackQuery')
      .map((c) => (c.payload.text as string | undefined) ?? '');
  const keyboardOf = (call: ApiCall | undefined): Button[][] =>
    ((call?.payload.reply_markup as { inline_keyboard?: Button[][] } | undefined)
      ?.inline_keyboard ?? []) as Button[][];

  function command(target: Bot, from: number, value: string) {
    return target.handleUpdate({
      update_id: updateId++,
      message: {
        message_id: updateId,
        date: date(),
        chat: { id: from, type: 'private', first_name: 'Иван' },
        from: { id: from, is_bot: false, first_name: 'Иван' },
        text: value,
        entities: [{ type: 'bot_command', offset: 0, length: value.split(' ')[0]!.length }],
      },
    } as unknown as Update);
  }

  function press(target: Bot, from: number, data: string) {
    return target.handleUpdate({
      update_id: updateId++,
      callback_query: {
        id: String(updateId),
        from: { id: from, is_bot: false, first_name: 'Иван' },
        chat_instance: 'ci',
        data,
        message: {
          message_id: 950,
          date: date(),
          chat: { id: from, type: 'private', first_name: 'Иван' },
          text: 'Мои машины',
        },
      },
    } as unknown as Update);
  }

  /** A client with an order (the given items) for a car, bound to a Telegram account. */
  async function client(
    items: { brand: string; article: string; articleNorm: string; qty?: number }[],
    status: OrderStatus = 'completed',
  ) {
    const phone = randomPhone();
    const [user] = await db.insert(users).values({ phone, name: 'Иван' }).returning();
    const [car] = await db
      .insert(userVehicles)
      .values({
        userId: user!.id,
        makeSlug: 'lada',
        make: 'Lada',
        model: 'Vesta',
        engine: '1.6',
        year: 2019,
        vin: VIN,
        mileageKm: 85_000,
        mileageAt: '2026-10-01',
        source: 'checkout',
      })
      .returning();
    const [order] = await db
      .insert(orders)
      .values({
        userId: user!.id,
        accessToken: randomBytes(32).toString('base64url'),
        status,
        paymentScheme: 'prepay',
        subtotalKop: 1000,
        totalKop: 1000,
        itemsHash: 'test',
        vehicleId: car!.id,
      })
      .returning();
    await db.insert(orderItems).values(
      items.map((item) => ({
        orderId: order!.id,
        offerKey: `${item.articleNorm}:${item.brand}:ORB1`,
        searchArticleNorm: item.articleNorm,
        brand: item.brand,
        article: item.article,
        name: 'Деталь',
        qty: item.qty ?? 1,
        stockId: 'ORB1',
        isLocal: true,
        priceSupplierAtOrderKop: 100,
        priceClientKop: 1,
        markupBp: 0,
        offerSnapshot: snapshot(item.brand, item.article, item.articleNorm),
        state: 'handed' as const,
      })),
    );
    const account = tgId();
    await bindMessenger(db, {
      userId: user!.id,
      orderId: order!.id,
      channel: 'telegram',
      externalUserId: String(account),
      chatId: String(account),
      now: new Date(),
    });
    return { userId: user!.id, account, car: car!, order: order! };
  }

  const KNECHT = { brand: 'Knecht', article: 'OC 90', articleNorm: 'OC90' };
  const TRW = { brand: 'TRW', article: 'GDB1330', articleNorm: 'GDB1330' };
  const OIL = { brand: 'CASTROL', article: 'EDGE 5W-40', articleNorm: 'EDGE5W40' };

  it('/garage: the car, the last 4 of the VIN, the mileage, the orders and the buttons', async () => {
    const c = await client([KNECHT, TRW]);
    await command(bot, c.account, '/garage');
    const [message] = sent();
    const text = String(message?.payload.text);
    expect(text).toContain('Lada Vesta 1.6, 2019');
    expect(text).toContain('VIN …6789');
    expect(text).toContain('пробег 85\u00a0000\u00a0км на 1 октября');
    expect(text).toContain(`${c.order.number} от `);
    expect(text).toContain('Knecht OC 90, TRW GDB1330');
    expect(text).not.toContain(VIN);
    expect(text).not.toContain(VIN.slice(0, 13));
    const buttons = keyboardOf(message).flat();
    expect(buttons.map((b) => b.text)).toEqual([
      `Купить снова ${c.order.number}`,
      'Удалить машину',
    ]);
    expect(buttons[0]?.callback_data).toMatch(new RegExp(`^a:rebuy:${c.order.id}:`));
    expect(buttons[1]?.callback_data).toMatch(new RegExp(`^a:vdel:${c.car.id}:`));
  });

  it('the «Мои машины» button under «Мои заказы» opens the same list', async () => {
    const c = await client([KNECHT]);
    await command(bot, c.account, '/orders');
    const list = sent()[0];
    const garage = keyboardOf(list)
      .flat()
      .find((b) => b.text === TEXTS.garageButton);
    expect(garage?.callback_data).toMatch(/^a:garage:me:/);
    mark = calls.length;
    await press(bot, c.account, garage!.callback_data!);
    expect(texts()[0]).toContain('Lada Vesta 1.6, 2019');
  });

  it('no cars: how to add one', async () => {
    const c = await client([KNECHT]);
    await db.delete(userVehicles).where(eq(userVehicles.id, c.car.id));
    await command(bot, c.account, '/garage');
    expect(texts()).toEqual([TEXTS.garageEmpty]);
  });

  it('«Купить снова»: today’s prices, marked goods left out with a note, the /p link', async () => {
    const c = await client([KNECHT, OIL]);
    await press(bot, c.account, buildCallbackData('rebuy', c.order.id, newNonce()));
    expect(answers()).toEqual([TEXTS.rebuyChecking]);
    const [reply] = sent();
    const text = String(reply?.payload.text);
    // The price of today for the same part, by the VIN preview rule (priceOffer).
    const settings = await loadOrderSettings(db, t.deps.env);
    const preview = await previewVinAnswer({
      text: 'Knecht OC90 1',
      search: vinSearch(t.deps),
      pricing: settings.pricing,
      excludedRules: await loadExcludedRules(db),
      eta: settings.eta,
      now: new Date(),
    });
    const line = preview.lines[0];
    if (line?.status !== 'ok') throw new Error('preview expected ok');
    expect(text).toContain(`Заказ ${c.order.number} снова — по сегодняшним ценам:`);
    expect(text).toContain(
      `• Knecht OC 90 × 1 — ${String(line.priceClientKop / 100).replace(/\B(?=(\d{3})+(?!\d))/g, '\u00a0')}\u00a0₽`,
    );
    expect(text).toContain('Не вошли: CASTROL EDGE 5W-40 — не продаём онлайн.');
    const open = keyboardOf(reply)[0]?.[0];
    expect(open?.text).toBe(TEXTS.rebuyOpen);
    const token = /\/p\/([A-Za-z0-9_-]{32})$/.exec(open?.url ?? '')?.[1];
    expect(open?.url).toBe(`https://detaly.test/p/${token}`);
    const [cart] = await db.select().from(carts).where(eq(carts.proposalToken, token!));
    expect(cart).toMatchObject({ repeatOrderId: c.order.id, vinRequestId: null });
    // The token never reaches the logs.
    expect(logs.join('')).not.toContain(token!);
    expect(logs.join('')).toContain('"action":"rebuy"');
  });

  it('«Купить снова» of another client’s order: refused, nothing made', async () => {
    const owner = await client([KNECHT]);
    const stranger = await client([TRW]);
    await press(bot, stranger.account, buildCallbackData('rebuy', owner.order.id, newNonce()));
    expect(answers()).toEqual([TEXTS.notYours]);
    expect(sent()).toEqual([]);
    expect(await db.select().from(carts).where(eq(carts.repeatOrderId, owner.order.id))).toEqual(
      [],
    );
  });

  it('«Купить снова» with nothing to offer says so', async () => {
    const c = await client([OIL]);
    await press(bot, c.account, buildCallbackData('rebuy', c.order.id, newNonce()));
    expect(texts()).toEqual([
      TEXTS.rebuyNone(c.order.number, 'CASTROL EDGE 5W-40 — не продаём онлайн'),
    ]);
  });

  it('«Удалить машину»: asks, then deletes; the order keeps everything but the link', async () => {
    const c = await client([KNECHT]);
    await press(bot, c.account, buildCallbackData('vdel', c.car.id, newNonce()));
    const ask = sent()[0];
    expect(String(ask?.payload.text)).toBe(TEXTS.deleteAsk('Lada Vesta 1.6, 2019'));
    const [yes, no] = keyboardOf(ask).flat();
    expect(yes?.text).toBe(TEXTS.deleteYes);
    expect(no).toMatchObject({ text: TEXTS.deleteNo });
    expect(no?.callback_data).toMatch(/^a:garage:me:/);
    // Nothing is deleted before the confirmation.
    expect(await db.select().from(userVehicles).where(eq(userVehicles.id, c.car.id))).toHaveLength(
      1,
    );

    mark = calls.length;
    await press(bot, c.account, yes!.callback_data!);
    expect(answers()).toEqual([TEXTS.deletedShort]);
    const edit = recent().find((call) => call.method === 'editMessageText');
    expect(edit?.payload.text).toBe(TEXTS.deleted('Lada Vesta 1.6, 2019'));
    expect(await db.select().from(userVehicles).where(eq(userVehicles.id, c.car.id))).toEqual([]);
    const [order] = await db.select().from(orders).where(eq(orders.id, c.order.id));
    expect(order).toMatchObject({ vehicleId: null, status: 'completed' });

    mark = calls.length;
    await press(bot, c.account, yes!.callback_data!);
    expect(texts()).toEqual([TEXTS.vehicleGone]);
    // Said once, by the message: the press only stops the spinner.
    expect(answers()).toEqual(['']);
  });

  it('another client’s car: neither asked about nor deleted', async () => {
    const owner = await client([KNECHT]);
    const stranger = await client([TRW]);
    await press(bot, stranger.account, buildCallbackData('vdel', owner.car.id, newNonce()));
    await press(bot, stranger.account, buildCallbackData('vdelok', owner.car.id, newNonce()));
    expect(texts()).toEqual([TEXTS.vehicleGone, TEXTS.vehicleGone]);
    expect(
      await db.select().from(userVehicles).where(eq(userVehicles.id, owner.car.id)),
    ).toHaveLength(1);
  });

  it('a stranger to the bot gets how to connect', async () => {
    await command(bot, tgId(), '/garage');
    expect(texts()).toEqual([TEXTS.notConnected('Детали')]);
  });

  it('GARAGE_ENABLED off: /garage is an unknown command, no button, presses are stale', async () => {
    const c = await client([KNECHT]);
    await command(botOff, c.account, '/garage');
    expect(texts()).toEqual([TEXTS.autoReply('+7 (3532) 00-00-00')]);

    mark = calls.length;
    await command(botOff, c.account, '/orders');
    const list = sent()[0];
    expect(
      keyboardOf(list)
        .flat()
        .map((b) => b.text),
    ).not.toContain(TEXTS.garageButton);
    expect(String(list?.payload.text)).not.toContain('Lada');

    for (const data of [
      buildCallbackData('garage', 'me', newNonce()),
      buildCallbackData('rebuy', c.order.id, newNonce()),
      buildCallbackData('vdel', c.car.id, newNonce()),
      buildCallbackData('vdelok', c.car.id, newNonce()),
    ]) {
      mark = calls.length;
      await press(botOff, c.account, data);
      expect(answers()).toEqual([TEXTS.staleButton]);
      expect(sent()).toEqual([]);
    }
    expect(await db.select().from(userVehicles).where(eq(userVehicles.id, c.car.id))).toHaveLength(
      1,
    );
    expect(await db.select().from(carts).where(eq(carts.repeatOrderId, c.order.id))).toEqual([]);
  });
});
