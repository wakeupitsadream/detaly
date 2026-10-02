// GET /api/health against local PG/Redis; the heartbeat key is prefixed (test:<uuid>:) so a
// running worker on the shared Redis cannot influence the result.
import { createRedis, writeHeartbeat, type Redis } from '@detaly/config';
import { deleteKeysByPrefix, testKeyPrefix, testRedisUrl } from '@detaly/config/testing';
import { createDb, type Db } from '@detaly/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { handleHealthRequest } from '@/server/api/health-handler';
import { createHealthDeps, type HealthReport } from '@/server/health';
import { intEnv, webDatabaseUrl } from './helpers';

const prefix = testKeyPrefix();
const heartbeatKey = `${prefix}detaly:heartbeat:worker`;
let redis: Redis;
let db: Db;

async function health(overrides: { db?: Db; redis?: Redis } = {}) {
  const response = await handleHealthRequest(() =>
    createHealthDeps({
      env: intEnv({ HEARTBEAT_STALE_SEC: '300', GIT_SHA: 'test-sha' }),
      db: overrides.db ?? db,
      redis: overrides.redis ?? redis,
      heartbeatKey,
    }),
  );
  return { status: response.status, body: (await response.json()) as HealthReport, response };
}

beforeAll(() => {
  redis = createRedis(testRedisUrl());
  db = createDb(webDatabaseUrl(), { max: 2 });
});

afterAll(async () => {
  await deleteKeysByPrefix(redis, prefix);
  await redis.quit();
  await db.close();
});

describe('GET /api/health', () => {
  it('is 503 without a worker heartbeat', async () => {
    const { status, body, response } = await health();
    expect(status).toBe(503);
    expect(response.headers.get('cache-control')).toContain('no-store');
    expect(body).toMatchObject({
      ok: false,
      version: 'test-sha',
      db: { ok: true },
      redis: { ok: true },
      worker: { ok: false, error: 'missing' },
    });
  });

  it('is 200 with a fresh heartbeat', async () => {
    await writeHeartbeat(redis, { key: heartbeatKey });
    const { status, body } = await health();
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.worker.ageSec).toBeLessThan(5);
  });

  it('is 503 when the heartbeat is older than HEARTBEAT_STALE_SEC', async () => {
    await writeHeartbeat(redis, { key: heartbeatKey, now: new Date(Date.now() - 301_000) });
    const { status, body } = await health();
    expect(status).toBe(503);
    expect(body.worker).toMatchObject({ ok: false, error: 'stale' });
  });

  it('is 503 within the timeout when Redis and Postgres are unreachable', async () => {
    const deadRedis = createRedis('redis://127.0.0.1:1/0', {
      maxRetriesPerRequest: 1,
      connectTimeout: 500,
      retryStrategy: () => 200,
    });
    deadRedis.on('error', () => {});
    const deadDb = createDb('postgres://detaly:detaly@127.0.0.1:1/detaly', {
      max: 1,
      postgres: { connect_timeout: 10 },
    });
    try {
      const startedAt = Date.now();
      const { status, body } = await health({ db: deadDb, redis: deadRedis });
      expect(Date.now() - startedAt).toBeLessThan(5_000);
      expect(status).toBe(503);
      expect(body.db.ok).toBe(false);
      expect(body.redis.ok).toBe(false);
      expect(body.worker.ok).toBe(false);
    } finally {
      deadRedis.disconnect();
      await deadDb.close().catch(() => undefined);
    }
  });
});
