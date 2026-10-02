/**
 * Readiness for /api/health (deploy.sh waits for it, healthwatch alerts on it):
 * Postgres `select 1`, Redis PING and the worker heartbeat age, each with a timeout.
 * Error details stay in the log; the public report carries short codes only.
 */
import { HEARTBEAT_KEY, readHeartbeatAgeSec, type Env, type Redis } from '@detaly/config';
import type { Db } from '@detaly/db';
import { TimeoutError, withTimeout } from './timeout';

export const HEALTH_TIMEOUT_MS = 2_000;

export type CheckError = 'timeout' | 'error' | 'missing' | 'stale';

export interface CheckResult {
  ok: boolean;
  latencyMs: number;
  error?: CheckError;
}

export interface WorkerCheckResult extends CheckResult {
  /** Seconds since the last heartbeat; null when absent or unreadable. */
  ageSec: number | null;
  staleSec: number;
}

export interface HealthReport {
  ok: boolean;
  version: string;
  checkedAt: string;
  db: CheckResult;
  redis: CheckResult;
  worker: WorkerCheckResult;
}

export interface HealthDeps {
  pingDb: () => Promise<unknown>;
  pingRedis: () => Promise<unknown>;
  heartbeatAgeSec: () => Promise<number | null>;
  /** HEARTBEAT_STALE_SEC. */
  staleSec: number;
  version: string;
  timeoutMs?: number;
  now?: () => Date;
  clock?: () => number;
  onError?: (error: unknown, check: 'db' | 'redis' | 'worker') => void;
}

function errorCode(error: unknown): CheckError {
  return error instanceof TimeoutError ? 'timeout' : 'error';
}

export async function computeHealth(deps: HealthDeps): Promise<HealthReport> {
  const timeoutMs = deps.timeoutMs ?? HEALTH_TIMEOUT_MS;
  const clock = deps.clock ?? (() => performance.now());
  const now = deps.now ?? (() => new Date());

  async function run<T>(
    check: 'db' | 'redis' | 'worker',
    fn: () => Promise<T>,
  ): Promise<{ value?: T; result: CheckResult }> {
    const startedAt = clock();
    try {
      const value = await withTimeout(fn(), timeoutMs, check);
      return { value, result: { ok: true, latencyMs: Math.round(clock() - startedAt) } };
    } catch (error) {
      deps.onError?.(error, check);
      return {
        result: { ok: false, latencyMs: Math.round(clock() - startedAt), error: errorCode(error) },
      };
    }
  }

  const [db, redis, heartbeat] = await Promise.all([
    run('db', deps.pingDb),
    run('redis', deps.pingRedis),
    run('worker', deps.heartbeatAgeSec),
  ]);

  const ageSec = heartbeat.value ?? null;
  let worker: WorkerCheckResult;
  if (!heartbeat.result.ok) {
    worker = { ...heartbeat.result, ageSec: null, staleSec: deps.staleSec };
  } else if (ageSec === null) {
    worker = { ...heartbeat.result, ok: false, error: 'missing', ageSec, staleSec: deps.staleSec };
  } else if (ageSec > deps.staleSec) {
    worker = { ...heartbeat.result, ok: false, error: 'stale', ageSec, staleSec: deps.staleSec };
  } else {
    worker = { ...heartbeat.result, ageSec, staleSec: deps.staleSec };
  }

  return {
    ok: db.result.ok && redis.result.ok && worker.ok,
    version: deps.version,
    checkedAt: now().toISOString(),
    db: db.result,
    redis: redis.result,
    worker,
  };
}

export interface RealHealthDepsOptions {
  env: Env;
  db: Db;
  redis: Redis;
  /** Tests point this at a prefixed key. */
  heartbeatKey?: string;
  onError?: HealthDeps['onError'];
}

export function createHealthDeps({
  env,
  db,
  redis,
  heartbeatKey = HEARTBEAT_KEY,
  onError,
}: RealHealthDepsOptions): HealthDeps {
  return {
    pingDb: () => db.$client`select 1`,
    pingRedis: async () => {
      const reply = await redis.ping();
      if (reply !== 'PONG') throw new Error(`unexpected PING reply: ${String(reply)}`);
      return reply;
    },
    heartbeatAgeSec: () => readHeartbeatAgeSec(redis, { key: heartbeatKey }),
    staleSec: env.HEARTBEAT_STALE_SEC,
    version: env.GIT_SHA,
    onError,
  };
}
