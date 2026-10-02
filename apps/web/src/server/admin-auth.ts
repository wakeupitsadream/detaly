/**
 * Basic auth of the mini admin (decision Б25, docs/phase-1b-implementation.md section 15).
 *
 * One account, ADMIN_BASIC_AUTH=`user:password` (Б19: whoever holds it acts as the owner).
 * - Without ADMIN_BASIC_AUTH the admin does not exist: /admin and /api/admin/* answer 404.
 * - The decoded `user:password` of the request is compared with the configured value as
 *   timingSafeEqual(sha256(given), sha256(expected)): equal-length digests, so neither the
 *   length nor a common prefix of the secret leaks through the comparison time.
 * - The gate itself runs in src/proxy.ts (Next 16: a layout cannot answer 401). Pages and the
 *   action handler call the same check again (defence in depth if a matcher ever misses).
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import { canonicalPath } from './request-limits';

/** WWW-Authenticate of a 401 (RFC 7617, the password may be UTF-8). */
export const ADMIN_CHALLENGE = 'Basic realm="admin", charset="UTF-8"';

/** Longest Authorization header looked at; anything longer is a wrong password. */
const MAX_AUTHORIZATION_LENGTH = 1024;

const BASIC_RE = /^Basic[ \t]+([A-Za-z0-9+/]+={0,2})[ \t]*$/i;

export type AdminAuthResult =
  /** ADMIN_BASIC_AUTH is not configured: 404. */
  | 'disabled'
  /** No Authorization header: 401 with the challenge, not counted as a wrong password. */
  | 'missing'
  /** Wrong, malformed or non-Basic credentials: 401, counted (admin_auth). */
  | 'invalid'
  | 'ok';

function under(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(`${prefix}/`);
}

/** /admin, /admin/** and /api/admin/** in any spelling the router may serve. */
export function isAdminPath(pathname: string): boolean {
  const path = canonicalPath(pathname);
  return under(path, '/admin') || under(path, '/api/admin');
}

/** The decoded `user:password` of a Basic Authorization header, or null when malformed. */
export function decodeBasicAuth(header: string): string | null {
  if (header.length > MAX_AUTHORIZATION_LENGTH) return null;
  const match = BASIC_RE.exec(header.trim());
  if (!match?.[1]) return null;
  const decoded = Buffer.from(match[1], 'base64').toString('utf8');
  return decoded.includes(':') ? decoded : null;
}

function digest(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

/** Constant-time comparison of two secrets of any length. */
export function secretsEqual(given: string, expected: string): boolean {
  return timingSafeEqual(digest(given), digest(expected));
}

interface HeaderSource {
  get(name: string): string | null;
}

/** Checks the Authorization header of a request against ADMIN_BASIC_AUTH. */
export function checkAdminAuth(
  headers: HeaderSource,
  expected: string | undefined,
): AdminAuthResult {
  if (!expected) return 'disabled';
  const header = headers.get('authorization');
  if (header === null || header.trim() === '') return 'missing';
  const given = decodeBasicAuth(header);
  // Compare even a malformed value, so both branches take the same time.
  const ok = secretsEqual(given ?? '', expected);
  return given !== null && ok ? 'ok' : 'invalid';
}

/** Headers of every /admin and /api/admin response, the 401, 404 and 429 included. */
export const ADMIN_RESPONSE_HEADERS: Readonly<Record<string, string>> = {
  'X-Robots-Tag': 'noindex, nofollow',
  'Cache-Control': 'no-store',
  'Referrer-Policy': 'no-referrer',
};
