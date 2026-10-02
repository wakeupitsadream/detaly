// WorkerDeps for worker tests (docs/phase-1b-implementation.md section 4.7): the `_worker`
// database from globalSetup, the shared Redis under a `test:<uuid>:` prefix, BullMQ queues with
// the test's own prefix and recording fakes of the ports. Providers (payments, receipts,
// rossko, smsDriver, telegram) come from overrides; rossko defaults to the bundled fixtures.
// Phase 1C: a memory FileStore, a fake client bot API (records sendMessage / sendPhoto, can
// answer 403 or 429), no MAX driver and a fetch that refuses the network.
//
//   const t = await createTestDeps({ payments: provider });
//   ... await processPayments(job, t.deps) ...
//   expect(t.fakes.alerts.calls).toEqual([...]);
//   await t.close();
import { createLogger, createRedis, parseEnv, type Env } from '@detaly/config';
import {
  deleteKeysByPrefix,
  minimalEnvSource,
  testKeyPrefix,
  testRedisUrl,
} from '@detaly/config/testing';
import { createDb } from '@detaly/db';
import { createMemoryFileStore, type MemoryFileStore } from '@detaly/files';
import {
  createFixtureCaller,
  createRosskoClient,
  createUnlimitedLimiter,
  FIXTURE_LOCAL_STOCK_IDS,
} from '@detaly/rossko';
import { Api } from 'grammy';
import { inject } from 'vitest';
import type {
  AlertPort,
  ClientTelegramApi,
  DeadLetterView,
  QueueInspector,
  QueueStats,
  SellerCardPort,
  WorkerDeps,
} from '../../src/deps';
import { closeQueues, createQueues } from '../../src/queues';

type CardCall =
  | { method: 'post'; input: Parameters<SellerCardPort['post']>[0] }
  | { method: 'refresh'; orderId: string }
  | { method: 'sendHandoverQr'; input: Parameters<SellerCardPort['sendHandoverQr']>[0] }
  | { method: 'postVin'; input: Parameters<SellerCardPort['postVin']>[0] }
  | { method: 'refreshVin'; vinRequestId: string };

export interface RecordingSellerCards extends SellerCardPort {
  calls: CardCall[];
}

export interface RecordingAlerts extends AlertPort {
  calls: Parameters<AlertPort['send']>[0][];
}

export interface RecordingInspector extends QueueInspector {
  /** What stats() and deadLetters() return; tests set them. */
  statsResult: QueueStats[];
  deadLettersResult: DeadLetterView[];
  retried: string[];
}

export function recordingSellerCards(): RecordingSellerCards {
  const calls: CardCall[] = [];
  return {
    calls,
    async post(input) {
      calls.push({ method: 'post', input });
      return { status: 'posted' };
    },
    async refresh(orderId) {
      calls.push({ method: 'refresh', orderId });
    },
    async sendHandoverQr(input) {
      calls.push({ method: 'sendHandoverQr', input });
    },
    async postVin(input) {
      calls.push({ method: 'postVin', input });
      return { status: 'posted' };
    },
    async refreshVin(vinRequestId) {
      calls.push({ method: 'refreshVin', vinRequestId });
    },
  };
}

export interface FakeClientTelegramCall {
  method: string;
  payload: Record<string, unknown>;
}

/** The client bot API with a recording transport (no network). */
export interface FakeClientTelegram {
  api: ClientTelegramApi;
  calls: FakeClientTelegramCall[];
  /** sendMessage and sendPhoto calls in order: chat id and text (caption for a photo). */
  sent(): { method: 'sendMessage' | 'sendPhoto'; chatId: string; text: string | null }[];
  /**
   * Answers the next calls with a Bot API error: 403 «bot was blocked by the user», 429 «Too Many
   * Requests» with retry_after (VERIFY: Telegram limits), or null to succeed again.
   */
  failWith(code: 403 | 429 | null): void;
}

export function fakeClientTelegram(): FakeClientTelegram {
  const api = new Api('654321:client-test-token-not-real');
  const calls: FakeClientTelegramCall[] = [];
  let failure: 403 | 429 | null = null;
  // The transformer returns the Bot API envelope of whatever method was called.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const envelope = (value: Record<string, unknown>): any => value;
  api.config.use(async (_prev, method, payload) => {
    const call = { method, payload: (payload ?? {}) as Record<string, unknown> };
    calls.push(call);
    if (failure === 403) {
      return envelope({
        ok: false,
        error_code: 403,
        description: 'Forbidden: bot was blocked by the user',
      });
    }
    if (failure === 429) {
      return envelope({
        ok: false,
        error_code: 429,
        description: 'Too Many Requests: retry after 5',
        parameters: { retry_after: 5 },
      });
    }
    const p = call.payload as { chat_id?: number | string; text?: string; caption?: string };
    return envelope({
      ok: true,
      result: {
        message_id: 2000 + calls.length,
        date: Math.floor(Date.now() / 1000),
        chat: { id: Number(p.chat_id ?? 0), type: 'private' },
        ...(p.text !== undefined ? { text: p.text } : {}),
        ...(p.caption !== undefined ? { caption: p.caption } : {}),
      },
    });
  });
  return {
    api,
    calls,
    sent: () =>
      calls
        .filter((call) => call.method === 'sendMessage' || call.method === 'sendPhoto')
        .map((call) => ({
          method: call.method as 'sendMessage' | 'sendPhoto',
          chatId: String(call.payload.chat_id),
          text:
            typeof call.payload.text === 'string'
              ? call.payload.text
              : typeof call.payload.caption === 'string'
                ? call.payload.caption
                : null,
        })),
    failWith(code) {
      failure = code;
    },
  };
}

/** fetch of the tests: no network (tests that download Telegram files pass their own). */
export const noNetworkFetch: typeof fetch = async () => {
  throw new Error('test-deps: network access is disabled, pass `fetch` in the overrides');
};

export function recordingAlerts(): RecordingAlerts {
  const calls: Parameters<AlertPort['send']>[0][] = [];
  return {
    calls,
    async send(input) {
      calls.push(input);
    },
  };
}

export function recordingInspector(): RecordingInspector {
  const inspector: RecordingInspector = {
    statsResult: [],
    deadLettersResult: [],
    retried: [],
    async stats() {
      return inspector.statsResult;
    },
    async deadLetters(limit) {
      return inspector.deadLettersResult.slice(0, limit);
    },
    async retryDeadLetter(id) {
      inspector.retried.push(id);
      return inspector.deadLettersResult.some((job) => job.id === id);
    },
  };
  return inspector;
}

export interface TestDepsOverrides extends Partial<
  Omit<WorkerDeps, 'sellerCards' | 'alerts' | 'inspector' | 'engine'>
> {
  /** Extra env values on top of minimalEnvSource (DATABASE_URL / REDIS_URL are set here). */
  envOverrides?: Record<string, string | undefined>;
  /** A whole port, or a phase 1B one: postVin / refreshVin then record into the fakes. */
  sellerCards?: Omit<SellerCardPort, 'postVin' | 'refreshVin'> & Partial<SellerCardPort>;
  alerts?: AlertPort;
  inspector?: QueueInspector;
}

export interface TestDeps {
  deps: WorkerDeps;
  fakes: {
    sellerCards: RecordingSellerCards;
    alerts: RecordingAlerts;
    inspector: RecordingInspector;
    /** How many times the engine nudged the outbox dispatcher. */
    nudges: { count: number };
    /** The default deps.files (unused when `files` is overridden). */
    files: MemoryFileStore;
    /** The default deps.clientTelegram (unused when `clientTelegram` is overridden). */
    clientTelegram: FakeClientTelegram;
  };
  /** Closes queues, Redis and the pool and deletes the test's Redis keys. */
  close(): Promise<void>;
}

/** The migrated and seeded `${DATABASE_URL_TEST}_worker` database (globalSetup). */
export function workerTestDatabaseUrl(): string {
  const url = inject('workerDatabaseUrl');
  if (!url) throw new Error('DATABASE_URL_TEST is not set: eval "$(scripts/dev-db.sh env)"');
  return url;
}

export async function createTestDeps(overrides: TestDepsOverrides = {}): Promise<TestDeps> {
  const {
    envOverrides,
    sellerCards: cardsOverride,
    alerts: alertsOverride,
    inspector: inspectorOverride,
    ...rest
  } = overrides;
  const keyPrefix = rest.keyPrefix ?? testKeyPrefix();
  const bullPrefix = rest.bullPrefix ?? `${keyPrefix}bull`;
  const databaseUrl = workerTestDatabaseUrl();
  const env: Env =
    rest.env ??
    parseEnv(
      minimalEnvSource({ DATABASE_URL: databaseUrl, REDIS_URL: testRedisUrl(), ...envOverrides }),
    );
  const ownDb = rest.db === undefined;
  const db = rest.db ?? createDb(databaseUrl, { max: 4 });
  const ownRedis = rest.redis === undefined;
  const redis = rest.redis ?? createRedis(testRedisUrl());
  const ownQueues = rest.queues === undefined;
  const queues = rest.queues ?? createQueues(redis, { prefix: bullPrefix });
  const now = rest.now ?? (() => new Date());

  const sellerCards = recordingSellerCards();
  const alerts = recordingAlerts();
  const inspector = recordingInspector();
  const nudges = { count: 0 };
  const files = createMemoryFileStore();
  const clientTelegram = fakeClientTelegram();

  const deps: WorkerDeps = {
    logger: createLogger('worker-test', { level: 'silent' }),
    heartbeatKey: `${keyPrefix}heartbeat`,
    payments: null,
    receipts: null,
    rossko: createRosskoClient({
      caller: createFixtureCaller(),
      key1: 'test-key1',
      key2: 'test-key2',
      deliveryId: env.ROSSKO_DELIVERY_ID ?? null,
      addressId: env.ROSSKO_ADDRESS_ID ?? null,
      paymentId: env.ROSSKO_PAYMENT_ID ?? null,
      localStockIds: FIXTURE_LOCAL_STOCK_IDS,
      limiter: createUnlimitedLimiter(),
      allowCheckout: env.ROSSKO_ALLOW_CHECKOUT,
    }),
    smsDriver: null,
    telegram: null,
    clientTelegram: clientTelegram.api,
    maxDriver: null,
    files,
    fetch: noNetworkFetch,
    ...rest,
    db,
    redis,
    env,
    now,
    keyPrefix,
    bullPrefix,
    queues,
    engine: {
      db,
      env,
      now,
      nudge: () => {
        nudges.count += 1;
      },
    },
    sellerCards: cardsOverride
      ? { postVin: sellerCards.postVin, refreshVin: sellerCards.refreshVin, ...cardsOverride }
      : sellerCards,
    alerts: alertsOverride ?? alerts,
    inspector: inspectorOverride ?? inspector,
  };

  return {
    deps,
    fakes: { sellerCards, alerts, inspector, nudges, files, clientTelegram },
    async close() {
      if (ownQueues) await closeQueues(queues);
      if (ownRedis) {
        await deleteKeysByPrefix(redis, keyPrefix);
        await redis.quit();
      }
      if (ownDb) await db.close();
    },
  };
}
