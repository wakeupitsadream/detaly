// Errors thrown by a singleton built in another Next bundle are instances of that bundle's copy
// of the class: the search handler must still map them by name (400/503, not 500).
import { describe, expect, it } from 'vitest';
import { handleSearchRequest } from '@/server/api/search-handler';
import { isNamedError } from '@/server/errors';
import { SearchInputError, type SearchService } from '@/server/search-service';

/** Same name and fields as the real classes, but a different constructor. */
class ForeignSearchInputError extends Error {
  readonly code = 'too_short';
  constructor(message: string) {
    super(message);
    this.name = 'SearchInputError';
  }
}

class ForeignSearchUnavailableError extends Error {
  readonly reason = 'rate';
  readonly retryAfterSec = 7;
  constructor(message: string) {
    super(message);
    this.name = 'SearchUnavailableError';
  }
}

function failing(error: Error): SearchService {
  return {
    search: () => Promise.reject(error),
  };
}

describe('cross-bundle error matching', () => {
  it('isNamedError matches by instanceof or by name', () => {
    expect(
      isNamedError(new SearchInputError('too_short', 'x'), SearchInputError, 'SearchInputError'),
    ).toBe(true);
    expect(
      isNamedError(new ForeignSearchInputError('x'), SearchInputError, 'SearchInputError'),
    ).toBe(true);
    expect(isNamedError(new Error('x'), SearchInputError, 'SearchInputError')).toBe(false);
    expect(isNamedError('SearchInputError', SearchInputError, 'SearchInputError')).toBe(false);
  });

  it('/api/search answers 400 for a SearchInputError from another bundle', async () => {
    const response = await handleSearchRequest(
      new URL('/api/search?q=x', 'http://localhost'),
      failing(new ForeignSearchInputError('Введите артикул')),
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: 'too_short' });
  });

  it('/api/search answers 503 with Retry-After for a SearchUnavailableError from another bundle', async () => {
    const response = await handleSearchRequest(
      new URL('/api/search?q=OC90', 'http://localhost'),
      failing(new ForeignSearchUnavailableError('Поиск перегружен')),
    );
    expect(response.status).toBe(503);
    expect(response.headers.get('Retry-After')).toBe('7');
  });
});
