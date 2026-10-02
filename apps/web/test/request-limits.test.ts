import { describe, expect, it } from 'vitest';
import {
  canonicalPath,
  classifyLimitedRequest,
  isForeignOriginWrite,
  pathSegments,
  type LimitedRequest,
} from '@/server/request-limits';
import { classifySearchRequest } from '@/server/search-request';

function classify(
  method: string,
  url: string,
  headers: Record<string, string> = {},
): LimitedRequest {
  // Split by hand: new URL() would resolve `//x` and `%2e%2e` before the classifier sees them.
  const [pathname = '', query = ''] = url.split('?');
  return classifyLimitedRequest({
    method,
    pathname,
    searchParams: new URLSearchParams(query),
    headers: new Headers(headers),
  });
}

const PASS: LimitedRequest = { kind: null, action: 'pass' };
const count = (kind: Exclude<LimitedRequest['kind'], null>): LimitedRequest => ({
  kind,
  action: 'count',
});

describe('classifyLimitedRequest: search', () => {
  it('decides exactly as classifySearchRequest on the search paths', () => {
    const cases: [string, string, Record<string, string>?][] = [
      ['GET', '/search?q=OC90'],
      ['GET', '/api/search?q=OC90'],
      ['GET', '/search'],
      ['GET', '/search?q=%20'],
      ['HEAD', '/search?q=OC90'],
      ['HEAD', '/api/search?q=OC90'],
      ['OPTIONS', '/api/search?q=OC90'],
      ['POST', '/search?q=OC90'],
      ['DELETE', '/api/search?q=OC90'],
      ['GET', '/search?q=OC90', { RSC: '1', 'Next-Router-Prefetch': '1' }],
      ['GET', '/search?q=OC90', { 'Next-Router-Prefetch': '1' }],
      ['GET', '/search?q=OC90', { Purpose: 'prefetch' }],
      ['GET', '/api/search?q=OC90', { RSC: '1', 'Next-Router-Prefetch': '1' }],
    ];
    for (const [method, url, headers = {}] of cases) {
      const parsed = new URL(url, 'http://localhost');
      const expected = classifySearchRequest({
        method,
        pathname: parsed.pathname,
        searchParams: parsed.searchParams,
        headers: new Headers(headers),
      });
      const actual = classify(method, url, headers);
      const label = `${method} ${url} ${JSON.stringify(headers)}`;
      if (expected === 'pass') expect(actual, label).toEqual(PASS);
      else expect(actual, label).toEqual({ kind: 'search', action: expected });
    }
  });

  it('answers HEAD in the proxy and spares only a genuine router prefetch', () => {
    expect(classify('HEAD', '/search?q=OC90')).toEqual({ kind: 'search', action: 'head' });
    expect(classify('GET', '/search?q=OC90', { RSC: '1', 'Next-Router-Prefetch': '1' })).toEqual(
      PASS,
    );
    expect(classify('GET', '/search?q=OC90', { 'Sec-Purpose': 'prefetch' })).toEqual(
      count('search'),
    );
  });

  it('counts spellings of the search path that the router may still serve', () => {
    expect(classify('GET', '/search/?q=OC90')).toEqual(count('search'));
    expect(classify('GET', '//search?q=OC90')).toEqual(count('search'));
    expect(classify('GET', '/%73earch?q=OC90')).toEqual(count('search'));
    expect(classify('GET', '/api/%73earch?q=OC90')).toEqual(count('search'));
  });
});

describe('classifyLimitedRequest: checkout, cancel, cart', () => {
  it('counts POST /api/checkout as checkout', () => {
    expect(classify('POST', '/api/checkout')).toEqual(count('checkout'));
    expect(classify('post', '/api/checkout')).toEqual(count('checkout'));
    expect(classify('POST', '/api/checkout?part=local')).toEqual(count('checkout'));
  });

  it('counts POST /api/orders/<token>/cancel as cancel', () => {
    const token = 'Zx9_aB-cd1234567890abcdefghijklmnopqrstuvw';
    expect(classify('POST', `/api/orders/${token}/cancel`)).toEqual(count('cancel'));
    expect(classify('POST', `/api/orders/${token}`)).toEqual(PASS);
    expect(classify('POST', '/api/orders/cancel')).toEqual(PASS);
    expect(classify('POST', `/api/orders/${token}/cancel/extra`)).toEqual(PASS);
  });

  it('counts POST, PATCH and DELETE on /api/cart and below as cart', () => {
    for (const method of ['POST', 'PATCH', 'DELETE']) {
      expect(classify(method, '/api/cart'), method).toEqual(count('cart'));
      expect(classify(method, '/api/cart/items'), method).toEqual(count('cart'));
      expect(
        classify(method, '/api/cart/items/0192d8a4-0000-7000-8000-000000000001'),
        method,
      ).toEqual(count('cart'));
    }
    // The no-JS form fallback is a POST with _method in the body: still a POST here.
    expect(classify('POST', '/api/cart/items/1?_method=delete')).toEqual(count('cart'));
    expect(classify('POST', '/api/cartography')).toEqual(PASS);
    expect(classify('POST', '/cart')).toEqual(PASS);
  });

  it('never counts GET, HEAD or OPTIONS on the write paths', () => {
    const paths = ['/api/checkout', '/api/orders/tok/cancel', '/api/cart', '/api/cart/items/1'];
    for (const method of ['GET', 'HEAD', 'OPTIONS', 'head', 'options']) {
      for (const path of paths) {
        expect(classify(method, path), `${method} ${path}`).toEqual(PASS);
      }
    }
  });

  it('counts other unsafe methods too: they cost the sender, not the shop', () => {
    expect(classify('PUT', '/api/checkout')).toEqual(count('checkout'));
    expect(classify('PUT', '/api/cart/items')).toEqual(count('cart'));
    expect(classify('DELETE', '/api/orders/tok/cancel')).toEqual(count('cancel'));
  });

  it('cannot be skipped by another spelling of the path', () => {
    expect(classify('POST', '/api/checkout/')).toEqual(count('checkout'));
    expect(classify('POST', '/api//checkout')).toEqual(count('checkout'));
    expect(classify('POST', '/api/%63heckout')).toEqual(count('checkout'));
    expect(classify('POST', '/api/x/%2e%2e/checkout')).toEqual(count('checkout'));
    expect(classify('POST', '/api/%63art/items')).toEqual(count('cart'));
    // One dynamic segment for the router, two once decoded: the raw form still matches.
    expect(classify('POST', '/api/orders/a%2Fb/cancel')).toEqual(count('cancel'));
    expect(classify('POST', '/api/orders/a%2Fb/%63ancel')).toEqual(count('cancel'));
    // A malformed escape is kept as is.
    expect(classify('POST', '/api/orders/%E0%A4%A/cancel')).toEqual(count('cancel'));
  });

  it('passes everything else', () => {
    expect(classify('POST', '/')).toEqual(PASS);
    expect(classify('POST', '/checkout')).toEqual(PASS);
    expect(classify('POST', '/o/token')).toEqual(PASS);
    expect(classify('GET', '/o/token')).toEqual(PASS);
    expect(classify('POST', '/api/health')).toEqual(PASS);
  });
});

describe('classifyLimitedRequest: phase 1B pay, order actions, webhook, admin', () => {
  const token = 'Zx9_aB-cd1234567890abcdefghijklmnopqrstuvw';

  it('counts POST /api/orders/<token>/pay as pay and /actions as order_action', () => {
    expect(classify('POST', `/api/orders/${token}/pay`)).toEqual(count('pay'));
    expect(classify('POST', `/api/orders/${token}/actions`)).toEqual(count('order_action'));
    expect(classify('POST', `/api/orders/${token}/%70ay`)).toEqual(count('pay'));
    expect(classify('POST', `/api/orders//${token}/actions/`)).toEqual(count('order_action'));
    expect(classify('PUT', `/api/orders/${token}/pay`)).toEqual(count('pay'));
  });

  it('never counts reads, other actions or prototype names', () => {
    for (const method of ['GET', 'HEAD', 'OPTIONS']) {
      expect(classify(method, `/api/orders/${token}/pay`), method).toEqual(PASS);
      expect(classify(method, `/api/orders/${token}/actions`), method).toEqual(PASS);
    }
    expect(classify('POST', `/api/orders/${token}/refund`)).toEqual(PASS);
    expect(classify('POST', `/api/orders/${token}/constructor`)).toEqual(PASS);
    expect(classify('POST', `/api/orders/${token}/toString`)).toEqual(PASS);
    expect(classify('POST', `/api/orders/${token}/pay/extra`)).toEqual(PASS);
    expect(classify('POST', '/api/orders/pay')).toEqual(PASS);
  });

  it('does not limit the YooKassa webhook or the admin (gated by the proxy itself)', () => {
    expect(classify('POST', '/api/webhooks/yookassa')).toEqual(PASS);
    expect(classify('POST', '/api/admin/orders/x/actions')).toEqual(PASS);
    expect(classify('GET', '/admin')).toEqual(PASS);
  });
});

describe('pathSegments and canonicalPath', () => {
  it('normalizes slashes and dot segments and decodes each segment once', () => {
    expect(canonicalPath('/')).toBe('/');
    expect(canonicalPath('')).toBe('/');
    expect(canonicalPath('/a//b/')).toBe('/a/b');
    expect(canonicalPath('/a/./b/../c')).toBe('/a/c');
    expect(canonicalPath('/../a')).toBe('/a');
    expect(canonicalPath('/%61pi')).toBe('/api');
    expect(canonicalPath('/%2561')).toBe('/%61');
    expect(canonicalPath('/%E0%A4%A/x')).toBe('/%E0%A4%A/x');
  });

  it('splits on the raw slash, as the router does', () => {
    expect(pathSegments('/o/a%2Fb')).toEqual(['o', 'a/b']);
    expect(pathSegments('/x/%2e%2e/y')).toEqual(['y']);
  });
});

describe('isForeignOriginWrite', () => {
  const base = 'https://detaly.example/';
  const foreign = (headers: Record<string, string>): boolean =>
    isForeignOriginWrite(new Headers(headers), base);

  it('is true only for an Origin other than the shop origin', () => {
    expect(foreign({ origin: 'https://evil.example' })).toBe(true);
    expect(foreign({ origin: 'null' })).toBe(true);
    expect(foreign({ origin: 'http://detaly.example' })).toBe(true);
    expect(foreign({ origin: 'https://detaly.example' })).toBe(false);
  });

  it('is false without Origin, so scripts and curl are still counted', () => {
    expect(foreign({})).toBe(false);
    expect(foreign({ 'sec-fetch-site': 'cross-site' })).toBe(false);
  });
});
