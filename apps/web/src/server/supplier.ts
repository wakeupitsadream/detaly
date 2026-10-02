/**
 * The supplier side of web shared by search, cart and checkout: one Rossko client (shared
 * limiter, cache and single-flight) and one settings reader per process. Tests build their
 * own with createSupplierDeps and a key prefix.
 */
import type { Env, Redis } from '@detaly/config';
import type { Database } from '@detaly/db';
import type { RosskoCaller, RosskoClient, RosskoLimiter } from '@detaly/rossko';
import { createDemoSupplier } from './demo/supplier';
import { serverEnv } from './env';
import { getDb } from './db';
import { singleton } from './globals';
import { getLogger } from './logger';
import { isDemoMode } from './mode';
import { getRedis } from './redis';
import { createWebRossko } from './rossko';
import { createSettingsReader, type SettingsReader } from './settings';

/**
 * Longest wait for a Rossko window slot for a `critical` call made by a web request
 * (POST /api/checkout): after it the request answers 503 instead of hanging (decision Д18).
 */
export const WEB_CRITICAL_MAX_WAIT_MS = 5_000;

export interface SupplierDepsOptions {
  env: Env;
  db: Database;
  redis: Redis;
  /** Prepended to limiter and cache keys; tests use `test:<uuid>:`. */
  keyPrefix?: string;
  /** Overrides the transport chosen by ROSSKO_MODE (tests). */
  caller?: RosskoCaller;
  onError?: (error: unknown, what: string) => void;
}

export interface Supplier {
  rossko: RosskoClient;
  limiter: RosskoLimiter;
  settings: SettingsReader;
}

export function createSupplierDeps(options: SupplierDepsOptions): Supplier {
  const { env, db, redis, keyPrefix, caller, onError } = options;
  const settings = createSettingsReader({
    db,
    env,
    onError: (error) => onError?.(error, 'settings'),
  });
  const rossko = createWebRossko({
    env,
    redis,
    db,
    settings,
    keyPrefix,
    caller,
    criticalMaxWaitMs: WEB_CRITICAL_MAX_WAIT_MS,
    onError,
  });
  return { rossko: rossko.client, limiter: rossko.limiter, settings };
}

/** Background failures of supplier wiring (settings, api_calls) as warnings without PD. */
export function logSupplierError(error: unknown, what: string): void {
  getLogger().warn(
    { err: error instanceof Error ? error.message : String(error), what },
    'supplier',
  );
}

/**
 * Process-wide supplier dependencies (lazy: nothing is read at import time). DEMO_MODE: the
 * fixtures behind the in-memory limiter and cache, settings from env (server/demo/supplier.ts).
 */
export function getSupplier(): Supplier {
  if (isDemoMode()) {
    return singleton('demo-supplier', () => createDemoSupplier({ env: serverEnv() }));
  }
  return singleton('supplier', () =>
    createSupplierDeps({
      env: serverEnv(),
      db: getDb(),
      redis: getRedis(),
      onError: logSupplierError,
    }),
  );
}
