/**
 * UUID v7 (RFC 9562) for the checkout idempotency key rendered into the form. Web has no
 * `uuid` dependency, and node:crypto only makes v4: 48-bit Unix ms timestamp, version 7,
 * 74 random bits, variant 10.
 */
import { randomBytes } from 'node:crypto';

export const UUID_V7_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function uuidV7(nowMs: number = Date.now()): string {
  const bytes = randomBytes(16);
  const ms = Math.max(0, Math.trunc(nowMs));
  // 48-bit big-endian timestamp (2^48 ms is far beyond any real clock).
  let rest = ms;
  for (let i = 5; i >= 0; i -= 1) {
    bytes[i] = rest % 256;
    rest = Math.floor(rest / 256);
  }
  bytes[6] = ((bytes[6] as number) & 0x0f) | 0x70;
  bytes[8] = ((bytes[8] as number) & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
