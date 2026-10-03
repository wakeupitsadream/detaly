// Phase 1C through the seller bot on the queues (docs/phase-1c-implementation.md section 9 item
// 6; Verification 1C V4, V5, V7, V8): the real worker (runWorker) on PostgreSQL and Redis, the
// web handlers in-process, YooKassa and SMS on msw, Rossko on fixtures (see harness.ts), plus:
//
// - a memory FileStore and a Telegram file server on the worker's `fetch` (photos sent to the
//   seller bot are downloaded, re-encoded and stored);
// - the client bot API with a recording transport (client notifications in Telegram).
//
// Scenarios:
// - an order: «Фото упаковки» in reply to the card -> «Приехало» goes to the client with the photo
//   -> a booking confirmed with «Подтвердить запись» -> handed -> a claim: «Вернуть деньги» is
//   refused before «Принял возврат» (V8) -> «Принял возврат» with a photo -> «Вернуть деньги» with
//   the answer -> refund_pending -> refund.succeeded -> refunded, refund_full receipt (V7);
// - a VIN request with two photos: the card has no photos and no phone -> an answer with a typo
//   shows the error and no «Отправить» -> fixed -> sent -> the client's SMS has the /p/ link (V4).
import { Writable } from 'node:stream';
import { createLogger, type Logger } from '@detaly/config';
import {
  and,
  asc,
  claims,
  documentVersions,
  eq,
  messengerBindings,
  orderPhotos,
  orders,
  sellerCards,
  vinRequests,
} from '@detaly/db';
import { CALLBACK_DATA_MAX_BYTES } from '@detaly/notify';
import { createMemoryFileStore, type MemoryFileStore } from '@detaly/files';
import { bookInstall, installSlotsForOrder, openClaim } from '@detaly/orders';
import { parseWorkHours } from '@detaly/domain';
import { createVinRequest, newVinRequestId } from '@detaly/vin';
import { Api } from 'grammy';
import type { Update, UserFromGetMe } from 'grammy/types';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runWorker } from '../../src/app';
import { createSellerBot } from '../../src/bots/seller/bot';
import { createSellerCards } from '../../src/bots/seller/cards';
import type { WorkerDeps } from '../../src/deps';
import { hasTestDatabase } from '../fixtures/databases';
import { fakeClientTelegram, type FakeClientTelegram } from '../helpers/test-deps';
import {
  allCallbackData,
  APP_BASE_URL,
  cardActions,
  checkout,
  clientPays,
  createFlowHarness,
  deliverWebhook,
  expectNoSecrets,
  fastForward,
  journal,
  lastRendering,
  OK_LINES,
  openCard,
  orderStatus,
  payloadText,
  payOnline,
  press,
  providerPaymentOf,
  receiptsOf,
  refundsOf,
  settled,
  waitFor,
  waitForStatus,
  type FlowHarness,
  type TgCall,
} from './harness';

const BOT_TOKEN = '123456:flow-1c-test-token-not-real';
const FILE_URL_PREFIX = `https://api.telegram.org/file/bot${BOT_TOKEN}/`;
const DAY = 24 * 60 * 60 * 1000;
/** An 8x8 JPEG (sharp output). */
const JPEG = Buffer.from(
  '/9j/2wBDAAYEBQYFBAYGBQYHBwYIChAKCgkJChQODwwQFxQYGBcUFhYaHSUfGhsjHBYWICwgIyYnKSopGR8tMC0oMCUoKSj/2wBDAQcHBwoIChMKChMoGhYaKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCj/wAARCAAIAAgDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAX/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFAEBAAAAAAAAAAAAAAAAAAAABv/EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAMAwEAAhEDEQA/AKAAcVP/2Q==',
  'base64',
);

const BOT_INFO = {
  id: 7_000_000_013,
  is_bot: true,
  first_name: 'Детали · продавцы',
  username: 'detaly_flow_1c_test_bot',
  can_join_groups: true,
  can_read_all_group_messages: false,
  supports_inline_queries: false,
} as UserFromGetMe;

let h: FlowHarness;
let files: MemoryFileStore;
let client: FakeClientTelegram;
let updateId = 50_000;

/**
 * Starts the worker as harness.start() does, with the phase 1C transports: the memory
 * FileStore, the client bot API and the Telegram file server on deps.fetch. The seller bot's
 * Api answers getFile.
 */
async function startWorker(): Promise<void> {
  const logger: Logger = createLogger('worker', {
    level: 'info',
    destination: new Writable({
      write(chunk, _encoding, callback) {
        h.logs.push(String(chunk));
        callback();
      },
    }),
  });
  const telegramFiles: typeof fetch = async (input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.startsWith(FILE_URL_PREFIX)) {
      return new Response(JPEG, { status: 200, headers: { 'Content-Type': 'image/jpeg' } });
    }
    return h.apis.fetch(input, init);
  };
  const api = new Api(BOT_TOKEN);
  api.config.use(h.tg.transformer);
  let captured: WorkerDeps | null = null;
  const handle = await runWorker({
    env: h.env,
    logger,
    bullPrefix: `${h.prefix}bull`,
    heartbeatKey: `${h.prefix}heartbeat`,
    keyPrefix: h.prefix,
    outboxChannel: `${h.prefix}outbox`,
    exit: () => undefined,
    overrides: {
      rosskoCaller: h.rossko,
      fetch: h.apis.fetch,
      telegram: api,
      sellerCards: (deps) => {
        // runWorker takes no phase 1C transports yet: they are put in before any job runs.
        deps.files = files;
        deps.clientTelegram = client.api;
        deps.fetch = telegramFiles;
        captured = deps;
        return createSellerCards(deps);
      },
    },
  });
  if (captured === null) throw new Error('runWorker did not build WorkerDeps');
  const deps: WorkerDeps = captured;
  const staffTg = new Set([h.sellerTg, h.ownerTg]);
  const bot = createSellerBot({
    token: BOT_TOKEN,
    isStaff: async (id) => staffTg.has(id),
    health: async () => ({ heartbeatAgeSec: 0, dbOk: true, gitSha: 'flow' }),
    botInfo: BOT_INFO,
    sellerChatId: h.sellerChatId,
    logger,
    deps,
  });
  bot.api.config.use(h.tg.transformer);
  // getFile of a photo: the path the file server above serves (installed last: runs first).
  bot.api.config.use(async (prev, method, payload, signal) => {
    if (method === 'getFile') {
      const fileId = String((payload as { file_id: string }).file_id);
      const result = {
        file_id: fileId,
        file_unique_id: `u-${fileId}`,
        file_size: JPEG.byteLength,
        file_path: `photos/${fileId}.jpg`,
      };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return { ok: true, result } as any;
    }
    return prev(method, payload, signal);
  });
  h.worker = { deps, bot, handle };
}

const groupChat = () => ({ id: h.sellerChatId, type: 'supergroup' as const, title: 'Продавцы' });

function replyTo(messageId: number) {
  return {
    reply_to_message: {
      message_id: messageId,
      date: Math.floor(Date.now() / 1000),
      chat: groupChat(),
      from: { ...BOT_INFO },
      text: 'prompt',
    },
  };
}

async function handle(update: Update): Promise<void> {
  const worker = h.worker;
  if (!worker) throw new Error('the worker is not running');
  await worker.bot.handleUpdate(update);
}

async function sendText(text: string, reply: number, from = h.sellerTg): Promise<void> {
  const id = updateId++;
  await handle({
    update_id: id,
    message: {
      message_id: id,
      date: Math.floor(Date.now() / 1000),
      chat: groupChat(),
      from: { id: from, is_bot: false, first_name: 'Продавец' },
      ...replyTo(reply),
      text,
    },
  } as unknown as Update);
}

async function sendPhoto(reply: number, from = h.sellerTg): Promise<void> {
  const id = updateId++;
  await handle({
    update_id: id,
    message: {
      message_id: id,
      date: Math.floor(Date.now() / 1000),
      chat: groupChat(),
      from: { id: from, is_bot: false, first_name: 'Продавец' },
      ...replyTo(reply),
      photo: [{ file_id: `flow-photo-${id}`, file_unique_id: `u${id}`, width: 800, height: 600 }],
    },
  } as unknown as Update);
}

/** Presses a button of a message directly (VIN cards: harness.press looks at order cards). */
async function pressOn(messageId: number, data: string, from = h.sellerTg): Promise<void> {
  const id = updateId++;
  await handle({
    update_id: id,
    callback_query: {
      id: `cb${id}`,
      from: { id: from, is_bot: false, first_name: 'Продавец' },
      chat_instance: 'flow',
      data,
      message: { message_id: messageId, date: Math.floor(Date.now() / 1000), chat: groupChat() },
    },
  } as Update);
}

function lastAnswer(since: number): string | undefined {
  return h.tg.calls
    .slice(since)
    .filter((c) => c.method === 'answerCallbackQuery')
    .map((c) => c.payload.text as string | undefined)
    .at(-1);
}

/** The ForceReply prompt the bot sent after `since`. */
function promptAfter(since: number): number {
  const prompt = h.tg.calls
    .slice(since)
    .filter(
      (c) =>
        c.method === 'sendMessage' &&
        (c.payload.reply_markup as { force_reply?: boolean } | undefined)?.force_reply === true,
    )
    .at(-1);
  if (!prompt) throw new Error('no ForceReply prompt');
  return (prompt.result as { message_id: number }).message_id;
}

function textsAfter(since: number): string[] {
  return h.tg.calls
    .slice(since)
    .filter((c) => c.method === 'sendMessage')
    .map((c) => String(c.payload.text));
}

async function openVinCard(vinRequestId: string): Promise<number> {
  return waitFor(`an open VIN card of ${vinRequestId}`, async () => {
    const [card] = await h.db
      .select({ messageId: sellerCards.messageId })
      .from(sellerCards)
      .where(and(eq(sellerCards.vinRequestId, vinRequestId)))
      .orderBy(asc(sellerCards.createdAt))
      .then((rows) => rows.slice(-1));
    const [open] = await h.db
      .select({ closedAt: sellerCards.closedAt })
      .from(sellerCards)
      .where(eq(sellerCards.messageId, card?.messageId ?? -1));
    return card?.messageId && open?.closedAt === null ? card.messageId : null;
  });
}

function buttonOn(messageId: number, label: string): string {
  const button = lastRendering(h.tg, messageId).buttons.find((b) => b.text.startsWith(label));
  if (!button?.callback_data) throw new Error(`no «${label}» on ${messageId}`);
  return button.callback_data;
}

describe.skipIf(!hasTestDatabase)('phase 1C through the seller bot', () => {
  beforeAll(async () => {
    h = await createFlowHarness('phase1c');
    // Bookings exist only with the installation partner (decision С6).
    h.env.INSTALL_PARTNER_NAME = 'Тестовый сервис';
    h.env.INSTALL_PARTNER_REQUISITES = 'ИП Тестов Т. Т., ИНН 561234567890';
    files = createMemoryFileStore();
    client = fakeClientTelegram();
    await startWorker();
  });
  afterAll(async () => {
    await h?.close();
  });

  it('packaging photo -> arrived with the photo -> booking confirmed -> claim refund (V5, V7, V8)', async () => {
    const order = await checkout(h, OK_LINES, { noShowCount: 2 });
    // The web checkout creates the pickup code; the harness checkout does not.
    await h.db.update(orders).set({ pickupCode: '4821' }).where(eq(orders.id, order.orderId));
    const chatId = String(9_200_000_000 + Math.floor(Math.random() * 1_000_000));
    await h.db.insert(messengerBindings).values({
      userId: order.userId,
      channel: 'telegram',
      externalUserId: chatId,
      chatId,
      isPrimary: true,
      phoneConfirmedAt: new Date(),
    });
    await payOnline(h, order);
    await clientPays(h, await providerPaymentOf(h, order.orderId));
    await waitForStatus(h, order.orderId, 'confirmed');
    await settled(h);
    await press(h, order.orderId, 'recheck');
    await waitForStatus(h, order.orderId, 'ordered_at_supplier');
    await settled(h);

    // The card asks for the packaging photo; the seller answers the card with one.
    const card = await openCard(h, order.orderId);
    expect(lastRendering(h.tg, card).text).toContain(
      'Пришлите фото упаковки ответом на эту карточку',
    );
    expect(await cardActions(h, order.orderId)).toContain('pphoto');
    let since = h.tg.calls.length;
    await sendPhoto(card);
    expect(textsAfter(since)).toEqual(['Фото сохранено']);
    const [packaging] = await h.db
      .select()
      .from(orderPhotos)
      .where(eq(orderPhotos.orderId, order.orderId));
    expect(packaging?.kind).toBe('packaging');
    expect(await files.get(packaging?.s3Key ?? '')).not.toBeNull();

    // «Приехало»: the client's «arrived» waits 2 minutes for the photo, then goes with it.
    const [first, second] = order.itemIds as [string, string];
    await press(h, order.orderId, 'iarr', first);
    await settled(h);
    await press(h, order.orderId, 'iarr', second);
    await waitForStatus(h, order.orderId, 'ready');
    await fastForward(h, order.orderId, 'order');
    await settled(h);
    const arrived = await waitFor('arrived in the client bot', async () =>
      client.calls.find((c) => c.method === 'sendPhoto' && String(c.payload.chat_id) === chatId),
    );
    expect(String(arrived.payload.caption)).toContain(order.number);
    expect(String(arrived.payload.caption)).toContain('Код выдачи: 4821');

    // The client books a slot (the web form / client bot); the seller confirms it in the bot.
    const slots = await installSlotsForOrder(h.db, {
      orderId: order.orderId,
      now: new Date(),
      schedule: parseWorkHours(h.env.PICKUP_HOURS ?? null),
    });
    const slot = slots.slots[0];
    if (!slot) throw new Error(`no install slots: ${slots.reason ?? ''}`);
    const booked = await bookInstall(h.web, {
      orderId: order.orderId,
      slotAt: slot.startAt,
      via: 'web',
      requestKey: newVinRequestId(),
      actor: { type: 'client', id: order.userId },
    });
    if (!booked.ok) throw new Error(`bookInstall: ${booked.reason}`);
    await settled(h);
    const bookingCard = await openCard(h, order.orderId);
    expect(lastRendering(h.tg, bookingCard).text).toContain(
      `Запись на установку: ${slot.dayText} ${slot.timeText} — ждёт подтверждения`,
    );
    const confirmedBefore = client.calls.length;
    await press(h, order.orderId, 'bconf', booked.bookingId);
    await settled(h);
    await waitFor('install_confirmed in the client bot', async () =>
      client.calls
        .slice(confirmedBefore)
        .find(
          (c) =>
            c.method === 'sendMessage' &&
            String(c.payload.chat_id) === chatId &&
            String(c.payload.text).includes(slot.timeText),
        ),
    );

    // At the point: «Клиент пришёл» -> the offset receipt -> «Выдал».
    await press(h, order.orderId, 'came');
    await waitFor('«Выдал» on the card', async () =>
      (await cardActions(h, order.orderId)).includes('handed'),
    );
    await press(h, order.orderId, 'handed');
    await waitForStatus(h, order.orderId, 'handed');
    await settled(h);

    // The client's claim (the /o/<token> form): a defect of the whole order.
    const opened = await openClaim(h.web, {
      orderId: order.orderId,
      kind: 'defect',
      text: 'Течёт, звоните мне',
      photoKeys: [],
      via: 'web',
      requestKey: newVinRequestId(),
      actor: { type: 'client', id: order.userId },
    });
    if (!opened.ok) throw new Error(`openClaim: ${opened.message}`);
    h.web.nudge?.();
    await settled(h);
    const claimCard = await waitFor('the claim on the card', async () => {
      const id = await openCard(h, order.orderId);
      return lastRendering(h.tg, id).text.includes('Претензия: брак') ? id : null;
    });
    expect(lastRendering(h.tg, claimCard).text).not.toContain('Течёт');

    // V8: the seller's «Вернуть деньги» before «Принял возврат» is refused, nothing changes.
    since = h.tg.calls.length;
    await press(h, order.orderId, 'cref', opened.claimId);
    expect(lastAnswer(since)).toBe('Сначала «Принял возврат»');
    expect(await orderStatus(h, order.orderId)).toBe('handed');
    expect(await refundsOf(h, order.orderId)).toEqual([]);

    // «Принял возврат» -> the photo of the returned part.
    since = h.tg.calls.length;
    await press(h, order.orderId, 'cret', opened.claimId);
    await sendPhoto(promptAfter(since));
    const [claim] = await h.db.select().from(claims).where(eq(claims.id, opened.claimId));
    expect(claim?.returnAcceptedAt).not.toBeNull();

    // «Вернуть деньги» -> the answer -> refund_pending -> YooKassa -> refund.succeeded -> refunded.
    h.apis.mock.configure({ refundStatus: 'pending' });
    since = h.tg.calls.length;
    await press(h, order.orderId, 'cref', opened.claimId);
    await sendText('Брак подтвердился — возвращаем деньги на карту', promptAfter(since));
    await waitForStatus(h, order.orderId, 'refund_pending');
    const refund = await waitFor('the refund at YooKassa', async () => {
      const [row] = await refundsOf(h, order.orderId);
      return row?.providerRefundId ? row : null;
    });
    h.apis.mock.setRefundStatus(refund.providerRefundId as string, 'succeeded');
    expect(await deliverWebhook(h, 'refund.succeeded', refund.providerRefundId as string)).toBe(
      200,
    );
    await waitForStatus(h, order.orderId, 'refunded');
    await settled(h);
    h.apis.mock.configure({ refundStatus: 'succeeded' });

    const [refunded] = await refundsOf(h, order.orderId);
    expect(refunded).toMatchObject({ status: 'succeeded', amountKop: order.totalKop });
    // Verification 1C: the refund deadline counts from the client's claim.
    expect(refunded?.deadlineAt?.getTime()).toBe((claim?.openedAt.getTime() ?? 0) + 10 * DAY);
    const receiptRows = await waitFor('the refund receipt', async () => {
      const rows = await receiptsOf(h, order.orderId);
      return rows.some((r) => r.kind === 'refund_full' && r.status === 'succeeded') ? rows : null;
    });
    expect(receiptRows.map((r) => r.kind)).toEqual(
      expect.arrayContaining(['prepayment', 'offset', 'refund_full']),
    );
    const steps = await journal(h, order.orderId);
    expect(steps).toEqual(
      expect.arrayContaining([
        'photo_added',
        'item_arrived:ordered_at_supplier->ready',
        'install_requested',
        'install_confirmed',
        'handed_over:ready->handed',
        'claim_opened',
        'claim_return_accepted',
        'claim_refund_approved:handed->refund_pending',
        'claim_decided',
      ]),
    );
    // The answer text stays in the claim: the client's messages say only «ответ готов».
    expect(client.calls.map((c) => payloadText(c.payload)).join('\n')).not.toContain(
      'Брак подтвердился',
    );
  }, 120_000);

  it('V4: a VIN request with photos -> typo -> error, no «Отправить» -> fixed -> sent -> SMS with /p/', async () => {
    const [doc] = await h.db
      .select({ id: documentVersions.id })
      .from(documentVersions)
      .where(eq(documentVersions.kind, 'consent_pd'))
      .limit(1);
    const phone = `+79${String(Math.floor(Math.random() * 1e9)).padStart(9, '0')}`;
    h.secrets.push(phone, phone.slice(1));
    const id = newVinRequestId();
    const photoKeys = [`vin/${id}/${newVinRequestId()}.jpg`, `vin/${id}/${newVinRequestId()}.jpg`];
    for (const key of photoKeys) await files.put(key, new Uint8Array(JPEG));
    await createVinRequest(h.db, {
      id,
      vin: 'XTA21099043456789',
      carText: 'ВАЗ 2109',
      needText: 'Масляный фильтр',
      phone,
      channel: 'sms',
      photoKeys,
      consent: {
        documentVersionId: doc?.id ?? '',
        textSha256: 'b'.repeat(64),
        ip: null,
        userAgent: null,
      },
      requestKey: newVinRequestId(),
      now: new Date(),
    });
    h.web.nudge?.();
    await settled(h);

    const card = await openVinCard(id);
    const text = lastRendering(h.tg, card).text;
    expect(text).toContain('Фото: 2 (в админке)');
    expect(text).toContain(`Клиент •••${phone.slice(-4)} · ответ: SMS`);

    let since = h.tg.calls.length;
    await pressOn(card, buttonOn(card, 'Ответить строками'));
    await sendText('MANN W9142X 1', promptAfter(since));
    const typo = await openVinCard(id);
    expect(lastRendering(h.tg, typo).text).toContain('✗ 1: MANN W9142X 1');
    expect(lastRendering(h.tg, typo).buttons.map((b) => b.text)).not.toContain('Отправить клиенту');

    since = h.tg.calls.length;
    await pressOn(typo, buttonOn(typo, 'Исправить'));
    await sendText('MANN W914/2 1', promptAfter(since));
    const fixed = await openVinCard(id);
    expect(lastRendering(h.tg, fixed).text).toContain('✓ MANN-FILTER W 914/2 × 1');
    since = h.tg.calls.length;
    await pressOn(fixed, buttonOn(fixed, 'Отправить клиенту'));
    expect(lastAnswer(since)).toBe('Подборка отправлена клиенту (SMS)');
    await settled(h);

    const [row] = await h.db.select().from(vinRequests).where(eq(vinRequests.id, id));
    expect(row).toMatchObject({ status: 'offered', proposalCount: 1 });
    const sms = await waitFor('the proposal SMS', async () =>
      h.apis.sms.find((m) => m.number === phone.slice(1) && m.text.includes('/p/')),
    );
    expect(sms.text).toContain(`${APP_BASE_URL}/p/`);
  }, 90_000);

  it('no full phone, token or VIN photo in Telegram and the logs; callback_data within 64 bytes', () => {
    expectNoSecrets(h);
    for (const data of allCallbackData(h.tg)) {
      expect(Buffer.byteLength(data)).toBeLessThanOrEqual(CALLBACK_DATA_MAX_BYTES);
    }
    // The seller bot never sends a photo (VIN and claim photos stay in the admin).
    const photos = h.tg.calls.filter((c: TgCall) => c.method === 'sendPhoto');
    expect(photos).toEqual([]);
    const logs = h.logs.join('');
    expect(logs).not.toContain(BOT_TOKEN);
    expect(logs).not.toContain('XTA21099043456789');
    expect(logs).not.toContain('Течёт');
  });
});
