/**
 * Public types of @detaly/rossko.
 *
 * Field names of Rossko SOAP v2.1 are taken from open-source clients and are NOT verified
 * against real responses yet (fixtures are synthetic, see fixtures/*.json `_meta`).
 */
import type { Kop, Offer } from '@detaly/domain/types';

export type RosskoMethod = 'GetSearch' | 'GetCheckoutDetails' | 'GetCheckout' | 'GetOrders';

export const ROSSKO_METHODS: readonly RosskoMethod[] = [
  'GetSearch',
  'GetCheckoutDetails',
  'GetCheckout',
  'GetOrders',
];

/** Invokes one Rossko method with already-built arguments and returns the parsed result. */
export interface RosskoCaller {
  call(method: RosskoMethod, args: Record<string, unknown>): Promise<unknown>;
  /** Raw XML of the last response when the transport has one (SOAP); used by the smoke script. */
  readonly lastRawResponse?: string | null;
}

/** `search` stops at ROSSKO_QUOTA_BREAKER_PCT of the daily quota, `critical` at 100%. */
export type CallPriority = 'search' | 'critical';

export interface AcquireOptions {
  priority: CallPriority;
  /** Give up with RosskoRateLimitError when the window frees up later than this. */
  maxWaitMs?: number;
}

export interface AcquireResult {
  /** Time spent waiting for a window slot. */
  waitedMs: number;
  /** Calls counted for the current Moscow day, including this one. */
  dailyCount: number;
}

export type TryAcquireResult =
  | { allowed: true; dailyCount: number }
  | { allowed: false; reason: 'rate'; waitMs: number; dailyCount: number }
  | { allowed: false; reason: 'breaker' | 'exhausted'; waitMs: 0; dailyCount: number };

export interface QuotaStatus {
  /** Moscow calendar day 'YYYY-MM-DD'. */
  day: string;
  dailyCount: number;
  dailyLimit: number;
  /** Search calls stop at this count. */
  breakerLimit: number;
  breakerOpen: boolean;
  exhausted: boolean;
}

export interface RosskoLimiter {
  /** Waits for a window slot (up to maxWaitMs) and counts the call. */
  acquire(options: AcquireOptions): Promise<AcquireResult>;
  /** Single attempt without waiting. */
  tryAcquire(options: { priority: CallPriority }): Promise<TryAcquireResult>;
  status(): Promise<QuotaStatus>;
}

/** Result of `search`. Offers are safe to cache; `isLocal` is re-applied on every read. */
export interface SearchResult {
  offers: Offer[];
  fromCache: boolean;
  /** When the supplier answered (ISO instant); for cache hits, the original time. */
  fetchedAt: string;
  /** Supplier `message` (e.g. "nothing found" text when success=false). */
  message: string | null;
}

export interface SearchOptions {
  priority?: CallPriority;
  /** Skip the cache read (cart recheck, POST /checkout); the fresh result is still cached. */
  bypassCache?: boolean;
  /**
   * Read the cache only: a miss (or no cache) throws SearchCacheMissError instead of calling
   * the supplier. For page views that must not spend the quota (/cart, /checkout).
   */
  cacheOnly?: boolean;
}

/** Parsed GetSearch response before caching. */
export interface ParsedSearch {
  success: boolean;
  message: string | null;
  offers: Offer[];
}

// ---------------------------------------------------------------------------
// GetCheckoutDetails
// ---------------------------------------------------------------------------

export interface CheckoutDetailsEntry {
  id: string;
  name: string | null;
}

export interface CheckoutDetailsAddress {
  id: string;
  /** Address parts joined with ', '. */
  text: string;
}

export interface CheckoutDetails {
  success: boolean;
  message: string | null;
  deliveries: (CheckoutDetailsEntry & { costKop: Kop | null; freeFromKop: Kop | null })[];
  payments: CheckoutDetailsEntry[];
  addresses: CheckoutDetailsAddress[];
}

// ---------------------------------------------------------------------------
// GetCheckout
// ---------------------------------------------------------------------------

export interface CheckoutItemRequest {
  brand: string;
  /** Article as returned by GetSearch (display form). */
  article: string;
  stockId: string;
  count: number;
  /** Our order number, so Rossko staff can match the line. */
  comment?: string;
}

export interface CheckoutRequest {
  items: readonly CheckoutItemRequest[];
  contact?: { name: string; phone: string };
  comment?: string;
  /** Ship available lines without waiting for the whole order. */
  deliveryParts?: boolean;
}

export interface CheckoutLine {
  brand: string;
  article: string;
  stockId: string | null;
  count: number;
  priceKop: Kop | null;
}

export interface CheckoutItemError extends Omit<CheckoutLine, 'priceKop'> {
  message: string | null;
}

export interface CheckoutResult {
  success: boolean;
  message: string | null;
  orderIds: string[];
  deliveryCostKop: Kop | null;
  items: CheckoutLine[];
  itemErrors: CheckoutItemError[];
}

// ---------------------------------------------------------------------------
// GetOrders
// ---------------------------------------------------------------------------

export interface RosskoOrderLine {
  brand: string;
  article: string;
  /** VERIFY: whether GetOrders lines carry the stock id at all (docs/external.md R11). */
  stockId: string | null;
  count: number;
  priceKop: Kop | null;
  statusCode: number | null;
}

export interface RosskoOrder {
  id: string;
  /** One of Rossko's 16 status codes (to be verified). */
  statusCode: number | null;
  statusText: string | null;
  createdAt: string | null;
  /**
   * The order comment we sent with GetCheckout (`DT-000123/1`, checkoutComment).
   * VERIFY: field name and whether Rossko echoes the comment in GetOrders (R10, R11).
   */
  comment: string | null;
  items: RosskoOrderLine[];
}

export interface RecentOrdersOptions {
  /**
   * Keep orders created at or after this instant, less RECENT_ORDERS_SINCE_SLACK_MS (minute
   * precision of Rossko timestamps, clock skew); a date-only createdAt is compared by the Moscow
   * calendar day. Orders whose createdAt is missing or not understood are kept: the comment, not
   * the time, identifies an order. Omit to keep everything the API lists.
   */
  since?: Date;
}

export interface OrdersOptions {
  /** Limiter priority of every GetOrders call (default `critical`). */
  priority?: CallPriority;
}

export interface OrdersResult {
  success: boolean;
  message: string | null;
  orders: RosskoOrder[];
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

/** Passed to `onCall` after every real supplier call (not for cache hits). Written to api_calls. */
export interface RosskoCallEvent {
  source: 'rossko';
  method: RosskoMethod;
  priority: CallPriority;
  durationMs: number;
  /** Transport-level success (no exception). */
  ok: boolean;
  /** Supplier `success` flag when the response had one. */
  supplierSuccess: boolean | null;
  /** Masked error message when ok=false. */
  error: string | null;
  /**
   * The request timed out. GetCheckout may have been executed after other failures too
   * (see checkoutMayHaveExecuted).
   */
  timeout: boolean;
}

export type LocalStockIdsSource =
  readonly string[] | (() => readonly string[] | Promise<readonly string[]>);

export interface RosskoClient {
  search(text: string, options?: SearchOptions): Promise<SearchResult>;
  checkoutDetails(): Promise<CheckoutDetails>;
  /**
   * Fetches orders by id; more than 20 ids are split into several calls. `priority` defaults to
   * `critical` (the recovery after a GetCheckout timeout); the step 8 polling passes `search`, so
   * it stops at the quota breaker (docs/rossko-automation.md).
   */
  orders(ids: readonly string[], options?: OrdersOptions): Promise<OrdersResult>;
  /**
   * GetOrders without order_ids: the account's recent orders, for the recovery after a
   * GetCheckout timeout (decision Б14). VERIFY: the list mode is unconfirmed; when Rossko refuses
   * it (success=false, SOAP fault, unexpected shape) this throws RosskoCallError with
   * code 'unsupported'. Timeouts and network errors are rethrown unchanged (retryable).
   */
  recentOrders(options?: RecentOrdersOptions): Promise<OrdersResult>;
  /**
   * Throws CheckoutDisabledError when allowCheckout is false and RosskoConfigError without
   * delivery/payment ids. Never retried by the client; on failure use checkoutMayHaveExecuted()
   * to decide between a retry and a GetOrders lookup.
   */
  checkout(request: CheckoutRequest): Promise<CheckoutResult>;
}
