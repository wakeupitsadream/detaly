/**
 * Checks shared by every state-changing request (cart, checkout, order cancellation) and the
 * consent evidence taken from a request (docs/phase-1a-implementation.md, Д7 and Д19).
 */
import { isIP } from 'node:net';
import { LOCAL_CLIENT } from './client-ip';

interface HeaderSource {
  get(name: string): string | null;
}

/**
 * Decision Д19: `Origin` must equal the origin of APP_BASE_URL exactly. Without `Origin`
 * (older browsers on same-origin form posts) the request passes only with
 * `Sec-Fetch-Site: same-origin`; anything else is rejected (403 by the caller).
 *
 * `Origin: null` is treated as a missing `Origin`: browsers send it on a same-origin form
 * POST from a page with `Referrer-Policy: no-referrer` (Fetch, «serialize a request origin»),
 * which is exactly the «Оплатить N ₽» form on /o/<token>. `Sec-Fetch-Site` is set by the
 * browser itself, so a sandboxed frame or a data: URL elsewhere (also `Origin: null`) arrives
 * as cross-site and is still rejected.
 */
export function isSameOrigin(headers: HeaderSource, appBaseUrl: string): boolean {
  let expected: string;
  try {
    expected = new URL(appBaseUrl).origin;
  } catch {
    return false;
  }
  const origin = headers.get('origin')?.trim() ?? null;
  if (origin !== null && origin !== 'null') return origin === expected;
  return headers.get('sec-fetch-site')?.trim().toLowerCase() === 'same-origin';
}

/** Hidden form field humans never fill (off screen, tabIndex -1, aria-hidden). */
export const HONEYPOT_FIELD = 'website';

/** A filled honeypot means a bot. Missing, null and blank values pass. */
export function isHoneypotTripped(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === 'string') return value.trim() !== '';
  return true;
}

/**
 * IP for consents.ip (decision Д7: kept as proof of consent). Only a trusted client address
 * is stored: the shared bucket 'local' (TRUSTED_IP_HEADER=none) and anything that is not an
 * IP literal become null. An IPv6 zone id is dropped (inet does not accept it).
 */
export function consentIp(ip: string | null | undefined): string | null {
  if (!ip || ip === LOCAL_CLIENT) return null;
  const address = ip.trim().replace(/%.*$/, '');
  return isIP(address) === 0 ? null : address;
}

/** Longest user agent stored with a consent. */
export const CONSENT_USER_AGENT_MAX = 512;

/** User-Agent for consents.user_agent: control characters removed, at most 512 chars. */
export function userAgentForConsent(headers: HeaderSource): string | null {
  const raw = headers.get('user-agent');
  if (raw === null) return null;
  // eslint-disable-next-line no-control-regex
  const clean = raw.replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  return clean === '' ? null : clean.slice(0, CONSENT_USER_AGENT_MAX);
}
