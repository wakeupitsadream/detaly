/**
 * Wiring of the maintenance kits (step 5, docs/kits.md) with the real dependencies: the shared
 * supplier (one Rossko client: cache, single-flight, quota breaker; one settings reader) and the
 * shared pool. DEMO_MODE: the sample kits, never the database.
 */
import type { Env } from '@detaly/config';
import { and, carts, eq, isNull, type Executor } from '@detaly/db';
import type { CartService } from '../cart/cart-service';
import { getDb } from '../db';
import { serverEnv } from '../env';
import { getLogger } from '../logger';
import { isDemoMode } from '../mode';
import { getSupplier } from '../supplier';
import type { KitAddDeps } from './add-handler';
import { loadKit, type KitRecord } from './catalog';
import { demoKitById } from './demo-kits';
import { priceKit, type KitView } from './kit-view';

/** Prices a kit now through the shared supplier and the current settings. */
export async function priceKitNow(kit: KitRecord, now: Date = new Date()): Promise<KitView> {
  const supplier = getSupplier();
  return priceKit(kit, { rossko: supplier.rossko, settings: await supplier.settings.get(), now });
}

/** Prices the kits of a page one after another (their articles share the cache). */
export async function priceKitsNow(
  list: readonly KitRecord[],
  now: Date = new Date(),
): Promise<KitView[]> {
  const views: KitView[] = [];
  for (const kit of list) views.push(await priceKitNow(kit, now));
  return views;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A published kit by id: a sample in DEMO_MODE; null for anything else. */
export function loadPublishedKit(id: string): Promise<KitRecord | null> {
  if (isDemoMode()) return Promise.resolve(demoKitById(id));
  if (!UUID_RE.test(id)) return Promise.resolve(null);
  return loadKit(getDb(), id, { published: true });
}

/**
 * Step 6 (docs/garage.md): the client cart of `cartToken` remembers the kit it was filled from
 * (carts.kit_id), the prefill of «Моя машина» on the checkout. Proposal carts are never touched.
 */
export async function rememberCartKit(
  db: Executor,
  cartToken: string,
  kitId: string,
): Promise<void> {
  if (!UUID_RE.test(kitId)) return;
  await db
    .update(carts)
    .set({ kitId })
    .where(
      and(eq(carts.anonToken, cartToken), eq(carts.status, 'active'), isNull(carts.proposalToken)),
    );
}

/** Dependencies of POST /api/cart/kits over a cart service (live, or the demo one of a request). */
export function kitAddDeps(
  service: CartService,
  env: Pick<Env, 'APP_BASE_URL' | 'CART_TTL_DAYS'>,
): KitAddDeps {
  return {
    env,
    service,
    loadKit: loadPublishedKit,
    price: (kit) => priceKitNow(kit),
    // Step 6: only with GARAGE_ENABLED (nothing collected otherwise); never in the demo (no db).
    rememberKit:
      !isDemoMode() && serverEnv().GARAGE_ENABLED
        ? (cartToken, kitId) => rememberCartKit(getDb(), cartToken, kitId)
        : undefined,
    logger: getLogger(),
  };
}
