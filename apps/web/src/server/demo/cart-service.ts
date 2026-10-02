/**
 * DemoCartService: the CartService contract (server/cart/cart-service.ts) over the signed
 * `demo_cart` cookie instead of Postgres (DEMO_MODE, docs/design.md section 5).
 *
 * The same rules as the live cart: the offer is found again by the query article and offer id
 * through the supplier cache, the client never sends a price, the stop list, multiplicity and
 * stock are validated by the same domain functions, and the cart is bounded by MAX_CART_LINES,
 * MAX_CART_SEARCHES and MAX_ORDER_TOTAL_KOP. Prices are recomputed from the fixtures on every
 * read, so nothing priced is stored in the browser.
 *
 * The `token` arguments of the contract are ignored: the cart is whatever the jar holds. The
 * route handlers bind the jar to the request (server/demo/cart-http.ts), pages bind it to
 * next/headers cookies() read-only (server/cart/index.ts).
 */
import {
  CartError,
  cartLineFromOffer,
  cartTotals,
  MAX_ORDER_TOTAL_KOP,
  offerViewId,
  repriceCartLines,
  validateQty,
  type CartLine,
  type Offer,
  type RepriceContext,
} from '@detaly/domain';
import { QuotaBreakerError, RosskoRateLimitError, type RosskoClient } from '@detaly/rossko';
import { MAX_CART_LINES, MAX_CART_SEARCHES } from '../cart-store';
import {
  MAX_OFFER_ID_LENGTH,
  parseQty,
  type CartService,
  type CartSettings,
  type CartSnapshot,
  type CartView,
} from '../cart/cart-service';
import { CartRequestError, isNamedError } from '../cart/errors';
import { normalizeSearchInput, SearchInputError } from '../search-service';
import { newDemoLineId, type DemoCartLine } from './cart-cookie';

/** Where the demo cart lines are kept for one request. */
export interface DemoCartJar {
  read(): Promise<DemoCartLine[]>;
  /** Stores the new lines; pages pass a jar that refuses (they never write). */
  write(lines: DemoCartLine[]): void;
}

export interface DemoCartServiceDeps {
  jar: DemoCartJar;
  supplier: { rossko: Pick<RosskoClient, 'search'> };
  loadSettings: () => Promise<CartSettings>;
  now?: () => Date;
  onError?: (error: unknown, what: string) => void;
}

/** Id the cart view reports (there is no carts row). */
export const DEMO_CART_ID = 'demo';

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

/** Cheapest usable offer with this id (as the live cart picks it). */
function pickOffer(offers: readonly Offer[], offerId: string): Offer | null {
  let best: Offer | null = null;
  for (const offer of offers) {
    if (offerViewId(offer) !== offerId) continue;
    if (!Number.isSafeInteger(offer.priceSupplierKop) || offer.priceSupplierKop <= 0) continue;
    if (best === null || offer.priceSupplierKop < best.priceSupplierKop) best = offer;
  }
  return best;
}

function parseLineId(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
  ) {
    throw new CartRequestError('line_not_found');
  }
  return value.toLowerCase();
}

export function createDemoCartService(deps: DemoCartServiceDeps): CartService {
  const now = deps.now ?? (() => new Date());

  function context(settings: CartSettings, at: Date): RepriceContext {
    return {
      markupRules: settings.markupRules,
      excludedRules: settings.excludedRules,
      eta: settings.eta,
      now: at,
    };
  }

  async function search(articleNorm: string): Promise<Offer[]> {
    try {
      return (await deps.supplier.rossko.search(articleNorm, { priority: 'search' })).offers;
    } catch (error) {
      if (isNamedError(error, RosskoRateLimitError, 'RosskoRateLimitError')) {
        throw new CartRequestError(
          'supplier_unavailable',
          undefined,
          Math.max(1, Math.ceil(error.retryAfterMs / 1000)),
        );
      }
      if (!isNamedError(error, QuotaBreakerError, 'QuotaBreakerError')) {
        deps.onError?.(error, 'demo cart: supplier search');
      }
      throw new CartRequestError('supplier_unavailable');
    }
  }

  /** Fresh offers per query article of these lines (one search per article, cached). */
  async function freshOffers(lines: readonly DemoCartLine[]): Promise<Map<string, Offer[]>> {
    const articles = [...new Set(lines.map((line) => line.q))];
    const results = await Promise.all(articles.map((q) => search(q)));
    return new Map(articles.map((q, i) => [q, results[i] ?? []]));
  }

  /**
   * Priced cart lines of the stored ones. Lines whose offer is gone or no longer sellable are
   * dropped (`strict`: an error instead, for writes that must not lose a line silently).
   */
  function priceLines(
    stored: readonly DemoCartLine[],
    fresh: ReadonlyMap<string, Offer[]>,
    ctx: RepriceContext,
  ): CartLine[] {
    const lines: CartLine[] = [];
    for (const line of stored) {
      const offer = pickOffer(fresh.get(line.q) ?? [], line.offerId);
      if (offer === null) continue;
      try {
        lines.push({ id: line.id, ...cartLineFromOffer(offer, line.q, line.qty, ctx) });
      } catch (error) {
        if (!(error instanceof CartError)) throw error;
      }
    }
    return lines;
  }

  async function snapshotOf(
    stored: readonly DemoCartLine[],
    settings: CartSettings,
    at: Date,
    bounded: boolean,
  ): Promise<CartSnapshot> {
    const lines = priceLines(stored, await freshOffers(stored), context(settings, at));
    const totalKop = cartTotals(lines).subtotalKop;
    if (bounded && totalKop > MAX_ORDER_TOTAL_KOP) throw new CartRequestError('cart_total');
    return { count: stored.length, totalKop };
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
      const [settings, offers, stored] = await Promise.all([
        deps.loadSettings(),
        search(articleNorm),
        deps.jar.read(),
      ]);
      const offer = pickOffer(offers, offerId);
      if (offer === null) throw new CartRequestError('offer_not_found');
      const at = now();
      const ctx = context(settings, at);
      const step = Math.max(1, Math.trunc(offer.stock.multiplicity) || 1);
      const qty = requestedQty ?? step;
      try {
        cartLineFromOffer(offer, articleNorm, qty, ctx);
      } catch (error) {
        fromCartError(error);
      }

      const existing = stored.find((line) => line.offerId === offerId);
      let next: DemoCartLine[];
      if (existing) {
        // Same offer again: one line with the summed quantity (it keeps its query article).
        try {
          cartLineFromOffer(offer, existing.q, existing.qty + qty, ctx);
        } catch (error) {
          fromCartError(error);
        }
        next = stored.map((line) =>
          line.id === existing.id ? { ...line, qty: line.qty + qty } : line,
        );
      } else {
        if (stored.length >= MAX_CART_LINES) throw new CartRequestError('cart_full');
        const searches = new Set(stored.map((line) => line.q));
        if (!searches.has(articleNorm) && searches.size >= MAX_CART_SEARCHES) {
          throw new CartRequestError('too_many_searches');
        }
        next = [...stored, { id: newDemoLineId(), q: articleNorm, offerId, qty }];
      }
      const totals = await snapshotOf(next, settings, at, true);
      deps.jar.write(next);
      return { ...totals, token: '', created: stored.length === 0 };
    },

    async updateItem(input) {
      const lineId = parseLineId(input.lineId);
      const qty = parseQty(input.qty);
      if (qty === undefined) throw new CartRequestError('invalid');
      const [settings, stored] = await Promise.all([deps.loadSettings(), deps.jar.read()]);
      const line = stored.find((l) => l.id === lineId);
      if (!line) throw new CartRequestError('line_not_found');
      const offer = pickOffer(await search(line.q), line.offerId);
      if (offer === null) throw new CartRequestError('offer_not_found');
      const check = validateQty(qty, {
        available: offer.stock.count,
        multiplicity: offer.stock.multiplicity,
      });
      if (!check.ok) throw new CartRequestError('qty', check.message);
      const next = stored.map((l) => (l.id === lineId ? { ...l, qty } : l));
      const totals = await snapshotOf(next, settings, now(), qty > line.qty);
      if (qty !== line.qty) deps.jar.write(next);
      return totals;
    },

    async removeItem(input) {
      const lineId = parseLineId(input.lineId);
      const [settings, stored] = await Promise.all([deps.loadSettings(), deps.jar.read()]);
      if (!stored.some((l) => l.id === lineId)) throw new CartRequestError('line_not_found');
      const next = stored.filter((l) => l.id !== lineId);
      deps.jar.write(next);
      return snapshotOf(next, settings, now(), false);
    },

    async viewCart(): Promise<CartView | null> {
      const stored = await deps.jar.read();
      if (stored.length === 0) return null;
      const settings = await deps.loadSettings();
      const at = now();
      const ctx = context(settings, at);
      let fresh: Map<string, Offer[]>;
      try {
        fresh = await freshOffers(stored);
      } catch (error) {
        deps.onError?.(error, 'demo cart view');
        return null;
      }
      const lines = priceLines(stored, fresh, ctx);
      if (lines.length === 0) return null;
      const repriced = repriceCartLines(lines, fresh, ctx).lines.filter((l) => l.status === 'ok');
      if (repriced.length === 0) return null;
      return {
        cartId: DEMO_CART_ID,
        lines: repriced,
        changes: [],
        stale: false,
        settings,
        now: at,
      };
    },
  };
}
