/**
 * Shapes of the pre-order recheck (decision Б12): «Проверить и заказать» re-runs GetSearch
 * bypassing the cache, compares supplier prices and stock with the order and proposes
 * alternatives for problem items. The implementation (`recheckOrder`) lives in recheck.ts
 * (package rossko-ops); the engine and the rossko worker only pass these shapes around.
 */
import type { ApprovalProposal, BasisPoints, Kop, Offer } from './types';

/** An order item as the recheck sees it (an order_items row, reduced). */
export interface RecheckItemInput {
  orderItemId: string;
  /** order_items.offer_key: `${articleNorm}:${brand}:${stockId}`. */
  offerKey: string;
  /** The article the offer was found by; GetSearch is repeated with it. */
  searchArticleNorm: string;
  qty: number;
  /** order_items.price_supplier_at_order_kop (per unit). */
  priceSupplierKop: Kop;
  /** order_items.price_client_kop (per unit); alternatives are offered at this price. */
  priceClientKop: Kop;
  /** order_items.offer_snapshot. */
  offer: Offer;
}

/**
 * An alternative for a problem item at the client's price: the same fields as the
 * `alternative` approval proposal, so the seller's choice becomes a proposal unchanged.
 */
export type RecheckAlternative = Omit<
  Extract<ApprovalProposal, { kind: 'alternative' }>,
  'kind'
> & {
  /** Fresh stock count of the alternative. */
  available: number;
};

/**
 * - ok: the same offer is there, with enough stock;
 * - unavailable: the offer (same offer_key) disappeared from the fresh search;
 * - insufficient: the offer is there, but stock < qty;
 * - excluded: the offer now falls into an excluded (marked) group.
 * Price drift is reported per item (driftBp) and decided for the whole order (priceDriftBp).
 */
export type RecheckItemStatus = 'ok' | 'unavailable' | 'insufficient' | 'excluded';

export interface RecheckItemResult {
  orderItemId: string;
  offerKey: string;
  status: RecheckItemStatus;
  qty: number;
  /** Supplier price per unit at checkout. */
  oldPriceSupplierKop: Kop;
  /** Fresh supplier price per unit; null when the offer is gone. */
  freshPriceSupplierKop: Kop | null;
  /** ceil((fresh - old) * 10000 / old); null when the offer is gone. */
  driftBp: BasisPoints | null;
  /** Fresh stock count; null when the offer is gone. */
  available: number | null;
  /** Up to 3 cheapest alternatives with margin >= the floor; empty for ok items within drift. */
  alternatives: RecheckAlternative[];
}

/** Why the recheck did not pass (orders.attention_reason). */
export type RecheckReason = 'price_drift' | 'unavailable';

export interface RecheckResult {
  items: RecheckItemResult[];
  /** Order drift: ceil((Σ fresh·qty − Σ old·qty) · 10000 / Σ old·qty); 0 when nothing is left. */
  priceDriftBp: BasisPoints;
  /** Every item has an offer with the same offer_key and stock >= qty (and is not excluded). */
  allAvailable: boolean;
  /** Σ old supplier price x qty. */
  oldSupplierTotalKop: Kop;
  /** Σ fresh supplier price x qty over the items that still have an offer. */
  freshSupplierTotalKop: Kop;
  /** null when the recheck passes against the tolerance given to recheckOrder. */
  reason: RecheckReason | null;
}
