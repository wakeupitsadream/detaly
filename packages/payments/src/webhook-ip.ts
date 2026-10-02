/**
 * IP allowlist of YooKassa notifications (decision Б4). The web route takes the client address
 * only from X-Real-IP set by Caddy (TRUSTED_IP_HEADER=x-real-ip) and checks it against
 * YOOKASSA_WEBHOOK_IP_ALLOWLIST: single addresses and CIDR networks, IPv4 and IPv6, matched with
 * node:net BlockList. Fail closed: an empty allowlist or an unparsable address allows nothing.
 */
import { BlockList, isIPv4, isIPv6 } from 'node:net';

/**
 * Networks YooKassa publishes for outgoing notifications, kept for the .env.example comment,
 * startup warnings and tests. The allowlist itself always comes from env.
 * VERIFY Ю5: the current list on yookassa.ru (developers → using-api → webhooks).
 */
export const YOOKASSA_DOCUMENTED_WEBHOOK_NETWORKS = [
  '185.71.76.0/27',
  '185.71.77.0/27',
  '77.75.153.0/25',
  '77.75.156.11',
  '77.75.156.35',
  '77.75.154.128/25',
  '2a02:5180::/32',
] as const;

export class WebhookIpAllowlistError extends Error {
  override name = 'WebhookIpAllowlistError';
}

/** A parsed allowlist; build it once at startup with parseWebhookIpAllowlist. */
export interface WebhookIpAllowlist {
  readonly entries: readonly string[];
  readonly size: number;
  /** @internal */
  readonly blockList: BlockList;
}

type Family = 'ipv4' | 'ipv6';

/** Expands an IPv6 address (no zone, may end in dotted IPv4) into 8 hextets, or null. */
function ipv6Hextets(address: string): number[] | null {
  let text = address;
  const tail: number[] = [];
  const lastColon = text.lastIndexOf(':');
  const last = text.slice(lastColon + 1);
  if (last.includes('.')) {
    if (!isIPv4(last)) return null;
    const [a = 0, b = 0, c = 0, d = 0] = last.split('.').map(Number);
    tail.push((a << 8) | b, (c << 8) | d);
    text = `${text.slice(0, lastColon + 1)}0:0`;
  }
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const parse = (part: string): number[] =>
    part === '' ? [] : part.split(':').map((h) => Number.parseInt(h, 16));
  const head = parse(halves[0] ?? '');
  const rest = halves.length === 2 ? parse(halves[1] ?? '') : [];
  const missing = 8 - head.length - rest.length;
  if (missing < 0 || (halves.length === 1 && missing !== 0)) return null;
  const hextets = [...head, ...Array<number>(missing).fill(0), ...rest];
  if (tail.length === 2) hextets.splice(6, 2, ...tail);
  return hextets.length === 8 && hextets.every((h) => Number.isInteger(h) && h >= 0 && h <= 0xffff)
    ? hextets
    : null;
}

/**
 * Normalises an address: trims, unwraps IPv4-mapped IPv6 ('::ffff:185.71.76.1' and
 * '::ffff:b947:4c01') to plain IPv4. Returns null for anything that is not a bare IP address
 * (zone ids, brackets, ports, hostnames, empty strings).
 */
function normaliseAddress(raw: string): { address: string; family: Family } | null {
  const address = raw.trim();
  if (address === '' || address.includes('%')) return null;
  if (isIPv4(address)) return { address, family: 'ipv4' };
  if (!isIPv6(address)) return null;
  const hextets = ipv6Hextets(address);
  if (hextets === null) return { address: address.toLowerCase(), family: 'ipv6' };
  const mapped = hextets.slice(0, 5).every((h) => h === 0) && hextets[5] === 0xffff;
  if (mapped) {
    const hi = hextets[6] ?? 0;
    const lo = hextets[7] ?? 0;
    return { address: `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`, family: 'ipv4' };
  }
  return { address: address.toLowerCase(), family: 'ipv6' };
}

const PREFIX_RE = /^\d{1,3}$/u;

/**
 * Parses YOOKASSA_WEBHOOK_IP_ALLOWLIST entries ('185.71.76.0/27', '77.75.156.11',
 * '2a02:5180::/32'). Throws WebhookIpAllowlistError naming the first invalid entry: a typo in
 * the list must stop the start, not silently drop a network.
 */
export function parseWebhookIpAllowlist(list: readonly string[]): WebhookIpAllowlist {
  const blockList = new BlockList();
  const entries: string[] = [];
  for (const rawEntry of list) {
    const entry = rawEntry.trim();
    if (entry === '') continue;
    const slash = entry.indexOf('/');
    const addressPart = slash === -1 ? entry : entry.slice(0, slash);
    const normalised = normaliseAddress(addressPart);
    if (normalised === null) {
      throw new WebhookIpAllowlistError(`invalid webhook allowlist entry '${entry}'`);
    }
    if (slash === -1) {
      blockList.addAddress(normalised.address, normalised.family);
    } else {
      const prefixText = entry.slice(slash + 1);
      const mappedFromV6 = normalised.family === 'ipv4' && isIPv6(addressPart.trim());
      let prefix = PREFIX_RE.test(prefixText) ? Number(prefixText) : Number.NaN;
      // '::ffff:1.2.3.0/120' is the IPv4 network 1.2.3.0/24.
      if (mappedFromV6) prefix -= 96;
      const max = normalised.family === 'ipv4' ? 32 : 128;
      if (!Number.isInteger(prefix) || prefix < 0 || prefix > max) {
        throw new WebhookIpAllowlistError(`invalid webhook allowlist entry '${entry}'`);
      }
      blockList.addSubnet(normalised.address, prefix, normalised.family);
    }
    entries.push(entry);
  }
  return { entries, size: entries.length, blockList };
}

/**
 * True when `ip` (the X-Real-IP value) is in the allowlist. Garbage, empty values and an empty
 * allowlist give false. A string array is parsed on every call (and throws on invalid entries);
 * pass a parsed allowlist on hot paths.
 */
export function isAllowedWebhookIp(
  ip: string | null | undefined,
  allowlist: WebhookIpAllowlist | readonly string[],
): boolean {
  if (typeof ip !== 'string') return false;
  const parsed = isParsedAllowlist(allowlist) ? allowlist : parseWebhookIpAllowlist(allowlist);
  if (parsed.size === 0) return false;
  const normalised = normaliseAddress(ip);
  if (normalised === null) return false;
  return parsed.blockList.check(normalised.address, normalised.family);
}

function isParsedAllowlist(
  value: WebhookIpAllowlist | readonly string[],
): value is WebhookIpAllowlist {
  return !Array.isArray(value);
}
