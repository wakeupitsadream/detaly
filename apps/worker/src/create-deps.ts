// Builds WorkerDeps from the parsed env (docs/phase-1b-implementation.md section 9.1): Postgres,
// Redis (RESP2), queues, the order engine with `nudge`, YooKassa (null without the 4 variables,
// decision Б6), the Rossko client behind the shared limiter, the SMS driver with its guard (null
// with SMS_PROVIDER=none), the seller and client bot APIs (null without a token), the photo
// FileStore (phase 1C), seller cards, alerts and the queue inspector. app.ts owns the returned
// connections and closes them on shutdown.
import {
  BULLMQ_PREFIX,
  createRedis,
  createWorkerRedis,
  databaseUrl,
  HEARTBEAT_KEY,
  OUTBOX_CHANNEL,
  redisUrl,
  type Env,
  type Logger,
  type Redis,
} from '@detaly/config';
import { and, apiCalls, createDb, eq, settings, sql, type Db } from '@detaly/db';
import { createFileStoreFromEnv, type FileStore } from '@detaly/files';
import {
  createSmsDriver,
  createSmsGuard,
  smsBudgetPeriod,
  smsBudgetState,
  type ChannelDriver,
} from '@detaly/notify';
import type { EngineDeps } from '@detaly/orders';
import { createPaymentsFromEnv } from '@detaly/payments';
import {
  createRosskoCaller,
  createRosskoClient,
  createRosskoLimiter,
  createSearchCache,
  FIXTURE_LOCAL_STOCK_IDS,
  type RosskoCaller,
  type RosskoClient,
} from '@detaly/rossko';
import { Api } from 'grammy';
import { createAlerts } from './alerts';
import { createSellerCards } from './bots/seller/cards';
import { safeErrorMessage } from './dead-letter';
import type { ClientTelegramApi, SellerCardPort, SellerTelegramApi, WorkerDeps } from './deps';
import { createQueueInspector } from './inspector';
import { createQueues } from './queues';

/**
 * Longest wait for a Rossko window slot inside a job: a longer wait becomes
 * RosskoRateLimitError, and the job is delayed (workers.ts) instead of blocking its queue.
 */
export const WORKER_ROSSKO_MAX_WAIT_MS = 10_000;

/** How long the live list of Orenburg stock ids is cached (admin edits apply within a minute). */
export const LOCAL_STOCK_IDS_TTL_MS = 60_000;

export interface CreateWorkerDepsOptions {
  env: Env;
  logger: Logger;
  /**
   * Prefix of the worker's own Redis keys (Rossko limiter and cache, SMS limits). '' in
   * production, like web, so both processes share the Rossko quota; tests: `test:<uuid>:`.
   */
  keyPrefix?: string;
  /** BullMQ prefix; default BULLMQ_PREFIX. */
  bullPrefix?: string;
  /** Heartbeat key; default HEARTBEAT_KEY. */
  heartbeatKey?: string;
  /** Channel of the engine's nudge; default OUTBOX_CHANNEL. */
  outboxChannel?: string;
  now?: () => Date;
  /** Postgres pool size (default 5). */
  dbMax?: number;
  /** Transport overrides (tests). */
  rosskoCaller?: RosskoCaller;
  fetch?: typeof fetch;
  /** Overrides the seller bot API built from TG_SELLER_BOT_TOKEN (tests: fake transport). */
  telegram?: SellerTelegramApi | null;
  /** Overrides the client bot API built from TG_CLIENT_BOT_TOKEN (tests: fake transport). */
  clientTelegram?: ClientTelegramApi | null;
  /** Overrides the FileStore of FILES_STORAGE (tests: memory store). */
  files?: FileStore;
  /** Overrides createSellerCards (tests). */
  sellerCards?: (deps: WorkerDeps) => SellerCardPort;
}

export interface WorkerResources {
  deps: WorkerDeps;
  /** Connection for BullMQ Workers (maxRetriesPerRequest: null). */
  workerRedis: Redis;
  /** Creates the outbox subscriber connection (SUBSCRIBE only). */
  createSubscriber: () => Redis;
  /** Channel the engine publishes to. */
  outboxChannel: string;
}

/** Redis key prefix of the Rossko limiter and cache: fixtures never share live keys (as web). */
export function rosskoKeyPrefix(mode: Env['ROSSKO_MODE'], keyPrefix = ''): string {
  return mode === 'live' ? keyPrefix : `${keyPrefix}fx:`;
}

/** settings `rossko.local_stock_ids` with the env fallback, cached for a minute. */
function liveLocalStockIds(db: Db, env: Env, logger: Logger): () => Promise<readonly string[]> {
  let cached: { at: number; ids: readonly string[] } | null = null;
  return async () => {
    if (cached && Date.now() - cached.at < LOCAL_STOCK_IDS_TTL_MS) return cached.ids;
    let ids: readonly string[] = env.ROSSKO_LOCAL_STOCK_IDS;
    try {
      const [row] = await db
        .select({ value: settings.value })
        .from(settings)
        .where(eq(settings.key, 'rossko.local_stock_ids'))
        .limit(1);
      const value: unknown = row?.value;
      if (Array.isArray(value) && value.every((id) => typeof id === 'string')) ids = value;
    } catch (error) {
      logger.warn({ err: safeErrorMessage(error) }, 'local stock ids: settings unavailable');
    }
    cached = { at: Date.now(), ids };
    return ids;
  };
}

export function createWorkerRossko(input: {
  env: Env;
  db: Db;
  redis: Redis;
  logger: Logger;
  keyPrefix: string;
  caller?: RosskoCaller;
}): RosskoClient {
  const { env, db, redis, logger } = input;
  const live = env.ROSSKO_MODE === 'live';
  const keyPrefix = rosskoKeyPrefix(env.ROSSKO_MODE, input.keyPrefix);
  return createRosskoClient({
    caller:
      input.caller ??
      createRosskoCaller({
        mode: env.ROSSKO_MODE,
        wsdlBase: env.ROSSKO_WSDL_BASE,
        timeoutMs: env.ROSSKO_TIMEOUT_MS,
      }),
    key1: env.ROSSKO_KEY1,
    key2: env.ROSSKO_KEY2,
    deliveryId: env.ROSSKO_DELIVERY_ID,
    addressId: env.ROSSKO_ADDRESS_ID,
    paymentId: env.ROSSKO_PAYMENT_ID,
    localStockIds: live ? liveLocalStockIds(db, env, logger) : FIXTURE_LOCAL_STOCK_IDS,
    // The same limiter keys as web: one Rossko quota per account.
    limiter: createRosskoLimiter(redis, {
      rpm: env.ROSSKO_RPM_LIMIT,
      daily: env.ROSSKO_DAILY_LIMIT,
      breakerPct: env.ROSSKO_QUOTA_BREAKER_PCT,
      keyPrefix,
    }),
    cache: createSearchCache(redis, { keyPrefix }),
    // The only place GetCheckout can ever run (ROSSKO_ALLOW_CHECKOUT, false on stage).
    allowCheckout: env.ROSSKO_ALLOW_CHECKOUT,
    criticalMaxWaitMs: WORKER_ROSSKO_MAX_WAIT_MS,
    onCall: live
      ? async (event) => {
          try {
            await db.insert(apiCalls).values({
              source: event.source,
              method: event.method,
              durationMs: Math.max(0, Math.round(event.durationMs)),
              ok: event.ok,
              error: event.error,
            });
          } catch (error) {
            logger.warn({ err: safeErrorMessage(error) }, 'api_calls insert failed');
          }
        }
      : undefined,
  });
}

/** SMS spent this budget month (api_calls.cost_kop, source 'sms'). */
export async function smsSpentKop(db: Db, now: Date): Promise<number> {
  const { from, to } = smsBudgetPeriod(now);
  const [row] = await db
    .select({ spent: sql<string>`coalesce(sum(${apiCalls.costKop}), 0)` })
    .from(apiCalls)
    .where(
      and(
        eq(apiCalls.source, 'sms'),
        sql`${apiCalls.createdAt} >= ${from.toISOString()}`,
        sql`${apiCalls.createdAt} < ${to.toISOString()}`,
      ),
    );
  return Number(row?.spent ?? 0);
}

/**
 * SMS driver behind the rate limits and the monthly budget (decision Б21), or null with
 * SMS_PROVIDER=none. A misconfigured provider (no login/key/sender) is logged and disabled
 * rather than taking the whole worker down: client notifications are then `skipped`.
 */
export function createWorkerSmsDriver(input: {
  env: Env;
  db: Db;
  redis: Redis;
  logger: Logger;
  keyPrefix: string;
  now: () => Date;
  fetch?: typeof fetch;
}): ChannelDriver | null {
  const { env, db, redis, logger, keyPrefix, now } = input;
  if (env.SMS_PROVIDER === 'none') return null;
  try {
    const guard = createSmsGuard({
      redis,
      secret: env.SESSION_SECRET,
      keyPrefix,
      now,
      budget: async () =>
        smsBudgetState({
          spentKop: await smsSpentKop(db, now()),
          budgetRub: env.SMS_MONTHLY_BUDGET_RUB,
        }),
    });
    return createSmsDriver({
      provider: env.SMS_PROVIDER,
      login: env.SMS_LOGIN ?? '',
      apiKey: env.SMS_API_KEY ?? '',
      sender: env.SMS_SENDER ?? null,
      apiUrl: env.SMS_API_URL ?? null,
      fetch: input.fetch,
      guard,
      logger,
    });
  } catch (error) {
    logger.error(
      { provider: env.SMS_PROVIDER, err: safeErrorMessage(error) },
      'SMS driver is not configured: SMS are disabled',
    );
    return null;
  }
}

export function createWorkerDeps(options: CreateWorkerDepsOptions): WorkerResources {
  const { env, logger } = options;
  const keyPrefix = options.keyPrefix ?? '';
  const bullPrefix = options.bullPrefix ?? BULLMQ_PREFIX;
  const heartbeatKey = options.heartbeatKey ?? HEARTBEAT_KEY;
  const outboxChannel = options.outboxChannel ?? OUTBOX_CHANNEL;
  const now = options.now ?? (() => new Date());

  // App commands and queues: RESP2. Workers: RESP2 + maxRetriesPerRequest: null.
  // The worker never runs in DEMO_MODE: both URLs are required (the helpers throw otherwise).
  const redisAddress = redisUrl(env);
  const redis = createRedis(redisAddress);
  const workerRedis = createWorkerRedis(redisAddress);
  for (const [name, client] of [
    ['redis', redis],
    ['workerRedis', workerRedis],
  ] as const) {
    client.on('error', (error: Error) =>
      logger.error({ client: name, err: safeErrorMessage(error) }, 'redis error'),
    );
  }
  const db = createDb(databaseUrl(env), { max: options.dbMax ?? 5 });

  const queues = createQueues(redis, { prefix: bullPrefix });
  for (const [name, queue] of Object.entries(queues)) {
    queue.on('error', (error) =>
      logger.error({ queue: name, err: safeErrorMessage(error) }, 'queue error'),
    );
  }

  const engine: EngineDeps = {
    db,
    env,
    now,
    // Best effort: without the message the dispatcher picks the rows up on its next poll.
    nudge: () => {
      redis.publish(outboxChannel, '1').catch(() => undefined);
    },
  };

  const payments = createPaymentsFromEnv(env, { fetch: options.fetch });
  const telegram =
    options.telegram !== undefined
      ? options.telegram
      : env.TG_SELLER_BOT_TOKEN
        ? new Api(env.TG_SELLER_BOT_TOKEN)
        : null;

  const clientTelegram =
    options.clientTelegram !== undefined
      ? options.clientTelegram
      : env.TG_CLIENT_BOT_TOKEN
        ? new Api(env.TG_CLIENT_BOT_TOKEN)
        : null;

  // Seller cards need the finished deps object: the port delegates to it once it is built.
  let cards: SellerCardPort | null = null;
  const built = (): SellerCardPort => {
    if (cards === null) throw new Error('seller cards are not built yet');
    return cards;
  };
  const cardsPort: SellerCardPort = {
    post: (input) => built().post(input),
    refresh: (orderId) => built().refresh(orderId),
    sendHandoverQr: (input) => built().sendHandoverQr(input),
    postVin: (input) => built().postVin(input),
    refreshVin: (vinRequestId) => built().refreshVin(vinRequestId),
    postFit: (input) => built().postFit(input),
    refreshFit: (requestId) => built().refreshFit(requestId),
  };

  const deps: WorkerDeps = {
    db,
    redis,
    logger,
    env,
    now,
    keyPrefix,
    bullPrefix,
    heartbeatKey,
    queues,
    engine,
    payments: payments?.payments ?? null,
    receipts: payments?.receipts ?? null,
    rossko: createWorkerRossko({
      env,
      db,
      redis,
      logger,
      keyPrefix,
      caller: options.rosskoCaller,
    }),
    smsDriver: createWorkerSmsDriver({
      env,
      db,
      redis,
      logger,
      keyPrefix,
      now,
      fetch: options.fetch,
    }),
    telegram,
    clientTelegram,
    // MAX is phase 2 (decision С1): no driver, selectChannel never picks it.
    maxDriver: null,
    files: options.files ?? createFileStoreFromEnv(env, { fetch: options.fetch }),
    fetch: options.fetch ?? fetch,
    sellerCards: cardsPort,
    alerts: createAlerts({ db, telegram, sellerChatId: env.TG_SELLER_CHAT_ID, logger, now }),
    inspector: createQueueInspector({ queues, logger }),
  };
  cards = (options.sellerCards ?? createSellerCards)(deps);

  return {
    deps,
    workerRedis,
    outboxChannel,
    createSubscriber: () => createRedis(redisAddress),
  };
}
