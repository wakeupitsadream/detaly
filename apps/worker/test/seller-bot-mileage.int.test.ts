// Step 6 (docs/garage.md): the mileage at the handover in the seller bot, on the `_worker`
// database with grammY without network (both Api transports recorded): after «Выдал» an order
// with a car gets «Пробег? (ответьте числом или нажмите «Пропустить»)»; a reply writes the
// mileage (source `handover`), a second reply finds no question (idempotent), a smaller number is
// written only when confirmed, «Пропустить» closes the question; no question without a car or
// without GARAGE_ENABLED, and a refused question never blocks the handover. VINs are synthetic.
import { randomInt, randomUUID } from 'node:crypto';
import { Writable } from 'node:stream';
import { createLogger } from '@detaly/config';
import { eq, orders, payments, receipts, staff, userVehicles } from '@detaly/db';
import { localDate } from '@detaly/domain';
import { Api, type Bot, type Transformer } from 'grammy';
import type { Update, UserFromGetMe } from 'grammy/types';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createSellerBot } from '../src/bots/seller/bot';
import { createSellerCards } from '../src/bots/seller/cards';
import {
  MILEAGE_NOT_A_NUMBER,
  MILEAGE_QUESTION,
  MILEAGE_SKIPPED,
  MILEAGE_STALE,
} from '../src/bots/seller/mileage';
import { hasTestDatabase } from './fixtures/databases';
import { createTestDeps, type TestDeps } from './helpers/test-deps';
import { PAYMENT_ENV, seedOrder, type Seeded } from './payments-helpers';

const TOKEN = '123456:seller-mileage-test-token';
const SELLER_CHAT = -100_888_000_000 - randomInt(0, 1_000_000);
const SELLER_TG = 8_300_000_000 + randomInt(0, 1_000_000);
const OTHER_TG = SELLER_TG + 1;
const VIN = 'XTA21099043456789';

const BOT_INFO = {
  id: 7_000_000_003,
  is_bot: true,
  first_name: 'Детали · продавцы',
  username: 'detaly_seller_mileage_test_bot',
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
}

function recorder() {
  const calls: Call[] = [];
  let nextMessageId = 7000;
  let fail: ((call: Omit<Call, 'result'>) => string | null) | null = null;
  const transformer: Transformer = async (_prev, method, payload) => {
    const p = payload as Record<string, unknown>;
    const failure = fail?.({ method, payload: p }) ?? null;
    if (failure !== null) {
      calls.push({ method, payload: p, result: { error: failure } });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return { ok: false, error_code: 400, description: failure } as any;
    }
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
  return {
    calls,
    transformer,
    failWhen(fn: typeof fail) {
      fail = fn;
    },
  };
}

let rec: ReturnType<typeof recorder>;
let t: TestDeps;
let off: TestDeps;
let bot: Bot;
let botOff: Bot;
const staffIds: string[] = [];
const logLines: string[] = [];
let updateId = 1;

function sent(since: number): Call[] {
  return rec.calls.slice(since).filter((c) => c.method === 'sendMessage' && !hasError(c));
}

function hasError(call: Call): boolean {
  return (call.result as { error?: string } | null)?.error !== undefined;
}

function messageId(call: Call | undefined): number {
  return (call?.result as { message_id: number }).message_id;
}

function keyboard(call: Call | undefined): Button[] {
  const markup = call?.payload.reply_markup as { inline_keyboard?: Button[][] } | undefined;
  return (markup?.inline_keyboard ?? []).flat();
}

function answers(since: number): (string | undefined)[] {
  return rec.calls
    .slice(since)
    .filter((c) => c.method === 'answerCallbackQuery')
    .map((c) => c.payload.text as string | undefined);
}

async function press(
  target: Bot,
  data: string,
  message: number,
  from = SELLER_TG,
  text = 'Пробег? (ответьте числом или нажмите «Пропустить»)',
) {
  const id = updateId++;
  await target.handleUpdate({
    update_id: id,
    callback_query: {
      id: `cb${id}`,
      from: { id: from, is_bot: false, first_name: 'Тест' },
      chat_instance: 'ci',
      data,
      message: {
        message_id: message,
        date: Math.floor(Date.now() / 1000),
        chat: { id: SELLER_CHAT, type: 'supergroup', title: 'Продавцы' },
        text,
      },
    },
  } as Update);
}

async function reply(text: string, replyTo: number, from = SELLER_TG) {
  const id = updateId++;
  const chat = { id: SELLER_CHAT, type: 'supergroup', title: 'Продавцы' };
  await bot.handleUpdate({
    update_id: id,
    message: {
      message_id: 90_000 + id,
      date: Math.floor(Date.now() / 1000),
      chat,
      from: { id: from, is_bot: false, first_name: 'Тест' },
      reply_to_message: {
        message_id: replyTo,
        date: Math.floor(Date.now() / 1000),
        chat,
        from: { ...BOT_INFO },
        text: 'Пробег?',
      },
      text,
    },
  } as unknown as Update);
}

/** A ready, prepaid order whose settlement receipt succeeded: «Выдал» is on its card. */
async function handable(deps: TestDeps, car: Partial<typeof userVehicles.$inferInsert> | null) {
  const seeded: Seeded = await seedOrder(deps.deps.db, {
    status: 'ready',
    itemState: 'arrived',
    clientArrived: true,
  });
  const [payment] = await deps.deps.db
    .insert(payments)
    .values({
      orderId: seeded.orderId,
      kind: 'prepayment',
      status: 'succeeded',
      amountKop: seeded.totalKop,
      idempotenceKey: randomUUID(),
    })
    .returning({ id: payments.id });
  await deps.deps.db.insert(receipts).values({
    orderId: seeded.orderId,
    paymentId: payment?.id,
    kind: 'offset',
    status: 'succeeded',
    idempotenceKey: randomUUID(),
  });
  let vehicleId: string | null = null;
  if (car !== null) {
    const [row] = await deps.deps.db
      .insert(userVehicles)
      .values({
        userId: seeded.userId,
        makeSlug: 'lada',
        make: 'Lada',
        model: 'Vesta',
        engine: '1.6',
        year: 2019,
        vin: VIN,
        source: 'kit',
        ...car,
      })
      .returning({ id: userVehicles.id });
    vehicleId = row!.id;
    await deps.deps.db.update(orders).set({ vehicleId }).where(eq(orders.id, seeded.orderId));
  }
  return { ...seeded, vehicleId };
}

/** Posts the card and presses «Выдал»; returns the calls index before the press. */
async function handOver(deps: TestDeps, target: Bot, orderId: string): Promise<number> {
  const before = rec.calls.length;
  await createSellerCards(deps.deps).post({ orderId, template: null });
  const card = rec.calls.slice(before).find((c) => c.method === 'sendMessage');
  const handed = keyboard(card).find((b) => b.text === 'Выдал');
  if (!handed?.callback_data) throw new Error('no «Выдал» on the card');
  const mark = rec.calls.length;
  await press(target, handed.callback_data, messageId(card));
  return mark;
}

async function vehicle(id: string | null) {
  const [row] = await t.deps.db
    .select()
    .from(userVehicles)
    .where(eq(userVehicles.id, id ?? ''));
  return row;
}

async function statusOf(orderId: string) {
  const [row] = await t.deps.db
    .select({ status: orders.status })
    .from(orders)
    .where(eq(orders.id, orderId));
  return row?.status;
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
  const env = {
    ...PAYMENT_ENV,
    TG_SELLER_BOT_TOKEN: TOKEN,
    TG_SELLER_CHAT_ID: String(SELLER_CHAT),
  };
  t = await createTestDeps({
    telegram: api,
    logger: createLogger('seller-mileage-test', { level: 'debug', destination: sink }),
    envOverrides: { ...env, GARAGE_ENABLED: 'true' },
  });
  off = await createTestDeps({
    telegram: api,
    db: t.deps.db,
    logger: t.deps.logger,
    envOverrides: { ...env, GARAGE_ENABLED: 'false' },
  });
  const rows = await t.deps.db
    .insert(staff)
    .values([
      { name: 'Продавец', role: 'seller', tgUserId: SELLER_TG },
      { name: 'Второй продавец', role: 'seller', tgUserId: OTHER_TG },
    ])
    .returning({ id: staff.id });
  staffIds.push(...rows.map((row) => row.id));
  const make = (deps: TestDeps) => {
    const created = createSellerBot({
      token: TOKEN,
      botInfo: BOT_INFO,
      isStaff: async (id) => id === SELLER_TG || id === OTHER_TG,
      health: async () => ({ heartbeatAgeSec: 1, dbOk: true, gitSha: null }),
      sellerChatId: SELLER_CHAT,
      logger: deps.deps.logger,
      deps: deps.deps,
    });
    created.api.config.use(rec.transformer);
    return created;
  };
  bot = make(t);
  botOff = make(off);
});

afterAll(async () => {
  if (!hasTestDatabase) return;
  if (staffIds.length > 0) {
    const sqlc = t.deps.db.$client;
    await sqlc`delete from staff where id in ${sqlc(staffIds)}`;
  }
  await off.close();
  await t.close();
});

beforeEach(() => {
  rec?.failWhen(null);
});

describe.skipIf(!hasTestDatabase)('the mileage at the handover (step 6)', () => {
  it('«Выдал» → the question; a reply writes it (source handover); a second reply finds nothing', async () => {
    const order = await handable(t, {});
    const mark = await handOver(t, bot, order.orderId);
    expect(await statusOf(order.orderId)).toBe('handed');
    const question = sent(mark).find((c) => String(c.payload.text).startsWith(MILEAGE_QUESTION));
    expect(question, 'the question').toBeDefined();
    const text = String(question?.payload.text);
    expect(text).toContain(`Заказ ${order.number} · Lada Vesta 1.6, 2019`);
    // No VIN in the sellers chat, not even its tail.
    expect(text).not.toContain(VIN);
    expect(text).not.toContain(VIN.slice(-4));
    expect(keyboard(question).map((b) => b.text)).toEqual(['Пропустить']);
    expect(keyboard(question)[0]?.callback_data).toMatch(new RegExp(`^a:mskip:${order.orderId}:`));

    const before = rec.calls.length;
    await reply('85 000 км', messageId(question));
    expect(await vehicle(order.vehicleId)).toMatchObject({
      mileageKm: 85_000,
      mileageAt: localDate(new Date()),
      source: 'handover',
    });
    expect(sent(before).map((c) => c.payload.text)).toEqual(['Пробег записан: 85 000 км.']);
    // The «Пропустить» button of the question is gone.
    expect(
      rec.calls
        .slice(before)
        .some(
          (c) =>
            c.method === 'editMessageReplyMarkup' && c.payload.message_id === messageId(question),
        ),
    ).toBe(true);

    // Idempotent: the question was answered, another reply to it changes nothing and says nothing.
    const again = rec.calls.length;
    await reply('99000', messageId(question));
    expect((await vehicle(order.vehicleId))?.mileageKm).toBe(85_000);
    expect(sent(again)).toEqual([]);
  });

  it('a smaller number is asked once more and written only as a confirmed correction', async () => {
    const order = await handable(t, { mileageKm: 90_000, mileageAt: '2026-09-01' });
    const mark = await handOver(t, bot, order.orderId);
    const question = sent(mark).find((c) => String(c.payload.text).startsWith(MILEAGE_QUESTION));
    expect(String(question?.payload.text)).toContain('Записано раньше: 90 000 км на 1 сентября');

    const before = rec.calls.length;
    await reply('80000', messageId(question));
    const confirm = sent(before).at(-1);
    expect(String(confirm?.payload.text)).toContain('Пробег не уменьшается');
    expect((await vehicle(order.vehicleId))?.mileageKm).toBe(90_000);

    // Another number than the one asked about: a new comparison, still lower → asked again.
    await reply('70000', messageId(confirm));
    const confirmAgain = sent(before).at(-1);
    expect(String(confirmAgain?.payload.text)).toContain('70 000');
    expect((await vehicle(order.vehicleId))?.mileageKm).toBe(90_000);

    await reply('70000', messageId(confirmAgain));
    expect(await vehicle(order.vehicleId)).toMatchObject({ mileageKm: 70_000, source: 'handover' });
  });

  it('not a number: said so, and the same question still takes the answer', async () => {
    const order = await handable(t, {});
    const mark = await handOver(t, bot, order.orderId);
    const question = sent(mark).find((c) => String(c.payload.text).startsWith(MILEAGE_QUESTION));
    const before = rec.calls.length;
    await reply('много', messageId(question));
    expect(sent(before).map((c) => c.payload.text)).toEqual([MILEAGE_NOT_A_NUMBER]);
    expect((await vehicle(order.vehicleId))?.mileageKm).toBeNull();
    await reply('12345', messageId(question));
    expect((await vehicle(order.vehicleId))?.mileageKm).toBe(12_345);
  });

  it('«Пропустить» closes the question and writes nothing; only the asker’s question', async () => {
    const order = await handable(t, {});
    const mark = await handOver(t, bot, order.orderId);
    const question = sent(mark).find((c) => String(c.payload.text).startsWith(MILEAGE_QUESTION));
    const skip = keyboard(question)[0]?.callback_data as string;

    // Another seller's press: not his question, the asker's button stays.
    let before = rec.calls.length;
    await press(bot, skip, messageId(question), OTHER_TG);
    expect(answers(before)).toEqual([MILEAGE_STALE]);
    expect(rec.calls.slice(before).map((c) => c.method)).toEqual(['answerCallbackQuery']);

    before = rec.calls.length;
    await press(bot, skip, messageId(question), SELLER_TG, String(question?.payload.text));
    expect(answers(before)).toEqual([MILEAGE_SKIPPED]);
    const edit = rec.calls
      .slice(before)
      .find((c) => c.method === 'editMessageText' && c.payload.message_id === messageId(question));
    // The question stays readable, closed: «Пропущено.» instead of «Ответьте … 10 минут».
    expect(String(edit?.payload.text)).toBe(
      `${MILEAGE_QUESTION}\nЗаказ ${order.number} · Lada Vesta 1.6, 2019\nПропущено.`,
    );

    // Nothing waits any more: a reply writes nothing, a second press is stale.
    await reply('50000', messageId(question));
    expect((await vehicle(order.vehicleId))?.mileageKm).toBeNull();
    before = rec.calls.length;
    await press(bot, skip, messageId(question));
    expect(answers(before)).toEqual([MILEAGE_STALE]);
    expect(await statusOf(order.orderId)).toBe('handed');
  });

  it('no question without a car, nor with GARAGE_ENABLED off', async () => {
    const noCar = await handable(t, null);
    let mark = await handOver(t, bot, noCar.orderId);
    expect(await statusOf(noCar.orderId)).toBe('handed');
    expect(sent(mark).some((c) => String(c.payload.text).startsWith(MILEAGE_QUESTION))).toBe(false);

    const withCar = await handable(off, {});
    mark = await handOver(off, botOff, withCar.orderId);
    expect(await statusOf(withCar.orderId)).toBe('handed');
    expect(sent(mark).some((c) => String(c.payload.text).startsWith(MILEAGE_QUESTION))).toBe(false);
  });

  it('a refused question never blocks the handover', async () => {
    const order = await handable(t, {});
    rec.failWhen((call) =>
      call.method === 'sendMessage' && String(call.payload.text).startsWith(MILEAGE_QUESTION)
        ? 'Bad Request: chat not found'
        : null,
    );
    await handOver(t, bot, order.orderId);
    expect(await statusOf(order.orderId)).toBe('handed');
    expect(logLines.join('')).toContain('mileage question failed');
    expect(logLines.join('')).not.toContain(VIN);
  });
});
