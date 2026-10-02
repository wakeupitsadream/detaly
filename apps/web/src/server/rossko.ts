/**
 * Rossko client for web: always behind the shared Redis limiter and the 15-minute search
 * cache from @detaly/rossko, in both modes, so fixtures behave like live (quota breaker, 503).
 *
 * - ROSSKO_MODE=fixtures: bundled synthetic fixtures; Orenburg stocks are
 *   FIXTURE_LOCAL_STOCK_IDS, otherwise no offer would be "В Оренбурге".
 * - ROSSKO_MODE=live: SOAP; Orenburg stocks come from settings `rossko.local_stock_ids`;
 *   every real call is written to `api_calls`.
 *
 * Web never orders: allowCheckout is always false here (GetCheckout runs in the worker).
 *
 * Fixtures keep their limiter and cache under `fx:` (rosskoKeyPrefix): synthetic prices must
 * never be served as live ones after switching ROSSKO_MODE, and demo searches must not spend
 * the real daily Rossko quota (or open its 70% breaker for live calls).
 */
import type { Env, Redis } from '@detaly/config';
import { apiCalls, type Database } from '@detaly/db';
import {
  createRosskoCaller,
  createRosskoClient,
  createRosskoLimiter,
  createSearchCache,
  FIXTURE_LOCAL_STOCK_IDS,
  type RosskoCaller,
  type RosskoClient,
  type RosskoLimiter,
} from '@detaly/rossko';
import type { SettingsReader } from './settings';

export interface WebRossko {
  client: RosskoClient;
  limiter: RosskoLimiter;
}

export interface WebRosskoOptions {
  env: Env;
  redis: Redis;
  db: Database;
  settings: SettingsReader;
  /** Prepended to limiter and cache keys; tests use `test:<uuid>:`. */
  keyPrefix?: string;
  /** Overrides the transport chosen by ROSSKO_MODE (tests). */
  caller?: RosskoCaller;
  /**
   * Longest wait for a limiter window slot for `critical` calls (checkout recheck). Web passes
   * WEB_CRITICAL_MAX_WAIT_MS (server/supplier.ts); the client default (60 s) is for the worker.
   */
  criticalMaxWaitMs?: number;
  onError?: (error: unknown, what: string) => void;
}

/** Redis key prefix of the limiter and cache for a mode: live keys are never shared. */
export function rosskoKeyPrefix(mode: Env['ROSSKO_MODE'], keyPrefix = ''): string {
  return mode === 'live' ? keyPrefix : `${keyPrefix}fx:`;
}

export function createWebRossko(options: WebRosskoOptions): WebRossko {
  const { env, redis, db, settings } = options;
  const live = env.ROSSKO_MODE === 'live';
  const keyPrefix = rosskoKeyPrefix(env.ROSSKO_MODE, options.keyPrefix);
  const limiter = createRosskoLimiter(redis, {
    rpm: env.ROSSKO_RPM_LIMIT,
    daily: env.ROSSKO_DAILY_LIMIT,
    breakerPct: env.ROSSKO_QUOTA_BREAKER_PCT,
    keyPrefix,
  });
  const client = createRosskoClient({
    caller:
      options.caller ??
      createRosskoCaller({
        mode: env.ROSSKO_MODE,
        wsdlBase: env.ROSSKO_WSDL_BASE,
        timeoutMs: env.ROSSKO_TIMEOUT_MS,
      }),
    key1: env.ROSSKO_KEY1,
    key2: env.ROSSKO_KEY2,
    deliveryId: env.ROSSKO_DELIVERY_ID,
    addressId: env.ROSSKO_ADDRESS_ID,
    paymentId: env.ROSSKO_PAYMENT_ID,
    localStockIds: live
      ? async () => (await settings.get()).localStockIds
      : FIXTURE_LOCAL_STOCK_IDS,
    limiter,
    cache: createSearchCache(redis, { keyPrefix }),
    allowCheckout: false,
    criticalMaxWaitMs: options.criticalMaxWaitMs,
    onCall: live
      ? async (event) => {
          try {
            await db.insert(apiCalls).values({
              source: event.source,
              method: event.method,
              durationMs: Math.max(0, Math.round(event.durationMs)),
              ok: event.ok,
              error: event.error,
            });
          } catch (error) {
            options.onError?.(error, 'api_calls');
          }
        }
      : undefined,
  });
  return { client, limiter };
}
