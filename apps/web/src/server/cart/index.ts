/**
 * Wiring of the cart with real dependencies (lazy singletons): the shared supplier side from
 * server/supplier.ts and the shared pool. Tests build their own with createCartService.
 */
import type { Executor } from '@detaly/db';
import { cookies } from 'next/headers';
import { getDb } from '../db';
import { DEMO_CART_COOKIE, decodeDemoCart } from '../demo/cart-cookie';
import type { DemoCartRequestDeps } from '../demo/cart-http';
import { createDemoCartService, type DemoCartJar } from '../demo/cart-service';
import { serverEnv } from '../env';
import { singleton } from '../globals';
import { getLogger } from '../logger';
import { isDemoMode } from '../mode';
import { getSupplier, type Supplier } from '../supplier';
import { createCartService, type CartService } from './cart-service';
import { safeErrorFields } from './errors';
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

/** Background cart failures as warnings: no query parameters (cart token) or client data. */
function logCartError(error: unknown, what: string): void {
  getLogger().warn({ err: safeErrorFields(error), what }, 'cart');
}

/** DemoCartService over a jar (DEMO_MODE): the demo supplier, settings from env. */
export function demoCartService(jar: DemoCartJar): CartService {
  const supplier = getSupplier();
  return createDemoCartService({
    jar,
    supplier,
    loadSettings: () => supplier.settings.get(),
    onError: logCartError,
  });
}

/**
 * The demo cart as a page sees it: this request's `demo_cart` cookie, read-only (Server
 * Components cannot set cookies; writes go through /api/cart/**).
 */
const pageDemoJar: DemoCartJar = {
  read: async () =>
    decodeDemoCart((await cookies()).get(DEMO_CART_COOKIE)?.value, serverEnv().SESSION_SECRET),
  write: () => {
    throw new Error('the demo cart is written only by /api/cart/** route handlers');
  },
};

/**
 * The cart service of pages. DEMO_MODE: DemoCartService over the request cookie (the token
 * argument of viewCart is ignored there).
 */
export function getCartService(): CartService {
  if (isDemoMode()) return singleton('demo-cart-service', () => demoCartService(pageDemoJar));
  return singleton('cart-service', () =>
    cartServiceFromSupplier(getSupplier(), getDb(), logCartError),
  );
}

function logCartRequestError(error: unknown): void {
  getLogger().error({ err: safeErrorFields(error) }, 'cart request failed');
}

/** Dependencies of the /api/cart/** route handlers. */
export function getCartHandlerDeps(): CartHandlerDeps {
  return { service: getCartService(), env: serverEnv(), onError: logCartRequestError };
}

/** Dependencies of the /api/cart/** route handlers in DEMO_MODE (server/demo/cart-http.ts). */
export function getDemoCartRequestDeps(): DemoCartRequestDeps {
  return { env: serverEnv(), service: demoCartService, onError: logCartRequestError };
}
