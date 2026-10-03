// Real processes: `node --import tsx` like the Dockerfile CMD and the compose healthcheck.
// Phase 1C: the worker with both bots (seller and client) long-polls a local fake Bot API, so
// start and SIGTERM are checked without the network.
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
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
  return spawnNode(['--import', 'tsx', script, ...args], env);
}

function spawnNode(argv: string[], env: Record<string, string | undefined>): Spawned {
  const child = spawn(process.execPath, argv, {
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

/**
 * The worker of test/fixtures/worker-process.ts, with the bots pointed at a local Bot API
 * (overrides.botClient.apiRoot from WORKER_TEST_TG_API_ROOT).
 */
const WORKER_WITH_FAKE_BOT_API = `
import { createLogger, parseEnv } from '@detaly/config';
import { runWorker } from './src/app.ts';
const prefix = process.env.WORKER_TEST_PREFIX;
if (!prefix?.startsWith('test:')) throw new Error('WORKER_TEST_PREFIX must start with test:');
const env = parseEnv(process.env);
const logger = createLogger('worker', { level: env.LOG_LEVEL, base: { gitSha: env.GIT_SHA } });
await runWorker({
  env,
  logger,
  bullPrefix: prefix + 'bull',
  heartbeatKey: prefix + 'heartbeat',
  keyPrefix: prefix,
  outboxChannel: prefix + 'outbox',
  overrides: { botClient: { apiRoot: process.env.WORKER_TEST_TG_API_ROOT } },
});
`;

interface BotApiCall {
  token: string;
  method: string;
  body: Record<string, unknown>;
}

/** A Bot API on 127.0.0.1: getMe, deleteWebhook, getUpdates (empty after a short wait). */
async function fakeBotApi(): Promise<{ server: Server; root: string; calls: BotApiCall[] }> {
  const calls: BotApiCall[] = [];
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk: Buffer) => (raw += chunk.toString()));
    req.on('end', () => {
      const match = /^\/bot([^/]+)\/(\w+)$/.exec(req.url ?? '');
      let body: Record<string, unknown>;
      try {
        body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
      } catch {
        body = {};
      }
      const token = match?.[1] ?? '';
      const method = match?.[2] ?? '';
      calls.push({ token, method, body });
      const reply = (result: unknown) => {
        if (res.writableEnded || res.destroyed) return;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, result }));
      };
      if (method === 'getMe') {
        const id = Number(token.split(':')[0]);
        return reply({ id, is_bot: true, first_name: 'test', username: `bot_${id}` });
      }
      if (method === 'getUpdates') {
        const timeout = typeof body.timeout === 'number' ? body.timeout : 0;
        setTimeout(() => reply([]), timeout > 0 ? 200 : 0).unref();
        return;
      }
      reply(true);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return { server, root: `http://127.0.0.1:${port}`, calls };
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
    expect(child.output()).toContain('the client bot is not started');
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

describe.skipIf(!hasTestDatabase)('worker process with both bots', () => {
  let databaseUrl: string;
  let api: Awaited<ReturnType<typeof fakeBotApi>>;

  beforeAll(async () => {
    const url = await prepareOwnDatabase('proc_bots');
    if (!url) throw new Error('DATABASE_URL_TEST is not set');
    databaseUrl = url;
    api = await fakeBotApi();
  });

  afterAll(async () => {
    api.server.closeAllConnections();
    await new Promise((resolve) => api.server.close(resolve));
  });

  it('starts the seller and the client bot, stops both on SIGTERM and exits 0', async () => {
    const procPrefix = `${prefix}procbots:`;
    const sellerToken = '1110001:seller-secret-not-real';
    const clientToken = '2220002:client-secret-not-real';
    const child = spawnNode(
      ['--import', 'tsx', '--input-type=module', '-e', WORKER_WITH_FAKE_BOT_API],
      baseEnv({
        DATABASE_URL: databaseUrl,
        TG_SELLER_BOT_TOKEN: sellerToken,
        TG_CLIENT_BOT_TOKEN: clientToken,
        TG_CLIENT_BOT_USERNAME: 'detaly_client_test_bot',
        YOOKASSA_SHOP_ID: '',
        YOOKASSA_SECRET_KEY: '',
        SMS_PROVIDER: 'none',
        WORKER_TEST_PREFIX: procPrefix,
        WORKER_TEST_TG_API_ROOT: api.root,
      }),
    );
    const polls = (token: string) =>
      api.calls.filter((c) => c.token === token && c.method === 'getUpdates');
    try {
      await vi.waitFor(
        () => {
          expect(child.output()).toContain('seller bot started');
          expect(child.output()).toContain('client bot started');
          expect(polls(sellerToken).length).toBeGreaterThan(0);
          expect(polls(clientToken).length).toBeGreaterThan(0);
        },
        { timeout: 20_000, interval: 200 },
      );
    } catch (error) {
      child.kill('SIGKILL');
      throw new Error(`${(error as Error).message}\n${child.output()}`, { cause: error });
    }
    // Each bot polls its own update types (the client bot also gets my_chat_member).
    expect(polls(clientToken)[0]?.body.allowed_updates).toEqual([
      'message',
      'callback_query',
      'my_chat_member',
    ]);
    expect(polls(sellerToken)[0]?.body.allowed_updates).toEqual(['message', 'callback_query']);
    expect(child.output()).toContain('"clientBot":true');

    const sentAt = Date.now();
    child.kill('SIGTERM');
    const result = await Promise.race([
      child.exited,
      new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 15_000)),
    ]);
    if (result === 'timeout') child.kill('SIGKILL');
    const output = child.output();
    expect(result, output).toEqual({ code: 0, signal: null });
    expect(Date.now() - sentAt).toBeLessThan(10_000);
    expect(output).toContain('shutdown complete');
    expect(output).not.toContain('shutdown step failed');
    // bot.stop() confirms the offset with a last getUpdates(limit 1): both bots stopped.
    for (const token of [sellerToken, clientToken]) {
      expect(polls(token).some((c) => c.body.limit === 1)).toBe(true);
    }
    expect(output).not.toContain('seller-secret');
    expect(output).not.toContain('client-secret');
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
