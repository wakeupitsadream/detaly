// Seller bot, phase 1C (docs/phase-1c-implementation.md section 9; Verification 1C V4, V6–V8):
// claim, booking and packaging photo buttons on the order card, photos (getFile -> download
// through deps.fetch -> ingestImage -> memory FileStore), ForceReply texts, VIN request cards
// with the answer in lines and its preview. The real engine and @detaly/vin on the `_worker`
// database, grammY without network (the transport of the bot's Api and deps.telegram is replaced
// and records every call), Rossko on the bundled fixtures, updates fed with bot.handleUpdate.
import { randomInt, randomUUID } from 'node:crypto';
import { Writable } from 'node:stream';
import { createLogger } from '@detaly/config';
import {
  asc,
  claims,
  documentVersions,
  eq,
  installBookings,
  messengerBindings,
  orderEvents,
  orderPhotos,
  orders,
  outbox,
  payments,
  receipts,
  refunds,
  sellerCards,
  sql,
  staff,
  vinRequests,
} from '@detaly/db';
import { createNoFileStore, type FileStore } from '@detaly/files';
import { CALLBACK_DATA_MAX_BYTES, parseCallbackData } from '@detaly/notify';
import { openClaim } from '@detaly/orders';
import { createVinRequest, newVinRequestId } from '@detaly/vin';
import { Api, type Bot, type Transformer } from 'grammy';
import type { Update, UserFromGetMe } from 'grammy/types';
import type { Job } from 'bullmq';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { awaitKey } from '../src/bots/seller/awaiting';
import { createSellerBot } from '../src/bots/seller/bot';
import { STALE_CARD } from '../src/bots/seller/callbacks';
import { PACKAGING_PHOTO_HINT } from '../src/bots/seller/card-view';
import { createSellerCards } from '../src/bots/seller/cards';
import { PACKAGING_NOT_NOW, STORAGE_OFF } from '../src/bots/seller/photos';
import type { WorkerDeps } from '../src/deps';
import { processNotify } from '../src/jobs/notify';
import { hasTestDatabase } from './fixtures/databases';
import { createTestDeps, type TestDeps } from './helpers/test-deps';
import { forceState, PAYMENT_ENV, seedOrder, type Seeded } from './payments-helpers';

const TOKEN = '123456:seller-bot-1c-test-token';
const SELLER_CHAT = -100_666_000_000 - randomInt(0, 1_000_000);
const SELLER_TG = 8_300_000_000 + randomInt(0, 1_000_000);
const OWNER_TG = SELLER_TG + 1;
const STRANGER_TG = SELLER_TG + 2;
const BASE_URL = 'https://detaly.test';
const DAY = 24 * 60 * 60 * 1000;
/** An 8x8 JPEG (sharp output): ingestImage re-encodes it. */
const JPEG = Buffer.from(
  '/9j/2wBDAAYEBQYFBAYGBQYHBwYIChAKCgkJChQODwwQFxQYGBcUFhYaHSUfGhsjHBYWICwgIyYnKSopGR8tMC0oMCUoKSj/2wBDAQcHBwoIChMKChMoGhYaKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCj/wAARCAAIAAgDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAX/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFAEBAAAAAAAAAAAAAAAAAAAABv/EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAMAwEAAhEDEQA/AKAAcVP/2Q==',
  'base64',
);
/** uuid v7 (the worker has no direct uuid dependency; @detaly/vin's generator is the same). */
const uuidv7 = newVinRequestId;
const FILE_URL_PREFIX = `https://api.telegram.org/file/bot${TOKEN}/`;

const BOT_INFO = {
  id: 7_000_000_011,
  is_bot: true,
  first_name: 'Детали · продавцы',
  username: 'detaly_seller_1c_test_bot',
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
  let nextMessageId = 6000;
  /** getFile answers: file_size per file_id (default: the JPEG's size). */
  const fileSizes = new Map<string, number>();
  const transformer: Transformer = async (_prev, method, payload) => {
    const p = payload as Record<string, unknown>;
    let result: unknown = true;
    if (method === 'sendMessage' || method === 'sendPhoto') {
      result = {
        message_id: nextMessageId++,
        date: Math.floor(Date.now() / 1000),
        chat: { id: Number(p.chat_id), type: 'supergroup', title: 'Продавцы' },
        ...(typeof p.text === 'string' ? { text: p.text } : {}),
      };
    }
    if (method === 'getFile') {
      const fileId = String(p.file_id);
      result = {
        file_id: fileId,
        file_unique_id: `u-${fileId}`,
        file_size: fileSizes.get(fileId) ?? JPEG.byteLength,
        file_path: `photos/${fileId}.jpg`,
      };
    }
    calls.push({ method, payload: p, result });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return { ok: true, result } as any;
  };
  return { calls, transformer, fileSizes };
}

/** deps.fetch: Telegram file downloads only (the JPEG), anything else is refused. */
function telegramFiles() {
  const downloads: string[] = [];
  const fetchImpl: typeof fetch = async (input) => {
    const url = String(input instanceof Request ? input.url : input);
    if (!url.startsWith(FILE_URL_PREFIX)) throw new Error('unexpected network access');
    downloads.push(url.slice(FILE_URL_PREFIX.length));
    return new Response(JPEG, { status: 200, headers: { 'Content-Type': 'image/jpeg' } });
  };
  return { downloads, fetch: fetchImpl };
}

let t: TestDeps;
let rec: ReturnType<typeof recorder>;
let files: ReturnType<typeof telegramFiles>;
let bot: Bot;
const logLines: string[] = [];
const staffIds: string[] = [];
const phones: string[] = [];
let updateId = 1;
let sellerId = '';
let documentVersionId = '';

function sentMessageId(call: Call): number {
  return (call.result as { message_id: number }).message_id;
}

function keyboardOf(call: Call): Button[] {
  const markup = call.payload.reply_markup as { inline_keyboard?: Button[][] } | undefined;
  return (markup?.inline_keyboard ?? []).flat();
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
    if (call.method === 'editMessageReplyMarkup' && call.payload.message_id === messageId) {
      return { text: '', buttons: keyboardOf(call) };
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

function answersSince(index: number): (string | undefined)[] {
  return callsSince(index)
    .filter((c) => c.method === 'answerCallbackQuery')
    .map((c) => c.payload.text as string | undefined);
}

/** Texts the bot sent (sendMessage) since `index`. */
function messagesSince(index: number): string[] {
  return callsSince(index)
    .filter((c) => c.method === 'sendMessage')
    .map((c) => String(c.payload.text));
}

/** The last ForceReply prompt the bot sent since `index`. */
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

const groupChat = { id: SELLER_CHAT, type: 'supergroup' as const, title: 'Продавцы' };

async function press(
  data: string,
  { from = SELLER_TG, messageId }: { from?: number; messageId: number },
): Promise<void> {
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

function replyTo(messageId: number | undefined) {
  return messageId === undefined
    ? {}
    : {
        reply_to_message: {
          message_id: messageId,
          date: Math.floor(Date.now() / 1000),
          chat: groupChat,
          from: { ...BOT_INFO },
          text: 'prompt',
        },
      };
}

async function sendText(
  text: string,
  { from = SELLER_TG, reply }: { from?: number; reply?: number } = {},
): Promise<void> {
  const id = updateId++;
  await bot.handleUpdate({
    update_id: id,
    message: {
      message_id: 100_000 + id,
      date: Math.floor(Date.now() / 1000),
      chat: groupChat,
      from: { id: from, is_bot: false, first_name: 'Тест' },
      ...replyTo(reply),
      text,
    },
  } as Update);
}

async function sendPhoto({
  from = SELLER_TG,
  reply,
}: { from?: number; reply?: number } = {}): Promise<string> {
  const id = updateId++;
  const fileId = `photo-${id}`;
  await bot.handleUpdate({
    update_id: id,
    message: {
      message_id: 100_000 + id,
      date: Math.floor(Date.now() / 1000),
      chat: groupChat,
      from: { id: from, is_bot: false, first_name: 'Тест' },
      ...replyTo(reply),
      photo: [
        { file_id: `${fileId}-s`, file_unique_id: `${fileId}-us`, width: 90, height: 90 },
        { file_id: fileId, file_unique_id: `${fileId}-u`, width: 800, height: 800 },
      ],
    },
  } as Update);
  return fileId;
}

async function postCard(orderId: string): Promise<number> {
  const before = rec.calls.length;
  await createSellerCards(t.deps).post({ orderId, template: null });
  const sent = callsSince(before).find((c) => c.method === 'sendMessage');
  if (!sent) throw new Error('no card was sent');
  return sentMessageId(sent);
}

/** The open card of the order (its message id). */
async function openOrderCard(orderId: string): Promise<number> {
  const rows = await t.deps.db
    .select()
    .from(sellerCards)
    .where(eq(sellerCards.orderId, orderId))
    .orderBy(asc(sellerCards.createdAt));
  const open = rows.filter((r) => r.closedAt === null).at(-1);
  if (!open?.messageId) throw new Error('no open card');
  return open.messageId;
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
  phones.push(seeded.phone);
  return seeded;
}

/**
 * A prepay order handed a day ago: the online prepayment and both receipts (prepayment inside
 * the payment, offset) succeeded — what «Вернуть деньги» by a claim needs.
 */
async function handedPrepay(): Promise<Seeded> {
  const seeded = await seed({ status: 'handed', scheme: 'prepay', itemState: 'handed' });
  const handedAt = new Date(Date.now() - DAY);
  await t.deps.db
    .update(orders)
    .set({
      handedAt,
      clientArrivedAt: handedAt,
      promisedDate: handedAt.toISOString().slice(0, 10),
    })
    .where(eq(orders.id, seeded.orderId));
  const paymentId = uuidv7();
  await t.deps.db.insert(payments).values({
    id: paymentId,
    orderId: seeded.orderId,
    kind: 'prepayment',
    status: 'succeeded',
    amountKop: seeded.totalKop,
    idempotenceKey: randomUUID(),
    providerPaymentId: `pay-${randomUUID()}`,
    paidAt: new Date(Date.now() - 3 * DAY),
  });
  await t.deps.db.insert(receipts).values([
    {
      orderId: seeded.orderId,
      paymentId,
      kind: 'prepayment',
      idempotenceKey: uuidv7(),
      status: 'succeeded',
    },
    {
      orderId: seeded.orderId,
      paymentId,
      kind: 'offset',
      idempotenceKey: uuidv7(),
      status: 'succeeded',
    },
  ]);
  return seeded;
}

async function openDefectClaim(seeded: Seeded, photos = 2): Promise<string> {
  const result = await openClaim(t.deps.engine, {
    orderId: seeded.orderId,
    kind: 'defect',
    text: 'Течёт по корпусу, мой номер 8 912 345-67-89',
    photoKeys: Array.from({ length: photos }, () => `claim/${seeded.orderId}/${uuidv7()}.jpg`),
    via: 'web',
    requestKey: uuidv7(),
    actor: { type: 'client', id: seeded.userId },
  });
  if (!result.ok) throw new Error(`openClaim: ${result.message}`);
  return result.claimId;
}

async function claimRow(id: string) {
  const [row] = await t.deps.db.select().from(claims).where(eq(claims.id, id));
  if (!row) throw new Error('no claim');
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
  files = telegramFiles();
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
    fetch: files.fetch,
    logger: createLogger('seller-bot-1c-test', { level: 'debug', destination: sink }),
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
      { name: 'Продавец 1C', role: 'seller', tgUserId: SELLER_TG },
      { name: 'Владелец 1C', role: 'owner', tgUserId: OWNER_TG },
    ])
    .returning({ id: staff.id, role: staff.role });
  for (const row of rows) staffIds.push(row.id);
  sellerId = rows.find((r) => r.role === 'seller')?.id ?? '';
  const [doc] = await t.deps.db
    .select({ id: documentVersions.id })
    .from(documentVersions)
    .where(eq(documentVersions.kind, 'consent_pd'))
    .limit(1);
  documentVersionId = doc?.id ?? '';
  bot = makeBot(t.deps);
});

afterAll(async () => {
  if (!hasTestDatabase) return;
  // Every outgoing message: no full phone of any client of this file, no photo sent by the bot
  // (VIN and claim photos never go to Telegram, decision С2), callback_data within 64 bytes.
  const outgoing = rec.calls
    .filter((c) => c.method !== 'getFile')
    .map((c) => JSON.stringify(c.payload))
    .join('\n');
  for (const phone of phones) {
    expect(outgoing.includes(phone.slice(1)), 'a full phone in Telegram').toBe(false);
    expect(outgoing.includes(phone.slice(2)), 'a full phone in Telegram').toBe(false);
  }
  expect(rec.calls.filter((c) => c.method === 'sendPhoto')).toEqual([]);
  for (const call of rec.calls) {
    for (const button of keyboardOf(call)) {
      if (button.callback_data) {
        expect(Buffer.byteLength(button.callback_data)).toBeLessThanOrEqual(
          CALLBACK_DATA_MAX_BYTES,
        );
      }
    }
  }
  // Logs: no phones, no texts of the claims or the answers, no bot token.
  const logs = logLines.join('');
  for (const phone of phones) expect(logs.includes(phone.slice(2))).toBe(false);
  expect(logs).not.toContain('Течёт');
  expect(logs).not.toContain(TOKEN);
  expect(/\+79\d{9}/u.test(logs)).toBe(false);

  if (staffIds.length > 0) {
    const sqlc = t.deps.db.$client;
    await sqlc`update claims set decided_by = null where decided_by in ${sqlc(staffIds)}`;
    await sqlc`update order_photos set by_staff_id = null where by_staff_id in ${sqlc(staffIds)}`;
    await sqlc`update vin_requests set assigned_staff_id = null where assigned_staff_id in ${sqlc(staffIds)}`;
    await sqlc`delete from staff where id in ${sqlc(staffIds)}`;
  }
  await t.close();
});

beforeEach(() => {
  rec?.fileSizes.clear();
});

describe.skipIf(!hasTestDatabase)('seller bot 1C: order card', () => {
  it('ordered_at_supplier: the hint, «Фото упаковки», a photo in reply to the card is stored', async () => {
    const seeded = await seed({ status: 'ordered_at_supplier', itemState: 'ordered' });
    const messageId = await postCard(seeded.orderId);
    const { text } = lastRendering(messageId);
    expect(text).toContain(PACKAGING_PHOTO_HINT);
    expect(labels(messageId)).toContain('Фото упаковки');

    const before = rec.calls.length;
    const fileId = await sendPhoto({ reply: messageId });
    expect(files.downloads).toContain(`photos/${fileId}.jpg`);
    expect(messagesSince(before)).toEqual(['Фото сохранено']);
    const photos = await t.deps.db
      .select()
      .from(orderPhotos)
      .where(eq(orderPhotos.orderId, seeded.orderId));
    expect(photos).toHaveLength(1);
    expect(photos[0]).toMatchObject({ kind: 'packaging', byStaffId: sellerId });
    expect(photos[0]?.s3Key).toMatch(new RegExp(`^order/${seeded.orderId}/[0-9a-f-]{36}\\.jpg$`));
    // The stored object is the re-encoded JPEG.
    const stored = await t.deps.files.get(photos[0]?.s3Key ?? '');
    expect(stored?.contentType).toBe('image/jpeg');
    expect(
      Buffer.from(stored?.bytes ?? [])
        .subarray(0, 2)
        .toString('hex'),
    ).toBe('ffd8');
    expect(await eventTypes(seeded.orderId)).toEqual(['photo_added']);
    expect(lastRendering(messageId).text).toContain('Фото упаковки: 1');

    // «Фото упаковки» -> ForceReply -> the photo in reply to the prompt.
    const pressed = rec.calls.length;
    await press(buttonData(messageId, 'Фото упаковки'), { messageId });
    expect(answersSince(pressed)).toEqual(['Пришлите фото ответом на сообщение']);
    const prompt = promptSince(pressed);
    expect(String(prompt.payload.text)).toContain(seeded.number);
    // A photo that does not reply to the prompt (nor to a card) is ignored.
    const ignored = rec.calls.length;
    await sendPhoto();
    expect(callsSince(ignored)).toEqual([]);
    await sendPhoto({ reply: sentMessageId(prompt) });
    expect(
      await t.deps.db.select().from(orderPhotos).where(eq(orderPhotos.orderId, seeded.orderId)),
    ).toHaveLength(2);
    expect(await t.deps.redis.exists(awaitKey(t.deps.keyPrefix, SELLER_CHAT, SELLER_TG))).toBe(0);
  });

  it('a photo in reply to a card of a handed order is not a packaging photo', async () => {
    const seeded = await seed({ status: 'handed', itemState: 'handed' });
    const messageId = await postCard(seeded.orderId);
    expect(labels(messageId)).not.toContain('Фото упаковки');
    const before = rec.calls.length;
    await sendPhoto({ reply: messageId });
    expect(messagesSince(before)).toEqual([PACKAGING_NOT_NOW]);
    expect(
      await t.deps.db.select().from(orderPhotos).where(eq(orderPhotos.orderId, seeded.orderId)),
    ).toEqual([]);
  });

  it('a photo above the size limit is refused before the download', async () => {
    const seeded = await seed({ status: 'ready', itemState: 'arrived' });
    const messageId = await postCard(seeded.orderId);
    const downloads = files.downloads.length;
    const id = updateId;
    rec.fileSizes.set(`photo-${id}`, 25 * 1024 * 1024);
    const before = rec.calls.length;
    await bot.handleUpdate({
      update_id: updateId++,
      message: {
        message_id: 100_000 + id,
        date: Math.floor(Date.now() / 1000),
        chat: groupChat,
        from: { id: SELLER_TG, is_bot: false, first_name: 'Тест' },
        ...replyTo(messageId),
        photo: [
          {
            file_id: `photo-${id}`,
            file_unique_id: 'u',
            width: 4000,
            height: 3000,
            file_size: 25 * 1024 * 1024,
          },
        ],
      },
    } as Update);
    expect(messagesSince(before)).toEqual(['Фото слишком большое — до 8 МБ']);
    expect(files.downloads).toHaveLength(downloads);
  });

  it('without a file store: «Хранилище фото не настроено», nothing changes', async () => {
    const noFiles: FileStore = createNoFileStore();
    const offBot = makeBot({ ...t.deps, files: noFiles });
    const seeded = await seed({ status: 'ordered_at_supplier', itemState: 'ordered' });
    const messageId = await postCard(seeded.orderId);
    const before = rec.calls.length;
    const id = updateId++;
    await offBot.handleUpdate({
      update_id: id,
      callback_query: {
        id: `cb${id}`,
        from: { id: SELLER_TG, is_bot: false, first_name: 'Тест' },
        chat_instance: 'ci',
        data: buttonData(messageId, 'Фото упаковки'),
        message: { message_id: messageId, date: 0, chat: groupChat },
      },
    } as Update);
    expect(answersSince(before)).toEqual([STORAGE_OFF]);
    const photoId = updateId++;
    await offBot.handleUpdate({
      update_id: photoId,
      message: {
        message_id: 100_000 + photoId,
        date: 0,
        chat: groupChat,
        from: { id: SELLER_TG, is_bot: false, first_name: 'Тест' },
        ...replyTo(messageId),
        photo: [{ file_id: 'p', file_unique_id: 'u', width: 10, height: 10 }],
      },
    } as Update);
    expect(messagesSince(before)).toEqual([STORAGE_OFF]);
    expect(callsSince(before).some((c) => c.method === 'getFile')).toBe(false);
    expect(
      await t.deps.db.select().from(orderPhotos).where(eq(orderPhotos.orderId, seeded.orderId)),
    ).toEqual([]);
  });

  it('booking: the card shows the slot, «Подтвердить запись» -> confirmed, the client is told', async () => {
    const seeded = await seed({ status: 'ready', itemState: 'arrived' });
    const slotAt = new Date('2026-10-08T09:00:00Z');
    const [booking] = await t.deps.db
      .insert(installBookings)
      .values({
        orderId: seeded.orderId,
        userId: seeded.userId,
        slotAt,
        status: 'requested',
        createdVia: 'web',
        requestKey: uuidv7(),
      })
      .returning({ id: installBookings.id });
    const bookingId = (booking as { id: string }).id;
    const messageId = await postCard(seeded.orderId);
    expect(lastRendering(messageId).text).toContain(
      'Запись на установку: чт 8 окт 14:00 — ждёт подтверждения',
    );
    const data = buttonData(messageId, 'Подтвердить запись');
    expect(parseCallbackData(data)).toMatchObject({ action: 'bconf', orderId: bookingId });
    expect(labels(messageId)).toContain('Отклонить запись чт 8 окт 14:00');

    const before = rec.calls.length;
    await press(data, { messageId });
    expect(answersSince(before)).toEqual(['Запись подтверждена']);
    const [row] = await t.deps.db
      .select()
      .from(installBookings)
      .where(eq(installBookings.id, bookingId));
    expect(row?.status).toBe('confirmed');
    expect(lastRendering(messageId).text).toContain('чт 8 окт 14:00 — подтверждена');
    expect(await eventTypes(seeded.orderId)).toContain('install_confirmed');
    const notify = await t.deps.db
      .select()
      .from(outbox)
      .where(sql`${outbox.data}->>'orderId' = ${seeded.orderId}`);
    expect(notify.map((r) => r.data.template)).toContain('install_confirmed');
    // A second press of the old button is stale.
    const again = rec.calls.length;
    await press(data, { messageId });
    expect(answersSince(again)).toEqual([STALE_CARD]);
  });

  it('V8: a seller cannot refund a claim before «Принял возврат»; V7 in the bot: photo, text, refund', async () => {
    const seeded = await handedPrepay();
    const claimId = await openDefectClaim(seeded);
    const messageId = await postCard(seeded.orderId);
    const { text } = lastRendering(messageId);
    expect(text).toContain('Претензия: брак · весь заказ · ответить до');
    expect(text).toContain('возврат принят нет · фото клиента: 2 (в админке)');
    expect(text).not.toContain('Течёт');
    expect(text).not.toContain('345-67-89');
    expect(labels(messageId)).toEqual(
      expect.arrayContaining([
        'Принял возврат',
        'Вернуть деньги (нужна причина)',
        'Замена',
        'Отказать по претензии',
      ]),
    );
    const [card] = await t.deps.db
      .select()
      .from(sellerCards)
      .where(eq(sellerCards.orderId, seeded.orderId));

    // The seller presses «Вернуть деньги»: the guard's reason, no prompt, nothing changes.
    let before = rec.calls.length;
    await press(buttonData(messageId, 'Вернуть деньги'), { messageId });
    expect(answersSince(before)).toEqual(['Сначала «Принял возврат»']);
    expect(callsSince(before).map((c) => c.method)).toEqual(['answerCallbackQuery']);
    expect(
      (
        await t.deps.db
          .select()
          .from(sellerCards)
          .where(eq(sellerCards.id, card?.id ?? ''))
      )[0]?.nonce,
    ).toBe(card?.nonce);
    expect(await status(seeded.orderId)).toBe('handed');
    expect(
      await t.deps.db.select().from(refunds).where(eq(refunds.orderId, seeded.orderId)),
    ).toEqual([]);

    // «Принял возврат» -> ForceReply -> the photo of the returned part.
    before = rec.calls.length;
    await press(buttonData(messageId, 'Принял возврат'), { messageId });
    const prompt = promptSince(before);
    expect(String(prompt.payload.text)).toContain('Пришлите фото возвращённой детали');
    // A text reply to a photo prompt is not taken.
    const textReply = rec.calls.length;
    await sendText('вот фото', { reply: sentMessageId(prompt) });
    expect(callsSince(textReply)).toEqual([]);
    before = rec.calls.length;
    await sendPhoto({ reply: sentMessageId(prompt) });
    expect(messagesSince(before)).toEqual(['Возврат принят — теперь можно решить претензию']);
    const accepted = await claimRow(claimId);
    expect(accepted.returnAcceptedAt).not.toBeNull();
    const returnPhotos = await t.deps.db
      .select()
      .from(orderPhotos)
      .where(eq(orderPhotos.claimId, claimId));
    expect(returnPhotos).toHaveLength(1);
    expect(returnPhotos[0]?.kind).toBe('return');
    const current = await openOrderCard(seeded.orderId);
    expect(lastRendering(current).text).toContain('возврат принят ✓');
    expect(labels(current)).not.toContain('Принял возврат');
    expect(labels(current)).toContain('Вернуть деньги');

    // «Вернуть деньги» -> ForceReply «Текст ответа клиенту» -> decideClaim -> refund_pending.
    before = rec.calls.length;
    await press(buttonData(current, 'Вернуть деньги'), { messageId: current });
    const textPrompt = promptSince(before);
    expect(String(textPrompt.payload.text)).toContain(
      'Текст ответа клиенту (он увидит его на странице заказа)',
    );
    // Another user's reply to the prompt is not the answer.
    const foreign = rec.calls.length;
    await sendText('Вернём деньги', { from: OWNER_TG, reply: sentMessageId(textPrompt) });
    expect(callsSince(foreign)).toEqual([]);
    before = rec.calls.length;
    await sendText('Брак подтвердился, вернём деньги на карту', {
      reply: sentMessageId(textPrompt),
    });
    expect(messagesSince(before)).toEqual([
      'Возврат денег по претензии создан. Клиент увидит ответ на странице заказа.',
    ]);
    expect(await status(seeded.orderId)).toBe('refund_pending');
    const decided = await claimRow(claimId);
    expect(decided).toMatchObject({
      decision: 'refund',
      decisionText: 'Брак подтвердился, вернём деньги на карту',
      decidedVia: 'bot',
      decidedBy: sellerId,
      overrideReason: null,
    });
    expect(decided.closedAt).not.toBeNull();
    const [refund] = await t.deps.db
      .select()
      .from(refunds)
      .where(eq(refunds.orderId, seeded.orderId));
    expect(refund?.amountKop).toBe(seeded.totalKop);
    // Verification 1C: the refund deadline counts from the client's claim.
    expect(refund?.deadlineAt?.getTime()).toBe(decided.openedAt.getTime() + 10 * DAY);
    expect(decided.refundId).toBe(refund?.id);
    expect(lastRendering(current).text).not.toContain('Претензия: брак');
  });

  it('owner: «Вернуть деньги (нужна причина)» asks the reason, then the text; the reason is journaled', async () => {
    const seeded = await handedPrepay();
    const claimId = await openDefectClaim(seeded, 0);
    const messageId = await postCard(seeded.orderId);
    expect(lastRendering(messageId).text).toContain('фото клиента: нет');

    let before = rec.calls.length;
    await press(buttonData(messageId, 'Вернуть деньги (нужна причина)'), {
      from: OWNER_TG,
      messageId,
    });
    expect(answersSince(before)).toEqual(['Сначала причина, затем текст ответа клиенту']);
    const reasonPrompt = promptSince(before);
    expect(String(reasonPrompt.payload.text)).toContain('Причина возврата без приёмки детали');

    before = rec.calls.length;
    await sendText('Клиент далеко, деталь заберём курьером', {
      from: OWNER_TG,
      reply: sentMessageId(reasonPrompt),
    });
    const textPrompt = promptSince(before);
    expect(String(textPrompt.payload.text)).toContain('Текст ответа клиенту');

    before = rec.calls.length;
    await sendText('Вернём деньги без возврата детали', {
      from: OWNER_TG,
      reply: sentMessageId(textPrompt),
    });
    expect(messagesSince(before)[0]).toContain('Возврат денег по претензии создан');
    expect(await status(seeded.orderId)).toBe('refund_pending');
    const row = await claimRow(claimId);
    expect(row.overrideReason).toBe('Клиент далеко, деталь заберём курьером');
    const [event] = await t.deps.db
      .select()
      .from(orderEvents)
      .where(eq(orderEvents.orderId, seeded.orderId))
      .orderBy(asc(orderEvents.createdAt))
      .then((rows) => rows.filter((r) => r.type === 'claim_refund_approved'));
    expect(event?.payload).toMatchObject({
      overrideReason: 'Клиент далеко, деталь заберём курьером',
    });
  });

  it('«Отказать по претензии» with the answer closes the claim; an empty answer asks again', async () => {
    const seeded = await handedPrepay();
    const claimId = await openDefectClaim(seeded, 1);
    const messageId = await postCard(seeded.orderId);
    let before = rec.calls.length;
    await press(buttonData(messageId, 'Отказать по претензии'), { messageId });
    let prompt = promptSince(before);
    before = rec.calls.length;
    await sendText('   ', { reply: sentMessageId(prompt) });
    expect(messagesSince(before)[0]).toContain('Нажмите «Отказать по претензии» ещё раз');
    expect((await claimRow(claimId)).decision).toBeNull();

    const current = await openOrderCard(seeded.orderId);
    before = rec.calls.length;
    await press(buttonData(current, 'Отказать по претензии'), { messageId: current });
    prompt = promptSince(before);
    await sendText('Следы неправильной установки, гарантия не действует', {
      reply: sentMessageId(prompt),
    });
    const row = await claimRow(claimId);
    expect(row).toMatchObject({ decision: 'reject', decidedVia: 'bot' });
    expect(row.closedAt).not.toBeNull();
    expect(await status(seeded.orderId)).toBe('handed');
    const notify = await t.deps.db
      .select()
      .from(outbox)
      .where(sql`${outbox.data}->>'orderId' = ${seeded.orderId}`);
    expect(notify.map((r) => r.data.template)).toContain('claim_decided');
    // The answer text never reaches the queue data (only /o/<token> shows it).
    expect(JSON.stringify(notify)).not.toContain('гарантия');
  });

  it('a stranger: silence for a press and for a photo in reply to a card', async () => {
    const seeded = await seed({ status: 'ordered_at_supplier', itemState: 'ordered' });
    const messageId = await postCard(seeded.orderId);
    const before = rec.calls.length;
    await press(buttonData(messageId, 'Фото упаковки'), { from: STRANGER_TG, messageId });
    await sendPhoto({ from: STRANGER_TG, reply: messageId });
    await sendText('ответ', { from: STRANGER_TG, reply: messageId });
    expect(callsSince(before)).toEqual([
      expect.objectContaining({
        method: 'answerCallbackQuery',
        payload: { callback_query_id: expect.any(String) },
      }),
    ]);
    expect(
      await t.deps.db.select().from(orderPhotos).where(eq(orderPhotos.orderId, seeded.orderId)),
    ).toEqual([]);
  });
});

describe.skipIf(!hasTestDatabase)('seller bot 1C: VIN requests', () => {
  async function vinRequest(phone: string, photoCount: number) {
    const id = newVinRequestId();
    const photoKeys = Array.from({ length: photoCount }, () => `vin/${id}/${uuidv7()}.jpg`);
    for (const key of photoKeys) await t.deps.files.put(key, new Uint8Array(JPEG));
    const result = await createVinRequest(t.deps.db, {
      id,
      vin: 'XTA21099043456789',
      carText: 'ВАЗ 2109',
      needText: `Масляный фильтр, перезвоните ${phone}`,
      phone,
      channel: 'telegram',
      photoKeys,
      consent: { documentVersionId, textSha256: 'a'.repeat(64), ip: null, userAgent: null },
      requestKey: uuidv7(),
      now: new Date(),
    });
    return result;
  }

  async function postVinCard(vinRequestId: string): Promise<number> {
    const before = rec.calls.length;
    const posted = await createSellerCards(t.deps).postVin({ vinRequestId });
    expect(posted).toEqual({ status: 'posted' });
    const sent = callsSince(before).find((c) => c.method === 'sendMessage');
    if (!sent) throw new Error('no VIN card');
    return sentMessageId(sent);
  }

  async function openVinCard(vinRequestId: string): Promise<number> {
    const rows = await t.deps.db
      .select()
      .from(sellerCards)
      .where(eq(sellerCards.vinRequestId, vinRequestId))
      .orderBy(asc(sellerCards.createdAt));
    const open = rows.filter((r) => r.closedAt === null);
    expect(open).toHaveLength(1);
    return open[0]?.messageId as number;
  }

  async function requestRow(id: string) {
    const [row] = await t.deps.db.select().from(vinRequests).where(eq(vinRequests.id, id));
    if (!row) throw new Error('no request');
    return row;
  }

  it('V4: the card without photos and phone -> a typo in the preview, no «Отправить» -> fixed -> sent, vin_proposal to the client', async () => {
    const phone = `+79${String(randomInt(0, 1_000_000_000)).padStart(9, '0')}`;
    phones.push(phone);
    const { vinRequestId, userId } = await vinRequest(phone, 2);
    const messageId = await postVinCard(vinRequestId);
    const card = lastRendering(messageId);
    expect(card.text).toContain('Заявка VIN №');
    expect(card.text).toContain('VIN XTA21099043456789');
    expect(card.text).toContain('Фото: 2 (в админке)');
    expect(card.text).toContain(`Клиент •••${phone.slice(-4)} · ответ: Telegram`);
    expect(card.text).toContain('Нужно: «Масляный фильтр, перезвоните •••»');
    expect(card.text).not.toContain(phone.slice(2));
    expect(card.buttons.map((b) => b.text)).toEqual([
      'Взять в работу',
      'Ответить строками',
      'Закрыть заявку',
      'Открыть в админке',
    ]);
    expect(card.buttons.at(-1)?.url).toBe(`${BASE_URL}/admin/vin/${vinRequestId}`);

    // «Взять в работу»
    let before = rec.calls.length;
    await press(buttonData(messageId, 'Взять в работу'), { messageId });
    expect(answersSince(before)).toEqual(['Заявка в работе']);
    expect(await requestRow(vinRequestId)).toMatchObject({
      status: 'in_work',
      assignedStaffId: sellerId,
    });
    expect(labels(messageId)).not.toContain('Взять в работу');

    // «Ответить строками» -> the format -> a typo.
    before = rec.calls.length;
    await press(buttonData(messageId, 'Ответить строками'), { messageId });
    let prompt = promptSince(before);
    expect(String(prompt.payload.text)).toContain('БРЕНД АРТИКУЛ [КОЛ-ВО]');
    // Ordinary chat text is not the answer.
    const chat = rec.calls.length;
    await sendText('MANN W914/2 1');
    expect(callsSince(chat)).toEqual([]);
    before = rec.calls.length;
    await sendText('MANN W9142X 1\n> Подобрали под ваш VIN', { reply: sentMessageId(prompt) });
    const previewCard = callsSince(before).find((c) => c.method === 'sendMessage');
    if (!previewCard) throw new Error('no preview card');
    const previewId = sentMessageId(previewCard);
    let preview = lastRendering(previewId);
    expect(preview.text).toContain('Превью ответа · заявка VIN');
    expect(preview.text).toContain('✗ 1: MANN W9142X 1 — Артикул W9142X не найден у поставщика');
    expect(preview.text).toContain('ошибок: 1');
    expect(preview.buttons.map((b) => b.text)).toEqual([
      'Исправить',
      'Закрыть заявку',
      'Открыть в админке',
    ]);
    // The older card of the request lost its buttons.
    expect(await openVinCard(vinRequestId)).toBe(previewId);
    expect(lastRendering(messageId).buttons).toEqual([]);
    expect((await requestRow(vinRequestId)).preview?.errorCount).toBe(1);

    // «Отправить» is refused even when forged with the current nonce.
    const [vinCard] = await t.deps.db
      .select()
      .from(sellerCards)
      .where(eq(sellerCards.messageId, previewId));
    before = rec.calls.length;
    await press(`a:vsend:${vinRequestId}:${vinCard?.nonce}`, { messageId: previewId });
    expect(answersSince(before)).toEqual(['В ответе есть ошибки — нажмите «Исправить»']);
    expect((await requestRow(vinRequestId)).status).toBe('in_work');

    // «Исправить» quotes the previous answer; the right lines -> ✓ and «Отправить клиенту».
    before = rec.calls.length;
    await press(buttonData(previewId, 'Исправить'), { messageId: previewId });
    prompt = promptSince(before);
    expect(String(prompt.payload.text)).toContain('Было:\nMANN W9142X 1');
    before = rec.calls.length;
    await sendText('MANN W914/2 1\n> Подобрали под ваш VIN', { reply: sentMessageId(prompt) });
    const fixedCard = callsSince(before).find((c) => c.method === 'sendMessage');
    if (!fixedCard) throw new Error('no fixed preview card');
    const fixedId = sentMessageId(fixedCard);
    preview = lastRendering(fixedId);
    expect(preview.text).toMatch(/✓ MANN-FILTER W 914\/2 × 1 — 798\u00a0₽, к \S+ \d+ \S+/u);
    expect(preview.text).toContain('Комментарий клиенту: Подобрали под ваш VIN');
    expect(preview.buttons.map((b) => b.text)).toEqual([
      'Отправить клиенту',
      'Исправить',
      'Закрыть заявку',
      'Открыть в админке',
    ]);

    // «Отправить клиенту» -> the proposal; a double press is stale.
    const send = buttonData(fixedId, 'Отправить клиенту');
    before = rec.calls.length;
    await press(send, { messageId: fixedId });
    expect(answersSince(before)).toEqual(['Подборка отправлена клиенту (Telegram)']);
    const sent = await requestRow(vinRequestId);
    expect(sent).toMatchObject({ status: 'offered', proposalCount: 1 });
    expect(lastRendering(fixedId).text).toContain('Подборка № 1 отправлена клиенту');
    expect(labels(fixedId)).toEqual([
      'Новая подборка строками',
      'Закрыть заявку',
      'Открыть в админке',
    ]);
    const again = rec.calls.length;
    await press(send, { messageId: fixedId });
    expect(answersSince(again)).toEqual([STALE_CARD]);

    // The client gets vin_proposal with the /p/ link (bound Telegram, fake client bot).
    const chatId = String(9_100_000_000 + randomInt(0, 1_000_000));
    await t.deps.db.insert(messengerBindings).values({
      userId,
      channel: 'telegram',
      externalUserId: chatId,
      chatId,
      isPrimary: true,
      phoneConfirmedAt: new Date(),
    });
    const jobs = await t.deps.db
      .select()
      .from(outbox)
      .where(sql`${outbox.jobId} like ${`vin:${vinRequestId}:vin_proposal:%`}`);
    expect(jobs).toHaveLength(1);
    await processNotify({ name: 'vin', data: jobs[0]?.data } as unknown as Job, t.deps);
    const delivered = t.fakes.clientTelegram.sent().filter((m) => m.chatId === chatId);
    expect(delivered).toHaveLength(1);
    expect(delivered[0]?.text).toContain('Подборка готова');
    expect(delivered[0]?.text).not.toContain(phone.slice(2));
    // The link is the button of the message.
    const message = t.fakes.clientTelegram.calls.find(
      (c) => c.method === 'sendMessage' && String(c.payload.chat_id) === chatId,
    );
    const buttons = (
      message?.payload.reply_markup as { inline_keyboard?: { url?: string }[][] } | undefined
    )?.inline_keyboard?.flat();
    expect(buttons?.some((b) => b.url?.startsWith(`${BASE_URL}/p/`))).toBe(true);
    expect(t.fakes.clientTelegram.calls.some((c) => c.method === 'sendPhoto')).toBe(false);
  });

  it('«Закрыть заявку» with a reason; a closed request has only the admin link', async () => {
    const phone = `+79${String(randomInt(0, 1_000_000_000)).padStart(9, '0')}`;
    phones.push(phone);
    const { vinRequestId } = await vinRequest(phone, 0);
    const messageId = await postVinCard(vinRequestId);
    expect(lastRendering(messageId).text).toContain('Фото: нет');
    let before = rec.calls.length;
    await press(buttonData(messageId, 'Закрыть заявку'), { messageId });
    const prompt = promptSince(before);
    before = rec.calls.length;
    await sendText('Дубль заявки', { reply: sentMessageId(prompt) });
    expect(messagesSince(before)).toEqual(['Заявка закрыта']);
    expect(await requestRow(vinRequestId)).toMatchObject({
      status: 'closed',
      closeReason: 'Дубль заявки',
    });
    expect(labels(messageId)).toEqual(['Открыть в админке']);
    expect(lastRendering(messageId).text).toContain('Статус: закрыта');
  });

  it('a VIN code on an order card and an order code on a VIN card are stale', async () => {
    const phone = `+79${String(randomInt(0, 1_000_000_000)).padStart(9, '0')}`;
    phones.push(phone);
    const { vinRequestId } = await vinRequest(phone, 0);
    const vinMessage = await postVinCard(vinRequestId);
    const [vinCard] = await t.deps.db
      .select()
      .from(sellerCards)
      .where(eq(sellerCards.messageId, vinMessage));
    let before = rec.calls.length;
    await press(`a:recheck:${vinRequestId}:${vinCard?.nonce}`, { messageId: vinMessage });
    expect(answersSince(before)).toEqual([STALE_CARD]);

    const seeded = await seed({ status: 'confirmed' });
    const orderMessage = await postCard(seeded.orderId);
    const [orderCard] = await t.deps.db
      .select()
      .from(sellerCards)
      .where(eq(sellerCards.orderId, seeded.orderId));
    before = rec.calls.length;
    await press(`a:vsend:${vinRequestId}:${orderCard?.nonce}`, { messageId: orderMessage });
    expect(answersSince(before)).toEqual([STALE_CARD]);
    expect((await requestRow(vinRequestId)).status).toBe('new');
  });

  it('a stranger pressing a VIN card hears nothing', async () => {
    const phone = `+79${String(randomInt(0, 1_000_000_000)).padStart(9, '0')}`;
    phones.push(phone);
    const { vinRequestId } = await vinRequest(phone, 1);
    const messageId = await postVinCard(vinRequestId);
    const before = rec.calls.length;
    await press(buttonData(messageId, 'Взять в работу'), { from: STRANGER_TG, messageId });
    expect(callsSince(before).map((c) => c.method)).toEqual(['answerCallbackQuery']);
    expect(answersSince(before)).toEqual([undefined]);
    expect((await requestRow(vinRequestId)).status).toBe('new');
  });
});

describe.skipIf(!hasTestDatabase)('seller bot 1C: forceState helper sanity', () => {
  it('a 1B card in ready keeps its buttons and adds «Фото упаковки» last before the admin link', async () => {
    const seeded = await seed({ status: 'confirmed', scheme: 'pay_on_handover' });
    await forceState(t.deps.db, seeded.orderId, { status: 'ready', itemState: 'arrived' });
    const messageId = await postCard(seeded.orderId);
    const names = labels(messageId);
    expect(names.at(-2)).toBe('Фото упаковки');
    expect(names.at(-1)).toBe('Открыть в админке');
    expect(lastRendering(messageId).text).not.toContain(PACKAGING_PHOTO_HINT);
  });
});
