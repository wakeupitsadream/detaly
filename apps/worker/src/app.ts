// Worker composition: WorkerDeps (create-deps.ts), Job Schedulers, Workers with dead-letter, the
// outbox dispatcher, the seller bot and graceful shutdown. main.ts calls runWorker() with the
// real env; the process integration test runs the same function with test-only key prefixes.
import { HEARTBEAT_KEY, type Env, type Logger } from '@detaly/config';
import { createSellerBot, startSellerBot, type SellerBotRunner } from './bots/seller/bot';
import { createStaffCache, loadStaffTgIds } from './bots/seller/staff';
import { createWorkerDeps, type CreateWorkerDepsOptions } from './create-deps';
import { createHealthProbe } from './health';
import { createOutboxDispatcher } from './outbox/dispatcher';
import { registerSchedulers } from './queues';
import { installShutdown, type ShutdownHandle } from './shutdown';
import { createWorkers } from './workers';

/** The worker reads the whole env (payments, Rossko, SMS, bots) through packages/config. */
export type WorkerEnv = Env;

export interface RunWorkerOptions {
  env: WorkerEnv;
  logger: Logger;
  /** BullMQ prefix; default BULLMQ_PREFIX. */
  bullPrefix?: string;
  /** Heartbeat key; default HEARTBEAT_KEY. */
  heartbeatKey?: string;
  /** Prefix of the worker's own Redis keys; '' in production (tests: `test:<uuid>:`). */
  keyPrefix?: string;
  /** Outbox pub/sub channel; default OUTBOX_CHANNEL (tests use a prefixed one). */
  outboxChannel?: string;
  /** Exit function for shutdown (default process.exit). */
  exit?: (code: number) => void;
  /** Transport overrides for tests (Rossko caller, fetch, Telegram API, seller cards). */
  overrides?: Pick<CreateWorkerDepsOptions, 'rosskoCaller' | 'fetch' | 'telegram' | 'sellerCards'>;
}

export async function runWorker({
  env,
  logger,
  bullPrefix,
  heartbeatKey = HEARTBEAT_KEY,
  keyPrefix,
  outboxChannel,
  exit,
  overrides,
}: RunWorkerOptions): Promise<ShutdownHandle> {
  const resources = createWorkerDeps({
    env,
    logger,
    bullPrefix,
    heartbeatKey,
    keyPrefix,
    outboxChannel,
    ...overrides,
  });
  const { deps, workerRedis } = resources;
  const { db, redis, queues } = deps;

  const workers = createWorkers({ connection: workerRedis, logger, deps });
  const dispatcher = createOutboxDispatcher({
    db,
    queues,
    logger,
    createSubscriber: resources.createSubscriber,
    channel: resources.outboxChannel,
  });

  // --- seller bot: /ping, order card buttons, «Счёт оплачен», /queues (all through deps) ---
  let bot: ReturnType<typeof createSellerBot> | null = null;
  if (env.TG_SELLER_BOT_TOKEN) {
    const staffCache = createStaffCache({ load: () => loadStaffTgIds(db), logger });
    bot = createSellerBot({
      token: env.TG_SELLER_BOT_TOKEN,
      isStaff: staffCache.isStaff,
      health: createHealthProbe({
        redis,
        pingDb: () => db.$client`select 1`,
        gitSha: env.GIT_SHA,
        heartbeatKey,
      }),
      sellerChatId: env.TG_SELLER_CHAT_ID,
      logger,
      deps,
    });
  } else {
    logger.warn('TG_SELLER_BOT_TOKEN is empty: the seller bot is not started');
  }
  // --- end of the seller bot block ---

  // Polling starts after the schedulers are registered; shutdown stops whatever is running.
  let botRunner: SellerBotRunner | null = null;

  // Signals are handled from here on, even if scheduler registration is still in flight.
  const handle = installShutdown({
    resources: {
      bot: bot ? { stop: async () => botRunner?.stop() } : null,
      dispatcher,
      workers,
      queues: Object.values(queues),
      redis: [workerRedis, redis],
      sql: db,
    },
    logger,
    exit,
  });

  try {
    await registerSchedulers(queues);
  } catch (error) {
    // A signal during startup closes the queues under the pending call: not a startup failure.
    if (handle.isShuttingDown()) return handle;
    throw error;
  }
  if (handle.isShuttingDown()) return handle;
  dispatcher.start();
  if (bot) botRunner = startSellerBot(bot, { logger, token: env.TG_SELLER_BOT_TOKEN });
  logger.info(
    {
      queues: Object.keys(queues),
      workers: workers.map((w) => w.name),
      bot: bot !== null,
      payments: deps.payments !== null,
      sms: deps.smsDriver !== null,
      rosskoMode: env.ROSSKO_MODE,
      rosskoCheckout: env.ROSSKO_ALLOW_CHECKOUT,
    },
    'worker started',
  );
  return handle;
}
