// Public API of @detaly/rossko: SOAP v2.1 client (npm `soap`), fixture caller, Redis limiter
// and cache, resilient mapper. The package does not touch the database (see `onCall`).
export {
  createRosskoCaller,
  createRosskoClient,
  ORDERS_BATCH_SIZE,
  type RosskoCallerConfig,
  type RosskoClientOptions,
} from './client';
export {
  createSearchCache,
  SEARCH_CACHE_TTL_SEC,
  type CachedSearch,
  type SearchCache,
  type SearchCacheOptions,
} from './cache';
export {
  CheckoutDisabledError,
  checkoutMayHaveExecuted,
  QuotaBreakerError,
  RosskoCallError,
  RosskoConfigError,
  RosskoRateLimitError,
  type QuotaBreakerReason,
} from './errors';
export {
  BUNDLED_FIXTURES,
  createFixtureCaller,
  FIXTURE_LOCAL_STOCK_IDS,
  fixtureName,
  NOT_FOUND_FIXTURE,
  stripMeta,
  type CheckoutFixtureVariant,
  type FixtureCallerOptions,
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
  type OrdersResult,
  type ParsedSearch,
  type QuotaStatus,
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
