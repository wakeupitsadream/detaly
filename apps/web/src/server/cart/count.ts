/**
 * Number of lines in the browser's cart for the header and the /search hint: one query, no
 * supplier call. A database failure counts as 0 so a page never fails because of the header.
 */
import { cookies } from 'next/headers';
import { cache } from 'react';
import { and, cartItems, carts, eq, sql, type Executor } from '@detaly/db';
import { isCartToken, readCartToken } from '../cart-store';
import { getDb } from '../db';
import { DEMO_CART_COOKIE, decodeDemoCart } from '../demo/cart-cookie';
import { serverEnv } from '../env';
import { getLogger } from '../logger';
import { isDemoMode } from '../mode';
import { safeErrorFields } from './errors';

/** Lines of the active cart of this token (0 for unknown, converted or malformed tokens). */
export async function countCartLines(db: Executor, token: string | null): Promise<number> {
  if (!isCartToken(token)) return 0;
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(cartItems)
    .innerJoin(carts, eq(carts.id, cartItems.cartId))
    .where(and(eq(carts.anonToken, token), eq(carts.status, 'active')));
  return row?.count ?? 0;
}

/**
 * The current request's cart line count, memoized per request; any failure -> 0. DEMO_MODE:
 * the lines of the signed `demo_cart` cookie.
 */
export const requestCartCount = cache(async (): Promise<number> => {
  try {
    if (isDemoMode()) {
      const value = (await cookies()).get(DEMO_CART_COOKIE)?.value;
      return decodeDemoCart(value, serverEnv().SESSION_SECRET).length;
    }
    const token = readCartToken(await cookies());
    if (token === null) return 0;
    return await countCartLines(getDb(), token);
  } catch (error) {
    try {
      getLogger().warn({ err: safeErrorFields(error) }, 'cart count failed');
    } catch {
      // Logger unavailable (env not parsed): the header still renders.
    }
    return 0;
  }
});
