/**
 * GetCheckout result -> our order items (decisions Б13, Б14, docs/phase-1b-implementation.md
 * section 8): which requested lines Rossko ordered (ItemsList), which it refused
 * (ItemsErrorList) and which cannot be told. Plus the order comment used to find a timed-out
 * checkout again in GetOrders.
 *
 * VERIFY: Rossko echoes article, brand, stock and count of every line in ItemsList and
 * ItemsErrorList as we sent them (docs/external.md R10). Lines are compared by normalized
 * article and brand, case-insensitive stock id and exact count; a result line without a stock id
 * (GetOrders lines may have none) matches on the other three when that is unique.
 */
import { normalizeArticle } from './normalize';
import type {
  CheckoutItemError,
  CheckoutItemRequest,
  CheckoutLine,
  CheckoutResult,
  RosskoOrder,
} from './types';

/** orders.number: 'DT-000123' (DB check orders_number). */
const ORDER_NUMBER_RE = /^DT-[0-9]{6}$/;

/** A line sent to GetCheckout, tagged with our id (supplier_order_items / order_items). */
export interface CheckoutMatchRequest extends CheckoutItemRequest {
  id: string;
}

export interface CheckoutMatch {
  /** Requested lines found in ItemsList. */
  covered: { id: string; line: CheckoutLine }[];
  /** Requested lines found in ItemsErrorList. */
  failed: { id: string; error: CheckoutItemError }[];
  /**
   * Ids of requested lines found in neither list (e.g. a partial count). Their fate is unknown:
   * the caller must not order them again without a manual check in the Rossko account.
   */
  unmatched: string[];
  /** ItemsList lines that match no requested line. */
  unexpectedItems: CheckoutLine[];
  /** ItemsErrorList lines that match no requested line. */
  unexpectedErrors: CheckoutItemError[];
}

export type CheckoutMatchErrorCode = 'ambiguous' | 'invalid';

/** The result cannot be mapped to our lines unambiguously: treat the checkout as unknown. */
export class CheckoutMatchError extends Error {
  readonly code: CheckoutMatchErrorCode;

  constructor(code: CheckoutMatchErrorCode, message: string) {
    super(message);
    this.name = 'CheckoutMatchError';
    this.code = code;
  }
}

/** 'DT-000123', 1 -> 'DT-000123/1': GetCheckout comment, unique per attempt. */
export function checkoutComment(orderNumber: string, attemptNo: number): string {
  if (!ORDER_NUMBER_RE.test(orderNumber)) {
    throw new RangeError(`invalid order number ${JSON.stringify(orderNumber)}`);
  }
  if (!Number.isSafeInteger(attemptNo) || attemptNo < 1) {
    throw new RangeError(`invalid attempt number ${String(attemptNo)}`);
  }
  return `${orderNumber}/${attemptNo}`;
}

function stockKey(stockId: string | null): string | null {
  const trimmed = stockId?.trim().toUpperCase() ?? '';
  return trimmed === '' ? null : trimmed;
}

function partKey(line: { article: string; brand: string; count: number }): string {
  return `${normalizeArticle(line.article)}|${normalizeArticle(line.brand)}|${line.count}`;
}

function partTitle(line: { article: string; brand: string }): string {
  return `${line.brand} ${line.article}`.replace(/\s+/g, ' ').trim();
}

/**
 * Splits a GetCheckout (or recovered) result over the requested lines. Throws
 * CheckoutMatchError when two requested lines cannot be told apart, when one result line fits
 * several requested lines, or when one requested line is matched twice (e.g. both ordered and
 * refused).
 */
export function matchCheckoutResult(
  requested: readonly CheckoutMatchRequest[],
  result: Pick<CheckoutResult, 'items' | 'itemErrors'>,
): CheckoutMatch {
  const ids = new Set<string>();
  const fullKeys = new Set<string>();
  for (const req of requested) {
    if (req.id === '' || ids.has(req.id)) {
      throw new CheckoutMatchError('invalid', `duplicate or empty request id '${req.id}'`);
    }
    ids.add(req.id);
    const full = `${partKey(req)}|${stockKey(req.stockId) ?? ''}`;
    if (fullKeys.has(full)) {
      throw new CheckoutMatchError(
        'ambiguous',
        `two requested lines of ${partTitle(req)} with the same stock and count`,
      );
    }
    fullKeys.add(full);
  }

  const assigned = new Map<string, 'covered' | 'failed'>();
  const match: CheckoutMatch = {
    covered: [],
    failed: [],
    unmatched: [],
    unexpectedItems: [],
    unexpectedErrors: [],
  };

  const find = (line: CheckoutLine | CheckoutItemError): CheckoutMatchRequest | null => {
    const key = partKey(line);
    const stock = stockKey(line.stockId);
    const candidates = requested.filter(
      (req) => partKey(req) === key && (stock === null || stockKey(req.stockId) === stock),
    );
    if (candidates.length > 1) {
      throw new CheckoutMatchError(
        'ambiguous',
        `${partTitle(line)} without a stock id fits ${candidates.length} requested lines`,
      );
    }
    const req = candidates[0] ?? null;
    if (req !== null && assigned.has(req.id)) {
      throw new CheckoutMatchError('ambiguous', `${partTitle(line)} is in the result twice`);
    }
    return req;
  };

  for (const line of result.items) {
    const req = find(line);
    if (req === null) {
      match.unexpectedItems.push(line);
    } else {
      assigned.set(req.id, 'covered');
      match.covered.push({ id: req.id, line });
    }
  }
  for (const error of result.itemErrors) {
    const req = find(error);
    if (req === null) {
      match.unexpectedErrors.push(error);
    } else {
      assigned.set(req.id, 'failed');
      match.failed.push({ id: req.id, error });
    }
  }
  match.unmatched = requested.filter((req) => !assigned.has(req.id)).map((req) => req.id);
  return match;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Orders whose comment contains `comment` as a whole token ('DT-000123/1' does not match
 * 'DT-000123/12'), case-insensitive. One GetCheckout may create several Rossko orders (one per
 * stock, OrderIDS is a list), so all of them are returned.
 * VERIFY: whether Rossko keeps the comment verbatim or prefixes it (R10).
 */
export function findOrdersByComment(
  orders: readonly RosskoOrder[],
  comment: string,
): RosskoOrder[] {
  const token = comment.trim();
  if (token === '') return [];
  const re = new RegExp(`(?<![0-9A-Za-z/-])${escapeRegExp(token)}(?![0-9A-Za-z])`, 'i');
  return orders.filter((order) => order.comment !== null && re.test(order.comment));
}

/** The first order with the comment (see findOrdersByComment), or null. */
export function findOrderByComment(
  orders: readonly RosskoOrder[],
  comment: string,
): RosskoOrder | null {
  return findOrdersByComment(orders, comment)[0] ?? null;
}

/**
 * Orders found by the comment after a GetCheckout timeout, read as a successful GetCheckout
 * (Б14). The order lines become ItemsList; there is no ItemsErrorList, so requested lines
 * missing from the orders end up in `unmatched` of matchCheckoutResult.
 * VERIFY: GetOrders does not report the delivery cost, so deliveryCostKop is null.
 */
export function checkoutResultFromOrders(orders: readonly RosskoOrder[]): CheckoutResult {
  return {
    success: orders.length > 0,
    message: null,
    orderIds: orders.map((order) => order.id),
    deliveryCostKop: null,
    items: orders.flatMap((order) =>
      order.items.map((line): CheckoutLine => ({
        brand: line.brand,
        article: line.article,
        stockId: line.stockId,
        count: line.count,
        priceKop: line.priceKop,
      })),
    ),
    itemErrors: [],
  };
}
