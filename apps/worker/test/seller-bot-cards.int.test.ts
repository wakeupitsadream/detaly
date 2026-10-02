// Seller bot cards and buttons (docs/phase-1b-implementation.md section 13): the real engine on
// the `_worker` database, grammY without network (the transport of both the bot's Api and
// deps.telegram is replaced through api.config.use and records every call), updates fed with
// bot.handleUpdate. Telegram ids are random per run; the staff rows are removed afterwards.
import { randomInt, randomUUID } from 'node:crypto';
import { Writable } from 'node:stream';
import { createLogger } from '@detaly/config';
import {
  clientApprovals,
  eq,
  messengerBindings,
  orderEvents,
  orders,
  payments,
  receipts,
  refunds,
  sellerCards,
  staff,
  and,
  asc,
  inArray,
} from '@detaly/db';
import { addDays, localDate, type Offer, type RecheckItemResult } from '@detaly/domain';
import { CALLBACK_DATA_MAX_BYTES, deadline, parseCallbackData } from '@detaly/notify';
import { recordJournalEvent } from '@detaly/orders';
import { Api, type Bot, type Transformer } from 'grammy';
import type { Update, UserFromGetMe } from 'grammy/types';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createSellerBot } from '../src/bots/seller/bot';
import { createSellerCards } from '../src/bots/seller/cards';
import { INVOICE_NOT_DUE, STALE_CARD } from '../src/bots/seller/callbacks';
import { awaitKey } from '../src/bots/seller/invoice';
import { hasTestDatabase } from './fixtures/databases';
import { createTestDeps, type TestDeps } from './helpers/test-deps';
import { PAYMENT_ENV, seedOrder, type Seeded } from './payments-helpers';

const TOKEN = '123456:seller-bot-test-token';
const SELLER_CHAT = -100_777_000_000 - randomInt(0, 1_000_000);
const SELLER_TG = 8_100_000_000 + randomInt(0, 1_000_000);
const OWNER_TG = SELLER_TG + 1;
const STRANGER_TG = SELLER_TG + 2;
const BASE_URL = 'https://detaly.test';
/** formatRub output: non-breaking spaces. */
const RUB_1920 = '1\u00a0920\u00a0₽';

const BOT_INFO = {
  id: 7_000_000_002,
  is_bot: true,
  first_name: 'Детали · продавцы',
  username: 'detaly_seller_cards_test_bot',
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

/** One recorder for the bot's Api and deps.telegram: the same chat, one message id sequence. */
function recorder() {
  const calls: Call[] = [];
  let nextMessageId = 5000;
  let failNext: ((call: Omit<Call, 'result'>) => string | null) | null = null;
  const transformer: Transformer = async (_prev, method, payload) => {
    const p = payload as Record<string, unknown>;
    const failure = failNext?.({ method, payload: p }) ?? null;
    if (failure !== null) {
      calls.push({ method, payload: p, result: { error: failure } });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return { ok: false, error_code: 400, description: failure } as any;
    }
    let result: unknown = true;
    if (method === 'sendMessage' || method === 'sendPhoto') {
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
  return {
    calls,
    transformer,
    failWhen(fn: ((call: Omit<Call, 'result'>) => string | null) | null) {
      failNext = fn;
    },
  };
}

let t: TestDeps;
let rec: ReturnType<typeof recorder>;
let bot: Bot;
const logLines: string[] = [];
const staffIds: string[] = [];
const seededPhones: string[] = [];
const seededOrderIds: string[] = [];
let updateId = 1;
let sellerId = '';

function sentMessageId(call: Call): number {
  return (call.result as { message_id: number }).message_id;
}

function keyboardOf(call: Call): Button[] {
  const markup = call.payload.reply_markup as { inline_keyboard?: Button[][] } | undefined;
  return (markup?.inline_keyboard ?? []).flat();
}

/** The last rendering (send or edit) of a message: its text and buttons. */
function lastRendering(messageId: number): { text: string; buttons: Button[] } {
  for (let i = rec.calls.length - 1; i >= 0; i -= 1) {
    const call = rec.calls[i] as Call;
    // A refused edit changed nothing in the chat.
    if ((call.result as { error?: string } | null)?.error !== undefined) continue;
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
  const button = lastRendering(messageId).buttons.find((b) => b.text.startsWith(label));
  if (!button?.callback_data) throw new Error(`no button «${label}» on message ${messageId}`);
  return button.callback_data;
}

function labels(messageId: number): string[] {
  return lastRendering(messageId).buttons.map((b) => b.text);
}

function callsSince(index: number): Call[] {
  return rec.calls.slice(index);
}

/** Answers to callback queries (text or undefined for an empty answer). */
function answersSince(index: number): (string | undefined)[] {
  return callsSince(index)
    .filter((c) => c.method === 'answerCallbackQuery')
    .map((c) => c.payload.text as string | undefined);
}

async function press(
  data: string,
  {
    from = SELLER_TG,
    messageId,
    chatId = SELLER_CHAT,
  }: { from?: number; messageId: number; chatId?: number },
): Promise<void> {
  const id = updateId++;
  await bot.handleUpdate({
    update_id: id,
    callback_query: {
      id: `cb${id}`,
      from: { id: from, is_bot: false, first_name: 'Тест' },
      chat_instance: 'ci',
      data,
      message: {
        message_id: messageId,
        date: Math.floor(Date.now() / 1000),
        chat:
          chatId === SELLER_CHAT
            ? { id: chatId, type: 'supergroup', title: 'Продавцы' }
            : { id: chatId, type: 'private', first_name: 'Тест' },
      },
    },
  } as Update);
}

async function sendText(
  text: string,
  { from, chatId = SELLER_CHAT, replyTo }: { from: number; chatId?: number; replyTo?: number },
): Promise<void> {
  const id = updateId++;
  const command = text.split(' ')[0] ?? text;
  const chat =
    chatId === SELLER_CHAT
      ? { id: chatId, type: 'supergroup', title: 'Продавцы' }
      : { id: chatId, type: 'private', first_name: 'Тест' };
  await bot.handleUpdate({
    update_id: id,
    message: {
      message_id: id,
      date: Math.floor(Date.now() / 1000),
      chat,
      from: { id: from, is_bot: false, first_name: 'Тест' },
      ...(replyTo === undefined
        ? {}
        : {
            reply_to_message: {
              message_id: replyTo,
              date: Math.floor(Date.now() / 1000),
              chat,
              from: { ...BOT_INFO },
              text: 'prompt',
            },
          }),
      text,
      ...(text.startsWith('/')
        ? { entities: [{ type: 'bot_command', offset: 0, length: command.length }] }
        : {}),
    },
  } as Update);
}

/** Posts a card through the port of the queue jobs; returns its Telegram message id. */
async function postCard(orderId: string, template: 'staff_new_order' | null = 'staff_new_order') {
  const before = rec.calls.length;
  await createSellerCards(t.deps).post({ orderId, template });
  const sent = callsSince(before).find((c) => c.method === 'sendMessage');
  if (!sent) throw new Error('no card was sent');
  return sentMessageId(sent);
}

async function cardRows(orderId: string) {
  return t.deps.db
    .select()
    .from(sellerCards)
    .where(eq(sellerCards.orderId, orderId))
    .orderBy(asc(sellerCards.createdAt));
}

async function status(orderId: string) {
  const [row] = await t.deps.db
    .select({ status: orders.status })
    .from(orders)
    .where(eq(orders.id, orderId));
  return row?.status;
}

async function eventTypes(orderId: string): Promise<string[]> {
  const rows = await t.deps.db
    .select({ type: orderEvents.type })
    .from(orderEvents)
    .where(eq(orderEvents.orderId, orderId))
    .orderBy(asc(orderEvents.createdAt), asc(orderEvents.id));
  return rows.map((r) => r.type);
}

async function seed(options: Parameters<typeof seedOrder>[1]): Promise<Seeded> {
  const seeded = await seedOrder(t.deps.db, options);
  seededPhones.push(seeded.phone);
  seededOrderIds.push(seeded.orderId);
  return seeded;
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
    logger: createLogger('seller-bot-test', { level: 'debug', destination: sink }),
    envOverrides: {
      ...PAYMENT_ENV,
      APP_BASE_URL: BASE_URL,
      TG_SELLER_BOT_TOKEN: TOKEN,
      TG_SELLER_CHAT_ID: String(SELLER_CHAT),
    },
  });
  const rows = await t.deps.db
    .insert(staff)
    .values([
      { name: 'Продавец', role: 'seller', tgUserId: SELLER_TG },
      { name: 'Владелец', role: 'owner', tgUserId: OWNER_TG },
    ])
    .returning({ id: staff.id, role: staff.role });
  for (const row of rows) staffIds.push(row.id);
  sellerId = rows.find((r) => r.role === 'seller')?.id ?? '';
  const staffTg = new Set([SELLER_TG, OWNER_TG]);
  bot = createSellerBot({
    token: TOKEN,
    botInfo: BOT_INFO,
    isStaff: async (id) => staffTg.has(id),
    health: async () => ({ heartbeatAgeSec: 1, dbOk: true, gitSha: null }),
    sellerChatId: SELLER_CHAT,
    logger: t.deps.logger,
    deps: t.deps,
  });
  bot.api.config.use(rec.transformer);
});

afterAll(async () => {
  if (!hasTestDatabase) return;
  if (staffIds.length > 0) {
    const sqlc = t.deps.db.$client;
    // The engine records who proposed an alternative; the order rows stay, the staff rows go.
    await sqlc`update client_approvals set created_by_staff_id = null where created_by_staff_id in ${sqlc(staffIds)}`;
    await sqlc`delete from staff where id in ${sqlc(staffIds)}`;
  }
  await t.close();
});

beforeEach(() => {
  rec?.failWhen(null);
});

describe.skipIf(!hasTestDatabase)('seller cards', () => {
  it('a new order card: state, masked phone, buttons from the engine, the admin link', async () => {
    const seeded = await seed({ status: 'confirmed', scheme: 'prepay' });
    // Paid online: the refusal button promises the money back.
    await t.deps.db.insert(payments).values({
      orderId: seeded.orderId,
      kind: 'prepayment',
      status: 'succeeded',
      amountKop: seeded.totalKop,
      idempotenceKey: randomUUID(),
    });
    const messageId = await postCard(seeded.orderId);

    const sent = rec.calls.find(
      (c) => c.method === 'sendMessage' && sentMessageId(c) === messageId,
    ) as Call;
    expect(sent.payload.chat_id).toBe(String(SELLER_CHAT));
    const { text, buttons } = lastRendering(messageId);
    expect(text).toContain(`Новый заказ ${seeded.number}`);
    expect(text).toContain('предоплата');
    expect(text).toContain(RUB_1920);
    expect(text).toContain('MANN W 914/2 × 1 — ждёт заказа');
    expect(text).toContain(`Клиент •••${seeded.phone.slice(-4)}`);
    expect(text).not.toContain(seeded.phone.slice(2));
    expect(buttons.map((b) => b.text)).toEqual([
      'Проверить и заказать',
      'Отказ клиента: вернуть деньги',
      'Открыть в админке',
    ]);
    expect(buttons.at(-1)?.url).toBe(`${BASE_URL}/admin/orders/${seeded.orderId}`);

    const [row] = await cardRows(seeded.orderId);
    expect(row).toMatchObject({ kind: 'order', messageId, chatId: String(SELLER_CHAT) });
    expect(row?.nonce).toMatch(/^[A-Za-z0-9_-]{8}$/);
    expect(row?.closedAt).toBeNull();
    for (const button of buttons.filter((b) => b.callback_data)) {
      expect(parseCallbackData(button.callback_data as string)?.nonce).toBe(row?.nonce);
    }
  });

  it('a new card closes the older open cards (a "not modified" answer is swallowed)', async () => {
    const seeded = await seed({ status: 'confirmed' });
    const first = await postCard(seeded.orderId);
    rec.failWhen((call) =>
      call.method === 'editMessageReplyMarkup' ? 'Bad Request: message is not modified' : null,
    );
    const second = await postCard(seeded.orderId, null);
    const closing = rec.calls.filter(
      (c) => c.method === 'editMessageReplyMarkup' && c.payload.message_id === first,
    );
    expect(closing).toHaveLength(1);
    expect(closing[0]?.payload.reply_markup).toEqual({ inline_keyboard: [] });
    const rows = await cardRows(seeded.orderId);
    expect(rows.map((r) => [r.messageId, r.closedAt !== null])).toEqual([
      [first, true],
      [second, false],
    ]);
    expect(lastRendering(second).text.startsWith(`Заказ ${seeded.number}`)).toBe(true);

    // The closed card's buttons are stale.
    const before = rec.calls.length;
    await press(buttonData(first, 'Проверить и заказать'), { messageId: first });
    expect(answersSince(before)).toEqual([STALE_CARD]);
    expect(await eventTypes(seeded.orderId)).not.toContain('recheck_requested');
  });

  it('a press applies the action, answers and redraws the card with a new nonce', async () => {
    const seeded = await seed({ status: 'confirmed' });
    const messageId = await postCard(seeded.orderId);
    const data = buttonData(messageId, 'Проверить и заказать');
    const [card] = await cardRows(seeded.orderId);

    const before = rec.calls.length;
    await press(data, { messageId });
    expect(answersSince(before)).toEqual(['Проверяем цены и наличие у Rossko…']);
    expect(await eventTypes(seeded.orderId)).toEqual(['recheck_requested']);
    const edits = callsSince(before).filter((c) => c.method === 'editMessageText');
    expect(edits).toHaveLength(1);
    expect(edits[0]?.payload).toMatchObject({
      chat_id: String(SELLER_CHAT),
      message_id: messageId,
    });
    const [after] = await cardRows(seeded.orderId);
    expect(after?.nonce).not.toBe(card?.nonce);
    expect(parseCallbackData(buttonData(messageId, 'Проверить и заказать'))?.nonce).toBe(
      after?.nonce,
    );

    // Double press: the old nonce is gone, nothing happens again (the card is only redrawn).
    const again = rec.calls.length;
    await press(data, { messageId });
    expect(answersSince(again)).toEqual([STALE_CARD]);
    expect(await eventTypes(seeded.orderId)).toEqual(['recheck_requested']);
    const [healed] = await cardRows(seeded.orderId);
    expect(parseCallbackData(buttonData(messageId, 'Проверить и заказать'))?.nonce).toBe(
      healed?.nonce,
    );
  });

  it('a card whose redraw failed after a press gets working buttons on the next press', async () => {
    const seeded = await seed({ status: 'ready', scheme: 'pay_on_handover', itemState: 'arrived' });
    const messageId = await postCard(seeded.orderId, null);
    const data = buttonData(messageId, 'Клиент пришёл');
    // Telegram refuses the edit after the action (flood limit): the message keeps old buttons.
    rec.failWhen((call) =>
      call.method === 'editMessageText' ? 'Too Many Requests: retry after 3' : null,
    );
    let before = rec.calls.length;
    await press(data, { messageId });
    expect(answersSince(before)).toEqual(['Отмечено: клиент пришёл']);
    expect(lastRendering(messageId).buttons.map((b) => b.callback_data)).toContain(data);
    rec.failWhen(null);

    // The old button is stale, does nothing, and the card catches up with the order.
    before = rec.calls.length;
    await press(data, { messageId });
    expect(answersSince(before)).toEqual([STALE_CARD]);
    expect(
      (await eventTypes(seeded.orderId)).filter((type) => type === 'client_arrived'),
    ).toHaveLength(1);
    expect(labels(messageId)).not.toContain('Клиент пришёл');
    const [card] = await cardRows(seeded.orderId);
    expect(card?.closedAt).toBeNull();
    const fresh = lastRendering(messageId).buttons.find((b) => b.callback_data);
    expect(parseCallbackData(fresh?.callback_data ?? '')?.nonce).toBe(card?.nonce);
  });

  it('a stranger gets an empty answer and changes nothing', async () => {
    const seeded = await seed({ status: 'confirmed' });
    const messageId = await postCard(seeded.orderId);
    const [card] = await cardRows(seeded.orderId);
    const before = rec.calls.length;
    await press(buttonData(messageId, 'Проверить и заказать'), { from: STRANGER_TG, messageId });
    expect(callsSince(before)).toEqual([
      expect.objectContaining({
        method: 'answerCallbackQuery',
        payload: { callback_query_id: expect.any(String) },
      }),
    ]);
    expect(await eventTypes(seeded.orderId)).toEqual([]);
    expect((await cardRows(seeded.orderId))[0]?.nonce).toBe(card?.nonce);
  });

  it('a button with an id of another order is stale', async () => {
    const one = await seed({ status: 'confirmed' });
    const other = await seed({ status: 'confirmed' });
    const messageId = await postCard(one.orderId);
    const [card] = await cardRows(one.orderId);
    const before = rec.calls.length;
    await press(`a:recheck:${other.orderId}:${card?.nonce}`, { messageId });
    expect(answersSince(before)).toEqual([STALE_CARD]);
    expect(await eventTypes(other.orderId)).toEqual([]);
  });

  it('«Счёт оплачен»: a seller is refused, the owner answers a ForceReply', async () => {
    const seeded = await seed({ status: 'awaiting_supplier_invoice', itemState: 'ordered' });
    const messageId = await postCard(seeded.orderId);
    expect(labels(messageId)).toContain('Счёт оплачен (владелец)');
    const data = buttonData(messageId, 'Счёт оплачен');
    const [card] = await cardRows(seeded.orderId);

    let before = rec.calls.length;
    await press(data, { from: SELLER_TG, messageId });
    expect(answersSince(before)).toEqual(['Только владелец']);
    expect(callsSince(before).map((c) => c.method)).toEqual(['answerCallbackQuery']);
    expect(await status(seeded.orderId)).toBe('awaiting_supplier_invoice');
    expect((await cardRows(seeded.orderId))[0]?.nonce).toBe(card?.nonce);

    before = rec.calls.length;
    await press(data, { from: OWNER_TG, messageId });
    const prompt = callsSince(before).find((c) => c.method === 'sendMessage') as Call;
    expect(prompt?.payload).toMatchObject({
      chat_id: SELLER_CHAT,
      reply_markup: { force_reply: true },
    });
    expect(String(prompt?.payload.text)).toContain(seeded.number);
    expect(
      await t.deps.redis.ttl(awaitKey(t.deps.keyPrefix, SELLER_CHAT, OWNER_TG)),
    ).toBeGreaterThan(500);

    const promptId = sentMessageId(prompt);
    // A seller's text is not the answer.
    before = rec.calls.length;
    await sendText('№ 1 от 01.10.2026', { from: SELLER_TG, replyTo: promptId });
    expect(callsSince(before)).toHaveLength(0);
    // Nor is an ordinary message of the owner in the chat: only a reply to the prompt counts.
    await sendText('ок, сейчас гляну', { from: OWNER_TG });
    expect(callsSince(before)).toHaveLength(0);
    expect(await status(seeded.orderId)).toBe('awaiting_supplier_invoice');

    await sendText('№ 512 от 02.10.2026', { from: OWNER_TG, replyTo: promptId });
    expect(await status(seeded.orderId)).toBe('ordered_at_supplier');
    const [event] = await t.deps.db
      .select({ payload: orderEvents.payload, actorId: orderEvents.actorId })
      .from(orderEvents)
      .where(
        and(eq(orderEvents.orderId, seeded.orderId), eq(orderEvents.type, 'supplier_invoice_paid')),
      );
    expect(event?.payload).toMatchObject({ paymentRef: '№ 512 от 02.10.2026', via: 'bot' });
    expect(event?.actorId).toBe(staffIds.find((id) => id !== sellerId));
    expect(await t.deps.redis.exists(awaitKey(t.deps.keyPrefix, SELLER_CHAT, OWNER_TG))).toBe(0);
    // The card shows the new state.
    expect(lastRendering(messageId).text).toContain('заказан у Rossko');

    // The old «Счёт оплачен» button of an order that moved on asks nothing.
    const [card2] = await cardRows(seeded.orderId);
    before = rec.calls.length;
    await press(`a:invpaid:${seeded.orderId}:${card2?.nonce}`, { from: OWNER_TG, messageId });
    expect(answersSince(before)).toEqual([INVOICE_NOT_DUE]);
    expect(callsSince(before).filter((c) => c.method === 'sendMessage')).toHaveLength(0);
    expect(await t.deps.redis.exists(awaitKey(t.deps.keyPrefix, SELLER_CHAT, OWNER_TG))).toBe(0);
  });

  it('«Повторить возврат»: owner only, sends the failed refund again with its deadline', async () => {
    const seeded = await seed({ status: 'refund_pending', itemState: 'refund_pending' });
    const [payment] = await t.deps.db
      .insert(payments)
      .values({
        orderId: seeded.orderId,
        kind: 'prepayment',
        status: 'succeeded',
        amountKop: seeded.totalKop,
        idempotenceKey: randomUUID(),
        providerPaymentId: `pay-${randomUUID()}`,
        confirmationType: 'redirect',
        request: {},
      })
      .returning({ id: payments.id });
    const deadlineAt = new Date(Date.now() + 5 * 86_400_000);
    const [failed] = await t.deps.db
      .insert(refunds)
      .values({
        orderId: seeded.orderId,
        paymentId: payment!.id,
        amountKop: seeded.totalKop,
        reason: 'refusal',
        status: 'failed',
        scope: 'order',
        error: 'invalid_request (HTTP 400)',
        idempotenceKey: randomUUID(),
        requestedAt: new Date(Date.now() - 5 * 86_400_000),
        deadlineAt,
      })
      .returning({ id: refunds.id });
    const messageId = await postCard(seeded.orderId, null);
    expect(labels(messageId)).toContain('Повторить возврат (владелец)');
    const data = buttonData(messageId, 'Повторить возврат');
    expect(parseCallbackData(data)).toMatchObject({ action: 'rrefund', orderId: seeded.orderId });

    let before = rec.calls.length;
    await press(data, { from: SELLER_TG, messageId });
    expect(answersSince(before)).toEqual(['Только владелец']);
    const rows = () =>
      t.deps.db
        .select()
        .from(refunds)
        .where(eq(refunds.orderId, seeded.orderId))
        .orderBy(asc(refunds.createdAt), asc(refunds.id));
    expect(await rows()).toHaveLength(1);

    before = rec.calls.length;
    await press(data, { from: OWNER_TG, messageId });
    expect(answersSince(before)).toEqual(['Возврат отправлен повторно']);
    const [, retry] = await rows();
    expect(retry).toMatchObject({
      status: 'pending',
      scope: 'order',
      retryOfRefundId: failed!.id,
      amountKop: seeded.totalKop,
    });
    expect(retry!.deadlineAt.getTime()).toBe(deadlineAt.getTime());
    // Redrawn without the button: the refund is on its way again.
    expect(labels(messageId)).not.toContain('Повторить возврат (владелец)');
  });

  it('«Аналог»: the menu lists the recheck alternatives; the choice asks the client', async () => {
    const seeded = await seed({ status: 'needs_attention', prices: [128_000] });
    const itemId = seeded.itemIds[0] as string;
    await t.deps.db.insert(messengerBindings).values({
      userId: seeded.userId,
      channel: 'telegram',
      externalUserId: `tg-${seeded.orderId}`,
      chatId: `chat-${seeded.orderId}`,
    });
    const offer: Offer = {
      source: 'rossko',
      brand: 'FILTRON',
      article: 'OP 520',
      articleNorm: 'OP520',
      name: 'Фильтр масляный',
      group: null,
      isCross: true,
      priceSupplierKop: 90_000,
      stock: {
        stockId: 'ORB1',
        isLocal: true,
        count: 3,
        multiplicity: 1,
        type: null,
        deliveryDays: 2,
        deliveryStart: null,
        deliveryEnd: null,
        extra: null,
        description: null,
      },
    } as Offer;
    const result: RecheckItemResult = {
      orderItemId: itemId,
      offerKey: 'W9142:MANN:ORB1',
      status: 'unavailable',
      qty: 1,
      oldPriceSupplierKop: 100_000,
      freshPriceSupplierKop: null,
      driftBp: null,
      available: null,
      alternatives: [
        {
          offer,
          priceClientKop: 128_000,
          priceSupplierKop: 90_000,
          markupBp: 4222,
          etaDate: addDays(localDate(new Date()), 5),
          searchArticleNorm: 'OP520',
          offerKey: 'OP520:FILTRON:ORB1',
          marginBp: 2968,
          available: 3,
        },
      ],
    };
    await recordJournalEvent(t.deps.db, {
      orderId: seeded.orderId,
      type: 'recheck_result',
      actor: { type: 'system', id: 'test' },
      payload: { items: [result] },
    });

    const messageId = await postCard(seeded.orderId, null);
    expect(labels(messageId)).toEqual(
      expect.arrayContaining(['Аналог: MANN W 914/2', 'Новый срок: MANN W 914/2']),
    );

    let before = rec.calls.length;
    await press(buttonData(messageId, 'Аналог: MANN W 914/2'), { messageId });
    expect(answersSince(before)).toEqual(['Выберите аналог']);
    const eta = addDays(localDate(new Date()), 5);
    expect(labels(messageId)).toEqual([
      `FILTRON OP 520 · маржа 30% · к ${deadline(eta)}`,
      'Назад',
      'Открыть в админке',
    ]);
    expect(lastRendering(messageId).text).toContain('Аналог для MANN W 914/2');
    expect((await cardRows(seeded.orderId))[0]?.orderItemId).toBe(itemId);

    // «Назад» returns the main keyboard (an empty answer: nothing to say).
    before = rec.calls.length;
    await press(buttonData(messageId, 'Назад'), { messageId });
    expect(answersSince(before)).toEqual([undefined]);
    expect(labels(messageId)).toContain('Аналог: MANN W 914/2');
    expect((await cardRows(seeded.orderId))[0]?.orderItemId).toBeNull();

    await press(buttonData(messageId, 'Аналог: MANN W 914/2'), { messageId });
    const altData = buttonData(messageId, 'FILTRON OP 520');
    expect(parseCallbackData(altData)).toMatchObject({ action: 'alt1', orderId: itemId });
    before = rec.calls.length;
    await press(altData, { messageId });
    expect(answersSince(before)).toEqual(['Аналог предложен клиенту']);
    expect(await status(seeded.orderId)).toBe('awaiting_client_approval');
    const [approval] = await t.deps.db
      .select()
      .from(clientApprovals)
      .where(eq(clientApprovals.orderId, seeded.orderId));
    expect(approval).toMatchObject({ kind: 'alternative', scope: 'item', orderItemId: itemId });
    expect(lastRendering(messageId).text).toContain('ждёт решения клиента');
  });

  it('«Новый срок» and «Проблема с позицией» menus carry the item and the option', async () => {
    const seeded = await seed({ status: 'ordered_at_supplier', itemState: 'ordered' });
    const messageId = await postCard(seeded.orderId, null);
    await press(buttonData(messageId, 'Проблема: MANN W 914/2'), { messageId });
    expect(labels(messageId)).toEqual([
      'Поставщик отказал',
      'Пришла не та',
      'Повреждена',
      'Задержка',
      'Назад',
      'Открыть в админке',
    ]);
    const before = rec.calls.length;
    await press(buttonData(messageId, 'Задержка'), { messageId });
    expect(answersSince(before)).toEqual(['Проблема с позицией отмечена']);
    expect(await status(seeded.orderId)).toBe('needs_attention');
    expect(lastRendering(messageId).text).toContain('Внимание: поставщик сдвинул срок');

    await press(buttonData(messageId, 'Новый срок: MANN W 914/2'), { messageId });
    expect(labels(messageId)[0]).toMatch(/^\+2 дня \(\d+ [а-я]+\)$/u);
    const eta = buttonData(messageId, '+7 дней');
    expect(parseCallbackData(eta)?.action).toBe('eta7');
    // No client binding and no SMS: the engine refuses, the card goes back to the main keyboard.
    const after = rec.calls.length;
    await press(eta, { messageId });
    expect(answersSince(after)).toEqual(['Клиенту не доставить сообщение — позвоните ему']);
    expect(await status(seeded.orderId)).toBe('needs_attention');
    expect(labels(messageId)).toContain('Новый срок: MANN W 914/2');
  });

  it('«Выдал» appears only after the settlement receipt succeeded', async () => {
    const seeded = await seed({ status: 'ready', itemState: 'arrived', clientArrived: true });
    const [payment] = await t.deps.db
      .insert(payments)
      .values({
        orderId: seeded.orderId,
        kind: 'prepayment',
        status: 'succeeded',
        amountKop: seeded.totalKop,
        idempotenceKey: randomUUID(),
      })
      .returning({ id: payments.id });
    const [receipt] = await t.deps.db
      .insert(receipts)
      .values({
        orderId: seeded.orderId,
        paymentId: payment?.id,
        kind: 'offset',
        status: 'pending',
        idempotenceKey: randomUUID(),
      })
      .returning({ id: receipts.id });
    const messageId = await postCard(seeded.orderId, null);
    expect(labels(messageId)).not.toContain('Выдал');
    expect(labels(messageId)).toContain('Повторить чек');
    expect(lastRendering(messageId).text).toContain('«Выдал» пока недоступно: Ждём чек');

    await t.deps.db
      .update(receipts)
      .set({ status: 'succeeded' })
      .where(eq(receipts.id, receipt?.id as string));
    await createSellerCards(t.deps).refresh(seeded.orderId);
    expect(labels(messageId)).toContain('Выдал');
    expect(labels(messageId)).not.toContain('Повторить чек');
  });

  it('a card whose message is gone is closed on refresh', async () => {
    const seeded = await seed({ status: 'confirmed' });
    const messageId = await postCard(seeded.orderId);
    rec.failWhen((call) =>
      call.method === 'editMessageText' && call.payload.message_id === messageId
        ? 'Bad Request: message to edit not found'
        : null,
    );
    await createSellerCards(t.deps).refresh(seeded.orderId);
    const [row] = await cardRows(seeded.orderId);
    expect(row?.closedAt).not.toBeNull();
  });

  it('«Выставить оплату» appears only after «Клиент пришёл»', async () => {
    const seeded = await seed({
      status: 'ready',
      scheme: 'pay_on_handover',
      itemState: 'arrived',
    });
    const messageId = await postCard(seeded.orderId, null);
    expect(labels(messageId)).toContain('Клиент пришёл');
    expect(labels(messageId)).not.toContain('Выставить оплату');
    expect(labels(messageId)).not.toContain('Выдал');

    const before = rec.calls.length;
    await press(buttonData(messageId, 'Клиент пришёл'), { messageId });
    expect(answersSince(before)).toEqual(['Отмечено: клиент пришёл']);
    expect(labels(messageId)).toContain('Выставить оплату');
    expect(labels(messageId)).not.toContain('Клиент пришёл');
  });

  it('the handover QR goes as a photo to the sellers chat only', async () => {
    const seeded = await seed({
      status: 'awaiting_handover_payment',
      scheme: 'pay_on_handover',
      itemState: 'arrived',
      clientArrived: true,
    });
    const link = 'https://yoomoney.ru/checkout/payments/v2/contract?orderId=qr-test';
    const [payment] = await t.deps.db
      .insert(payments)
      .values({
        orderId: seeded.orderId,
        kind: 'full',
        amountKop: seeded.totalKop,
        idempotenceKey: randomUUID(),
        confirmationType: 'qr',
        confirmationData: link,
      })
      .returning({ id: payments.id });
    const before = rec.calls.length;
    await createSellerCards(t.deps).sendHandoverQr({
      orderId: seeded.orderId,
      paymentId: payment?.id as string,
      confirmationData: link,
      expiresAt: new Date('2026-10-02T09:45:00Z'),
    });
    const sent = callsSince(before);
    expect(sent.map((c) => c.method)).toEqual(['sendPhoto']);
    const photo = sent[0] as Call;
    expect(photo.payload.chat_id).toBe(String(SELLER_CHAT));
    expect(photo.payload.caption).toBe(
      `QR на оплату ${seeded.number} ${RUB_1920}, действует до 14:45`,
    );
    expect(keyboardOf(photo)).toEqual([{ text: 'Ссылка на оплату', url: link }]);
    const photoFile = photo.payload.photo as { fileData?: unknown };
    expect(Buffer.isBuffer(photoFile.fileData)).toBe(true);
    expect((photoFile.fileData as Buffer).subarray(1, 4).toString()).toBe('PNG');
    const rows = await cardRows(seeded.orderId);
    expect(rows).toEqual([
      expect.objectContaining({ kind: 'qr', messageId: sentMessageId(photo) }),
    ]);
  });
});

describe.skipIf(!hasTestDatabase)('/queues', () => {
  const entry = {
    id: 'notify|notify|0190a3b4-0000-7000-8000-000000000001|staff_new_order',
    queue: 'notify',
    name: 'order',
    jobId: 'notify|0190a3b4-0000-7000-8000-000000000001|staff_new_order',
    error: 'GrammyError:400',
    failedAt: '2026-10-02T09:00:00.000Z',
  };

  beforeEach(() => {
    t.fakes.inspector.statsResult = [
      { queue: 'notify', waiting: 1, active: 0, delayed: 2, failed: 1, completed: 10 },
    ];
    t.fakes.inspector.deadLettersResult = [entry];
    t.fakes.inspector.retried.length = 0;
  });

  it('is silent for a seller', async () => {
    const before = rec.calls.length;
    await sendText('/queues', { from: SELLER_TG, chatId: SELLER_TG });
    await sendText('/queues', { from: SELLER_TG });
    expect(callsSince(before)).toHaveLength(0);
  });

  it('shows the owner the counts and retries a dead-letter job once', async () => {
    let before = rec.calls.length;
    await sendText('/queues', { from: OWNER_TG, chatId: OWNER_TG });
    const reply = callsSince(before).find((c) => c.method === 'sendMessage') as Call;
    expect(reply.payload.chat_id).toBe(OWNER_TG);
    expect(String(reply.payload.text)).toContain(
      'notify: ждут 1 · в работе 0 · отложено 2 · с ошибкой 1',
    );
    expect(String(reply.payload.text)).toContain('1. notify/order');
    const messageId = sentMessageId(reply);
    const data = buttonData(messageId, 'Повторить 1');
    expect(parseCallbackData(data)?.action).toBe('dlq');

    // A seller pressing it (e.g. a forwarded keyboard) is refused.
    before = rec.calls.length;
    await press(data, { from: SELLER_TG, messageId, chatId: SELLER_TG });
    expect(answersSince(before)).toEqual(['Только владелец']);
    expect(t.fakes.inspector.retried).toEqual([]);

    before = rec.calls.length;
    await press(data, { from: OWNER_TG, messageId, chatId: OWNER_TG });
    expect(answersSince(before)).toEqual(['Задача возвращена в очередь']);
    expect(t.fakes.inspector.retried).toEqual([entry.id]);
    // The list is redrawn with new buttons; the old ones are spent.
    expect(callsSince(before).some((c) => c.method === 'editMessageText')).toBe(true);
    before = rec.calls.length;
    await press(data, { from: OWNER_TG, messageId, chatId: OWNER_TG });
    expect(answersSince(before)).toEqual(['Список устарел, отправьте /queues ещё раз']);
    expect(t.fakes.inspector.retried).toEqual([entry.id]);
  });
});

describe.skipIf(!hasTestDatabase)('seller bot invariants', () => {
  it('every callback_data fits in 64 bytes', () => {
    const data = rec.calls.flatMap((c) =>
      keyboardOf(c)
        .map((b) => b.callback_data)
        .filter((d): d is string => typeof d === 'string'),
    );
    expect(data.length).toBeGreaterThan(10);
    for (const value of data) {
      expect(Buffer.byteLength(value, 'utf8')).toBeLessThanOrEqual(CALLBACK_DATA_MAX_BYTES);
      expect(parseCallbackData(value)).not.toBeNull();
    }
  });

  it('nothing was sent outside the sellers chat and the owner chat', () => {
    const chats = new Set(
      rec.calls
        .map((c) => c.payload.chat_id)
        .filter((id) => id !== undefined)
        .map(String),
    );
    for (const chat of chats) expect([String(SELLER_CHAT), String(OWNER_TG)]).toContain(chat);
  });

  it('logs and Telegram texts carry no phone, order token or bot token', async () => {
    const tokens = await t.deps.db
      .select({ token: orders.accessToken })
      .from(orders)
      .where(inArray(orders.id, seededOrderIds));
    expect(tokens.length).toBe(seededOrderIds.length);
    const logs = logLines.join('');
    expect(logs).toContain('seller bot action');
    const texts = JSON.stringify(rec.calls.map((c) => [c.payload.text, c.payload.caption]));
    for (const phone of seededPhones) {
      const digits = phone.replace(/^\+/u, '');
      expect(logs).not.toContain(digits);
      expect(texts).not.toContain(digits);
    }
    expect(logs).not.toContain('seller-bot-test-token');
    for (const { token } of tokens) {
      expect(logs).not.toContain(token);
      expect(texts).not.toContain(token);
    }
    expect(logs).not.toContain('/o/');
  });
});
