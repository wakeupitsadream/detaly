/** GET /api/search?q=&brand=&local=1 -> {offers, fromCache, quota, ...}. */
import { isNamedError } from '../errors';
import { SearchInputError, SearchUnavailableError, type SearchService } from '../search-service';

const NO_STORE = { 'Cache-Control': 'no-store' };

export function parseLocalFlag(value: string | null): boolean {
  return value === '1' || value === 'true' || value === 'on';
}

export async function handleSearchRequest(
  url: URL,
  service: SearchService,
  onError?: (error: unknown) => void,
): Promise<Response> {
  const params = url.searchParams;
  try {
    const result = await service.search({
      q: params.get('q'),
      brand: params.get('brand'),
      localOnly: parseLocalFlag(params.get('local')),
    });
    return Response.json(
      {
        query: result.query,
        articleNorm: result.articleNorm,
        brand: result.brand,
        localOnly: result.localOnly,
        offers: result.offers,
        total: result.totalBeforeFilters,
        brands: result.brands,
        fromCache: result.fromCache,
        quota: result.quota,
      },
      { headers: NO_STORE },
    );
  } catch (error) {
    if (isNamedError(error, SearchInputError, 'SearchInputError')) {
      return Response.json(
        { error: error.code, message: error.message },
        { status: 400, headers: NO_STORE },
      );
    }
    if (isNamedError(error, SearchUnavailableError, 'SearchUnavailableError')) {
      const headers: Record<string, string> = { ...NO_STORE };
      if (error.retryAfterSec !== null) headers['Retry-After'] = String(error.retryAfterSec);
      return Response.json(
        { error: 'unavailable', reason: error.reason, message: error.message },
        { status: 503, headers },
      );
    }
    onError?.(error);
    return Response.json(
      { error: 'internal', message: 'Ошибка сервера, попробуйте позже' },
      { status: 500, headers: NO_STORE },
    );
  }
}
