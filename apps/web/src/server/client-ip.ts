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

const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
const HEXTET_RE = /^[0-9a-f]{1,4}$/;

function ipv4Octets(value: string): number[] | null {
  const m = IPV4_RE.exec(value);
  if (m === null) return null;
  const octets = m.slice(1, 5).map(Number);
  return octets.every((o) => o <= 255) ? octets : null;
}

/** Eight 16-bit groups of an IPv6 text (with '::' and a dotted IPv4 tail), or null. */
function ipv6Groups(text: string): number[] | null {
  const value = text.replace(/%.*$/, '');
  const halves = value.split('::');
  if (halves.length > 2) return null;
  const parse = (part: string): number[] | null => {
    if (part === '') return [];
    const out: number[] = [];
    const pieces = part.split(':');
    for (let i = 0; i < pieces.length; i += 1) {
      const piece = pieces[i] as string;
      if (i === pieces.length - 1 && piece.includes('.')) {
        const octets = ipv4Octets(piece);
        if (octets === null) return null;
        out.push(((octets[0] as number) << 8) | (octets[1] as number));
        out.push(((octets[2] as number) << 8) | (octets[3] as number));
      } else if (HEXTET_RE.test(piece)) {
        out.push(parseInt(piece, 16));
      } else {
        return null;
      }
    }
    return out;
  };
  const head = parse(halves[0] as string);
  const tail = halves.length === 2 ? parse(halves[1] as string) : [];
  if (head === null || tail === null) return null;
  if (halves.length === 1) return head.length === 8 ? head : null;
  const missing = 8 - head.length - tail.length;
  if (missing < 1) return null;
  return [...head, ...new Array<number>(missing).fill(0), ...tail];
}

/**
 * Rate-limit subject of a client address. One IPv6 host usually owns a whole /64 (any VPS),
 * so per-address buckets would give it 2^64 fresh limits: IPv6 is bucketed by its /64 prefix.
 * IPv4-mapped IPv6 (::ffff:a.b.c.d) is the IPv4 address itself. Anything unparseable shares
 * the 'local' bucket.
 */
export function rateLimitSubject(ip: string): string {
  if (ip === LOCAL_CLIENT) return ip;
  if (ipv4Octets(ip) !== null) return ip;
  const groups = ipv6Groups(ip.toLowerCase());
  if (groups === null) return LOCAL_CLIENT;
  const mapped =
    groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff ? groups.slice(6) : null;
  if (mapped !== null) {
    const [hi = 0, lo = 0] = mapped;
    return [hi >> 8, hi & 0xff, lo >> 8, lo & 0xff].join('.');
  }
  return `${groups
    .slice(0, 4)
    .map((g) => g.toString(16).padStart(4, '0'))
    .join(':')}::/64`;
}
