/**
 * Cart operations behind /api/cart/** and the /cart page (docs/phase-1a-implementation.md
 * section 5). Pure orchestration over injected dependencies, like search-service.ts;
 * server/cart/index.ts wires the real ones.
 *
 * - Adding takes the offer from a supplier search through the 15-minute cache (the client has
 *   just seen it on /search); the client sends only the query, the offer id and a quantity —
 *   never a price or a markup.
 * - Every write locks the cart row (`for update`), so the line limits and the quantity sum of
 *   a repeated add hold under concurrent requests.
 * - Opening the cart re-prices it from the supplier cache only (no supplier call: page views
 *   must not spend the Rossko quota); a miss keeps the stored prices, and checkout re-checks
 *   past the cache anyway.
 *
 * VERIFY: the offer id posted from /search is `${articleNorm}:${brand}:${stockId}`; finding it
 * again in a (possibly re-fetched) answer assumes live Rossko keeps stock ids stable between
 * calls (docs/external.md, R13–R15). Fixtures do.
 */
import { and, cartItems, carts, eq, type Executor } from '@detaly/db';
import {
  CartError,
  cartLineFromOffer,
  cartTotals,
  MAX_ORDER_TOTAL_KOP,
  offerViewId,
  repriceCartLines,
  validateQty,
  type CartLine,
  type LineChange,
  type Offer,
  type RepriceContext,
  type RepricedLine,
} from '@detaly/domain';
import { QuotaBreakerError, RosskoRateLimitError, type RosskoClient } from '@detaly/rossko';
import {
  fetchFreshOffers,
  findActiveCart,
  isCartToken,
  MAX_CART_LINES,
  MAX_CART_SEARCHES,
  newCartToken,
  persistRepricing,
  removeCartLines,
} from '../cart-store';
import { normalizeSearchInput, SearchInputError } from '../search-service';
import type { SearchSettings } from '../settings';
import { CartRequestError, isNamedError } from './errors';

/** Longest offer id accepted (`${articleNorm}:${brand}:${stockId}`). */
export const MAX_OFFER_ID_LENGTH = 200;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type CartSettings = Pick<SearchSettings, 'pricing' | 'excludedRules' | 'eta' | 'order'>;

export interface CartServiceDeps {
  db: Executor;
  supplier: { rossko: Pick<RosskoClient, 'search'> };
  loadSettings: () => Promise<CartSettings>;
  now?: () => Date;
  /** Failures that do not fail the request (repricing on the cart page); no client data. */
  onError?: (error: unknown, what: string) => void;
}

/** What a write answers: lines in the cart and their sum. */
export interface CartSnapshot {
  /** Number of lines (positions), as in the header. */
  count: number;
  totalKop: number;
}

export interface AddItemInput {
  /** Cart cookie value or null. */
  token: string | null;
  /** Query article the offer was found by (as typed or normalized). */
  q: unknown;
  /** OfferView.id = offerViewId(offer). */
  offerId: unknown;
  /** Units to add; default: the offer's multiplicity. */
  qty?: unknown;
}

export interface AddItemResult extends CartSnapshot {
  /** The cart token to (re)set in the cookie: a new one when a cart was created. */
  token: string;
  created: boolean;
  /** The cart line of the offer (new or merged): «Проверить под мою машину» opens its form. */
  lineId: string;
}

export interface LineInput {
  token: string | null;
  lineId: unknown;
}

export interface CartView {
  cartId: string;
  /** Lines still in the cart after repricing (status 'ok'). */
  lines: RepricedLine[];
  /** What repricing changed; shown once (already stored, so the next render has none). */
  changes: LineChange[];
  /** Prices of some or all lines could not be re-checked now (supplier or quota failure). */
  stale: boolean;
  settings: CartSettings;
  now: Date;
}

export interface CartService {
  addItem(input: AddItemInput): Promise<AddItemResult>;
  updateItem(input: LineInput & { qty: unknown }): Promise<CartSnapshot>;
  removeItem(input: LineInput): Promise<CartSnapshot>;
  /** The active cart re-priced through the supplier cache; null for no or an empty cart. */
  viewCart(token: string | null): Promise<CartView | null>;
}

/** A positive integer from a form string or a JSON number; undefined when absent. */
export function parseQty(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new CartRequestError('invalid');
    return value;
  }
  if (typeof value === 'string' && /^\s*\d{1,4}\s*$/.test(value)) return Number(value.trim());
  throw new CartRequestError('invalid');
}

function parseLineId(value: unknown): string {
  if (typeof value !== 'string' || !UUID_RE.test(value)) {
    throw new CartRequestError('line_not_found');
  }
  return value.toLowerCase();
}

// The supplier client is a process-wide singleton that another bundle may have created, so
// its errors are matched by name too (see isCartRequestError).
function isRateLimit(error: unknown): error is RosskoRateLimitError {
  return isNamedError(error, RosskoRateLimitError, 'RosskoRateLimitError');
}

function isQuotaBreaker(error: unknown): error is QuotaBreakerError {
  return isNamedError(error, QuotaBreakerError, 'QuotaBreakerError');
}

function supplierError(error: unknown): CartRequestError {
  if (isRateLimit(error) && Number.isFinite(error.retryAfterMs)) {
    return new CartRequestError(
      'supplier_unavailable',
      undefined,
      Math.max(1, Math.ceil(error.retryAfterMs / 1000)),
    );
  }
  return new CartRequestError('supplier_unavailable');
}

function fromCartError(error: unknown): never {
  if (error instanceof CartError) {
    switch (error.code) {
      case 'excluded':
        throw new CartRequestError('excluded');
      case 'qty':
        throw new CartRequestError('qty', error.message);
      case 'price':
        throw new CartRequestError('offer_not_found');
      case 'article':
        throw new CartRequestError('invalid');
    }
  }
  throw error;
}

/** Cheapest offer with this id (duplicates are possible, as in buildOfferViews). */
function pickOffer(offers: readonly Offer[], offerId: string): Offer | null {
  let best: Offer | null = null;
  for (const offer of offers) {
    if (offerViewId(offer) !== offerId) continue;
    if (!Number.isSafeInteger(offer.priceSupplierKop) || offer.priceSupplierKop <= 0) continue;
    if (best === null || offer.priceSupplierKop < best.priceSupplierKop) best = offer;
  }
  return best;
}

type CartRow = typeof carts.$inferSelect;

/** The active cart of a token, locked for the rest of the transaction. */
async function lockActiveCart(tx: Executor, token: string | null): Promise<CartRow | null> {
  if (!isCartToken(token)) return null;
  const [cart] = await tx
    .select()
    .from(carts)
    .where(and(eq(carts.anonToken, token), eq(carts.status, 'active')))
    .for('update');
  return cart ?? null;
}

/**
 * The cart after a write that may grow it; above MAX_ORDER_TOTAL_KOP the write is refused
 * (thrown inside the transaction, so it rolls back): such a cart could never be checked out,
 * and its total would overflow the int4 *_kop columns of an order.
 */
async function boundedSnapshot(tx: Executor, cartId: string): Promise<CartSnapshot> {
  const result = await snapshot(tx, cartId);
  if (result.totalKop > MAX_ORDER_TOTAL_KOP) throw new CartRequestError('cart_total');
  return result;
}

async function snapshot(tx: Executor, cartId: string): Promise<CartSnapshot> {
  const rows = await tx
    .select({
      qty: cartItems.qty,
      priceClientKop: cartItems.priceClientKop,
      priceSupplierKop: cartItems.priceSupplierKop,
    })
    .from(cartItems)
    .where(eq(cartItems.cartId, cartId));
  return { count: rows.length, totalKop: cartTotals(rows).subtotalKop };
}

/** cart_items columns of a priced line (add, merge, the fit check analog). */
export function lineValues(line: Omit<CartLine, 'id'>, now: Date) {
  return {
    offerKey: line.offerKey,
    searchArticleNorm: line.searchArticleNorm,
    brand: line.offer.brand,
    article: line.offer.article,
    name: line.offer.name,
    qty: line.qty,
    stockId: line.offer.stock.stockId,
    isLocal: line.isLocal,
    etaDate: line.etaDate,
    priceSupplierKop: line.priceSupplierKop,
    priceClientKop: line.priceClientKop,
    markupBp: line.markupBp,
    offerSnapshot: line.offer,
    fetchedAt: now,
  };
}

/** Lines kept as stored when they could not be re-checked. */
function unchecked(lines: readonly CartLine[]): RepricedLine[] {
  return lines.map((line) => ({
    ...line,
    status: 'ok',
    available: line.offer.stock.count,
    multiplicity: Math.max(1, Math.trunc(line.offer.stock.multiplicity) || 1),
    stale: true,
  }));
}

export function createCartService(deps: CartServiceDeps): CartService {
  const { db } = deps;
  const now = deps.now ?? (() => new Date());

  function repriceContext(settings: CartSettings, at: Date): RepriceContext {
    return {
      pricing: settings.pricing,
      excludedRules: settings.excludedRules,
      eta: settings.eta,
      now: at,
    };
  }

  return {
    async addItem(input) {
      let articleNorm: string;
      try {
        articleNorm = normalizeSearchInput({
          q: typeof input.q === 'string' ? input.q : '',
        }).articleNorm;
      } catch (error) {
        if (error instanceof SearchInputError) throw new CartRequestError('invalid');
        throw error;
      }
      const offerId = input.offerId;
      if (typeof offerId !== 'string' || offerId === '' || offerId.length > MAX_OFFER_ID_LENGTH) {
        throw new CartRequestError('invalid');
      }
      const requestedQty = parseQty(input.qty);

      const settingsPromise = deps.loadSettings();
      let offers: Offer[];
      try {
        // Through the cache: the offer was just shown on /search.
        ({ offers } = await deps.supplier.rossko.search(articleNorm, { priority: 'search' }));
      } catch (error) {
        settingsPromise.then(undefined, () => undefined);
        if (!(isQuotaBreaker(error) || isRateLimit(error))) {
          deps.onError?.(error, 'cart add: supplier search');
        }
        throw supplierError(error);
      }
      const settings = await settingsPromise;
      const offer = pickOffer(offers, offerId);
      if (offer === null) throw new CartRequestError('offer_not_found');

      const at = now();
      const ctx = repriceContext(settings, at);
      const step = Math.max(1, Math.trunc(offer.stock.multiplicity) || 1);
      const qty = requestedQty ?? step;
      let line: Omit<CartLine, 'id'>;
      try {
        // Validates the stop list, price and quantity before anything is written.
        line = cartLineFromOffer(offer, articleNorm, qty, ctx);
      } catch (error) {
        fromCartError(error);
      }

      return db.transaction(async (tx) => {
        let cart = await lockActiveCart(tx, input.token);
        let created = false;
        if (cart === null) {
          const [inserted] = await tx
            .insert(carts)
            .values({ anonToken: newCartToken(), status: 'active' })
            .returning();
          if (!inserted) throw new Error('cart insert returned nothing');
          cart = inserted;
          created = true;
        }
        const cartId = cart.id;
        const existingLines = await tx
          .select({
            id: cartItems.id,
            offerKey: cartItems.offerKey,
            searchArticleNorm: cartItems.searchArticleNorm,
            qty: cartItems.qty,
          })
          .from(cartItems)
          .where(eq(cartItems.cartId, cartId));
        const existing = existingLines.find((l) => l.offerKey === line.offerKey);
        let lineId: string;
        if (existing) {
          lineId = existing.id;
          // Same offer again: one line with the summed quantity, priced from the fresh offer.
          // The line keeps its query article (the number of distinct searches stays the same).
          let merged: Omit<CartLine, 'id'>;
          try {
            merged = cartLineFromOffer(offer, existing.searchArticleNorm, existing.qty + qty, ctx);
          } catch (error) {
            fromCartError(error);
          }
          await tx
            .update(cartItems)
            .set({ ...lineValues(merged, at), updatedAt: at })
            .where(eq(cartItems.id, existing.id));
        } else {
          if (existingLines.length >= MAX_CART_LINES) throw new CartRequestError('cart_full');
          const searches = new Set(existingLines.map((l) => l.searchArticleNorm));
          if (!searches.has(articleNorm) && searches.size >= MAX_CART_SEARCHES) {
            throw new CartRequestError('too_many_searches');
          }
          const [inserted] = await tx
            .insert(cartItems)
            .values({ cartId, ...lineValues(line, at) })
            .returning({ id: cartItems.id });
          if (!inserted) throw new Error('cart line insert returned nothing');
          lineId = inserted.id;
        }
        await tx.update(carts).set({ updatedAt: at }).where(eq(carts.id, cartId));
        const totals = await boundedSnapshot(tx, cartId);
        return { ...totals, token: cart.anonToken ?? '', created, lineId };
      });
    },

    async updateItem(input) {
      const lineId = parseLineId(input.lineId);
      const qty = parseQty(input.qty);
      if (qty === undefined) throw new CartRequestError('invalid');
      const at = now();
      return db.transaction(async (tx) => {
        const cart = await lockActiveCart(tx, input.token);
        if (cart === null) throw new CartRequestError('line_not_found');
        const [row] = await tx
          .select()
          .from(cartItems)
          .where(and(eq(cartItems.id, lineId), eq(cartItems.cartId, cart.id)));
        if (!row) throw new CartRequestError('line_not_found');
        // Stock and step of the stored offer; the page and checkout re-check them fresh.
        const check = validateQty(qty, {
          available: row.offerSnapshot.stock.count,
          multiplicity: row.offerSnapshot.stock.multiplicity,
        });
        if (!check.ok) throw new CartRequestError('qty', check.message);
        if (qty !== row.qty) {
          await tx.update(cartItems).set({ qty, updatedAt: at }).where(eq(cartItems.id, row.id));
          await tx.update(carts).set({ updatedAt: at }).where(eq(carts.id, cart.id));
        }
        return qty > row.qty ? boundedSnapshot(tx, cart.id) : snapshot(tx, cart.id);
      });
    },

    async removeItem(input) {
      const lineId = parseLineId(input.lineId);
      const at = now();
      return db.transaction(async (tx) => {
        const cart = await lockActiveCart(tx, input.token);
        if (cart === null) throw new CartRequestError('line_not_found');
        // A fit check of this line still waiting for the master is cancelled (step 4).
        if ((await removeCartLines(tx, cart.id, [lineId])) === 0) {
          throw new CartRequestError('line_not_found');
        }
        await tx.update(carts).set({ updatedAt: at }).where(eq(carts.id, cart.id));
        return snapshot(tx, cart.id);
      });
    },

    async viewCart(token) {
      if (!isCartToken(token)) return null;
      const active = await findActiveCart(db, token);
      if (active === null || active.lines.length === 0) return null;
      const settings = await deps.loadSettings();
      const at = now();
      const base = { cartId: active.cart.id, settings, now: at };
      try {
        // Cache only: opening the cart never calls the supplier (a miss keeps stored prices).
        const fresh = await fetchFreshOffers(
          deps.supplier.rossko,
          active.lines.map((l) => l.searchArticleNorm),
          { priority: 'search', cacheOnly: true },
        );
        const { lines, changes } = repriceCartLines(
          active.lines,
          fresh,
          repriceContext(settings, at),
        );
        await persistRepricing(db, active.cart.id, lines, { now: at });
        const kept = lines.filter((l) => l.status === 'ok');
        if (kept.length === 0 && changes.length === 0) return null;
        return { ...base, lines: kept, changes, stale: kept.some((l) => l.stale) };
      } catch (error) {
        deps.onError?.(error, 'cart repricing');
        return { ...base, lines: unchecked(active.lines), changes: [], stale: true };
      }
    },
  };
}
