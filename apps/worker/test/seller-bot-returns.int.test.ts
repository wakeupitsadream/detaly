// Seller bot, step 7 (docs/month-close.md): the parts going back to Rossko on the order card —
// the task line with the deadline, «Сдал водителю» (requested -> shipped, shipped_at) and «Не берут»
// (requested -> rejected, a stock_items row at the cost of the order, «Не принят поставщиком»).
// Staff only; a double tap, a stale card and a second press from elsewhere write nothing twice.
// The real engine on the `_worker` database, grammY without network (every call is recorded),
// updates fed with bot.handleUpdate.
import { randomInt } from 'node:crypto';
import { createLogger } from '@detaly/config';
import {
  and,
  eq,
  inArray,
  orderEvents,
  orders,
  staff,
  stockItems,
  supplierReturns,
} from '@detaly/db';
import { formatDayMonth, formatRub, localDate } from '@detaly/domain';
import { CALLBACK_DATA_MAX_BYTES } from '@detaly/notify';
import { performStaffAction, STOCK_REASON_NOT_ACCEPTED } from '@detaly/orders';
import { Api, type Bot, type Transformer } from 'grammy';
import type { Update, UserFromGetMe } from 'grammy/types';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSellerBot } from '../src/bots/seller/bot';
import { STALE_CARD } from '../src/bots/seller/callbacks';
import { createSellerCards } from '../src/bots/seller/cards';
import { hasTestDatabase } from './fixtures/databases';
import { createTestDeps, type TestDeps } from './helpers/test-deps';
import { PAYMENT_ENV, seedOrder, type Seeded } from './payments-helpers';

const TOKEN = '123456:seller-bot-returns-test-token';
const SELLER_CHAT = -100_777_000_000 - randomInt(0, 1_000_000);
const SELLER_TG = 8_400_000_000 + randomInt(0, 1_000_000);
const OWNER_TG = SELLER_TG + 1;
const STRANGER_TG = SELLER_TG + 2;
const DAY = 24 * 60 * 60 * 1000;

const BOT_INFO = {
  id: 7_000_000_021,
  is_bot: true,
  first_name: 'Детали · продавцы',
  username: 'detaly_seller_returns_test_bot',
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
        text: p.text,
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
const staffIds: string[] = [];
let updateId = 1;

function keyboardOf(call: Call): Button[] {
  const markup = call.payload.reply_markup as { inline_keyboard?: Button[][] } | undefined;
  return (markup?.inline_keyboard ?? []).flat();
}

function lastRendering(messageId: number): { text: string; buttons: Button[] } {
  for (let i = rec.calls.length - 1; i >= 0; i -= 1) {
    const call = rec.calls[i] as Call;
    const sent = (call.result as { message_id?: number } | null)?.message_id;
    if (call.method === 'sendMessage' && sent === messageId) {
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

function labels(messageId: number): string[] {
  return lastRendering(messageId).buttons.map((b) => b.text);
}

function answersSince(index: number): (string | undefined)[] {
  return rec.calls
    .slice(index)
    .filter((c) => c.method === 'answerCallbackQuery')
    .map((c) => c.payload.text as string | undefined);
}

const groupChat = { id: SELLER_CHAT, type: 'supergroup' as const, title: 'Продавцы' };

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

async function postCard(orderId: string): Promise<number> {
  const before = rec.calls.length;
  await createSellerCards(t.deps).post({ orderId, template: 'staff_supplier_return_task' });
  const sent = rec.calls.slice(before).find((c) => c.method === 'sendMessage');
  if (!sent) throw new Error('no card was sent');
  return (sent.result as { message_id: number }).message_id;
}

/** A no-show order whose two parts wait for the Rossko driver until `deadline`. */
async function withReturns(deadline: Date): Promise<{ seeded: Seeded; returnIds: string[] }> {
  const seeded = await seedOrder(t.deps.db, {
    status: 'refund_pending',
    itemState: 'refund_pending',
    prices: [128_000, 64_000],
  });
  await t.deps.db
    .update(orders)
    .set({ supplierReturnDeadlineAt: deadline })
    .where(eq(orders.id, seeded.orderId));
  const rows = await t.deps.db
    .insert(supplierReturns)
    .values(
      seeded.itemIds.map((orderItemId, i) => ({
        orderItemId,
        kind: 'return' as const,
        status: 'requested' as const,
        amountExpectedKop: i === 0 ? 100_000 : 50_000,
        createdAt: new Date(Date.now() - (2 - i) * 1000),
      })),
    )
    .returning({ id: supplierReturns.id, orderItemId: supplierReturns.orderItemId });
  const returnIds = seeded.itemIds.map(
    (itemId) => rows.find((row) => row.orderItemId === itemId)?.id ?? '',
  );
  return { seeded, returnIds };
}

async function returnRow(id: string) {
  const [row] = await t.deps.db.select().from(supplierReturns).where(eq(supplierReturns.id, id));
  if (!row) throw new Error('no supplier return');
  return row;
}

async function eventCount(orderId: string, type: string): Promise<number> {
  const rows = await t.deps.db
    .select({ id: orderEvents.id })
    .from(orderEvents)
    .where(and(eq(orderEvents.orderId, orderId), eq(orderEvents.type, type)));
  return rows.length;
}

beforeAll(async () => {
  if (!hasTestDatabase) return;
  rec = recorder();
  const api = new Api(TOKEN);
  api.config.use(rec.transformer);
  t = await createTestDeps({
    telegram: api,
    logger: createLogger('seller-bot-returns-test', { level: 'silent' }),
    envOverrides: {
      ...PAYMENT_ENV,
      APP_BASE_URL: 'https://detaly.test',
      TG_SELLER_BOT_TOKEN: TOKEN,
      TG_SELLER_CHAT_ID: String(SELLER_CHAT),
    },
  });
  const rows = await t.deps.db
    .insert(staff)
    .values([
      { name: 'Продавец возвратов', role: 'seller', tgUserId: SELLER_TG },
      { name: 'Владелец возвратов', role: 'owner', tgUserId: OWNER_TG },
    ])
    .returning({ id: staff.id });
  for (const row of rows) staffIds.push(row.id);
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
  for (const call of rec.calls) {
    for (const button of keyboardOf(call)) {
      if (button.callback_data) {
        expect(Buffer.byteLength(button.callback_data)).toBeLessThanOrEqual(
          CALLBACK_DATA_MAX_BYTES,
        );
      }
    }
  }
  if (staffIds.length > 0) {
    const sqlc = t.deps.db.$client;
    await sqlc`delete from staff where id in ${sqlc(staffIds)}`;
  }
  await t.close();
});

describe.skipIf(!hasTestDatabase)('seller bot: supplier returns (step 7)', () => {
  it('the card shows the task with the deadline and «Сдал водителю» / «Не берут» per part', async () => {
    const deadline = new Date(Date.now() + 2 * DAY);
    const { seeded } = await withReturns(deadline);
    const messageId = await postCard(seeded.orderId);
    const { text } = lastRendering(messageId);
    const until = formatDayMonth(localDate(deadline));
    expect(text).toContain(
      `Вернуть Rossko до ${until}: MANN W 914/2 × 1 — «Сдал водителю» или «Не берут»`,
    );
    expect(text).toContain(
      `Вернуть Rossko до ${until}: BRAND1 W 914/3 × 1 — «Сдал водителю» или «Не берут»`,
    );
    expect(labels(messageId)).toEqual(
      expect.arrayContaining([
        'Сдал водителю: MANN W 914/2',
        'Не берут: MANN W 914/2',
        'Сдал водителю: BRAND1 W 914/3',
        'Не берут: BRAND1 W 914/3',
      ]),
    );
  });

  it('«Сдал водителю»: shipped once; a double tap and a stale card change nothing', async () => {
    const { seeded, returnIds } = await withReturns(new Date(Date.now() + 2 * DAY));
    const messageId = await postCard(seeded.orderId);
    const data = buttonData(messageId, 'Сдал водителю: MANN W 914/2');

    const before = rec.calls.length;
    await Promise.all([press(data, messageId), press(data, messageId)]);
    const answers = answersSince(before);
    expect(answers).toHaveLength(2);
    expect(answers).toContain(STALE_CARD);
    expect(answers).toContain('Сдано водителю: MANN W 914/2. Ждём деньги от Rossko');

    const shipped = await returnRow(returnIds[0]!);
    expect(shipped.status).toBe('shipped');
    expect(shipped.shippedAt).toBeInstanceOf(Date);
    expect(await eventCount(seeded.orderId, 'supplier_return_shipped')).toBe(1);
    // The other part still waits.
    expect((await returnRow(returnIds[1]!)).status).toBe('requested');

    // The card is redrawn: the part that left waits for the money, its buttons are gone.
    const redrawn = lastRendering(messageId);
    expect(redrawn.text).toContain(
      `Возврат Rossko: MANN W 914/2 × 1 — сдан водителю ${formatDayMonth(localDate(shipped.shippedAt!))}, ждём деньги`,
    );
    expect(labels(messageId)).not.toContain('Сдал водителю: MANN W 914/2');
    expect(labels(messageId)).toContain('Сдал водителю: BRAND1 W 914/3');

    // The old button again: the nonce rotated.
    const again = rec.calls.length;
    await press(data, messageId);
    expect(answersSince(again)).toEqual([STALE_CARD]);

    // A second press from elsewhere (the admin, another card): «Уже отмечено», no second event.
    const repeated = await performStaffAction(t.deps.engine, {
      staff: { id: staffIds[0]!, role: 'seller', via: 'bot' },
      action: 'srship',
      targetId: returnIds[0]!,
    });
    expect(repeated).toMatchObject({ ok: true });
    expect(repeated.message).toMatch(/^Уже отмечено: MANN W 914\/2 сдан водителю/u);
    expect(await eventCount(seeded.orderId, 'supplier_return_shipped')).toBe(1);
  });

  it('«Не берут»: rejected, one stock row at the cost of the order «Не принят поставщиком»', async () => {
    const { seeded, returnIds } = await withReturns(new Date(Date.now() - DAY));
    const messageId = await postCard(seeded.orderId);
    const data = buttonData(messageId, 'Не берут: BRAND1 W 914/3');

    // Not staff: refused before anything is read.
    const stranger = rec.calls.length;
    await press(data, messageId, STRANGER_TG);
    expect((await returnRow(returnIds[1]!)).status).toBe('requested');
    expect(answersSince(stranger)).toEqual([undefined]);

    const before = rec.calls.length;
    await press(data, messageId, OWNER_TG);
    expect(answersSince(before)).toEqual([
      `Не берут: BRAND1 W 914/3 — деталь на складе (${formatRub(50_000)})`,
    ]);
    expect((await returnRow(returnIds[1]!)).status).toBe('rejected');
    const stock = await t.deps.db
      .select()
      .from(stockItems)
      .where(inArray(stockItems.orderItemId, seeded.itemIds));
    expect(stock).toHaveLength(1);
    expect(stock[0]).toMatchObject({
      orderItemId: seeded.itemIds[1],
      costKop: 50_000,
      reason: STOCK_REASON_NOT_ACCEPTED,
      writtenOffAt: null,
    });
    expect(STOCK_REASON_NOT_ACCEPTED).toBe('Не принят поставщиком');
    expect(await eventCount(seeded.orderId, 'stock_item_created')).toBe(1);
    expect(labels(messageId)).not.toContain('Не берут: BRAND1 W 914/3');

    // Pressed again elsewhere: «Уже отмечено», still one stock row.
    const repeated = await performStaffAction(t.deps.engine, {
      staff: { id: staffIds[1]!, role: 'owner', via: 'bot' },
      action: 'srrej',
      targetId: returnIds[1]!,
    });
    expect(repeated).toMatchObject({ ok: true });
    expect(repeated.message).toBe('Уже отмечено: BRAND1 W 914/3 не берут, деталь на складе');
    expect(
      await t.deps.db
        .select({ id: stockItems.id })
        .from(stockItems)
        .where(inArray(stockItems.orderItemId, seeded.itemIds)),
    ).toHaveLength(1);
    // A part marked «Не берут» cannot be «Сдал водителю» afterwards.
    const shipped = await performStaffAction(t.deps.engine, {
      staff: { id: staffIds[0]!, role: 'seller', via: 'bot' },
      action: 'srship',
      targetId: returnIds[1]!,
    });
    expect(shipped).toMatchObject({
      ok: false,
      message: 'BRAND1 W 914/3: уже отмечено «Не берут»',
    });
  });
});
