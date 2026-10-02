/**
 * Which rate limit a request spends (used by src/proxy.ts; limits in server/rate-limit.ts).
 *
 * - search: /search and /api/search, exactly as classifySearchRequest decides (HEAD answered
 *   by the proxy, only a genuine router prefetch is free).
 * - checkout: POST /api/checkout.
 * - cancel: POST /api/orders/<token>/cancel.
 * - pay: POST /api/orders/<token>/pay (phase 1B).
 * - order_action: POST /api/orders/<token>/actions (phase 1B).
 * - cart: POST, PATCH and DELETE on /api/cart and /api/cart/**.
 *
 * Not limited here: the YooKassa webhook (/api/webhooks/yookassa, closed by the IP allowlist
 * in its handler) and /admin with /api/admin (Basic auth in the proxy, which limits wrong
 * passwords itself: admin_auth).
 *
 * On the checkout, cancel, pay, order action and cart paths GET, HEAD and OPTIONS are never counted (they change
 * nothing and are used by CORS preflights and link checkers). Any other method is counted, not
 * only the ones the handlers export: an unexported method costs a 405 and nothing more, and
 * counting it keeps the classifier from depending on what each handler happens to export.
 *
 * Paths are compared by segments the way the router sees them: split on the raw `/`, each
 * segment percent-decoded once, empty and `.` segments dropped, `..` resolved. So a spelling
 * the router may still map to a handler (`/api/%63heckout`, `/api//checkout/`) cannot skip the
 * counter. Counting a spelling the router rejects only costs the sender their own allowance.
 *
 * A write with a foreign `Origin` is not counted either (isForeignOriginWrite): the handlers
 * reject it with 403 before doing any work, and counting it would let any site the visitor
 * opens lock the visitor's bucket with hidden form posts.
 */
import type { RateLimitKind } from './rate-limit';
import { isSameOrigin } from './request-guards';
import { classifySearchRequest, type HeaderSource } from './search-request';

export type LimitedRequest =
  { kind: RateLimitKind; action: 'count' | 'head' } | { kind: null; action: 'pass' };

export interface LimitedRequestLike {
  method: string;
  pathname: string;
  searchParams: URLSearchParams;
  headers: HeaderSource;
}

const PASS: LimitedRequest = { kind: null, action: 'pass' };

/** Methods that never change state; not counted on the write paths. */
const SAFE_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD', 'OPTIONS']);

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    // Malformed escape: keep the raw segment.
    return segment;
  }
}

/** Decoded path segments (see the module comment). A decoded segment may contain `/`. */
export function pathSegments(pathname: string): string[] {
  const segments: string[] = [];
  for (const raw of pathname.split('/')) {
    const segment = decodeSegment(raw);
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  return segments;
}

/**
 * Canonical path for prefix checks (`/o/…`, `/cart`): the decoded segments joined with `/`.
 * A `%2F` inside a segment becomes a separator here, which only ever makes a prefix match
 * more likely.
 */
export function canonicalPath(pathname: string): string {
  return `/${pathSegments(pathname).join('/')}`;
}

/** Limits of the order API by its last segment: /api/orders/<token>/<action>. */
const ORDER_WRITE_KINDS: Readonly<Record<string, RateLimitKind>> = {
  cancel: 'cancel',
  pay: 'pay',
  actions: 'order_action',
};

/** Write-path limit of a decoded path, or null. */
function writeKind(segments: string[]): RateLimitKind | null {
  if (segments[0] !== 'api') return null;
  const [, area, token, action] = segments;
  if (area === 'checkout' && segments.length === 2) return 'checkout';
  if (area === 'orders' && segments.length === 4 && token && action !== undefined) {
    return Object.hasOwn(ORDER_WRITE_KINDS, action) ? (ORDER_WRITE_KINDS[action] ?? null) : null;
  }
  if (area === 'cart') return 'cart';
  return null;
}

export function classifyLimitedRequest(request: LimitedRequestLike): LimitedRequest {
  const segments = pathSegments(request.pathname);
  const search = classifySearchRequest({ ...request, pathname: `/${segments.join('/')}` });
  if (search !== 'pass') return { kind: 'search', action: search };
  if (SAFE_METHODS.has(request.method.toUpperCase())) return PASS;
  const kind = writeKind(segments);
  return kind === null ? PASS : { kind, action: 'count' };
}

/**
 * True for a checkout, cancel, pay, order action or cart write that carries an `Origin` other than APP_BASE_URL's
 * (`null` included, unless `Sec-Fetch-Site: same-origin` marks it as a form on one of our
 * no-referrer pages, see isSameOrigin). Browsers send `Origin` on every cross-site POST, and a cross-site PATCH or
 * DELETE never gets past the CORS preflight, so this is exactly the CSRF case: the handler
 * answers 403 (decision Д19) and the proxy does not spend the visitor's allowance on it.
 * Otherwise five hidden forms on any page would block cancellation for the visitor's whole
 * /64 or carrier NAT for an hour. Requests without `Origin` (scripts, curl, the e2e) are
 * counted, and a forged foreign `Origin` buys an attacker nothing but a 403.
 */
export function isForeignOriginWrite(headers: HeaderSource, appBaseUrl: string): boolean {
  return headers.get('origin') !== null && !isSameOrigin(headers, appBaseUrl);
}
