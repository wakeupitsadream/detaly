/**
 * Which requests the search rate limit counts (used by src/proxy.ts).
 *
 * The limit protects the Rossko quota, so every request that makes the server run a search
 * must be counted, whatever its method or headers say:
 * - Next answers HEAD with the GET handler and renders /search for POST, PUT and the rest,
 *   so only HEAD is spared, and the proxy answers it itself without running the search.
 * - Prefetch hints such as `Purpose: prefetch`, `Sec-Purpose` or a bare
 *   `Next-Router-Prefetch` are client-controlled and do not stop the page from rendering.
 *   Only a genuine App Router prefetch of /search (`RSC: 1` together with
 *   `Next-Router-Prefetch: 1`, exactly as Next itself checks them) renders the shell without
 *   page data, so only that one is free. /api/search is never prefetched by the router.
 * - Requests without a query never reach Rossko (the page shows the form, the API says 400).
 */

export const LIMITED_PATHS: ReadonlySet<string> = new Set(['/search', '/api/search']);

/** count: spend one hit; head: answer HEAD without the handler; pass: not a search. */
export type SearchRequestKind = 'count' | 'head' | 'pass';

interface HeaderSource {
  get(name: string): string | null;
}

export interface SearchRequestLike {
  method: string;
  pathname: string;
  searchParams: URLSearchParams;
  headers: HeaderSource;
}

/** The same test Next uses to render a prefetch (no page data) instead of the page. */
export function isRouterPrefetch(headers: HeaderSource): boolean {
  return headers.get('rsc') === '1' && headers.get('next-router-prefetch') === '1';
}

export function classifySearchRequest(request: SearchRequestLike): SearchRequestKind {
  if (!LIMITED_PATHS.has(request.pathname)) return 'pass';
  // searchParams.get returns the first value, as the page and the route handler read it.
  if ((request.searchParams.get('q') ?? '').trim() === '') return 'pass';
  const method = request.method.toUpperCase();
  if (method === 'OPTIONS') return 'pass';
  if (method === 'HEAD') return 'head';
  if (request.pathname === '/search' && isRouterPrefetch(request.headers)) return 'pass';
  return 'count';
}
