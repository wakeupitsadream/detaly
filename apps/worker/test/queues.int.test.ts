// createWorkerDeps (section 9.1): what each env switches on, the queue policies on real BullMQ
// queues and the SMS budget query. Own database `_worker_deps`, Redis keys under `test:<uuid>:`.
import { createLogger, createRedis, parseEnv, type Redis } from '@detaly/config';
import {
  deleteKeysByPrefix,
  minimalEnvSource,
  testKeyPrefix,
  testRedisUrl,
} from '@detaly/config/testing';
import { apiCalls, createDb, type Db } from '@detaly/db';
import { CheckoutDisabledError } from '@detaly/rossko';
import { Api } from 'grammy';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createWorkerDeps, smsSpentKop, type WorkerResources } from '../src/create-deps';
import type { SellerCardPort } from '../src/deps';
import { closeQueues } from '../src/queues';
import { hasTestDatabase, prepareOwnDatabase } from './fixtures/databases';

const prefix = testKeyPrefix();
const logger = createLogger('worker-test', { level: 'silent' });

describe.skipIf(!hasTestDatabase)('createWorkerDeps', () => {
  let databaseUrl: string;
  let db: Db;
  let redis: Redis;
  const opened: WorkerResources[] = [];

  beforeAll(async () => {
    const url = await prepareOwnDatabase('deps');
    if (!url) throw new Error('DATABASE_URL_TEST is not set');
    databaseUrl = url;
    db = createDb(databaseUrl, { max: 2 });
    redis = createRedis(testRedisUrl());
  });

  afterAll(async () => {
    for (const { deps, workerRedis } of opened) {
      await closeQueues(deps.queues);
      await deps.redis.quit();
      await workerRedis.quit();
      await deps.db.close();
    }
    await deleteKeysByPrefix(redis, prefix);
    await redis.quit();
    await db.close();
  });

  function build(env: Record<string, string | undefined> = {}, cards?: SellerCardPort) {
    const resources = createWorkerDeps({
      env: parseEnv(
        minimalEnvSource({ DATABASE_URL: databaseUrl, REDIS_URL: testRedisUrl(), ...env }),
      ),
      logger,
      keyPrefix: prefix,
      bullPrefix: `${prefix}bull`,
      heartbeatKey: `${prefix}heartbeat`,
      outboxChannel: `${prefix}outbox`,
      dbMax: 2,
      sellerCards: cards ? () => cards : undefined,
    });
    opened.push(resources);
    return resources;
  }

  it('without keys and tokens: no payments, no SMS, no Telegram, no Rossko checkout', async () => {
    const { deps, workerRedis } = build();
    expect(deps.payments).toBeNull();
    expect(deps.receipts).toBeNull();
    expect(deps.smsDriver).toBeNull();
    expect(deps.telegram).toBeNull();
    // phase 1C: no client bot without its token, MAX is phase 2, photos off by default
    expect(deps.clientTelegram).toBeNull();
    expect(deps.maxDriver).toBeNull();
    expect(deps.files.kind).toBe('none');
    expect(
      build({ TG_CLIENT_BOT_TOKEN: '654321:fake-client-token' }).deps.clientTelegram,
    ).toBeInstanceOf(Api);
    expect(deps.keyPrefix).toBe(prefix);
    expect(deps.bullPrefix).toBe(`${prefix}bull`);
    expect(deps.engine.db).toBe(deps.db);
    expect(deps.redis.options.protocol).toBe(2);
    expect(workerRedis.options.maxRetriesPerRequest).toBeNull();
    await expect(
      deps.rossko.checkout({
        items: [{ partnumber: 'OC90', brand: 'Knecht', stock: 'x', count: 1 }],
      } as never),
    ).rejects.toBeInstanceOf(CheckoutDisabledError);
  });

  it('carries the queue policies as default job options', () => {
    const { deps } = build();
    expect(deps.queues.payments.defaultJobOptions).toMatchObject({
      attempts: 5,
      backoff: { type: 'exponential', delay: 10_000 },
    });
    expect(deps.queues.notify.defaultJobOptions).toMatchObject({
      attempts: 5,
      backoff: { type: 'exponential', delay: 30_000 },
    });
    expect(deps.queues.housekeeping.defaultJobOptions).toMatchObject({ attempts: 1 });
    expect(deps.queues['dead-letter'].defaultJobOptions).toEqual({ attempts: 1 });
    expect(deps.queues.rossko.opts.prefix).toBe(`${prefix}bull`);
  });

  it('enables payments only with all four YooKassa variables (decision Б6)', () => {
    const three = {
      YOOKASSA_SHOP_ID: 'shop',
      YOOKASSA_SECRET_KEY: 'secret',
      YOOKASSA_VAT_CODE: '1',
    };
    expect(build(three).deps.payments).toBeNull();
    const { deps } = build({ ...three, YOOKASSA_TAX_SYSTEM_CODE: '2' });
    expect(deps.payments).not.toBeNull();
    expect(deps.receipts).not.toBeNull();
  });

  it('builds the SMS driver with a guard, and disables a misconfigured provider', () => {
    const ok = build({
      SMS_PROVIDER: 'smsaero',
      SMS_LOGIN: 'shop@example.com',
      SMS_API_KEY: 'key',
      SMS_SENDER: 'DETALY',
    });
    expect(ok.deps.smsDriver?.channel).toBe('sms');
    expect(build({ SMS_PROVIDER: 'smsc', SMS_API_KEY: 'key' }).deps.smsDriver).toBeNull();
  });

  it('builds the seller bot API from the token and hands the deps to the cards factory', async () => {
    const posted: string[] = [];
    const cards: SellerCardPort = {
      post: async (input) => {
        posted.push(input.orderId);
        return { status: 'posted' };
      },
      refresh: async () => undefined,
      sendHandoverQr: async () => undefined,
      // phase 1C ports
      postVin: async () => ({ status: 'posted' }),
      refreshVin: async () => undefined,
      // step 4 ports
      postFit: async () => ({ status: 'posted' }),
      refreshFit: async () => undefined,
    };
    const { deps } = build({ TG_SELLER_BOT_TOKEN: '123456:fake-token-for-tests' }, cards);
    expect(deps.telegram).toBeInstanceOf(Api);
    await deps.sellerCards.post({ orderId: 'o-1' });
    expect(posted).toEqual(['o-1']);
  });

  it('sums the SMS spending of the budget month (Asia/Yekaterinburg)', async () => {
    const now = new Date('2031-03-15T10:00:00Z');
    await db.insert(apiCalls).values([
      // 1 March 00:30 Yekaterinburg = 28 Feb 19:30 UTC: inside March.
      sms(500, '2031-02-28T19:30:00Z'),
      sms(700, '2031-03-10T12:00:00Z'),
      // 28 Feb 23:00 Yekaterinburg: February.
      sms(900, '2031-02-28T18:00:00Z'),
      { ...sms(1_000, '2031-03-10T12:00:00Z'), source: 'rossko' },
    ]);
    expect(await smsSpentKop(db, now)).toBe(1_200);
  });
});

function sms(costKop: number, at: string) {
  return {
    source: 'sms' as const,
    method: 'send',
    durationMs: 10,
    ok: true,
    costKop,
    createdAt: new Date(at),
  };
}
