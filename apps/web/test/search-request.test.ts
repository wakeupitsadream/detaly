import { describe, expect, it } from 'vitest';
import { classifySearchRequest, type SearchRequestKind } from '@/server/search-request';

function kind(
  method: string,
  url: string,
  headers: Record<string, string> = {},
): SearchRequestKind {
  const parsed = new URL(url, 'http://localhost');
  return classifySearchRequest({
    method,
    pathname: parsed.pathname,
    searchParams: parsed.searchParams,
    headers: new Headers(headers),
  });
}

describe('classifySearchRequest', () => {
  it('counts GET searches on both limited paths', () => {
    expect(kind('GET', '/search?q=OC90')).toBe('count');
    expect(kind('GET', '/api/search?q=OC90')).toBe('count');
  });

  it('ignores other paths and requests without a query', () => {
    expect(kind('GET', '/')).toBe('pass');
    expect(kind('GET', '/about?q=OC90')).toBe('pass');
    expect(kind('GET', '/search')).toBe('pass');
    expect(kind('GET', '/search?q=%20%20')).toBe('pass');
    expect(kind('GET', '/api/search?brand=Knecht')).toBe('pass');
    // The first q is what the page and the handler read.
    expect(kind('GET', '/search?q=&q=OC90')).toBe('pass');
    expect(kind('GET', '/search?q=OC90&q=')).toBe('count');
  });

  it('answers HEAD in the proxy instead of letting Next run the GET handler', () => {
    expect(kind('HEAD', '/search?q=OC90')).toBe('head');
    expect(kind('HEAD', '/api/search?q=OC90')).toBe('head');
    expect(kind('HEAD', '/about')).toBe('pass');
    expect(kind('OPTIONS', '/api/search?q=OC90')).toBe('pass');
  });

  it('counts other methods: Next renders /search for POST, PUT, DELETE and PATCH', () => {
    for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
      expect(kind(method, '/search?q=OC90'), method).toBe('count');
      expect(kind(method, '/api/search?q=OC90'), method).toBe('count');
    }
  });

  it('spares only a genuine router prefetch of /search', () => {
    const router = { RSC: '1', 'Next-Router-Prefetch': '1' };
    expect(kind('GET', '/search?q=OC90', router)).toBe('pass');
    expect(
      kind('GET', '/search?q=OC90', { ...router, 'Next-Router-Segment-Prefetch': '/_tree' }),
    ).toBe('pass');
  });

  it('counts spoofable prefetch hints, which still render the page', () => {
    const spoofed: Record<string, string>[] = [
      { 'Next-Router-Prefetch': '1' },
      { RSC: '1', 'Next-Router-Prefetch': '2' },
      { RSC: '1', 'Next-Router-Prefetch': 'true' },
      { RSC: '1, 1', 'Next-Router-Prefetch': '1' },
      { RSC: '1' },
      { Purpose: 'prefetch' },
      { 'Sec-Purpose': 'prefetch;prerender' },
      { 'Next-Router-Segment-Prefetch': '/_tree' },
    ];
    for (const headers of spoofed) {
      expect(kind('GET', '/search?q=OC90', headers), JSON.stringify(headers)).toBe('count');
    }
    // The API is never prefetched by the router: even the genuine pair is counted there.
    expect(kind('GET', '/api/search?q=OC90', { RSC: '1', 'Next-Router-Prefetch': '1' })).toBe(
      'count',
    );
  });
});
