/**
 * Cart lines (phase 1A, docs/phase-1a-implementation.md section 3.2): building a line from a
 * supplier offer, quantity rules, repricing against fresh supplier offers, totals, the
 * local / to-order split and the canonical items hash payload. Pure: `now` comes in `ctx`.
 *
 * VERIFY: a line is matched to fresh offers by offerKey = `${articleNorm}:${brand}:${stockId}`
 * and searched again by the query article (searchArticleNorm). Both assume that live Rossko
 * keeps stock ids stable between calls and returns crosses for the original query article
 * (docs/external.md, R13–R15). Fixtures behave this way.
 */
import { CLIENT_TIME_ZONE, DateError, etaDate } from './dates';
import { isExcluded } from './excluded';
import { MoneyError, safeMul, sumKop } from './money';
import { offerViewId } from './offers';
import { price } from './pricing';
import type {
  CartLine,
  CartPart,
  CartTotals,
  IsoDate,
  LineChange,
  Offer,
  RepriceContext,
  RepricedLine,
} from './types';

/** Largest quantity of one line. */
export const MAX_LINE_QTY = 99;

/** cart_items.search_article_norm / order_items.search_article_norm (DB check). */
export const ARTICLE_NORM_RE = /^[A-Z0-9]{1,64}$/;

export type CartErrorCode = 'excluded' | 'qty' | 'price' | 'article';

export class CartError extends Error {
  override name = 'CartError';
  readonly code: CartErrorCode;

  constructor(code: CartErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

/** What can be shown anywhere (also in messengers): brand and article, 'Knecht OC 90'. */
export function lineTitle(offer: Pick<Offer, 'brand' | 'article'>): string {
  return `${offer.brand} ${offer.article}`.replace(/\s+/g, ' ').trim();
}

export type QtyCheck = { ok: true } | { ok: false; message: string };

/** Integer 1..MAX_LINE_QTY, a multiple of `multiplicity` and not above the supplier stock. */
export function validateQty(
  qty: number,
  { available, multiplicity }: { available: number; multiplicity: number },
): QtyCheck {
  const step = Math.max(1, Math.trunc(multiplicity) || 1);
  if (!Number.isSafeInteger(qty) || qty < 1 || qty > MAX_LINE_QTY) {
    return { ok: false, message: `Количество — целое число от 1 до ${MAX_LINE_QTY}` };
  }
  if (qty % step !== 0) {
    return { ok: false, message: `Эта деталь продаётся по ${step} шт.: количество кратно ${step}` };
  }
  if (!Number.isSafeInteger(available) || available < step) {
    return { ok: false, message: 'Нет в наличии' };
  }
  if (qty > available) {
    return { ok: false, message: `В наличии только ${available} шт.` };
  }
  return { ok: true };
}

interface PricedOffer {
  offer: Offer;
  priceClientKop: number;
  markupBp: number;
  etaDate: IsoDate;
}

/** Client price and date of an offer, or null when its price or delivery term is unusable. */
function priceOffer(offer: Offer, ctx: RepriceContext): PricedOffer | null {
  if (!Number.isSafeInteger(offer.priceSupplierKop) || offer.priceSupplierKop <= 0) return null;
  let eta: IsoDate;
  try {
    eta = etaDate(offer.stock, ctx.now, ctx.timeZone ?? CLIENT_TIME_ZONE);
  } catch (error) {
    if (error instanceof DateError) return null;
    throw error;
  }
  try {
    const priced = price(ctx.markupRules, offer.priceSupplierKop, offer.stock.isLocal);
    return { offer, ...priced, etaDate: eta };
  } catch (error) {
    if (error instanceof MoneyError) return null;
    throw error;
  }
}

/**
 * A new cart line for `qty` units of `offer` found by the query `searchArticleNorm`.
 * Throws CartError: 'excluded' (marked goods), 'price' (no usable price or delivery date),
 * 'qty' (validateQty), 'article' (query article is not [A-Z0-9]{1,64}).
 */
export function cartLineFromOffer(
  offer: Offer,
  searchArticleNorm: string,
  qty: number,
  ctx: RepriceContext,
): Omit<CartLine, 'id'> {
  if (!ARTICLE_NORM_RE.test(searchArticleNorm)) {
    throw new CartError('article', 'Неверный артикул запроса');
  }
  const exclusion = isExcluded({ name: offer.name, group: offer.group }, ctx.excludedRules);
  if (exclusion.excluded) {
    throw new CartError('excluded', 'Не продаём онлайн, спросите в сервисе');
  }
  const priced = priceOffer(offer, ctx);
  if (priced === null) {
    throw new CartError('price', 'У предложения нет цены или срока поставки');
  }
  const check = validateQty(qty, {
    available: offer.stock.count,
    multiplicity: offer.stock.multiplicity,
  });
  if (!check.ok) throw new CartError('qty', check.message);
  return {
    offerKey: offerViewId(offer),
    searchArticleNorm,
    qty,
    priceSupplierKop: offer.priceSupplierKop,
    priceClientKop: priced.priceClientKop,
    markupBp: priced.markupBp,
    isLocal: offer.stock.isLocal,
    etaDate: priced.etaDate,
    offer,
  };
}

function stepOf(offer: Offer): number {
  return Math.max(1, Math.trunc(offer.stock.multiplicity) || 1);
}

/**
 * Re-prices lines against fresh supplier offers keyed by the query article
 * (`freshBySearch.get(line.searchArticleNorm)`):
 * - `null` (or no entry): that search failed; the line stays as it is (`stale: true`), no change;
 * - no fresh offer with the line's offerKey, or none with a usable price and date -> unavailable;
 * - several fresh offers with the same key -> the cheapest (as buildOfferViews);
 * - the offer is marked goods now -> excluded;
 * - stock below the quantity (or a new multiplicity) -> the largest multiple of the step that
 *   fits; 0 -> unavailable;
 * - a different client price -> a `price` change (delta per unit).
 * The delivery date is refreshed silently: it is not part of the items hash.
 */
export function repriceCartLines(
  lines: readonly CartLine[],
  freshBySearch: ReadonlyMap<string, readonly Offer[] | null>,
  ctx: RepriceContext,
): { lines: RepricedLine[]; changes: LineChange[] } {
  const out: RepricedLine[] = [];
  const changes: LineChange[] = [];
  for (const line of lines) {
    const fresh = freshBySearch.get(line.searchArticleNorm);
    const title = lineTitle(line.offer);
    const base = { lineId: line.id, offerKey: line.offerKey, title };
    if (fresh === undefined || fresh === null) {
      out.push({
        ...line,
        status: 'ok',
        available: line.offer.stock.count,
        multiplicity: stepOf(line.offer),
        stale: true,
      });
      continue;
    }
    let best: PricedOffer | null = null;
    for (const offer of fresh) {
      if (offerViewId(offer) !== line.offerKey) continue;
      const priced = priceOffer(offer, ctx);
      if (priced !== null && (best === null || priced.priceClientKop < best.priceClientKop)) {
        best = priced;
      }
    }
    if (best === null) {
      out.push({
        ...line,
        status: 'unavailable',
        available: 0,
        multiplicity: stepOf(line.offer),
        stale: false,
      });
      changes.push({ kind: 'unavailable', ...base });
      continue;
    }
    const { offer } = best;
    const available = offer.stock.count;
    const multiplicity = stepOf(offer);
    const exclusion = isExcluded({ name: offer.name, group: offer.group }, ctx.excludedRules);
    if (exclusion.excluded) {
      out.push({ ...line, status: 'excluded', available, multiplicity, stale: false });
      changes.push({ kind: 'excluded', ...base, reason: exclusion.reason ?? '' });
      continue;
    }
    let qty = line.qty;
    if (qty > available || qty % multiplicity !== 0 || qty > MAX_LINE_QTY) {
      const cap = Math.min(qty, Number.isSafeInteger(available) ? available : 0, MAX_LINE_QTY);
      qty = Math.max(0, Math.floor(cap / multiplicity) * multiplicity);
    }
    if (qty === 0) {
      out.push({ ...line, status: 'unavailable', available, multiplicity, stale: false });
      changes.push({ kind: 'unavailable', ...base });
      continue;
    }
    const updated: RepricedLine = {
      ...line,
      qty,
      priceSupplierKop: offer.priceSupplierKop,
      priceClientKop: best.priceClientKop,
      markupBp: best.markupBp,
      isLocal: offer.stock.isLocal,
      etaDate: best.etaDate,
      offer,
      status: 'ok',
      available,
      multiplicity,
      stale: false,
    };
    if (best.priceClientKop !== line.priceClientKop) {
      changes.push({
        kind: 'price',
        ...base,
        oldPriceKop: line.priceClientKop,
        newPriceKop: best.priceClientKop,
        deltaKop: best.priceClientKop - line.priceClientKop,
      });
    }
    if (qty !== line.qty) {
      changes.push({ kind: 'qty', ...base, oldQty: line.qty, newQty: qty });
    }
    out.push(updated);
  }
  return { lines: out, changes };
}

type PricedQty = Pick<CartLine, 'qty' | 'priceClientKop' | 'priceSupplierKop'>;

/** Sums in integer kopecks (overflow throws MoneyError). */
export function cartTotals(lines: readonly PricedQty[]): CartTotals {
  const subtotalKop = sumKop(lines.map((l) => safeMul(l.priceClientKop, l.qty)));
  const supplierKop = sumKop(lines.map((l) => safeMul(l.priceSupplierKop, l.qty)));
  let itemsCount = 0;
  for (const line of lines) itemsCount += line.qty;
  return { subtotalKop, supplierKop, marginKop: subtotalKop - supplierKop, itemsCount };
}

/** Orenburg lines and to-order lines; `mixed` when both are present. */
export function splitCartLines<T extends Pick<CartLine, 'isLocal'>>(
  lines: readonly T[],
): { local: T[]; toOrder: T[]; mixed: boolean } {
  const local = lines.filter((l) => l.isLocal);
  const toOrder = lines.filter((l) => !l.isLocal);
  return { local, toOrder, mixed: local.length > 0 && toOrder.length > 0 };
}

/**
 * Lines of the requested part. A homogeneous cart ignores `part` (all lines): after the local
 * part is checked out, `/checkout?part=order` sees only to-order lines and takes them all.
 */
export function selectCartPart<T extends Pick<CartLine, 'isLocal'>>(
  lines: readonly T[],
  part: CartPart,
): T[] {
  const { local, toOrder, mixed } = splitCartLines(lines);
  if (!mixed || part === 'all') return [...lines];
  return part === 'local' ? local : toOrder;
}

/**
 * Canonical string hashed into items_hash (decision Д8): `offerKey|qty|priceClientKop` per
 * line, sorted by offerKey, joined by '\n'. Dates are not part of it.
 */
export function itemsHashPayload(
  lines: readonly Pick<CartLine, 'offerKey' | 'qty' | 'priceClientKop'>[],
): string {
  return [...lines]
    .sort((a, b) => (a.offerKey < b.offerKey ? -1 : a.offerKey > b.offerKey ? 1 : 0))
    .map((l) => `${l.offerKey}|${l.qty}|${l.priceClientKop}`)
    .join('\n');
}
