/**
 * Cart persistence shared by the cart pages, the cart API and checkout
 * (docs/phase-1a-implementation.md section 4, decisions Д9, Д10, Д17, Д21).
 *
 * - The browser holds only an opaque token in the `cart` cookie (carts.anon_token); prices,
 *   markups and quantities live in the database and are never taken from the client.
 * - Lines are re-priced against fresh supplier offers searched by their query article
 *   (cart_items.search_article_norm): from the 15-minute cache only when a page opens (no
 *   supplier call on a miss), past the cache (priority critical) at checkout.
 *
 * VERIFY: matching by offer_key assumes live Rossko keeps stock ids stable between calls, and
 * searching by the query article assumes crosses come back for it (docs/external.md). An empty
 * answer is "not found" only with Rossko's not-found message; any other empty answer is treated
 * as a supplier failure, so a supplier outage never empties a cart (docs/external.md, R13–R15).
 */
import { randomBytes } from 'node:crypto';
import type { Env } from '@detaly/config';
import { and, cartItems, carts, eq, inArray, sql, type Executor } from '@detaly/db';
import type { CartLine, Offer, RepricedLine } from '@detaly/domain';
import { searchFailure, type CallPriority, type RosskoClient } from '@detaly/rossko';
import { cancelFitChecks } from '@detaly/vin';

/** Cookie with the cart token (decision Д21). No `__Host-` prefix: e2e runs on plain http. */
export const CART_COOKIE = 'cart';
/** Cart limits live in @detaly/domain (shared with VIN proposals in @detaly/vin). */
export { MAX_CART_LINES, MAX_CART_SEARCHES } from '@detaly/domain';

const CART_TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

/** 32 random bytes, base64url: 43 characters, 256 bits. */
export function newCartToken(): string {
  return randomBytes(32).toString('base64url');
}

export function isCartToken(value: unknown): value is string {
  return typeof value === 'string' && CART_TOKEN_RE.test(value);
}

export interface CartCookieOptions {
  httpOnly: true;
  sameSite: 'lax';
  path: '/';
  secure: boolean;
  /** Seconds. */
  maxAge: number;
}

/** Options for `cookies().set(CART_COOKIE, token, options)` in route handlers. */
export function cartCookieOptions(
  env: Pick<Env, 'APP_BASE_URL' | 'CART_TTL_DAYS'>,
): CartCookieOptions {
  return {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    secure: new URL(env.APP_BASE_URL).protocol === 'https:',
    maxAge: env.CART_TTL_DAYS * 86_400,
  };
}

interface CookieSource {
  get(name: string): { value: string } | undefined;
}

/** The cart token from the request cookies, or null when it is missing or malformed. */
export function readCartToken(cookieStore: CookieSource): string | null {
  const value = cookieStore.get(CART_COOKIE)?.value;
  return isCartToken(value) ? value : null;
}

type CartRow = typeof carts.$inferSelect;
type CartItemRow = typeof cartItems.$inferSelect;

export interface ActiveCart {
  cart: CartRow;
  /** In the order they were added. */
  lines: CartLine[];
}

export function toCartLine(row: CartItemRow): CartLine {
  return {
    id: row.id,
    offerKey: row.offerKey,
    searchArticleNorm: row.searchArticleNorm,
    qty: row.qty,
    priceSupplierKop: row.priceSupplierKop,
    priceClientKop: row.priceClientKop,
    markupBp: row.markupBp,
    isLocal: row.isLocal,
    etaDate: row.etaDate,
    offer: row.offerSnapshot,
  };
}

/** The active cart of this token with its lines; null for unknown, converted or bad tokens. */
export async function findActiveCart(db: Executor, token: string): Promise<ActiveCart | null> {
  if (!isCartToken(token)) return null;
  const cart = await db.query.carts.findFirst({
    where: (t, ops) => ops.and(ops.eq(t.anonToken, token), ops.eq(t.status, 'active')),
    with: {
      items: { orderBy: (t, ops) => [ops.asc(t.createdAt), ops.asc(t.id)] },
    },
  });
  if (!cart) return null;
  const { items, ...row } = cart;
  return { cart: row, lines: items.map(toCartLine) };
}

/** A supplier search failed (error answer or transport/limiter failure) for one article. */
export class SupplierSearchError extends Error {
  override name = 'SupplierSearchError';
  readonly articleNorm: string;

  constructor(articleNorm: string, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.articleNorm = articleNorm;
  }
}

export interface FetchFreshOptions {
  /** `search`: through the limiter breaker (pages); `critical`: checkout recheck. */
  priority: CallPriority;
  /** Skip the cache read (checkout); the fresh answer is still cached. */
  bypassCache?: boolean;
  /**
   * Page views (/cart, /checkout): read the supplier cache only, never call Rossko. A miss maps
   * to null (the line keeps its stored price, flagged stale) like a failed search; the fresh
   * check past the cache stays with POST /api/checkout. Opening pages therefore never spends
   * the Rossko quota, whatever the number of carts and reloads (the IP limits guard /search,
   * the cart writes and checkout only).
   */
  cacheOnly?: boolean;
}

/**
 * Fresh offers per query article, searched in parallel. With priority `search` a failing
 * article maps to null (lines stay as they are); with `critical` the first failure is thrown
 * (checkout answers 503 and creates nothing). Errors carry no client data.
 */
export async function fetchFreshOffers(
  rossko: Pick<RosskoClient, 'search'>,
  articleNorms: Iterable<string>,
  { priority, bypassCache = false, cacheOnly = false }: FetchFreshOptions,
): Promise<Map<string, Offer[] | null>> {
  const unique = [...new Set(articleNorms)];
  const searchOne = async (articleNorm: string): Promise<Offer[]> => {
    let result;
    try {
      result = await rossko.search(articleNorm, {
        priority,
        bypassCache,
        ...(cacheOnly ? { cacheOnly } : {}),
      });
    } catch (error) {
      throw new SupplierSearchError(
        articleNorm,
        `search ${articleNorm} failed: ${error instanceof Error ? error.name : 'error'}`,
        { cause: error },
      );
    }
    if (result.offers.length === 0) {
      const failure = searchFailure({ success: false, message: result.message });
      if (failure !== null) throw new SupplierSearchError(articleNorm, failure);
    }
    return result.offers;
  };
  const out = new Map<string, Offer[] | null>();
  if (priority === 'critical') {
    const results = await Promise.all(unique.map(searchOne));
    unique.forEach((article, i) => out.set(article, results[i] ?? null));
    return out;
  }
  const settled = await Promise.allSettled(unique.map(searchOne));
  unique.forEach((article, i) => {
    const result = settled[i];
    out.set(article, result?.status === 'fulfilled' ? result.value : null);
  });
  return out;
}

/**
 * Stores a repricing in one transaction: fresh price, markup, snapshot, date and quantity for
 * re-checked lines (`fetched_at` = now), removal of unavailable and excluded lines. Stale lines
 * (their search failed) are left untouched. Returns the ids of removed lines.
 */
export async function persistRepricing(
  db: Executor,
  cartId: string,
  repriced: readonly RepricedLine[],
  { now = new Date() }: { now?: Date } = {},
): Promise<string[]> {
  const removed = repriced.filter((l) => l.status !== 'ok').map((l) => l.id);
  const fresh = repriced.filter((l) => l.status === 'ok' && !l.stale);
  if (removed.length === 0 && fresh.length === 0) return [];
  await db.transaction(async (tx) => {
    // Same lock order as the cart API and checkout (carts row, then its lines): without it a
    // checkout in another tab could deadlock against this write (40P01).
    await tx.select({ id: carts.id }).from(carts).where(eq(carts.id, cartId)).for('update');
    for (const line of fresh) {
      await tx
        .update(cartItems)
        .set({
          // Repricing only ever lowers a quantity (stock, multiplicity). The snapshot was read
          // before the supplier call, so a quantity changed meanwhile in another tab is kept
          // when it is already lower; it is never raised back to the snapshot value.
          qty: sql`least(${cartItems.qty}, ${line.qty})`,
          brand: line.offer.brand,
          article: line.offer.article,
          name: line.offer.name,
          stockId: line.offer.stock.stockId,
          isLocal: line.isLocal,
          etaDate: line.etaDate,
          priceSupplierKop: line.priceSupplierKop,
          priceClientKop: line.priceClientKop,
          markupBp: line.markupBp,
          offerSnapshot: line.offer,
          fetchedAt: now,
        })
        .where(and(eq(cartItems.id, line.id), eq(cartItems.cartId, cartId)));
    }
    await removeCartLines(tx, cartId, removed);
    await tx.update(carts).set({ updatedAt: now }).where(eq(carts.id, cartId));
  });
  return removed;
}

/**
 * Deletes lines of this cart (ids of other carts are ignored). Returns how many were removed.
 * Step 4 (docs/fit-check.md): a fit check of a removed line still waiting for the master is
 * cancelled first (its card is redrawn); answered checks stay for the order and the statistics.
 */
export async function removeCartLines(
  tx: Executor,
  cartId: string,
  lineIds: readonly string[],
): Promise<number> {
  if (lineIds.length === 0) return 0;
  await cancelFitChecks(tx, { cartId, cartItemIds: lineIds });
  const deleted = await tx
    .delete(cartItems)
    .where(and(eq(cartItems.cartId, cartId), inArray(cartItems.id, [...lineIds])))
    .returning({ id: cartItems.id });
  return deleted.length;
}
