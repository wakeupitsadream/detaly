// WorkerDeps for worker tests (docs/phase-1b-implementation.md section 4.7): the `_worker`
// database from globalSetup, the shared Redis under a `test:<uuid>:` prefix, BullMQ queues with
// the test's own prefix and recording fakes of the ports. Providers (payments, receipts,
// rossko, smsDriver, telegram) come from overrides; rossko defaults to the bundled fixtures.
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
import {
  createFixtureCaller,
  createRosskoClient,
  createUnlimitedLimiter,
  FIXTURE_LOCAL_STOCK_IDS,
} from '@detaly/rossko';
import { inject } from 'vitest';
import type {
  AlertPort,
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
  | { method: 'sendHandoverQr'; input: Parameters<SellerCardPort['sendHandoverQr']>[0] };

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
    },
    async refresh(orderId) {
      calls.push({ method: 'refresh', orderId });
    },
    async sendHandoverQr(input) {
      calls.push({ method: 'sendHandoverQr', input });
    },
  };
}

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
  sellerCards?: SellerCardPort;
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
    sellerCards: cardsOverride ?? sellerCards,
    alerts: alertsOverride ?? alerts,
    inspector: inspectorOverride ?? inspector,
  };

  return {
    deps,
    fakes: { sellerCards, alerts, inspector, nudges },
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
