// Real processes: `node --import tsx` like the Dockerfile CMD and the compose healthcheck.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRedis, type Redis } from '@detaly/config';
import {
  deleteKeysByPrefix,
  minimalEnvSource,
  testKeyPrefix,
  testRedisUrl,
} from '@detaly/config/testing';
import { afterAll, beforeAll, describe, expect, inject, it, vi } from 'vitest';

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
      DATABASE_URL: inject('workerDatabaseUrl') ?? undefined,
      REDIS_URL: testRedisUrl(),
      NODE_ENV: 'test',
      LOG_LEVEL: 'info',
      GIT_SHA: 'testsha',
    }),
    ...overrides,
  };
}

describe('worker process shutdown', () => {
  it('exits with 0 within 10 s of SIGTERM after the first heartbeat', async () => {
    const heartbeatKey = `${prefix}proc:heartbeat`;
    const child = spawnTsx(
      'test/fixtures/worker-process.ts',
      [],
      baseEnv({
        TG_SELLER_BOT_TOKEN: '',
        WORKER_TEST_BULL_PREFIX: `${prefix}proc:bull`,
        WORKER_TEST_HEARTBEAT_KEY: heartbeatKey,
      }),
    );
    try {
      await vi.waitFor(
        async () => {
          expect(await redis.exists(heartbeatKey), child.output()).toBe(1);
        },
        { timeout: 20_000, interval: 200 },
      );
    } catch (error) {
      child.kill('SIGKILL');
      throw error;
    }
    expect(child.output()).toContain('the seller bot is not started');

    const sentAt = Date.now();
    child.kill('SIGTERM');
    const result = await Promise.race([
      child.exited,
      new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 10_000)),
    ]);
    if (result === 'timeout') child.kill('SIGKILL');

    expect(result, child.output()).toEqual({ code: 0, signal: null });
    expect(Date.now() - sentAt).toBeLessThan(10_000);
    expect(child.output()).toContain('shutdown complete');
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
