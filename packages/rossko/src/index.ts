// Public API of @detaly/rossko: SOAP v2.1 client (npm `soap`), fixture caller, Redis limiter
// and cache, resilient mapper. The package does not touch the database (see `onCall`).
export {
  createRosskoCaller,
  createRosskoClient,
  ORDERS_BATCH_SIZE,
  RECENT_ORDERS_SINCE_SLACK_MS,
  searchFailure,
  UNSUPPORTED_CODE,
  type RosskoCallerConfig,
  type RosskoClientOptions,
} from './client';
export {
  createSearchCache,
  SEARCH_CACHE_TTL_SEC,
  SEARCH_ERROR_CACHE_TTL_SEC,
  type CachedSearch,
  type SearchCache,
  type SearchCacheOptions,
} from './cache';
export {
  checkoutComment,
  CheckoutMatchError,
  checkoutResultFromOrders,
  findOrderByComment,
  findOrdersByComment,
  matchCheckoutResult,
  type CheckoutMatch,
  type CheckoutMatchErrorCode,
  type CheckoutMatchRequest,
} from './checkout-match';
export {
  CheckoutDisabledError,
  checkoutMayHaveExecuted,
  QuotaBreakerError,
  RosskoCallError,
  RosskoConfigError,
  RosskoRateLimitError,
  SearchCacheMissError,
  type QuotaBreakerReason,
} from './errors';
export {
  BUNDLED_FIXTURES,
  createFixtureCaller,
  FIXTURE_LOCAL_STOCK_IDS,
  FIXTURE_TIMEOUT_MESSAGE,
  fixtureName,
  NOT_FOUND_FIXTURE,
  stripMeta,
  type CheckoutFixtureVariant,
  type FixtureCallerOptions,
  type OrdersListFixtureVariant,
} from './fixture-caller';
export {
  createRosskoLimiter,
  createUnlimitedLimiter,
  WINDOW_MS,
  type RosskoLimiterOptions,
} from './limiter';
export {
  applyLocalStocks,
  mapCheckoutDetails,
  mapCheckoutResult,
  mapOrdersResult,
  mapSearchResult,
  parseSearchResponse,
  RosskoResponseError,
  type MapSearchOptions,
} from './mapper';
export { MASK, maskSecrets } from './mask';
export {
  createMemoryLimiter,
  createMemorySearchCache,
  MEMORY_CACHE_MAX_ENTRIES,
  type MemoryLimiterOptions,
  type MemorySearchCacheOptions,
} from './memory';
export { normalizeArticle, rubToKop } from './normalize';
export { toArray } from './raw';
export { createSoapCaller, type SoapCallerOptions } from './soap-caller';
export {
  ROSSKO_METHODS,
  type AcquireOptions,
  type AcquireResult,
  type CallPriority,
  type CheckoutDetails,
  type CheckoutDetailsAddress,
  type CheckoutDetailsEntry,
  type CheckoutItemError,
  type CheckoutItemRequest,
  type CheckoutLine,
  type CheckoutRequest,
  type CheckoutResult,
  type LocalStockIdsSource,
  type OrdersOptions,
  type OrdersResult,
  type ParsedSearch,
  type QuotaStatus,
  type RecentOrdersOptions,
  type RosskoCallEvent,
  type RosskoCaller,
  type RosskoClient,
  type RosskoLimiter,
  type RosskoMethod,
  type RosskoOrder,
  type RosskoOrderLine,
  type SearchOptions,
  type SearchResult,
  type TryAcquireResult,
} from './types';
