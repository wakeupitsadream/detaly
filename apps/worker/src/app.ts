// Worker composition: Redis, Postgres, queues, Job Schedulers, Workers, the seller bot and
// graceful shutdown. main.ts calls runWorker() with the real env; the shutdown integration
// test runs the same function with test-only key prefixes.
import {
  createRedis,
  createWorkerRedis,
  HEARTBEAT_KEY,
  type Env,
  type Logger,
} from '@detaly/config';
import { createDb } from '@detaly/db';
import { createSellerBot, startSellerBot, type SellerBotRunner } from './bots/seller/bot';
import { createStaffCache, loadStaffTgIds } from './bots/seller/staff';
import { createHealthProbe } from './health';
import { createQueues, registerSchedulers } from './queues';
import { installShutdown, type ShutdownHandle } from './shutdown';
import { createWorkers } from './workers';

export type WorkerEnv = Pick<
  Env,
  'DATABASE_URL' | 'REDIS_URL' | 'GIT_SHA' | 'TG_SELLER_BOT_TOKEN' | 'TG_SELLER_CHAT_ID'
>;

export interface RunWorkerOptions {
  env: WorkerEnv;
  logger: Logger;
  /** BullMQ prefix; default BULLMQ_PREFIX. */
  bullPrefix?: string;
  /** Heartbeat key; default HEARTBEAT_KEY. */
  heartbeatKey?: string;
  /** Exit function for shutdown (default process.exit). */
  exit?: (code: number) => void;
}

export async function runWorker({
  env,
  logger,
  bullPrefix,
  heartbeatKey = HEARTBEAT_KEY,
  exit,
}: RunWorkerOptions): Promise<ShutdownHandle> {
  // App commands and queues: RESP2. Workers: RESP2 + maxRetriesPerRequest: null.
  const redis = createRedis(env.REDIS_URL);
  const workerRedis = createWorkerRedis(env.REDIS_URL);
  for (const [name, client] of [
    ['redis', redis],
    ['workerRedis', workerRedis],
  ] as const) {
    client.on('error', (error: Error) => logger.error({ client: name, err: error }, 'redis error'));
  }
  const db = createDb(env.DATABASE_URL, { max: 5 });

  const queues = createQueues(redis, { prefix: bullPrefix });
  for (const [name, queue] of Object.entries(queues)) {
    queue.on('error', (error) => logger.error({ queue: name, err: error }, 'queue error'));
  }
  const workers = createWorkers({
    connection: workerRedis,
    redis,
    logger,
    prefix: bullPrefix,
    heartbeatKey,
  });

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
    });
  } else {
    logger.warn('TG_SELLER_BOT_TOKEN is empty: the seller bot is not started');
  }

  // Polling starts after the schedulers are registered; shutdown stops whatever is running.
  let botRunner: SellerBotRunner | null = null;

  // Signals are handled from here on, even if scheduler registration is still in flight.
  const handle = installShutdown({
    resources: {
      bot: bot ? { stop: async () => botRunner?.stop() } : null,
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
  if (bot) botRunner = startSellerBot(bot, { logger, token: env.TG_SELLER_BOT_TOKEN });
  logger.info(
    { queues: Object.keys(queues), workers: workers.map((w) => w.name), bot: bot !== null },
    'worker started',
  );
  return handle;
}
