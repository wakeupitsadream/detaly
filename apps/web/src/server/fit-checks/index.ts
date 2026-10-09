/**
 * Wiring of the step 4 fit check handlers with the process dependencies (lazy: nothing is read
 * at import time). Tests build the handlers with their own deps.
 */
import { getCheckoutGate } from '../checkout-gate';
import { getDb } from '../db';
import { getEngineDeps } from '../engine';
import { serverEnv } from '../env';
import { getLogger } from '../logger';
import { hitSubjectRateLimit, type RateLimitDecision } from '../rate-limit';
import { getRedis } from '../redis';
import { getSupplier } from '../supplier';
import { withTimeout } from '../timeout';
import type { FitLineActionDeps } from './line-actions';
import type { FitSubmitDeps } from './submit-handler';

/** The proxy's budget for a rate limit decision (src/proxy.ts): Redis down fails open. */
const CART_LIMIT_TIMEOUT_MS = 1_000;

export function getFitSubmitDeps(): FitSubmitDeps {
  const env = serverEnv();
  const db = getDb();
  const logger = getLogger();
  return {
    db,
    env,
    gate: () => getCheckoutGate({ env, db, logger }),
    limitCart: async (cartId): Promise<RateLimitDecision | null> => {
      try {
        return await withTimeout(
          hitSubjectRateLimit(getRedis(), {
            kind: 'fit_check_cart',
            secret: env.SESSION_SECRET,
            subject: cartId,
          }),
          CART_LIMIT_TIMEOUT_MS,
          'fit check cart limit',
        );
      } catch (error) {
        logger.warn(
          { err: error instanceof Error ? error.message : String(error) },
          'fit check cart limit unavailable, failing open',
        );
        return null;
      }
    },
    logger,
    nudge: () => getEngineDeps().nudge?.(),
  };
}

export function getFitLineActionDeps(): FitLineActionDeps {
  const supplier = getSupplier();
  return {
    db: getDb(),
    env: serverEnv(),
    supplier,
    loadSettings: () => supplier.settings.get(),
    logger: getLogger(),
  };
}
