/**
 * Search by article: validation and normalization, supplier search through the Rossko cache
 * and limiter, client prices and dates via buildOfferViews, marked goods via excluded_groups,
 * and a fire-and-forget `search_log` row (the client IP is never stored).
 *
 * Pure orchestration over injected dependencies; server/search.ts wires the real ones.
 */
import { buildOfferViews, normalizeText, type OfferView } from '@detaly/domain';
import {
  normalizeArticle,
  QuotaBreakerError,
  RosskoRateLimitError,
  type RosskoClient,
  type RosskoLimiter,
} from '@detaly/rossko';
import { isNamedError } from './errors';
import type { SearchSettings } from './settings';

/** Shortest normalized article we search for ("OC9" is fine, "OC" is not). */
export const MIN_QUERY_LENGTH = 3;
/** Longest raw query accepted. */
export const MAX_QUERY_LENGTH = 64;
export const MAX_BRAND_LENGTH = 64;

export type SearchInputErrorCode = 'missing' | 'too_short' | 'too_long' | 'brand_too_long';

export class SearchInputError extends Error {
  readonly code: SearchInputErrorCode;

  constructor(code: SearchInputErrorCode, message: string) {
    super(message);
    this.name = 'SearchInputError';
    this.code = code;
  }
}

/** quota: the Rossko breaker is open (or the quota is gone) and the cache had nothing. */
export type SearchUnavailableReason = 'quota' | 'rate' | 'supplier';

export class SearchUnavailableError extends Error {
  readonly reason: SearchUnavailableReason;
  readonly retryAfterSec: number | null;

  constructor(reason: SearchUnavailableReason, message: string, retryAfterSec: number | null) {
    super(message);
    this.name = 'SearchUnavailableError';
    this.reason = reason;
    this.retryAfterSec = retryAfterSec;
  }
}

export interface SearchInput {
  q: string | null | undefined;
  brand?: string | null;
  localOnly?: boolean;
}

export interface NormalizedSearchInput {
  /** Trimmed query as typed. */
  query: string;
  /** normalizeArticle(query): upper case [A-Z0-9]. */
  articleNorm: string;
  /** Trimmed brand filter or null. */
  brand: string | null;
  localOnly: boolean;
}

export interface QuotaInfo {
  breakerOpen: boolean;
  exhausted: boolean;
}

export interface SearchResponse {
  query: string;
  articleNorm: string;
  brand: string | null;
  localOnly: boolean;
  offers: OfferView[];
  /** Offers before the brand and local filters (for "show all" hints). */
  totalBeforeFilters: number;
  /** Distinct brands of the unfiltered result, in display order. */
  brands: string[];
  fromCache: boolean;
  /** null when the limiter state could not be read. */
  quota: QuotaInfo | null;
}

export interface SearchLogRow {
  query: string;
  brand: string | null;
  article: string;
  resultsCount: number;
  fromCache: boolean;
  latencyMs: number;
}

export interface SearchServiceDeps {
  rossko: Pick<RosskoClient, 'search'>;
  limiter: Pick<RosskoLimiter, 'status'>;
  loadSettings: () => Promise<Pick<SearchSettings, 'pricing' | 'excludedRules' | 'eta'>>;
  /** Fire-and-forget; failures go to onBackgroundError. */
  logSearch?: (row: SearchLogRow) => Promise<unknown>;
  onBackgroundError?: (error: unknown, what: string) => void;
  /** Wall clock for ETA dates. */
  now?: () => Date;
  /** Monotonic-ish clock for latency (ms). */
  clock?: () => number;
}

export function normalizeSearchInput(input: SearchInput): NormalizedSearchInput {
  const query = (input.q ?? '').trim();
  if (query === '') throw new SearchInputError('missing', 'Введите артикул');
  if (query.length > MAX_QUERY_LENGTH) {
    throw new SearchInputError(
      'too_long',
      `Слишком длинный запрос: не больше ${MAX_QUERY_LENGTH} символов`,
    );
  }
  const articleNorm = normalizeArticle(query);
  if (articleNorm.length < MIN_QUERY_LENGTH) {
    throw new SearchInputError(
      'too_short',
      `Введите артикул: не меньше ${MIN_QUERY_LENGTH} букв или цифр`,
    );
  }
  const brand = (input.brand ?? '').trim();
  if (brand.length > MAX_BRAND_LENGTH) {
    throw new SearchInputError('brand_too_long', 'Слишком длинное название бренда');
  }
  return { query, articleNorm, brand: brand === '' ? null : brand, localOnly: !!input.localOnly };
}

function sameBrand(a: string, b: string): boolean {
  return normalizeText(a).trim() === normalizeText(b).trim();
}

function toUnavailable(error: unknown): SearchUnavailableError | null {
  if (isNamedError(error, QuotaBreakerError, 'QuotaBreakerError')) {
    return new SearchUnavailableError('quota', 'Поиск временно недоступен, попробуйте позже', null);
  }
  if (isNamedError(error, RosskoRateLimitError, 'RosskoRateLimitError')) {
    return new SearchUnavailableError(
      'rate',
      'Поиск перегружен, попробуйте через минуту',
      Math.max(1, Math.ceil(error.retryAfterMs / 1000)),
    );
  }
  return null;
}

export interface SearchService {
  search(input: SearchInput): Promise<SearchResponse>;
}

export function createSearchService(deps: SearchServiceDeps): SearchService {
  const now = deps.now ?? (() => new Date());
  const clock = deps.clock ?? (() => performance.now());

  function background(promise: Promise<unknown>, what: string): void {
    promise.then(undefined, (error: unknown) => deps.onBackgroundError?.(error, what));
  }

  return {
    async search(input) {
      const normalized = normalizeSearchInput(input);
      const startedAt = clock();
      const settingsPromise = deps.loadSettings();
      let result;
      try {
        result = await deps.rossko.search(normalized.articleNorm, { priority: 'search' });
      } catch (error) {
        settingsPromise.then(undefined, () => undefined);
        const unavailable = toUnavailable(error);
        if (unavailable) throw unavailable;
        // Supplier fault, or Redis down: without the limiter Rossko is never called.
        deps.onBackgroundError?.(error, 'rossko search');
        throw new SearchUnavailableError(
          'supplier',
          'Поиск временно недоступен, попробуйте позже',
          null,
        );
      }
      const searchSettings = await settingsPromise;
      const views = buildOfferViews(result.offers, {
        pricing: searchSettings.pricing,
        excludedRules: searchSettings.excludedRules,
        eta: searchSettings.eta,
        now: now(),
      });
      const brands: string[] = [];
      for (const view of views) {
        if (!brands.some((known) => sameBrand(known, view.brand))) brands.push(view.brand);
      }
      const offers = views.filter(
        (view) =>
          (!normalized.localOnly || view.isLocal) &&
          (normalized.brand === null || sameBrand(view.brand, normalized.brand)),
      );
      const latencyMs = Math.max(0, Math.round(clock() - startedAt));

      if (deps.logSearch) {
        background(
          deps.logSearch({
            query: normalized.query,
            brand: normalized.brand,
            article: normalized.articleNorm,
            resultsCount: offers.length,
            fromCache: result.fromCache,
            latencyMs,
          }),
          'search_log',
        );
      }

      let quota: QuotaInfo | null = null;
      try {
        const status = await deps.limiter.status();
        quota = { breakerOpen: status.breakerOpen, exhausted: status.exhausted };
      } catch (error) {
        deps.onBackgroundError?.(error, 'quota status');
      }

      return {
        query: normalized.query,
        articleNorm: normalized.articleNorm,
        brand: normalized.brand,
        localOnly: normalized.localOnly,
        offers,
        totalBeforeFilters: views.length,
        brands,
        fromCache: result.fromCache,
        quota,
      };
    },
  };
}
