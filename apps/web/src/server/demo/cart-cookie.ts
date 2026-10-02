/**
 * The demo cart lives in the browser (DEMO_MODE has no database): the httpOnly cookie
 * `demo_cart` holds the lines as `<payload>.<signature>`, base64url JSON signed with
 * HMAC-SHA256 over SESSION_SECRET. The cookie keeps only what the client chose (query article,
 * offer id, quantity, a line id); prices are never taken from it: every read re-prices the
 * lines from the supplier fixtures, exactly as the live cart never trusts the client.
 *
 * A cookie with a bad signature, a wrong shape or too many lines reads as an empty cart.
 */
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import type { Env } from '@detaly/config';
import { MAX_CART_LINES } from '../cart-store';

export const DEMO_CART_COOKIE = 'demo_cart';

/** One cart line as stored in the cookie. */
export interface DemoCartLine {
  /** Line id (uuid): the /api/cart/items/<id> address. */
  id: string;
  /** Normalized query article the offer was found by (repricing searches by it). */
  q: string;
  /** offerViewId of the chosen offer. */
  offerId: string;
  qty: number;
}

const VERSION = 1;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ARTICLE_RE = /^[A-Z0-9]{3,64}$/;
const MAX_OFFER_ID = 200;
const MAX_QTY = 9999;
/** Larger values are not even decoded (4 KB is the browser's cookie limit anyway). */
const MAX_COOKIE_LENGTH = 4096;

export function newDemoLineId(): string {
  return randomUUID();
}

function sign(secret: string, payload: string): string {
  // Domain-separated from the rate-limit buckets, which use the same secret.
  return createHmac('sha256', secret).update(`demo_cart:${payload}`).digest('base64url');
}

function isLine(value: unknown): value is [string, string, string, number] {
  if (!Array.isArray(value) || value.length !== 4) return false;
  const [id, q, offerId, qty] = value as unknown[];
  return (
    typeof id === 'string' &&
    UUID_RE.test(id) &&
    typeof q === 'string' &&
    ARTICLE_RE.test(q) &&
    typeof offerId === 'string' &&
    offerId.length > 0 &&
    offerId.length <= MAX_OFFER_ID &&
    typeof qty === 'number' &&
    Number.isSafeInteger(qty) &&
    qty >= 1 &&
    qty <= MAX_QTY
  );
}

export function encodeDemoCart(lines: readonly DemoCartLine[], secret: string): string {
  if (lines.length > MAX_CART_LINES) throw new RangeError('too many demo cart lines');
  const payload = Buffer.from(
    JSON.stringify({ v: VERSION, l: lines.map((l) => [l.id, l.q, l.offerId, l.qty]) }),
  ).toString('base64url');
  return `${payload}.${sign(secret, payload)}`;
}

/** The lines of a cookie value; [] for a missing, forged or malformed one. */
export function decodeDemoCart(value: string | null | undefined, secret: string): DemoCartLine[] {
  if (!value || value.length > MAX_COOKIE_LENGTH) return [];
  const dot = value.indexOf('.');
  if (dot <= 0) return [];
  const payload = value.slice(0, dot);
  const given = Buffer.from(value.slice(dot + 1), 'base64url');
  const expected = Buffer.from(sign(secret, payload), 'base64url');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return [];
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as unknown;
    if (typeof data !== 'object' || data === null) return [];
    const { v, l } = data as { v?: unknown; l?: unknown };
    if (v !== VERSION || !Array.isArray(l) || l.length > MAX_CART_LINES) return [];
    if (!l.every(isLine)) return [];
    const lines = l.map(([id, q, offerId, qty]) => ({ id, q, offerId, qty }));
    return new Set(lines.map((line) => line.id)).size === lines.length ? lines : [];
  } catch {
    return [];
  }
}

/** `Set-Cookie` value for the demo cart (HttpOnly, SameSite=Lax, Secure on https). */
export function demoCartSetCookie(
  value: string | null,
  env: Pick<Env, 'APP_BASE_URL' | 'CART_TTL_DAYS'>,
): string {
  const parts = [
    `${DEMO_CART_COOKIE}=${value ?? ''}`,
    'Path=/',
    `Max-Age=${value === null ? 0 : env.CART_TTL_DAYS * 86_400}`,
    'HttpOnly',
    'SameSite=Lax',
  ];
  if (new URL(env.APP_BASE_URL).protocol === 'https:') parts.push('Secure');
  return parts.join('; ');
}
