/**
 * Raw Rossko responses -> typed data. Field names follow open-source clients
 * (mirikoff/rossko-api-manager, tamgdemaslo/vin_oil_mann) and must be re-checked against real
 * responses recorded by scripts/rossko-smoke.ts.
 *
 * Robustness rules (the input is never trusted):
 * - single objects and arrays are both accepted (toArray), key casing is ignored;
 * - prices are converted with rubToKop (no floats); a stock with a bad or zero price, zero
 *   quantity, no id or no delivery term (no days and no parseable deliveryEnd) is dropped, the
 *   rest of the response survives;
 * - multiplicity defaults to 1, missing deliveryStart/deliveryEnd become null;
 * - crosses are flagged isCross; duplicates (same article, brand, stock) are dropped.
 */
import { parseSupplierTimestamp } from '@detaly/domain';
import type { Offer, StockInfo } from '@detaly/domain/types';
import { normalizeArticle, rubToKop } from './normalize';
import { bool, field, firstField, int, isObject, listOf, str, toArray, unwrapResult } from './raw';
import type {
  CheckoutDetails,
  CheckoutItemError,
  CheckoutLine,
  CheckoutResult,
  OrdersResult,
  ParsedSearch,
  RosskoMethod,
  RosskoOrder,
} from './types';

export interface MapSearchOptions {
  localStockIds: readonly string[];
}

/** The response does not look like a Rossko result at all (not cached, reported as failure). */
export class RosskoResponseError extends Error {
  readonly method: RosskoMethod;

  constructor(method: RosskoMethod, message: string) {
    super(`Rossko ${method}: ${message}`);
    this.name = 'RosskoResponseError';
    this.method = method;
  }
}

function resultOf(method: RosskoMethod, raw: unknown) {
  const result = unwrapResult(raw);
  if (!result) throw new RosskoResponseError(method, 'unexpected response shape');
  return result;
}

function successOf(result: Record<string, unknown>, hasPayload: boolean): boolean {
  return bool(field(result, 'success')) ?? hasPayload;
}

/** Kopecks or null for missing/invalid amounts (`{$value: '1.00'}` nodes are unwrapped). */
function kopOrNull(value: unknown): number | null {
  const amount = typeof value === 'number' ? value : str(value);
  if (amount === null) return null;
  try {
    return rubToKop(amount);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// GetSearch
// ---------------------------------------------------------------------------

function mapStock(raw: unknown, localStockIds: ReadonlySet<string>) {
  if (!isObject(raw)) return null;
  const stockId = str(firstField(raw, ['id', 'stock_id', 'stockId']));
  if (stockId === null) return null;
  const priceKop = kopOrNull(field(raw, 'price'));
  if (priceKop === null || priceKop <= 0) return null;
  // VERIFY: a non-numeric stock count such as '>10' or '10+' (meaning and frequency unknown,
  // docs/external.md R13) drops the offer for now; if it is common, read it as a lower bound.
  const count = int(field(raw, 'count'));
  if (count === null || count <= 0) return null;
  // A negative term is not a real promise (e.g. -1 for "unknown"): treat it as missing.
  const deliveryRaw = int(field(raw, 'delivery'));
  const delivery = deliveryRaw !== null && deliveryRaw >= 0 ? deliveryRaw : null;
  const deliveryEnd = str(field(raw, 'deliveryEnd'));
  // Without a delivery term we cannot promise a date: skip the stock. A deliveryEnd that is
  // not a date we understand ('скоро', '08/10') is no term either: never promise "today".
  if (delivery === null && (deliveryEnd === null || parseSupplierTimestamp(deliveryEnd) === null)) {
    return null;
  }
  const multiplicity = int(field(raw, 'multiplicity'));
  const stock: StockInfo = {
    stockId,
    isLocal: localStockIds.has(stockId),
    count,
    multiplicity: multiplicity === null || multiplicity < 1 ? 1 : multiplicity,
    type: str(field(raw, 'type')),
    deliveryDays: delivery,
    deliveryStart: str(field(raw, 'deliveryStart')),
    deliveryEnd,
    extra: str(field(raw, 'extra')),
    description: str(field(raw, 'description')),
  };
  return { priceKop, stock };
}

function mapPart(
  raw: unknown,
  isCross: boolean,
  localStockIds: ReadonlySet<string>,
  seen: Set<string>,
  out: Offer[],
): void {
  if (!isObject(raw)) return;
  const brand = str(field(raw, 'brand'));
  const article = str(firstField(raw, ['partnumber', 'article', 'number']));
  if (brand !== null && article !== null) {
    const articleNorm = normalizeArticle(article);
    if (articleNorm !== '') {
      const name = str(field(raw, 'name')) ?? '';
      const group = str(firstField(raw, ['group', 'productGroup', 'product_group', 'category']));
      for (const rawStock of listOf(field(raw, 'stocks'), ['stock'])) {
        const mapped = mapStock(rawStock, localStockIds);
        if (!mapped) continue;
        const key = `${articleNorm}:${brand.toUpperCase()}:${mapped.stock.stockId}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({
          source: 'rossko',
          brand,
          article,
          articleNorm,
          name,
          group,
          isCross,
          priceSupplierKop: mapped.priceKop,
          stock: mapped.stock,
        });
      }
    }
  }
  // Crosses are one level deep; a cross of a cross is still a cross.
  if (!isCross) {
    for (const cross of listOf(field(raw, 'crosses'), ['Part'])) {
      mapPart(cross, true, localStockIds, seen, out);
    }
  }
}

/** GetSearch response -> success flag, supplier message and flat offers (part x stock). */
export function parseSearchResponse(raw: unknown, options: MapSearchOptions): ParsedSearch {
  const result = resultOf('GetSearch', raw);
  const parts = listOf(field(result, 'PartsList'), ['Part']);
  const localStockIds = new Set(options.localStockIds);
  const seen = new Set<string>();
  const offers: Offer[] = [];
  for (const part of parts) mapPart(part, false, localStockIds, seen, offers);
  return {
    success: successOf(result, parts.length > 0),
    message: str(field(result, 'message')),
    offers,
  };
}

/** GetSearch response -> Offer[]; `success:false` (nothing found) gives []. */
export function mapSearchResult(raw: unknown, options: MapSearchOptions): Offer[] {
  return parseSearchResponse(raw, options).offers;
}

/** Re-applies `isLocal` (local stock ids live in settings and may change after caching). */
export function applyLocalStocks(
  offers: readonly Offer[],
  localStockIds: readonly string[],
): Offer[] {
  const local = new Set(localStockIds);
  return offers.map((offer) => {
    const isLocal = local.has(offer.stock.stockId);
    return offer.stock.isLocal === isLocal
      ? offer
      : { ...offer, stock: { ...offer.stock, isLocal } };
  });
}

// ---------------------------------------------------------------------------
// GetCheckoutDetails (structure is a guess, see fixtures/GetCheckoutDetails.json)
// ---------------------------------------------------------------------------

export function mapCheckoutDetails(raw: unknown): CheckoutDetails {
  const result = resultOf('GetCheckoutDetails', raw);
  const deliveries = listOf(firstField(result, ['DeliveryList', 'deliveries']), ['delivery'])
    .filter(isObject)
    .flatMap((d) => {
      const id = str(field(d, 'id'));
      if (id === null) return [];
      return [
        {
          id,
          name: str(field(d, 'name')),
          costKop: kopOrNull(firstField(d, ['cost', 'price'])),
          freeFromKop: kopOrNull(firstField(d, ['free_from', 'freeFrom', 'min_sum'])),
        },
      ];
    });
  const payments = listOf(firstField(result, ['PaymentList', 'payments']), ['payment'])
    .filter(isObject)
    .flatMap((p) => {
      const id = str(field(p, 'id'));
      return id === null ? [] : [{ id, name: str(field(p, 'name')) }];
    });
  const addresses = listOf(firstField(result, ['AddressList', 'addresses']), ['address'])
    .filter(isObject)
    .flatMap((a) => {
      const id = str(field(a, 'id'));
      if (id === null) return [];
      const parts = ['city', 'street', 'house', 'office']
        .map((key) => str(field(a, key)))
        .filter((part): part is string => part !== null);
      return [{ id, text: parts.join(', ') }];
    });
  return {
    success: successOf(result, deliveries.length > 0),
    message: str(field(result, 'message')),
    deliveries,
    payments,
    addresses,
  };
}

// ---------------------------------------------------------------------------
// GetCheckout
// ---------------------------------------------------------------------------

function mapLine(raw: unknown): CheckoutLine | null {
  if (!isObject(raw)) return null;
  const brand = str(field(raw, 'brand'));
  const article = str(firstField(raw, ['partnumber', 'article']));
  if (brand === null || article === null) return null;
  return {
    brand,
    article,
    stockId: str(firstField(raw, ['stock', 'stock_id', 'stockId'])),
    count: int(field(raw, 'count')) ?? 0,
    priceKop: kopOrNull(field(raw, 'price')),
  };
}

export function mapCheckoutResult(raw: unknown): CheckoutResult {
  const result = resultOf('GetCheckout', raw);
  const orderIdsRaw = field(result, 'OrderIDS');
  const orderIds = (isObject(orderIdsRaw) ? listOf(orderIdsRaw, ['id']) : toArray(orderIdsRaw))
    .map((id) => str(id))
    .filter((id): id is string => id !== null);
  const deliveryCostRaw = field(result, 'DeliveryCost');
  const deliveryCostKop = kopOrNull(
    isObject(deliveryCostRaw) ? field(deliveryCostRaw, 'cost') : deliveryCostRaw,
  );
  const items = listOf(field(result, 'ItemsList'), ['Item'])
    .map(mapLine)
    .filter((line): line is CheckoutLine => line !== null);
  const itemErrors = listOf(field(result, 'ItemsErrorList'), ['ItemError']).flatMap(
    (rawError): CheckoutItemError[] => {
      const line = mapLine(rawError);
      if (!line) return [];
      const { priceKop: _priceKop, ...rest } = line;
      return [{ ...rest, message: str(firstField(rawError, ['message', 'error', 'text'])) }];
    },
  );
  return {
    success: successOf(result, orderIds.length > 0),
    message: str(field(result, 'message')),
    orderIds,
    deliveryCostKop,
    items,
    itemErrors,
  };
}

// ---------------------------------------------------------------------------
// GetOrders
// ---------------------------------------------------------------------------

export function mapOrdersResult(raw: unknown): OrdersResult {
  const result = resultOf('GetOrders', raw);
  const orders = listOf(firstField(result, ['OrdersList', 'orders']), ['Order'])
    .filter(isObject)
    .flatMap((o): RosskoOrder[] => {
      const id = str(field(o, 'id'));
      if (id === null) return [];
      const items = listOf(firstField(o, ['parts', 'items', 'PartsList']), ['part', 'item'])
        .filter(isObject)
        .flatMap((p) => {
          const brand = str(field(p, 'brand'));
          const article = str(firstField(p, ['partnumber', 'article']));
          if (brand === null || article === null) return [];
          return [
            {
              brand,
              article,
              stockId: str(firstField(p, ['stock', 'stock_id', 'stockId'])),
              count: int(field(p, 'count')) ?? 0,
              priceKop: kopOrNull(field(p, 'price')),
              statusCode: int(field(p, 'status')),
            },
          ];
        });
      return [
        {
          id,
          statusCode: int(field(o, 'status')),
          statusText: str(firstField(o, ['status_name', 'statusName', 'status_text'])),
          createdAt: str(firstField(o, ['created', 'created_at', 'date'])),
          // VERIFY: the comment field of GetOrders is a guess (docs/external.md R10, R11).
          comment: str(firstField(o, ['comment', 'note', 'description'])),
          items,
        },
      ];
    });
  return {
    success: successOf(result, orders.length > 0),
    message: str(field(result, 'message')),
    orders,
  };
}
