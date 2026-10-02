// Real processes: `node --import tsx` like the Dockerfile CMD and the compose healthcheck.
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRedis, type Redis } from '@detaly/config';
import {
  deleteKeysByPrefix,
  minimalEnvSource,
  testKeyPrefix,
  testRedisUrl,
} from '@detaly/config/testing';
import { createDb, eq, outbox, type Db } from '@detaly/db';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { hasTestDatabase, prepareOwnDatabase } from './fixtures/databases';

const WORKER_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const prefix = testKeyPrefix();

let redis: Redis;

beforeAll(() => {
  redis = createRedis(testRedisUrl());
});

afterAll(async () => {
  await deleteKeysByPrefix(redis, prefix);
  await redis.quit();
});

interface Spawned {
  output: () => string;
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  kill: (signal: NodeJS.Signals) => void;
}

function spawnTsx(
  script: string,
  args: string[],
  env: Record<string, string | undefined>,
): Spawned {
  const child = spawn(process.execPath, ['--import', 'tsx', script, ...args], {
    cwd: WORKER_DIR,
    env: env as NodeJS.ProcessEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString()));
  child.stderr.on('data', (chunk: Buffer) => (output += chunk.toString()));
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
    child.on('exit', (code, signal) => resolve({ code, signal })),
  );
  return { output: () => output, exited, kill: (signal) => child.kill(signal) };
}

function baseEnv(overrides: Record<string, string | undefined> = {}) {
  return {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    ...minimalEnvSource({
      REDIS_URL: testRedisUrl(),
      NODE_ENV: 'test',
      LOG_LEVEL: 'info',
      GIT_SHA: 'testsha',
    }),
    ...overrides,
  };
}

describe.skipIf(!hasTestDatabase)('worker process', () => {
  let databaseUrl: string;
  let db: Db;

  beforeAll(async () => {
    // Own database: the worker's outbox dispatcher takes every pending row of its database.
    const url = await prepareOwnDatabase('proc');
    if (!url) throw new Error('DATABASE_URL_TEST is not set');
    databaseUrl = url;
    db = createDb(databaseUrl, { max: 2 });
  });

  afterAll(async () => {
    await db.close();
  });

  it('runs without bot tokens and YooKassa keys, dispatches the outbox, exits 0 on SIGTERM', async () => {
    const procPrefix = `${prefix}proc:`;
    const heartbeatKey = `${procPrefix}heartbeat`;
    const child = spawnTsx(
      'test/fixtures/worker-process.ts',
      [],
      baseEnv({
        DATABASE_URL: databaseUrl,
        TG_SELLER_BOT_TOKEN: '',
        YOOKASSA_SHOP_ID: '',
        YOOKASSA_SECRET_KEY: '',
        SMS_PROVIDER: 'none',
        WORKER_TEST_PREFIX: procPrefix,
      }),
    );
    const outboxKey = `process-test:${randomUUID()}`;
    try {
      await vi.waitFor(
        async () => {
          expect(await redis.exists(heartbeatKey), child.output()).toBe(1);
        },
        { timeout: 20_000, interval: 200 },
      );
      // The running process moves an outbox row into BullMQ (nudge or poll).
      await db
        .insert(outbox)
        .values({ queue: 'housekeeping', name: 'heartbeat', jobId: outboxKey });
      await redis.publish(`${procPrefix}outbox`, '1');
      await vi.waitFor(
        async () => {
          const [row] = await db.select().from(outbox).where(eq(outbox.jobId, outboxKey));
          expect(row?.dispatchedAt, child.output()).toBeInstanceOf(Date);
        },
        { timeout: 10_000, interval: 100 },
      );
    } catch (error) {
      child.kill('SIGKILL');
      throw error;
    }
    expect(child.output()).toContain('the seller bot is not started');
    expect(child.output()).toContain('worker started');
    expect(child.output()).toContain('"payments":false');
    expect(child.output()).toContain('"rosskoCheckout":false');

    const sentAt = Date.now();
    child.kill('SIGTERM');
    const result = await Promise.race([
      child.exited,
      new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 10_000)),
    ]);
    if (result === 'timeout') child.kill('SIGKILL');

    expect(result, child.output()).toEqual({ code: 0, signal: null });
    expect(Date.now() - sentAt).toBeLessThan(10_000);
    const output = child.output();
    expect(output).toContain('shutdown complete');
    expect(output).not.toContain('shutdown step failed');
    // No secrets or phones in the log.
    expect(output).not.toContain(String(minimalEnvSource().SESSION_SECRET));
    expect(output).not.toMatch(/\+7\d{10}/);
  });
});

describe('healthcheck.ts', () => {
  it('exits with 0 for a fresh heartbeat and 1 for a missing one', async () => {
    const key = `${prefix}hc:heartbeat`;
    const env = { PATH: process.env.PATH, REDIS_URL: testRedisUrl() };

    const missing = spawnTsx('src/healthcheck.ts', [key], env);
    expect((await missing.exited).code, missing.output()).toBe(1);

    await redis.set(key, String(Date.now()), 'EX', 60);
    const fresh = spawnTsx('src/healthcheck.ts', [key], env);
    expect((await fresh.exited).code, fresh.output()).toBe(0);

    await redis.set(key, String(Date.now() - 121_000), 'EX', 60);
    const stale = spawnTsx('src/healthcheck.ts', [key], env);
    expect((await stale.exited).code, stale.output()).toBe(1);
  });

  it('exits with 1 when Redis is unreachable', async () => {
    const down = spawnTsx('src/healthcheck.ts', [`${prefix}hc:none`], {
      PATH: process.env.PATH,
      REDIS_URL: 'redis://127.0.0.1:1/0',
    });
    expect((await down.exited).code, down.output()).toBe(1);
  });
});
