/**
 * Supplier side of the demo (DEMO_MODE): bundled Rossko fixtures behind the in-memory limiter
 * and search cache from @detaly/rossko, settings from env. Same Supplier contract as the live
 * wiring in server/supplier.ts, nothing touches Postgres or Redis, and fixtures are used
 * whatever ROSSKO_MODE says (the env schema requires fixtures in the demo anyway).
 */
import type { Env } from '@detaly/config';
import {
  createFixtureCaller,
  createMemoryLimiter,
  createMemorySearchCache,
  createRosskoClient,
  FIXTURE_LOCAL_STOCK_IDS,
  type RosskoCaller,
} from '@detaly/rossko';
import { createEnvSettingsReader } from '../settings';
import type { Supplier } from '../supplier';

export interface DemoSupplierOptions {
  env: Env;
  /** Overrides the bundled fixtures (tests). */
  caller?: RosskoCaller;
  now?: () => number;
}

export function createDemoSupplier({ env, caller, now }: DemoSupplierOptions): Supplier {
  const limiter = createMemoryLimiter({
    rpm: env.ROSSKO_RPM_LIMIT,
    daily: env.ROSSKO_DAILY_LIMIT,
    breakerPct: env.ROSSKO_QUOTA_BREAKER_PCT,
    ...(now ? { now } : {}),
  });
  const rossko = createRosskoClient({
    caller: caller ?? createFixtureCaller(),
    key1: null,
    key2: null,
    localStockIds: FIXTURE_LOCAL_STOCK_IDS,
    limiter,
    cache: createMemorySearchCache({ keyPrefix: 'fx:', ...(now ? { now } : {}) }),
    // The demo never orders anything.
    allowCheckout: false,
    ...(now ? { now } : {}),
  });
  return { rossko, limiter, settings: createEnvSettingsReader(env) };
}
