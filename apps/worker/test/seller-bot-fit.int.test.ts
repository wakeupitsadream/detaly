// Step 4 (docs/fit-check.md): fit check cards in the seller bot — the card (full VIN, the comment
// masked, numbered lines, no client phone or name), the answers per line (staff only, callback_data
// within 64 bytes), idempotency (a second press edits nothing: «Уже отвечено»), «Аналог» with the
// reply «БРЕНД АРТИКУЛ» found and priced on the Rossko fixtures or «Не нашёл у поставщика»,
// and the fit guarantee label of a «не подошла» claim on the order card. The real database
// (`_worker`), grammY without network (the transport is replaced and records every call).
import { randomBytes, randomInt } from 'node:crypto';
import { Writable } from 'node:stream';
import { createLogger } from '@detaly/config';
import {
  cartItems,
  carts,
  eq,
  fitChecks,
  orderItems,
  orders,
  sellerCards,
  staff,
} from '@detaly/db';
import { offerViewId, type Offer } from '@detaly/domain';
import { CALLBACK_DATA_MAX_BYTES, parseCallbackData } from '@detaly/notify';
import { openClaim } from '@detaly/orders';
import { createFitCheckRequest, newVinRequestId } from '@detaly/vin';
import { Api, type Bot, type Transformer } from 'grammy';
import type { Update, UserFromGetMe } from 'grammy/types';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSellerBot } from '../src/bots/seller/bot';
import { createSellerCards } from '../src/bots/seller/cards';
import { FIT_CARD_HEADLINE } from '../src/bots/seller/fit-view';
import type { WorkerDeps } from '../src/deps';
import { hasTestDatabase } from './fixtures/databases';
import { createTestDeps, type TestDeps } from './helpers/test-deps';
import { PAYMENT_ENV, seedOrder } from './payments-helpers';

const TOKEN = '123456:seller-bot-fit-test-token';
const SELLER_CHAT = -100_777_000_000 - randomInt(0, 1_000_000);
const SELLER_TG = 8_500_000_000 + randomInt(0, 1_000_000);
const OWNER_TG = SELLER_TG + 1;
const STRANGER_TG = SELLER_TG + 2;
const BASE_URL = 'https://detaly.test';
/** Synthetic VIN that passes isValidVin (never a real car). */
const VIN = 'XTA21099012345678';
/** A phone typed into the comment must never reach Telegram. */
const COMMENT_PHONE_DIGITS = '9123456789';
const DAY = 24 * 60 * 60 * 1000;

const BOT_INFO = {
  id: 7_000_000_021,
  is_bot: true,
  first_name: 'Детали · продавцы',
  username: 'detaly_seller_fit_test_bot',
  can_join_groups: true,
  can_read_all_group_messages: false,
  supports_inline_queries: false,
} as UserFromGetMe;

interface Call {
  method: string;
  payload: Record<string, unknown>;
  result: unknown;
}

interface Button {
  text: string;
  callback_data?: string;
  url?: string;
}

function recorder() {
  const calls: Call[] = [];
  let nextMessageId = 9000;
  const transformer: Transformer = async (_prev, method, payload) => {
    const p = payload as Record<string, unknown>;
    let result: unknown = true;
    if (method === 'sendMessage') {
      result = {
        message_id: nextMessageId++,
        date: Math.floor(Date.now() / 1000),
        chat: { id: Number(p.chat_id), type: 'supergroup', title: 'Продавцы' },
        ...(typeof p.text === 'string' ? { text: p.text } : {}),
      };
    }
    calls.push({ method, payload: p, result });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return { ok: true, result } as any;
  };
  return { calls, transformer };
}

let t: TestDeps;
let rec: ReturnType<typeof recorder>;
let bot: Bot;
const logLines: string[] = [];
const staffIds: string[] = [];
let sellerId = '';
let updateId = 1;

const groupChat = { id: SELLER_CHAT, type: 'supergroup' as const, title: 'Продавцы' };

function keyboardOf(call: Call): Button[] {
  const markup = call.payload.reply_markup as { inline_keyboard?: Button[][] } | undefined;
  return (markup?.inline_keyboard ?? []).flat();
}

function sentMessageId(call: Call): number {
  return (call.result as { message_id: number }).message_id;
}

function lastRendering(messageId: number): { text: string; buttons: Button[] } {
  for (let i = rec.calls.length - 1; i >= 0; i -= 1) {
    const call = rec.calls[i] as Call;
    if (call.method === 'sendMessage' && sentMessageId(call) === messageId) {
      return { text: String(call.payload.text), buttons: keyboardOf(call) };
    }
    if (call.method === 'editMessageText' && call.payload.message_id === messageId) {
      return { text: String(call.payload.text), buttons: keyboardOf(call) };
    }
  }
  throw new Error(`message ${messageId} was never sent`);
}

function buttonData(messageId: number, label: string): string {
  const button = lastRendering(messageId).buttons.find((b) => b.text === label);
  if (!button?.callback_data) throw new Error(`no button «${label}» on message ${messageId}`);
  return button.callback_data;
}

function callsSince(index: number): Call[] {
  return rec.calls.slice(index);
}

function answersSince(index: number): (string | undefined)[] {
  return callsSince(index)
    .filter((c) => c.method === 'answerCallbackQuery')
    .map((c) => c.payload.text as string | undefined);
}

function messagesSince(index: number): string[] {
  return callsSince(index)
    .filter((c) => c.method === 'sendMessage')
    .map((c) => String(c.payload.text));
}

function promptSince(index: number): Call {
  const prompt = callsSince(index)
    .filter(
      (c) =>
        c.method === 'sendMessage' &&
        (c.payload.reply_markup as { force_reply?: boolean } | undefined)?.force_reply === true,
    )
    .at(-1);
  if (!prompt) throw new Error('no ForceReply prompt');
  return prompt;
}

async function press(data: string, messageId: number, from = SELLER_TG): Promise<void> {
  const id = updateId++;
  await bot.handleUpdate({
    update_id: id,
    callback_query: {
      id: `cb${id}`,
      from: { id: from, is_bot: false, first_name: 'Тест' },
      chat_instance: 'ci',
      data,
      message: { message_id: messageId, date: Math.floor(Date.now() / 1000), chat: groupChat },
    },
  } as Update);
}

async function reply(text: string, to: number, from = SELLER_TG): Promise<void> {
  const id = updateId++;
  // A reply quoting the bot's prompt (grammY types a quoted message as one without a quote).
  await bot.handleUpdate({
    update_id: id,
    message: {
      message_id: 200_000 + id,
      date: Math.floor(Date.now() / 1000),
      chat: groupChat,
      from: { id: from, is_bot: false, first_name: 'Тест' },
      reply_to_message: {
        message_id: to,
        date: Math.floor(Date.now() / 1000),
        chat: groupChat,
        from: { ...BOT_INFO },
        text: 'prompt',
      },
      text,
    },
  } as unknown as Update);
}

/** A cart with lines of the fixture offers and a request for all of them; its card posted. */
async function postedRequest(
  offers: Offer[],
): Promise<{ requestId: string; checkIds: string[]; messageId: number }> {
  const [cart] = await t.deps.db
    .insert(carts)
    .values({ anonToken: randomBytes(32).toString('base64url') })
    .returning();
  const lineIds: string[] = [];
  for (const offer of offers) {
    const [line] = await t.deps.db
      .insert(cartItems)
      .values({
        cartId: cart!.id,
        offerKey: offerViewId(offer),
        searchArticleNorm: offer.articleNorm,
        brand: offer.brand,
        article: offer.article,
        name: offer.name,
        qty: 1,
        stockId: offer.stock.stockId,
        isLocal: offer.stock.isLocal,
        priceSupplierKop: offer.priceSupplierKop,
        priceClientKop: offer.priceSupplierKop * 2,
        markupBp: 2800,
        offerSnapshot: offer,
        fetchedAt: new Date(),
      })
      .returning();
    lineIds.push(line!.id);
  }
  const created = await createFitCheckRequest(t.deps.db, {
    cartId: cart!.id,
    lineIds,
    vin: VIN,
    comment: `двигатель 1.6, 2019, звоните 8 ${COMMENT_PHONE_DIGITS}`,
    now: new Date(),
  });
  if (!created.ok) throw new Error(`not created: ${created.reason}`);
  const rows = await t.deps.db
    .select({ id: fitChecks.id, cartItemId: fitChecks.cartItemId })
    .from(fitChecks)
    .where(eq(fitChecks.requestId, created.requestId));
  const checkIds = lineIds.map((lineId) => rows.find((r) => r.cartItemId === lineId)!.id);
  const before = rec.calls.length;
  expect(await createSellerCards(t.deps).postFit({ requestId: created.requestId })).toEqual({
    status: 'posted',
  });
  const sent = callsSince(before).find((c) => c.method === 'sendMessage');
  if (!sent) throw new Error('no card was sent');
  return { requestId: created.requestId, checkIds, messageId: sentMessageId(sent) };
}

async function fixtureOffer(article: string, brand: string): Promise<Offer> {
  const { offers } = await t.deps.rossko.search(article);
  const offer = offers.find((o) => o.brand === brand && !o.isCross);
  if (!offer) throw new Error(`no fixture offer ${brand} ${article}`);
  return offer;
}

async function statusOf(id: string) {
  const [row] = await t.deps.db.select().from(fitChecks).where(eq(fitChecks.id, id));
  return row;
}

function makeBot(deps: WorkerDeps): Bot {
  const staffTg = new Set([SELLER_TG, OWNER_TG]);
  const instance = createSellerBot({
    token: TOKEN,
    botInfo: BOT_INFO,
    isStaff: async (id) => staffTg.has(id),
    health: async () => ({ heartbeatAgeSec: 1, dbOk: true, gitSha: null }),
    sellerChatId: SELLER_CHAT,
    logger: deps.logger,
    deps,
  });
  instance.api.config.use(rec.transformer);
  return instance;
}

beforeAll(async () => {
  if (!hasTestDatabase) return;
  rec = recorder();
  const api = new Api(TOKEN);
  api.config.use(rec.transformer);
  const sink = new Writable({
    write(chunk: Buffer, _enc, done) {
      logLines.push(chunk.toString());
      done();
    },
  });
  t = await createTestDeps({
    telegram: api,
    logger: createLogger('seller-bot-fit-test', { level: 'debug', destination: sink }),
    envOverrides: {
      ...PAYMENT_ENV,
      APP_BASE_URL: BASE_URL,
      TG_SELLER_BOT_TOKEN: TOKEN,
      TG_SELLER_CHAT_ID: String(SELLER_CHAT),
      PICKUP_HOURS: 'Пн–Пт 10:00–19:00',
    },
  });
  const rows = await t.deps.db
    .insert(staff)
    .values([
      { name: 'Мастер Лёша', role: 'seller', tgUserId: SELLER_TG },
      { name: 'Владелец', role: 'owner', tgUserId: OWNER_TG },
    ])
    .returning({ id: staff.id, role: staff.role });
  for (const row of rows) staffIds.push(row.id);
  sellerId = rows.find((r) => r.role === 'seller')?.id ?? '';
  bot = makeBot(t.deps);
});

afterAll(async () => {
  if (!hasTestDatabase) return;
  const outgoing = rec.calls.map((c) => JSON.stringify(c.payload)).join('\n');
  // The phone typed into the comment never reaches Telegram; callback_data stays within 64 bytes.
  expect(outgoing).not.toContain(COMMENT_PHONE_DIGITS);
  for (const call of rec.calls) {
    for (const button of keyboardOf(call)) {
      if (button.callback_data) {
        expect(Buffer.byteLength(button.callback_data)).toBeLessThanOrEqual(
          CALLBACK_DATA_MAX_BYTES,
        );
      }
    }
  }
  // Logs: ids and counts only — no VIN, no comment, no token.
  const logs = logLines.join('');
  expect(logs).not.toContain(VIN);
  expect(logs).not.toContain('двигатель');
  expect(logs).not.toContain(TOKEN);
  if (staffIds.length > 0) {
    const sqlc = t.deps.db.$client;
    await sqlc`update fit_checks set answered_by = null where answered_by in ${sqlc(staffIds)}`;
    await sqlc`update order_items set fit_checked_by = null where fit_checked_by in ${sqlc(staffIds)}`;
    await sqlc`update claims set decided_by = null where decided_by in ${sqlc(staffIds)}`;
    await sqlc`delete from staff where id in ${sqlc(staffIds)}`;
  }
  await t.close();
});

describe.skipIf(!hasTestDatabase)('seller bot: fit check cards', () => {
  it('the card: headline, the full VIN, the comment masked, numbered lines, buttons per line', async () => {
    const knecht = await fixtureOffer('OC90', 'Knecht');
    const trw = await fixtureOffer('GDB1330', 'TRW');
    const { requestId, checkIds, messageId } = await postedRequest([knecht, trw]);
    const { text, buttons } = lastRendering(messageId);
    expect(text.startsWith(`${FIT_CARD_HEADLINE} № `)).toBe(true);
    expect(text).toContain(`VIN ${VIN}`);
    expect(text).toContain('Комментарий: «двигатель 1.6, 2019, звоните •••»');
    expect(text).toContain('1. Knecht OC 90 — Фильтр масляный');
    expect(text).toContain('2. TRW GDB1330 — Колодки тормозные дисковые передние');
    expect(text).toContain('⏳ ждёт ответа');
    expect(text).toContain('Ответьте в течение часа');
    expect(buttons.map((b) => b.text)).toEqual([
      '1 · Подходит',
      '1 · Аналог',
      '1 · Не подходит',
      '1 · Нужен звонок',
      '2 · Подходит',
      '2 · Аналог',
      '2 · Не подходит',
      '2 · Нужен звонок',
      'Открыть в админке',
    ]);
    expect(buttons.at(-1)?.url).toBe(`${BASE_URL}/admin/fit-checks`);
    const parsed = parseCallbackData(buttonData(messageId, '2 · Нужен звонок'));
    expect(parsed).toMatchObject({ action: 'fcall', orderId: checkIds[1] });
    const [card] = await t.deps.db
      .select()
      .from(sellerCards)
      .where(eq(sellerCards.fitRequestId, requestId));
    expect(card).toMatchObject({ kind: 'fit', orderId: null, messageId, closedAt: null });
  });

  it('«Подходит»: the line answered by the presser, the card redrawn; a second press edits nothing', async () => {
    const knecht = await fixtureOffer('OC90', 'Knecht');
    const trw = await fixtureOffer('GDB1330', 'TRW');
    const { checkIds, messageId } = await postedRequest([knecht, trw]);
    const fits = buttonData(messageId, '1 · Подходит');
    const notFit = buttonData(messageId, '1 · Не подходит');

    let before = rec.calls.length;
    await press(fits, messageId);
    expect(answersSince(before)).toEqual(['Записано: подходит']);
    expect(await statusOf(checkIds[0]!)).toMatchObject({ status: 'fits', answeredBy: sellerId });
    const redrawn = lastRendering(messageId);
    expect(redrawn.text).toMatch(/✓ Подходит · Мастер Лёша, \d{2}:\d{2} /u);
    expect(redrawn.buttons.map((b) => b.text)).not.toContain('1 · Подходит');
    expect(redrawn.buttons.map((b) => b.text)).toContain('2 · Подходит');

    // The same button again, and another answer on the answered line: «Уже отвечено», no edit.
    for (const data of [fits, notFit]) {
      before = rec.calls.length;
      await press(data, messageId);
      expect(answersSince(before)).toEqual(['Уже отвечено: подходит']);
      expect(callsSince(before).filter((c) => c.method.startsWith('edit'))).toEqual([]);
    }
    expect(await statusOf(checkIds[0]!)).toMatchObject({ status: 'fits' });

    // «Нужен звонок» on the second line by the owner.
    before = rec.calls.length;
    await press(buttonData(messageId, '2 · Нужен звонок'), messageId, OWNER_TG);
    expect(answersSince(before)).toEqual(['Записано: нужен звонок']);
    expect(await statusOf(checkIds[1]!)).toMatchObject({ status: 'call_needed' });
    const done = lastRendering(messageId);
    expect(done.text).toContain('☎ Нужен звонок');
    expect(done.text).toContain('Все позиции отвечены.');
    expect(done.buttons.map((b) => b.text)).toEqual(['Открыть в админке']);
  });

  it('a stranger hears nothing; a line of another request on this card is stale', async () => {
    const knecht = await fixtureOffer('OC90', 'Knecht');
    const first = await postedRequest([knecht]);
    const second = await postedRequest([knecht]);
    const before = rec.calls.length;
    await press(buttonData(first.messageId, '1 · Не подходит'), first.messageId, STRANGER_TG);
    // The spinner stops, nothing is said or edited.
    expect(callsSince(before).map((c) => c.method)).toEqual(['answerCallbackQuery']);
    expect(answersSince(before)).toEqual([undefined]);
    expect(await statusOf(first.checkIds[0]!)).toMatchObject({ status: 'pending' });

    // The nonce of the first card with the line id of the second request.
    const nonce = parseCallbackData(buttonData(first.messageId, '1 · Подходит'))!.nonce;
    const forged = `a:ffit:${second.checkIds[0]}:${nonce}`;
    const pressed = rec.calls.length;
    await press(forged, first.messageId);
    expect(answersSince(pressed)).toEqual(['Карточка устарела, откройте свежую']);
    expect(await statusOf(second.checkIds[0]!)).toMatchObject({ status: 'pending' });
  });

  it('«Аналог» -> «БРЕНД АРТИКУЛ»: not found keeps the line waiting; found is priced and stored', async () => {
    const mann = await fixtureOffer('W9142', 'MANN-FILTER');
    const { checkIds, messageId } = await postedRequest([mann]);

    let before = rec.calls.length;
    await press(buttonData(messageId, '1 · Аналог'), messageId);
    expect(answersSince(before)).toEqual(['Ответьте «БРЕНД АРТИКУЛ» на сообщение']);
    let prompt = promptSince(before);
    expect(String(prompt.payload.text)).toContain(
      'Аналог для строки 1: MANN-FILTER W 914/2 — Фильтр масляный',
    );
    expect(String(prompt.payload.text)).toContain('«БРЕНД АРТИКУЛ»');

    before = rec.calls.length;
    await reply('KNECHT W9142X', sentMessageId(prompt));
    expect(messagesSince(before)).toEqual([
      'Не нашёл у поставщика — проверьте артикул. Нажмите «Аналог» ещё раз.',
    ]);
    expect(await statusOf(checkIds[0]!)).toMatchObject({ status: 'pending' });

    // The prompt is taken once: a second reply to it does nothing.
    before = rec.calls.length;
    await reply('KNECHT OC90', sentMessageId(prompt));
    expect(callsSince(before)).toEqual([]);

    before = rec.calls.length;
    await press(buttonData(messageId, '1 · Аналог'), messageId);
    prompt = promptSince(before);
    before = rec.calls.length;
    await reply('KNECHT OC90', sentMessageId(prompt));
    const [confirmation] = messagesSince(before);
    // Knecht OC 90 in Orenburg: 412,50 ₽ × 1.28 = 528 ₽.
    expect(confirmation).toMatch(
      /^Аналог записан: Knecht OC 90 — 528\s₽, к .+\. Клиент увидит его в корзине\.$/u,
    );
    const stored = await statusOf(checkIds[0]!);
    expect(stored).toMatchObject({
      status: 'analog',
      analogBrand: 'Knecht',
      analogArticle: 'OC 90',
      analogName: 'Фильтр масляный',
      answeredBy: sellerId,
    });
    expect(stored?.analogOffer?.stock.stockId).toBe('ORB1');
    const card = lastRendering(messageId);
    expect(card.text).toMatch(/↔ Аналог: Knecht OC 90 — Фильтр масляный, 528\s₽, к /u);
    expect(card.buttons.map((b) => b.text)).toEqual(['Открыть в админке']);

    // The same part is not an analog.
    const second = await postedRequest([mann]);
    before = rec.calls.length;
    await press(buttonData(second.messageId, '1 · Аналог'), second.messageId);
    prompt = promptSince(before);
    before = rec.calls.length;
    await reply('MANN W914/2', sentMessageId(prompt));
    expect(messagesSince(before)[0]).toContain('Это та же деталь');
  });

  it('an expired line takes no answer', async () => {
    const knecht = await fixtureOffer('OC90', 'Knecht');
    const { checkIds, messageId } = await postedRequest([knecht]);
    await t.deps.db
      .update(fitChecks)
      .set({ status: 'expired' })
      .where(eq(fitChecks.id, checkIds[0]!));
    const before = rec.calls.length;
    await press(buttonData(messageId, '1 · Подходит'), messageId);
    expect(answersSince(before)).toEqual(['Уже отвечено: не успели ответить']);
    expect(await statusOf(checkIds[0]!)).toMatchObject({ status: 'expired' });
  });
});

describe.skipIf(!hasTestDatabase)('seller bot: the fit guarantee on a claim', () => {
  it('a «не подошла» claim on an item with the guarantee shows the label; others do not', async () => {
    const seeded = await seedOrder(t.deps.db, {
      status: 'handed',
      scheme: 'pay_on_handover',
      itemState: 'handed',
    });
    const handedAt = new Date(Date.now() - DAY);
    await t.deps.db
      .update(orders)
      .set({ handedAt, clientArrivedAt: handedAt })
      .where(eq(orders.id, seeded.orderId));
    const [guaranteed, plain] = seeded.itemIds;
    await t.deps.db
      .update(orderItems)
      .set({ fitCheckedAt: handedAt, fitCheckedBy: sellerId, fitGuarantee: true })
      .where(eq(orderItems.id, guaranteed!));
    for (const [itemId, kind] of [
      [guaranteed, 'not_fit'],
      [plain, 'not_fit'],
    ] as const) {
      const opened = await openClaim(t.deps.engine, {
        orderId: seeded.orderId,
        itemId: itemId!,
        kind,
        text: 'Не подошла к машине',
        photoKeys: [],
        via: 'web',
        requestKey: newVinRequestId(),
        actor: { type: 'client', id: seeded.userId },
      });
      expect(opened, JSON.stringify(opened)).toMatchObject({ ok: true });
    }
    const before = rec.calls.length;
    await createSellerCards(t.deps).post({ orderId: seeded.orderId, template: null });
    const card = callsSince(before).find((c) => c.method === 'sendMessage');
    const text = String(card?.payload.text);
    const claimLines = text.split('\n').filter((line) => line.startsWith('Претензия'));
    expect(claimLines).toHaveLength(2);
    expect(
      claimLines.filter((l) => l.includes('Гарантия подбора: мастер проверил под VIN')),
    ).toHaveLength(1);
    expect(claimLines.find((l) => l.includes('Гарантия подбора'))).toContain(
      'позиция MANN W 914/2',
    );
  });
});
