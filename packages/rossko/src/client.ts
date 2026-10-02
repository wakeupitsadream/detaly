/**
 * Rossko client: limiter + cache + transport + mapper. Knows nothing about the database:
 * `onCall` lets the caller write `api_calls`.
 *
 * No retries here. Retrying is the worker's decision (BullMQ), and GetCheckout must never be
 * repeated blindly: after a timeout the worker checks GetOrders first.
 */
import { localDate, parseSupplierTimestamp } from '@detaly/domain';
import type { RosskoMode } from '@detaly/domain/statuses';
import {
  CheckoutDisabledError,
  RosskoCallError,
  RosskoConfigError,
  SearchCacheMissError,
} from './errors';
import { createFixtureCaller } from './fixture-caller';
import { maskSecrets } from './mask';
import {
  applyLocalStocks,
  mapCheckoutDetails,
  mapCheckoutResult,
  mapOrdersResult,
  parseSearchResponse,
  RosskoResponseError,
} from './mapper';
import { normalizeArticle } from './normalize';
import { SEARCH_ERROR_CACHE_TTL_SEC, type SearchCache, type CachedSearch } from './cache';
import { createSoapCaller } from './soap-caller';
import type {
  CallPriority,
  CheckoutDetails,
  CheckoutRequest,
  CheckoutResult,
  LocalStockIdsSource,
  OrdersResult,
  RecentOrdersOptions,
  RosskoCallEvent,
  RosskoCaller,
  RosskoClient,
  RosskoLimiter,
  RosskoMethod,
  SearchResult,
} from './types';

/** GetOrders accepts at most 20 ids per call. */
export const ORDERS_BATCH_SIZE = 20;

export interface RosskoClientOptions {
  caller: RosskoCaller;
  key1: string | null | undefined;
  key2: string | null | undefined;
  deliveryId?: string | null;
  addressId?: string | null;
  paymentId?: string | null;
  /** Orenburg stock ids (settings `rossko.local_stock_ids`); a function is read on every call. */
  localStockIds: LocalStockIdsSource;
  limiter: RosskoLimiter;
  /** null/undefined disables caching. */
  cache?: SearchCache | null;
  /** Called after every real supplier call; errors thrown by the hook are swallowed. */
  onCall?: (event: RosskoCallEvent) => void | Promise<void>;
  /** ROSSKO_ALLOW_CHECKOUT; false on stage and until the semi-automatic flow is approved. */
  allowCheckout: boolean;
  /** Longest wait for a window slot for `search` priority (web must answer fast). Default 2000. */
  searchMaxWaitMs?: number;
  /** Longest wait for `critical` calls (worker). Default 60000. */
  criticalMaxWaitMs?: number;
  /** Injected clock (ms). */
  now?: () => number;
}

/**
 * GetSearch answers "nothing found" as success:false with a message; any other success:false
 * is treated as a supplier error.
 * VERIFY: the wording is taken from the synthetic NOTFOUND fixture and must be re-checked
 * against real responses (scripts/rossko-smoke.ts, docs/external.md R15).
 */
const SEARCH_NOT_FOUND_RE = /(?:ничего\s+)?не\s+найден|not\s+found/i;

/** null for a usable GetSearch answer, else the error to report (and cache only briefly). */
export function searchFailure(parsed: { success: boolean; message: string | null }): string | null {
  if (parsed.success) return null;
  if (parsed.message !== null && SEARCH_NOT_FOUND_RE.test(parsed.message)) return null;
  return `GetSearch success=false: ${parsed.message ?? 'no message'}`;
}

/**
 * GetOrders in list mode answering "no orders" (an empty list, not a refusal).
 * VERIFY: wording unknown; taken by analogy with GetSearch (docs/external.md R11).
 */
const ORDERS_NONE_RE = /заказ\S*\s+не\s+найден|нет\s+заказ|not\s+found|no\s+orders/i;

/** Error code of RosskoCallError when a method mode is refused by Rossko (recentOrders). */
export const UNSUPPORTED_CODE = 'unsupported';

/** null for a usable GetOrders list answer, else the refusal to report. */
function ordersListFailure(parsed: { success: boolean; message: string | null }): string | null {
  if (parsed.success) return null;
  if (parsed.message !== null && ORDERS_NONE_RE.test(parsed.message)) return null;
  return `GetOrders without order_ids refused: ${parsed.message ?? 'no message'}`;
}

/**
 * Whether a failed list call means "Rossko does not support it" rather than a transient fault:
 * an unexpected answer shape, or an HTTP 4xx / 500 (SOAP faults travel as 500).
 * VERIFY: how Rossko actually refuses GetOrders without order_ids (R11).
 */
function isRefusal(error: unknown): boolean {
  if (error instanceof RosskoResponseError) return true;
  if (!(error instanceof RosskoCallError) || error.timeout || error.wsdl) return false;
  return error.statusCode !== null && error.statusCode >= 400 && error.statusCode <= 500;
}

/** Moscow calendar day: date-only Rossko timestamps are Moscow dates. */
const SUPPLIER_TIME_ZONE = 'Europe/Moscow';

function createdSince(createdAt: string | null, since: Date): boolean {
  if (createdAt === null) return true;
  const parsed = parseSupplierTimestamp(createdAt);
  if (parsed === null) return true;
  if (parsed.kind === 'instant') return parsed.instant.getTime() >= since.getTime();
  return parsed.date >= localDate(since, SUPPLIER_TIME_ZONE);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createRosskoClient(options: RosskoClientOptions): RosskoClient {
  const { caller, limiter } = options;
  const cache = options.cache ?? null;
  const now = options.now ?? Date.now;
  const key1 = options.key1 ?? '';
  const key2 = options.key2 ?? '';
  const deliveryId = options.deliveryId || null;
  const addressId = options.addressId || null;
  const paymentId = options.paymentId || null;
  const maxWait: Record<CallPriority, number> = {
    search: options.searchMaxWaitMs ?? 2_000,
    critical: options.criticalMaxWaitMs ?? 60_000,
  };
  const inflight = new Map<string, Promise<CachedSearch>>();

  async function localStockIds(): Promise<readonly string[]> {
    const source = options.localStockIds;
    return typeof source === 'function' ? await source() : source;
  }

  function emit(event: Omit<RosskoCallEvent, 'source'>): void {
    if (!options.onCall) return;
    try {
      const pending = options.onCall({ source: 'rossko', ...event });
      if (pending && typeof pending.then === 'function') pending.then(undefined, () => undefined);
    } catch {
      // The hook must not break a supplier call.
    }
  }

  async function invoke<T extends { success: boolean }>(
    method: RosskoMethod,
    args: Record<string, unknown>,
    priority: CallPriority,
    parse: (raw: unknown) => T,
    /** Supplier-level failure inside a well-formed answer: reported as ok=false. */
    failure: (parsed: T) => string | null = () => null,
  ): Promise<T> {
    await limiter.acquire({ priority, maxWaitMs: maxWait[priority] });
    const startedAt = now();
    try {
      const parsed = parse(await caller.call(method, args));
      const failed = failure(parsed);
      emit({
        method,
        priority,
        durationMs: now() - startedAt,
        ok: failed === null,
        supplierSuccess: parsed.success,
        error: failed === null ? null : maskSecrets(failed, [key1, key2]),
        timeout: false,
      });
      return parsed;
    } catch (error) {
      emit({
        method,
        priority,
        durationMs: now() - startedAt,
        ok: false,
        supplierSuccess: null,
        error: maskSecrets(errorMessage(error), [key1, key2]),
        timeout: error instanceof RosskoCallError && error.timeout,
      });
      throw error;
    }
  }

  function credentials(): Record<string, unknown> {
    return { KEY1: key1, KEY2: key2 };
  }

  async function fetchSearch(
    articleNorm: string,
    priority: CallPriority,
    cacheKey: string | null,
  ): Promise<CachedSearch> {
    const args: Record<string, unknown> = { ...credentials(), text: articleNorm };
    if (deliveryId) args.delivery_id = deliveryId;
    if (addressId) args.address_id = addressId;
    // isLocal is re-applied on every read, so the ids at parse time do not matter here.
    const parsed = await invoke(
      'GetSearch',
      args,
      priority,
      (raw) => parseSearchResponse(raw, { localStockIds: [] }),
      searchFailure,
    );
    const value: CachedSearch = {
      offers: parsed.offers,
      message: parsed.message,
      fetchedAt: new Date(now()).toISOString(),
    };
    if (cache && cacheKey) {
      try {
        // A supplier error looks like "nothing found": keep it only briefly, then ask again.
        await cache.set(
          cacheKey,
          value,
          searchFailure(parsed) === null ? undefined : SEARCH_ERROR_CACHE_TTL_SEC,
        );
      } catch {
        // A cache write failure must not lose a paid-for supplier answer.
      }
    }
    return value;
  }

  return {
    async search(
      text,
      { priority = 'search', bypassCache = false, cacheOnly = false } = {},
    ): Promise<SearchResult> {
      const articleNorm = normalizeArticle(text);
      const localIds = await localStockIds();
      if (articleNorm === '') {
        return {
          offers: [],
          fromCache: false,
          fetchedAt: new Date(now()).toISOString(),
          message: null,
        };
      }
      const cacheKey = cache ? cache.key(articleNorm, deliveryId) : null;
      if (cache && cacheKey && !bypassCache) {
        let hit: CachedSearch | null;
        try {
          hit = await cache.get(cacheKey);
        } catch {
          hit = null; // Redis trouble: fall through to the limiter, which decides.
        }
        if (hit) {
          return {
            offers: applyLocalStocks(hit.offers, localIds),
            fromCache: true,
            fetchedAt: hit.fetchedAt,
            message: hit.message,
          };
        }
      }
      if (cacheOnly) throw new SearchCacheMissError();
      // Single-flight: identical concurrent searches share one supplier call. Priority is part
      // of the key, so a critical recheck never fails because of a search-level breaker.
      const flightKey = `${articleNorm}:${deliveryId ?? '-'}:${priority}`;
      let flight = inflight.get(flightKey);
      if (!flight) {
        flight = fetchSearch(articleNorm, priority, cacheKey).finally(() => {
          inflight.delete(flightKey);
        });
        inflight.set(flightKey, flight);
      }
      const fresh = await flight;
      return {
        offers: applyLocalStocks(fresh.offers, localIds),
        fromCache: false,
        fetchedAt: fresh.fetchedAt,
        message: fresh.message,
      };
    },

    checkoutDetails(): Promise<CheckoutDetails> {
      return invoke('GetCheckoutDetails', credentials(), 'critical', mapCheckoutDetails);
    },

    async orders(ids): Promise<OrdersResult> {
      const unique = [...new Set(ids.map((id) => id.trim()).filter((id) => id !== ''))];
      const merged: OrdersResult = { success: true, message: null, orders: [] };
      for (let i = 0; i < unique.length; i += ORDERS_BATCH_SIZE) {
        const batch = unique.slice(i, i + ORDERS_BATCH_SIZE);
        // Argument shape is unverified (see fixtures/GetOrders.json).
        const result = await invoke(
          'GetOrders',
          { ...credentials(), order_ids: { id: batch } },
          'critical',
          mapOrdersResult,
        );
        merged.success &&= result.success;
        merged.message ??= result.message;
        merged.orders.push(...result.orders);
      }
      return merged;
    },

    async recentOrders({ since }: RecentOrdersOptions = {}): Promise<OrdersResult> {
      if (since !== undefined && Number.isNaN(since.getTime())) {
        throw new RangeError('recentOrders: invalid since');
      }
      let result: OrdersResult;
      try {
        // VERIFY: GetOrders without order_ids as an "account orders" list, and whether it takes
        // a period or paging (R11). No filter arguments are sent: unknown elements might make
        // the call fail; `since` is applied here instead.
        result = await invoke(
          'GetOrders',
          credentials(),
          'critical',
          mapOrdersResult,
          ordersListFailure,
        );
      } catch (error) {
        if (!isRefusal(error)) throw error;
        throw new RosskoCallError(
          'GetOrders',
          `order list is not supported: ${maskSecrets(errorMessage(error), [key1, key2])}`,
          {
            statusCode: error instanceof RosskoCallError ? error.statusCode : null,
            code: UNSUPPORTED_CODE,
          },
        );
      }
      const refusal = ordersListFailure(result);
      if (refusal !== null) {
        throw new RosskoCallError('GetOrders', maskSecrets(refusal, [key1, key2]), {
          code: UNSUPPORTED_CODE,
        });
      }
      const orders =
        since === undefined
          ? result.orders
          : result.orders.filter((order) => createdSince(order.createdAt, since));
      return { success: true, message: result.message, orders };
    },

    async checkout(request: CheckoutRequest): Promise<CheckoutResult> {
      if (!options.allowCheckout) throw new CheckoutDisabledError();
      // Without these ids Rossko would pick its own default delivery/payment: a real order to
      // an unknown place. Fail before the limiter and the network.
      if (!deliveryId || !paymentId) {
        throw new RosskoConfigError(
          'Rossko checkout needs ROSSKO_DELIVERY_ID and ROSSKO_PAYMENT_ID (see GetCheckoutDetails)',
        );
      }
      if (request.items.length === 0) throw new RangeError('checkout needs at least one item');
      for (const item of request.items) {
        if (!item.brand.trim() || !item.article.trim() || !item.stockId.trim()) {
          throw new RangeError('checkout item needs brand, article and stockId');
        }
        if (!Number.isInteger(item.count) || item.count <= 0) {
          throw new RangeError(`invalid count ${item.count} for ${item.brand} ${item.article}`);
        }
      }
      // Argument shape follows open-source clients and is unverified (see docs/external.md).
      const args: Record<string, unknown> = {
        ...credentials(),
        delivery: { delivery_id: deliveryId, ...(addressId ? { address_id: addressId } : {}) },
        payment: { payment_id: paymentId },
        delivery_parts: request.deliveryParts ?? false,
        PARTS: {
          Part: request.items.map((item) => ({
            partnumber: item.article,
            brand: item.brand,
            stock: item.stockId,
            count: item.count,
            ...(item.comment ? { comment: item.comment } : {}),
          })),
        },
      };
      if (request.contact)
        args.contact = { name: request.contact.name, phone: request.contact.phone };
      if (request.comment) args.comment = request.comment;
      return invoke('GetCheckout', args, 'critical', mapCheckoutResult);
    },
  };
}

export interface RosskoCallerConfig {
  mode: RosskoMode;
  wsdlBase: string;
  timeoutMs: number;
  /** fixtures mode only: read fixtures from a directory instead of the bundled set. */
  fixturesDir?: string;
}

/** ROSSKO_MODE=live -> SOAP, fixtures -> bundled (or on-disk) fixtures. */
export function createRosskoCaller(config: RosskoCallerConfig): RosskoCaller {
  switch (config.mode) {
    case 'live':
      return createSoapCaller({ wsdlBase: config.wsdlBase, timeoutMs: config.timeoutMs });
    case 'fixtures':
      return createFixtureCaller(config.fixturesDir);
  }
}
