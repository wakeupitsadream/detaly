/**
 * Client IP for rate limiting. Only Caddy sets X-Real-IP (from the TCP peer) and web is not
 * reachable directly, so the header is trusted only when TRUSTED_IP_HEADER=x-real-ip.
 * Otherwise (local runs, unknown topology) every request maps to the shared bucket 'local':
 * a spoofable header must never let a client pick its own rate-limit bucket.
 *
 * X-Forwarded-For is ignored on purpose: Caddy rewrites it, and the left-most value is
 * client-controlled.
 */
import type { Env } from './env';

export const LOCAL_CLIENT = 'local';

/** IPv4 or IPv6 text (optionally with a zone id), at most 45 characters. */
const IP_RE = /^(?:\d{1,3}(?:\.\d{1,3}){3}|[0-9a-f:.]*:[0-9a-f:.]*(?:%[\w.-]+)?)$/i;

interface HeaderSource {
  get(name: string): string | null;
}

export function getClientIp(
  headers: HeaderSource,
  trustedHeader: Env['TRUSTED_IP_HEADER'],
): string {
  if (trustedHeader !== 'x-real-ip') return LOCAL_CLIENT;
  const raw = headers.get('x-real-ip')?.trim();
  if (!raw || raw.length > 45 || !IP_RE.test(raw)) return LOCAL_CLIENT;
  return raw.toLowerCase();
}
