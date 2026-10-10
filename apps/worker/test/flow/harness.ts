// End-to-end harness of the queue flow tests (docs/phase-1b-implementation.md section 16): the
// real worker composition (runWorker: WorkerDeps, Workers, the outbox dispatcher, the Job
// Schedulers, graceful shutdown) on the real PostgreSQL 16 and Redis 7, with every external
// system replaced in-process:
//
// - YooKassa: the msw emulation of @detaly/payments/testing, reached through the injected
//   `fetch` (msw `getResponse`, no socket interception: msw 3 would break the Postgres and Redis
//   connections), with a test hook that can "crash" right after YooKassa answered;
// - SMS Aero: an msw handler on the same `fetch`;
// - Rossko: the bundled fixture caller; GetCheckout answers GetCheckout.itemErrors when the
//   W 914/2 line is in the request and GetCheckout.ok otherwise;
// - Telegram: grammY with a replaced transport (deps.telegram and the seller bot's Api record
//   every call); button presses are fed with bot.handleUpdate.
//
// The web side runs the real web handlers in-process: POST /api/orders/<token>/pay,
// POST /api/orders/<token>/actions and POST /api/webhooks/yookassa (with X-Real-IP from the
// allowlist), each with its own engine deps whose nudge PUBLISHes to the worker's channel.
//
// Every file gets its own database `${DATABASE_URL_TEST}_worker_<suffix>` (the dispatcher and
// the housekeeping timers act on every row of their database) and Redis keys, BullMQ queues and
// the outbox channel under `test:<uuid>:`.
import { randomBytes, randomInt } from 'node:crypto';
import { Writable } from 'node:stream';
import {
  createLogger,
  createRedis,
  parseEnv,
  type Env,
  type Logger,
  type QueueName,
  type Redis,
} from '@detaly/config';
import {
  deleteKeysByPrefix,
  minimalEnvSource,
  testKeyPrefix,
  testRedisUrl,
} from '@detaly/config/testing';
import {
  and,
  asc,
  createDb,
  desc,
  eq,
  isNull,
  notifications,
  orderEvents,
  orderItems,
  orders,
  outbox,
  payments,
  receipts,
  refunds,
  sellerCards,
  sql,
  staff,
  supplierOrders,
  users,
  type Db,
} from '@detaly/db';
import { resolveTransition, type Offer, type TransitionContext } from '@detaly/domain';
import { parseCallbackData } from '@detaly/notify';
import {
  loadOrderSettings,
  loadOrderSnapshot,
  persistTransition,
  type EngineDeps,
} from '@detaly/orders';
import { createYooKassaProvider } from '@detaly/payments';
import { createYooKassaMock, type YooKassaMock } from '@detaly/payments/testing';
import {
  createFixtureCaller,
  createRosskoClient,
  createUnlimitedLimiter,
  FIXTURE_LOCAL_STOCK_IDS,
  type RosskoCaller,
  type RosskoMethod,
} from '@detaly/rossko';
import { Api, InputFile, type Bot, type Transformer } from 'grammy';
import type { Update, UserFromGetMe } from 'grammy/types';
import { getResponse, http, HttpResponse } from 'msw';
import { expect } from 'vitest';
import { handleAdminAction } from '../../../web/src/server/admin/actions-handler';
import { handleOrderAction } from '../../../web/src/server/orders/actions-handler';
import { handlePayRequest } from '../../../web/src/server/payments/pay-handler';
import { handleYooKassaWebhook } from '../../../web/src/server/payments/webhook-handler';
import { runWorker } from '../../src/app';
import { createSellerBot } from '../../src/bots/seller/bot';
import { createSellerCards } from '../../src/bots/seller/cards';
import { isSchedulerJob } from '../../src/dead-letter';
import type { WorkerDeps } from '../../src/deps';
import type { ShutdownHandle } from '../../src/shutdown';
import { prepareOwnDatabase } from '../fixtures/databases';

export const APP_BASE_URL = 'https://detaly.flow.test';
export const YOOKASSA_API = 'https://api.yookassa.ru/v3';
export const SMS_API = 'https://sms.flow.test/v2';
const SHOP = { shopId: 'flow-shop', secretKey: 'flow-secret' } as const;
const BOT_TOKEN = '123456:flow-test-token-not-real';
const ADMIN_BASIC_AUTH = 'admin:flow-admin-password';
/** A YooKassa notification address (inside YOOKASSA_WEBHOOK_IP_ALLOWLIST below). */
const YOOKASSA_IP = '185.71.76.10';

const BOT_INFO = {
  id: 7_000_000_003,
  is_bot: true,
  first_name: 'Детали · продавцы',
  username: 'detaly_flow_test_bot',
  can_join_groups: true,
  can_read_all_group_messages: false,
  supports_inline_queries: false,
} as UserFromGetMe;

// ---------------------------------------------------------------------------------------------
// Telegram
// ---------------------------------------------------------------------------------------------

export interface TgCall {
  method: string;
  payload: Record<string, unknown>;
  result: unknown;
}

export interface TgButton {
  text: string;
  callback_data?: string;
  url?: string;
}

/** One recorder for deps.telegram and the bot's Api: one chat, one message id sequence. */
export function telegramRecorder() {
  const calls: TgCall[] = [];
  let nextMessageId = 9000;
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
    calls.push({ method, payload: p, result });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return { ok: true, result } as any;
  };
  return { calls, transformer };
}

export type TelegramRecorder = ReturnType<typeof telegramRecorder>;

function keyboardOf(call: TgCall): TgButton[] {
  const markup = call.payload.reply_markup as { inline_keyboard?: TgButton[][] } | undefined;
  return (markup?.inline_keyboard ?? []).flat();
}

/** The last rendering (send or edit) of a message: its text and buttons. */
export function lastRendering(
  tg: TelegramRecorder,
  messageId: number,
): { text: string; buttons: TgButton[] } {
  for (let i = tg.calls.length - 1; i >= 0; i -= 1) {
    const call = tg.calls[i] as TgCall;
    const sentId = (call.result as { message_id?: number } | null)?.message_id;
    if (call.method === 'sendMessage' && sentId === messageId) {
      return { text: String(call.payload.text), buttons: keyboardOf(call) };
    }
    if (call.method === 'editMessageText' && call.payload.message_id === messageId) {
      return { text: String(call.payload.text), buttons: keyboardOf(call) };
    }
    if (call.method === 'editMessageReplyMarkup' && call.payload.message_id === messageId) {
      // Keyboard only: the text stays the one of the previous rendering.
      const before = lastRenderingBefore(tg, messageId, i);
      return { text: before.text, buttons: keyboardOf(call) };
    }
  }
  throw new Error(`message ${messageId} was never sent`);
}

function lastRenderingBefore(
  tg: TelegramRecorder,
  messageId: number,
  index: number,
): { text: string } {
  for (let i = index - 1; i >= 0; i -= 1) {
    const call = tg.calls[i] as TgCall;
    const sentId = (call.result as { message_id?: number } | null)?.message_id;
    if (
      (call.method === 'sendMessage' && sentId === messageId) ||
      (call.method === 'editMessageText' && call.payload.message_id === messageId)
    ) {
      return { text: String(call.payload.text) };
    }
  }
  return { text: '' };
}

/** Every callback_data of every inline button the bot ever sent or drew. */
export function allCallbackData(tg: TelegramRecorder): string[] {
  return tg.calls.flatMap((call) =>
    keyboardOf(call)
      .map((b) => b.callback_data)
      .filter((d): d is string => typeof d === 'string'),
  );
}

/** A Bot API payload as text (files, e.g. the QR photo, become `[file]`). */
export function payloadText(payload: Record<string, unknown>): string {
  // InputFile.toJSON throws (before any replacer runs): files are swapped out first.
  const plain = Object.fromEntries(
    Object.entries(payload).map(([key, value]) => [
      key,
      value instanceof InputFile ? '[file]' : value,
    ]),
  );
  return JSON.stringify(plain);
}

// ---------------------------------------------------------------------------------------------
// Rossko
// ---------------------------------------------------------------------------------------------

function partsOf(args: Record<string, unknown>): Record<string, unknown>[] {
  const parts = (args.PARTS as { Part?: unknown } | undefined)?.Part;
  return (Array.isArray(parts) ? parts : parts ? [parts] : []) as Record<string, unknown>[];
}

export interface FlowRossko extends RosskoCaller {
  calls: { method: RosskoMethod; args: Record<string, unknown> }[];
  count(method: RosskoMethod): number;
}

/** Fixture caller: GetCheckout.itemErrors when W 914/2 is requested, GetCheckout.ok otherwise. */
export function flowRossko(): FlowRossko {
  const ok = createFixtureCaller({ checkoutVariant: 'ok' });
  const itemErrors = createFixtureCaller({ checkoutVariant: 'itemErrors' });
  const calls: FlowRossko['calls'] = [];
  return {
    calls,
    count: (method) => calls.filter((c) => c.method === method).length,
    async call(method, args) {
      calls.push({ method, args });
      const refused = partsOf(args).some((p) => String(p.partnumber) === 'W 914/2');
      return (method === 'GetCheckout' && refused ? itemErrors : ok).call(method, args);
    },
  };
}

// ---------------------------------------------------------------------------------------------
// YooKassa and SMS over one fetch
// ---------------------------------------------------------------------------------------------

export interface SmsMessage {
  number: string;
  text: string;
}

export interface CrashHook {
  /** `POST /payments`, `POST /receipts` ... (path below /v3). */
  path: string;
  /** Called with the request body: true -> the answer is dropped and fetch throws. */
  when?: (body: Record<string, unknown> | null) => boolean;
  times: number;
}

export function externalApis() {
  // POST /receipts registers at once unless a test asks for `pending` (mock.configure).
  const mock: YooKassaMock = createYooKassaMock({
    ...SHOP,
    apiUrl: YOOKASSA_API,
    receiptStatus: 'succeeded',
  });
  const sms: SmsMessage[] = [];
  const crashes: CrashHook[] = [];
  const smsHandlers = [
    http.get(`${SMS_API}/sms/send`, ({ request }) => {
      const url = new URL(request.url);
      sms.push({
        number: url.searchParams.get('number') ?? '',
        text: url.searchParams.get('text') ?? '',
      });
      return HttpResponse.json({ success: true, data: { id: sms.length, cost: '3.69' } });
    }),
  ];
  const handlers = [...mock.handlers, ...smsHandlers];
  const fetchImpl: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const key = `${request.method} ${url.pathname.replace(/^\/v3/u, '')}`;
    const crash = url.href.startsWith(YOOKASSA_API)
      ? crashes.find((c) => c.path === key && c.times > 0)
      : undefined;
    let body: Record<string, unknown> | null = null;
    if (crash?.when && request.method === 'POST') {
      body = (await request.clone().json()) as Record<string, unknown>;
    }
    const response = await getResponse(handlers, request);
    if (response === undefined) throw new Error(`unhandled external request ${url.origin}`);
    if (response.type === 'error') throw new TypeError('fetch failed');
    if (crash && (!crash.when || crash.when(body))) {
      // YooKassa did the work; the caller never learns it ("crash" after the answer).
      crash.times -= 1;
      throw new TypeError('fetch failed: test hook after the YooKassa answer');
    }
    return response;
  };
  return {
    mock,
    sms,
    fetch: fetchImpl,
    crashAfterAnswer(hook: CrashHook) {
      crashes.push(hook);
    },
  };
}

export type ExternalApis = ReturnType<typeof externalApis>;

// ---------------------------------------------------------------------------------------------
// The harness
// ---------------------------------------------------------------------------------------------

export interface RunningWorker {
  deps: WorkerDeps;
  bot: Bot;
  handle: ShutdownHandle;
}

export interface OrderLine {
  article: string;
  brand: string;
  stockId: string;
  qty: number;
}

export interface FlowOrder {
  orderId: string;
  number: string;
  token: string;
  phone: string;
  userId: string;
  itemIds: string[];
  totalKop: number;
}

/** Lines of GetCheckout.ok: both from the Orenburg stock. */
export const OK_LINES: OrderLine[] = [
  { article: 'OC90', brand: 'Knecht', stockId: 'ORB1', qty: 2 },
  { article: 'GDB1330', brand: 'TRW', stockId: 'ORB1', qty: 1 },
];

/** Lines of GetCheckout.itemErrors: OC 90 is ordered, W 914/2 is refused. */
export const ITEM_ERROR_LINES: OrderLine[] = [
  { article: 'OC90', brand: 'Knecht', stockId: 'MSK7', qty: 1 },
  { article: 'W9142', brand: 'MANN-FILTER', stockId: 'MSK7', qty: 1 },
];

/** Unscaled fixture offers for building orders (no cache, no limiter, no checkout). */
const plainRossko = createRosskoClient({
  caller: createFixtureCaller(),
  key1: 'k1',
  key2: 'k2',
  deliveryId: 'fx-delivery',
  paymentId: 'fx-payment',
  localStockIds: FIXTURE_LOCAL_STOCK_IDS,
  limiter: createUnlimitedLimiter(),
  allowCheckout: false,
});

async function fixtureOffer(line: OrderLine): Promise<Offer> {
  const { offers } = await plainRossko.search(line.article);
  const offer = offers.find(
    (o) =>
      o.brand === line.brand && o.stock.stockId === line.stockId && o.articleNorm === line.article,
  );
  if (!offer) throw new Error(`no fixture offer ${line.brand} ${line.article} @${line.stockId}`);
  return offer;
}

/** The default markup (28%) rounded up to the rouble, as the cart computes it. */
function clientPrice(supplierKop: number): number {
  return Math.ceil((supplierKop * 12_800) / 1_000_000) * 100;
}

function randomPhone(): string {
  return `+79${String(randomInt(0, 1_000_000_000)).padStart(9, '0')}`;
}

/** Captured log lines (JSON) of the worker and the web handlers. */
function logSink(lines: string[]): Writable {
  return new Writable({
    write(chunk, _encoding, callback) {
      lines.push(String(chunk));
      callback();
    },
  });
}

export interface FlowHarness {
  env: Env;
  db: Db;
  redis: Redis;
  prefix: string;
  apis: ExternalApis;
  rossko: FlowRossko;
  tg: TelegramRecorder;
  sellerChatId: number;
  sellerTg: number;
  ownerTg: number;
  logs: string[];
  /** Phones and tokens used by the test (never allowed in logs or Telegram). */
  secrets: string[];
  /** Engine deps of the "web" process. */
  web: EngineDeps;
  webLogger: Logger;
  worker: RunningWorker | null;
  start(): Promise<RunningWorker>;
  stop(): Promise<void>;
  close(): Promise<void>;
}

export async function createFlowHarness(suffix: string): Promise<FlowHarness> {
  const url = await prepareOwnDatabase(suffix);
  if (!url) throw new Error('DATABASE_URL_TEST is not set: eval "$(scripts/dev-db.sh env)"');
  const prefix = testKeyPrefix();
  const sellerChatId = -100_888_000_000 - randomInt(0, 1_000_000);
  const sellerTg = 8_200_000_000 + randomInt(0, 1_000_000);
  const ownerTg = sellerTg + 1;
  const env = parseEnv(
    minimalEnvSource({
      DATABASE_URL: url,
      REDIS_URL: testRedisUrl(),
      APP_BASE_URL,
      YOOKASSA_SHOP_ID: SHOP.shopId,
      YOOKASSA_SECRET_KEY: SHOP.secretKey,
      YOOKASSA_API_URL: YOOKASSA_API,
      YOOKASSA_VAT_CODE: '1',
      YOOKASSA_TAX_SYSTEM_CODE: '2',
      YOOKASSA_WEBHOOK_IP_ALLOWLIST: '185.71.76.0/27,185.71.77.0/27',
      TRUSTED_IP_HEADER: 'x-real-ip',
      ROSSKO_MODE: 'fixtures',
      ROSSKO_ALLOW_CHECKOUT: 'true',
      ROSSKO_DELIVERY_ID: 'fx-delivery',
      ROSSKO_PAYMENT_ID: 'fx-payment',
      SMS_PROVIDER: 'smsaero',
      SMS_LOGIN: 'shop@example.test',
      SMS_API_KEY: 'flow-sms-key',
      SMS_SENDER: 'Detali',
      SMS_API_URL: SMS_API,
      // Empty: runWorker does not long-poll Telegram; the test drives its own bot instance.
      TG_SELLER_BOT_TOKEN: '',
      TG_SELLER_CHAT_ID: String(sellerChatId),
      PICKUP_ADDRESS: 'г. Оренбург, ул. Тестовая, 1',
      PICKUP_HOURS: 'Пн–Пт 10:00–19:00',
      ADMIN_BASIC_AUTH,
      LOG_LEVEL: 'info',
    }),
  );
  const db = createDb(url, { max: 6 });
  const redis = createRedis(testRedisUrl());
  const webRedis = createRedis(testRedisUrl());
  const outboxChannel = `${prefix}outbox`;
  const apis = externalApis();
  const rossko = flowRossko();
  const tg = telegramRecorder();
  const logs: string[] = [];
  const logger = createLogger('worker', { level: 'info', destination: logSink(logs) });
  const webLogger = createLogger('web', { level: 'info', destination: logSink(logs) });

  // Staff of this run (random Telegram ids; the rows stay in the file's own database).
  await db.insert(staff).values([
    { name: 'Продавец (flow)', role: 'seller', tgUserId: sellerTg },
    { name: 'Владелец (flow)', role: 'owner', tgUserId: ownerTg },
  ]);
  const staffTg = new Set([sellerTg, ownerTg]);

  const web: EngineDeps = {
    db,
    env,
    nudge: () => {
      webRedis.publish(outboxChannel, '1').catch(() => undefined);
    },
  };

  const harness: FlowHarness = {
    env,
    db,
    redis,
    prefix,
    apis,
    rossko,
    tg,
    sellerChatId,
    sellerTg,
    ownerTg,
    logs,
    secrets: [],
    web,
    webLogger,
    worker: null,
    async start() {
      if (harness.worker) throw new Error('the worker is already running');
      const api = new Api(BOT_TOKEN);
      api.config.use(tg.transformer);
      let captured: WorkerDeps | null = null;
      const handle = await runWorker({
        env,
        logger,
        bullPrefix: `${prefix}bull`,
        heartbeatKey: `${prefix}heartbeat`,
        keyPrefix: prefix,
        outboxChannel,
        exit: () => undefined,
        overrides: {
          rosskoCaller: rossko,
          fetch: apis.fetch,
          telegram: api,
          sellerCards: (deps) => {
            captured = deps;
            return createSellerCards(deps);
          },
        },
      });
      if (captured === null) throw new Error('runWorker did not build WorkerDeps');
      const deps: WorkerDeps = captured;
      const bot = createSellerBot({
        token: BOT_TOKEN,
        isStaff: async (id) => staffTg.has(id),
        health: async () => ({ heartbeatAgeSec: 0, dbOk: true, gitSha: 'flow' }),
        botInfo: BOT_INFO,
        sellerChatId,
        logger,
        deps,
      });
      bot.api.config.use(tg.transformer);
      harness.worker = { deps, bot, handle };
      return harness.worker;
    },
    async stop() {
      const running = harness.worker;
      if (!running) return;
      harness.worker = null;
      await running.handle.shutdown('SIGTERM');
      running.handle.uninstall();
    },
    async close() {
      await harness.stop();
      await deleteKeysByPrefix(redis, prefix);
      await redis.quit();
      await webRedis.quit();
      await db.close();
    },
  };
  return harness;
}

// ---------------------------------------------------------------------------------------------
// Waiting
// ---------------------------------------------------------------------------------------------

export async function waitFor<T>(
  what: string,
  probe: () => Promise<T | null | undefined | false>,
  timeoutMs = 20_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown = null;
  for (;;) {
    try {
      const value = await probe();
      if (value !== null && value !== undefined && value !== false) return value;
    } catch (error) {
      last = error;
    }
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${what}${last ? `: ${String(last)}` : ''}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

const WORK_QUEUES: QueueName[] = ['payments', 'receipts', 'rossko', 'notify'];

/**
 * Nothing left to do: every due outbox row dispatched and the work queues without waiting,
 * active, prioritized or delayed jobs (housekeeping and reconciliation keep their schedulers;
 * since step 8 the rossko queue keeps one too — the next run of rossko/poll-orders is not work).
 */
export async function settled(h: FlowHarness, timeoutMs = 20_000): Promise<void> {
  const worker = h.worker;
  if (!worker) throw new Error('the worker is not running');
  await waitFor(
    'the outbox and the queues to drain',
    async () => {
      const [due] = await h.db
        .select({ n: sql<number>`count(*)::int` })
        .from(outbox)
        .where(and(isNull(outbox.dispatchedAt), sql`${outbox.availableAt} <= now()`));
      if ((due?.n ?? 0) > 0) return false;
      for (const name of WORK_QUEUES) {
        const queue = worker.deps.queues[name];
        const counts = await queue.getJobCounts(
          'waiting',
          'active',
          'prioritized',
          'waiting-children',
        );
        if (Object.values(counts).some((n) => n > 0)) return false;
        const delayed = await queue.getDelayed();
        if (delayed.some((job) => !isSchedulerJob(job))) return false;
      }
      const hk = await worker.deps.queues.housekeeping.getJobCounts('active', 'waiting');
      return Object.values(hk).every((n) => n === 0);
    },
    timeoutMs,
  );
}

// ---------------------------------------------------------------------------------------------
// The client: checkout, web pay, web actions, YooKassa webhooks
// ---------------------------------------------------------------------------------------------

/**
 * Checkout as web does it (checkout-service.ts): user, order in draft, items with the offer
 * snapshot, then the state machine decides (resolveTransition 'checkout') and persistTransition
 * writes the status, expires_at, the journal and the client notification in one transaction.
 * The consent rows of 1A are not written (hasPdConsent is a fact here).
 */
export async function checkout(
  h: FlowHarness,
  lines: readonly OrderLine[],
  options: { noShowCount?: number } = {},
): Promise<FlowOrder> {
  const phone = randomPhone();
  const token = randomBytes(32).toString('base64url');
  h.secrets.push(phone, phone.slice(1), token);
  const offers = await Promise.all(lines.map(fixtureOffer));
  const rows = lines.map((line, i) => {
    const offer = offers[i] as Offer;
    return {
      offerKey: `${offer.articleNorm}:${offer.brand}:${offer.stock.stockId}`,
      searchArticleNorm: line.article,
      brand: offer.brand,
      article: offer.article,
      name: offer.name,
      qty: line.qty,
      stockId: offer.stock.stockId,
      isLocal: offer.stock.isLocal,
      priceSupplierAtOrderKop: offer.priceSupplierKop,
      priceClientKop: clientPrice(offer.priceSupplierKop),
      markupBp: 2800,
      etaDate: '2026-10-08',
      offerSnapshot: offer,
      state: 'pending' as const,
    };
  });
  const totalKop = rows.reduce((sum, r) => sum + r.priceClientKop * r.qty, 0);
  const marginKop = rows.reduce(
    (sum, r) => sum + (r.priceClientKop - r.priceSupplierAtOrderKop) * r.qty,
    0,
  );
  const allItemsLocal = rows.every((r) => r.isLocal);
  const settings = await loadOrderSettings(h.db, h.env);

  return h.db
    .transaction(async (tx) => {
      const [user] = await tx
        .insert(users)
        .values({ phone, noShowCount: options.noShowCount ?? 0 })
        .returning({ id: users.id, noShowCount: users.noShowCount });
      const { id: userId, noShowCount } = user as { id: string; noShowCount: number };
      const ctx: TransitionContext = {
        actor: 'client',
        hasPdConsent: true,
        allItemsLocal,
        totalKop,
        minOrderTotalKop: settings.minOrderTotalKop,
        orderMarginKop: marginKop,
        minMarginKop: settings.minMarginKop,
        onPickupMaxTotalKop: settings.onPickupMaxTotalKop,
        noShowCount,
        noShowLimit: settings.noShowLimit,
        fulfillment: 'pickup',
      };
      const resolved = resolveTransition('draft', 'checkout', ctx);
      if (!resolved.ok) throw new Error(`checkout: ${resolved.reason}`);
      const scheme = resolved.rule.to === 'awaiting_payment' ? 'prepay' : 'pay_on_handover';
      const [order] = await tx
        .insert(orders)
        .values({
          userId,
          accessToken: token,
          status: 'draft',
          paymentScheme: scheme,
          subtotalKop: totalKop,
          courierFeeKop: 0,
          totalKop,
          itemsHash: 'flow',
        })
        .returning({ id: orders.id, number: orders.number });
      const { id: orderId, number } = order as { id: string; number: string };
      const items = await tx
        .insert(orderItems)
        .values(rows.map((r) => ({ ...r, orderId })))
        .returning({ id: orderItems.id });
      const snapshot = await loadOrderSnapshot(tx, orderId, { lock: true });
      if (!snapshot) throw new Error('no snapshot');
      await persistTransition(
        tx,
        snapshot,
        { rule: resolved.rule, ctx, changes: [] },
        {
          deps: h.web,
          orderId,
          event: 'checkout',
          actor: { type: 'client', id: userId },
          payload: { part: 'all', scheme, items: rows.length },
        },
      );
      return {
        orderId,
        number,
        token,
        phone,
        userId,
        itemIds: items.map((i) => i.id),
        totalKop,
      };
    })
    .finally(() => h.web.nudge?.());
}

const SAME_ORIGIN = { Origin: APP_BASE_URL };

/** «Оплатить N ₽»: web POST /api/orders/<token>/pay; returns the 303 Location. */
export async function payOnline(h: FlowHarness, order: FlowOrder): Promise<string> {
  const response = await handlePayRequest(
    new Request(`${APP_BASE_URL}/api/orders/${order.token}/pay`, {
      method: 'POST',
      headers: { ...SAME_ORIGIN, Accept: 'text/html' },
    }),
    order.token,
    {
      engine: h.web,
      payments: createYooKassaProvider({ ...SHOP, apiUrl: YOOKASSA_API, fetch: h.apis.fetch }),
      appBaseUrl: APP_BASE_URL,
      logger: h.webLogger,
    },
  );
  expect(response.status).toBe(303);
  return response.headers.get('location') ?? '';
}

/** The YooKassa notification as POSTed to web (from an allowlisted address). */
export async function deliverWebhook(
  h: FlowHarness,
  event: string,
  objectId: string,
): Promise<number> {
  const response = await handleYooKassaWebhook(
    new Request(`${APP_BASE_URL}/api/webhooks/yookassa`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Real-IP': YOOKASSA_IP },
      body: JSON.stringify(h.apis.mock.notification(event, objectId)),
    }),
    { db: h.db, env: h.env, nudge: h.web.nudge, logger: h.webLogger },
  );
  return response.status;
}

/** The client paid on the YooKassa page: the payment succeeds and YooKassa notifies web. */
export async function clientPays(h: FlowHarness, providerPaymentId: string): Promise<void> {
  h.apis.mock.setPaymentStatus(providerPaymentId, 'succeeded');
  expect(await deliverWebhook(h, 'payment.succeeded', providerPaymentId)).toBe(200);
}

/** A client decision on /o/<token>: web POST /api/orders/<token>/actions. */
export async function clientAction(
  h: FlowHarness,
  order: FlowOrder,
  action: string,
  extra: Record<string, string> = {},
): Promise<number> {
  const response = await handleOrderAction(
    new Request(`${APP_BASE_URL}/api/orders/${order.token}/actions`, {
      method: 'POST',
      headers: { ...SAME_ORIGIN, 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, ...extra }),
    }),
    order.token,
    {
      engine: h.web,
      redis: h.redis,
      keyPrefix: h.prefix,
      appBaseUrl: APP_BASE_URL,
      logger: h.webLogger,
    },
  );
  return response.status;
}

/**
 * A button of the admin card (/admin/orders/<id>, Basic auth): web POST
 * /api/admin/orders/<id>/actions, the same engine action as the bot. Returns the status (303).
 */
export async function adminAction(
  h: FlowHarness,
  orderId: string,
  action: string,
  fields: Record<string, string> = {},
): Promise<number> {
  const auth = Buffer.from(ADMIN_BASIC_AUTH).toString('base64');
  const response = await handleAdminAction(
    new Request(`${APP_BASE_URL}/api/admin/orders/${orderId}/actions`, {
      method: 'POST',
      headers: {
        ...SAME_ORIGIN,
        Authorization: `Basic ${auth}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ action, ...fields }).toString(),
    }),
    orderId,
    { engine: h.web, logger: h.webLogger },
  );
  return response.status;
}

/** The provider payment id of the order's latest payment (waits until it is known). */
export async function providerPaymentOf(h: FlowHarness, orderId: string): Promise<string> {
  return waitFor(`the provider payment of ${orderId}`, async () => {
    const snapshot = await loadOrderSnapshot(h.db, orderId, { lock: false });
    return snapshot?.payments.at(-1)?.providerPaymentId ?? null;
  });
}

// ---------------------------------------------------------------------------------------------
// The seller: cards and presses
// ---------------------------------------------------------------------------------------------

let updateId = 1;

/** The open order card of the order in the sellers chat (its Telegram message id). */
export async function openCard(h: FlowHarness, orderId: string): Promise<number> {
  return waitFor(`an open seller card of ${orderId}`, async () => {
    const [card] = await h.db
      .select({ messageId: sellerCards.messageId })
      .from(sellerCards)
      .where(
        and(
          eq(sellerCards.orderId, orderId),
          eq(sellerCards.kind, 'order'),
          isNull(sellerCards.closedAt),
        ),
      )
      .orderBy(desc(sellerCards.createdAt))
      .limit(1);
    return card?.messageId ?? null;
  });
}

/** Codes of the buttons on the order's current card. */
export async function cardActions(h: FlowHarness, orderId: string): Promise<string[]> {
  const messageId = await openCard(h, orderId);
  return lastRendering(h.tg, messageId)
    .buttons.map((b) => (b.callback_data ? parseCallbackData(b.callback_data)?.action : null))
    .filter((a): a is NonNullable<typeof a> => a !== null && a !== undefined);
}

/**
 * Presses the button `code` (for `targetId`: the order or one of its items) on the order's
 * current card, as the seller (or the owner). Waits until the card shows the button.
 */
export async function press(
  h: FlowHarness,
  orderId: string,
  code: string,
  targetId: string = orderId,
  from: number = h.sellerTg,
): Promise<void> {
  const worker = h.worker;
  if (!worker) throw new Error('the worker is not running');
  const find = async () => {
    const id = await openCard(h, orderId);
    const button = lastRendering(h.tg, id).buttons.find((b) =>
      b.callback_data?.startsWith(`a:${code}:${targetId}:`),
    );
    return button?.callback_data ? { messageId: id, data: button.callback_data } : null;
  };
  // Transitions made by the queues (recheck, GetCheckout, payments, receipts, timers) redraw
  // the open card themselves: no press is needed to see the buttons of the new status.
  const { messageId, data } = await waitFor(`button ${code} on the card of ${orderId}`, find);
  const id = updateId++;
  await worker.bot.handleUpdate({
    update_id: id,
    callback_query: {
      id: `cb${id}`,
      from: { id: from, is_bot: false, first_name: 'Продавец' },
      chat_instance: 'flow',
      data,
      message: {
        message_id: messageId,
        date: Math.floor(Date.now() / 1000),
        chat: { id: h.sellerChatId, type: 'supergroup', title: 'Продавцы' },
      },
    },
  } as Update);
}

// ---------------------------------------------------------------------------------------------
// Reading back
// ---------------------------------------------------------------------------------------------

export async function orderStatus(h: FlowHarness, orderId: string): Promise<string> {
  const [row] = await h.db
    .select({ status: orders.status })
    .from(orders)
    .where(eq(orders.id, orderId));
  return row?.status ?? 'missing';
}

export async function waitForStatus(
  h: FlowHarness,
  orderId: string,
  status: string,
  timeoutMs = 20_000,
): Promise<void> {
  await waitFor(
    `order ${orderId} to reach ${status}`,
    async () => (await orderStatus(h, orderId)) === status,
    timeoutMs,
  );
}

export async function eventsOf(h: FlowHarness, orderId: string) {
  return h.db
    .select()
    .from(orderEvents)
    .where(eq(orderEvents.orderId, orderId))
    .orderBy(asc(orderEvents.createdAt), asc(orderEvents.id));
}

/** `type` or `type:from->to` for transitions, in journal order. */
export async function journal(h: FlowHarness, orderId: string): Promise<string[]> {
  return (await eventsOf(h, orderId)).map((e) =>
    e.fromStatus !== null && e.toStatus !== null && e.fromStatus !== e.toStatus
      ? `${e.type}:${e.fromStatus}->${e.toStatus}`
      : e.type,
  );
}

/** notifications rows of the order's journal events (dedupe_key `<order_event_id>:…`). */
export async function notificationsOf(h: FlowHarness, orderId: string) {
  return h.db
    .select()
    .from(notifications)
    .where(
      sql`split_part(${notifications.dedupeKey}, ':', 1) in (
        select ${orderEvents.id}::text from ${orderEvents} where ${orderEvents.orderId} = ${orderId})`,
    )
    .orderBy(asc(notifications.createdAt), asc(notifications.dedupeKey));
}

/** No phone number or order token of the run in the logs, Telegram or SMS texts. */
export function expectNoSecrets(h: FlowHarness): void {
  const logs = h.logs.join('');
  const telegram = h.tg.calls.map((c) => payloadText(c.payload)).join('\n');
  const sms = h.apis.sms.map((m) => m.text).join('\n');
  for (const secret of h.secrets) {
    expect(logs.includes(secret), 'a phone or an order token in the logs').toBe(false);
    expect(telegram.includes(secret), 'a phone or an order token in Telegram').toBe(false);
  }
  // SMS carry the /o/<token> link by design (confirm_request, decision_needed, arrived): only
  // the phone itself must never be in their text.
  for (const phone of h.secrets.filter((s) => /^\+?79\d{9}$/u.test(s))) {
    expect(sms.includes(phone), 'a phone in an SMS text').toBe(false);
  }
  expect(/\+79\d{9}/u.test(logs), 'a +79… number in the logs').toBe(false);
}

export async function receiptsOf(h: FlowHarness, orderId: string) {
  return h.db
    .select()
    .from(receipts)
    .where(eq(receipts.orderId, orderId))
    .orderBy(asc(receipts.createdAt), asc(receipts.id));
}

export async function refundsOf(h: FlowHarness, orderId: string) {
  return h.db.select().from(refunds).where(eq(refunds.orderId, orderId));
}

export async function paymentsOf(h: FlowHarness, orderId: string) {
  return h.db
    .select()
    .from(payments)
    .where(eq(payments.orderId, orderId))
    .orderBy(asc(payments.createdAt));
}

export async function itemsOf(h: FlowHarness, orderId: string) {
  return h.db
    .select()
    .from(orderItems)
    .where(eq(orderItems.orderId, orderId))
    .orderBy(asc(orderItems.createdAt), asc(orderItems.id));
}

export async function supplierOrdersOf(h: FlowHarness, orderId: string) {
  return h.db.select().from(supplierOrders).where(eq(supplierOrders.orderId, orderId));
}

/** Outbox rows written for the order (data.orderId). */
export async function outboxOf(h: FlowHarness, orderId: string) {
  return h.db
    .select()
    .from(outbox)
    .where(sql`${outbox.data}->>'orderId' = ${orderId}`)
    .orderBy(asc(outbox.createdAt), asc(outbox.id));
}

/**
 * A delayed outbox row (a receipt poll in 2 minutes) of the order becomes due now, as if the
 * time had passed, and the dispatcher is woken.
 */
export async function fastForward(h: FlowHarness, orderId: string, name: string): Promise<void> {
  await waitFor(`a delayed ${name} row of ${orderId}`, async () => {
    const due = await h.db
      .update(outbox)
      .set({ availableAt: sql`now()` })
      .where(
        and(
          isNull(outbox.dispatchedAt),
          eq(outbox.name, name),
          sql`${outbox.data}->>'orderId' = ${orderId}`,
        ),
      )
      .returning({ id: outbox.id });
    return due.length > 0 ? due : null;
  });
  h.web.nudge?.();
}

/**
 * Every notify job written for the order has exactly one notifications row with its dedupe key
 * (`<order_event_id>:<template>:<channel>`), none left queued or failed; keys are unique.
 */
export async function expectNotificationsOnce(h: FlowHarness, orderId: string) {
  const rows = await notificationsOf(h, orderId);
  const keys = rows.map((r) => r.dedupeKey);
  expect(new Set(keys).size).toBe(keys.length);
  for (const row of rows) expect(['sent', 'skipped']).toContain(row.status);
  const jobs = (await outboxOf(h, orderId)).filter((r) => r.queue === 'notify');
  for (const job of jobs) {
    const prefix = `${String(job.data.orderEventId)}:${String(job.data.template)}:`;
    const matching = keys.filter((k) => k.startsWith(prefix));
    expect(matching, `notifications of ${prefix}`).toHaveLength(1);
  }
  return rows;
}
