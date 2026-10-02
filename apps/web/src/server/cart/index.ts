/**
 * Wiring of the cart with real dependencies (lazy singletons): the shared supplier side from
 * server/supplier.ts and the shared pool. Tests build their own with createCartService.
 */
import type { Executor } from '@detaly/db';
import { getDb } from '../db';
import { serverEnv } from '../env';
import { singleton } from '../globals';
import { getLogger } from '../logger';
import { getSupplier, type Supplier } from '../supplier';
import { createCartService, type CartService } from './cart-service';
import type { CartHandlerDeps } from './http';

/** Cart service on top of existing supplier dependencies (same settings reader and cache). */
export function cartServiceFromSupplier(
  supplier: Pick<Supplier, 'rossko' | 'settings'>,
  db: Executor,
  onError?: (error: unknown, what: string) => void,
): CartService {
  return createCartService({
    db,
    supplier,
    loadSettings: () => supplier.settings.get(),
    onError,
  });
}

/** Background cart failures as warnings: the error message only, no client data. */
function logCartError(error: unknown, what: string): void {
  getLogger().warn({ err: error instanceof Error ? error.message : String(error), what }, 'cart');
}

export function getCartService(): CartService {
  return singleton('cart-service', () =>
    cartServiceFromSupplier(getSupplier(), getDb(), logCartError),
  );
}

/** Dependencies of the /api/cart/** route handlers. */
export function getCartHandlerDeps(): CartHandlerDeps {
  return {
    service: getCartService(),
    env: serverEnv(),
    onError: (error) => getLogger().error({ err: error }, 'cart request failed'),
  };
}
