/** Process-wide checkout service wired to the real database, supplier, gate and logger. */
import { getCheckoutGate } from '../checkout-gate';
import { getDb } from '../db';
import { getEngineDeps } from '../engine';
import { serverEnv } from '../env';
import { singleton } from '../globals';
import { getLogger } from '../logger';
import { getSupplier } from '../supplier';
import { createCheckoutService, type CheckoutService } from './checkout-service';

export function getCheckoutService(): CheckoutService {
  return singleton('checkout-service', () => {
    const env = serverEnv();
    const db = getDb();
    const supplier = getSupplier();
    const logger = getLogger();
    return createCheckoutService({
      db,
      supplier,
      loadSettings: () => supplier.settings.get(),
      gate: () => getCheckoutGate({ env, db, logger }),
      logger,
      env,
      // Wakes the outbox dispatcher after the order commit (decision Б1).
      nudge: () => getEngineDeps().nudge?.(),
    });
  });
}
