// Unit tests of the checkout building blocks: input parsing, items hash, uuid v7, cookies.
import { itemsHashPayload } from '@detaly/domain';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { cookieSource } from '@/server/checkout/handler';
import { itemsHash } from '@/server/checkout/hash';
import { cleanName, FIELD_MESSAGES, parseCheckoutInput } from '@/server/checkout/input';
import { parseCartPart } from '@/server/checkout/page-data';
import { newAccessToken, newPickupCode, orderUrl } from '@/server/checkout/checkout-service';
import { UUID_V7_RE, uuidV7 } from '@/server/checkout/uuid';

const HASH = 'a'.repeat(64);

function body(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    part: 'all',
    phone: '8 (912) 345-67-89',
    name: '  Иван   Петров ',
    channel: 'max',
    acceptOffer: true,
    consentPd: true,
    expectedTotalKop: 52_800,
    itemsHash: HASH,
    checkoutKey: uuidV7(),
    ...overrides,
  };
}

describe('parseCheckoutInput', () => {
  it('normalizes the phone and the name and drops unknown fields', () => {
    const result = parseCheckoutInput(body({ priceClientKop: 1, totalKop: 1 }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.input).toEqual({
      part: 'all',
      phone: '+79123456789',
      name: 'Иван Петров',
      channel: 'max',
      consentMarketing: false,
      expectedTotalKop: 52_800,
      itemsHash: HASH,
      checkoutKey: expect.stringMatching(UUID_V7_RE),
    });
    expect(result.input).not.toHaveProperty('priceClientKop');
  });

  it('defaults part to all and accepts the marketing tick only as true', () => {
    const result = parseCheckoutInput(body({ part: undefined, consentMarketing: 'true' }));
    expect(result.ok && result.input.part).toBe('all');
    expect(result.ok && result.input.consentMarketing).toBe(false);
    const ticked = parseCheckoutInput(body({ consentMarketing: true }));
    expect(ticked.ok && ticked.input.consentMarketing).toBe(true);
  });

  it.each([
    ['no body', undefined],
    ['an array', []],
    ['a bad part', body({ part: 'half' })],
    ['a fractional total', body({ expectedTotalKop: 1.5 })],
    ['a negative total', body({ expectedTotalKop: -1 })],
    ['a total as a string', body({ expectedTotalKop: '52800' })],
    ['a short hash', body({ itemsHash: 'abc' })],
    ['an upper-case hash', body({ itemsHash: 'A'.repeat(64) })],
    ['a bad checkout key', body({ checkoutKey: 'not-a-uuid' })],
  ])('rejects %s with 400', (_label, value) => {
    expect(parseCheckoutInput(value)).toEqual({ ok: false, status: 400, error: 'bad_request' });
  });

  it('requires both the offer and the PD consent (consent_required)', () => {
    expect(parseCheckoutInput(body({ consentPd: false }))).toEqual({
      ok: false,
      status: 422,
      error: 'consent_required',
      fields: { consentPd: FIELD_MESSAGES.consentPd },
    });
    expect(parseCheckoutInput(body({ acceptOffer: 'on' }))).toMatchObject({
      status: 422,
      error: 'consent_required',
      fields: { acceptOffer: FIELD_MESSAGES.acceptOffer },
    });
    const both = parseCheckoutInput(body({ acceptOffer: undefined, consentPd: undefined }));
    expect(both).toMatchObject({ error: 'consent_required' });
  });

  it('marks invalid phone, name and channel per field (validation)', () => {
    expect(
      parseCheckoutInput(body({ phone: '+1 202 555 0100', name: '', channel: 'whatsapp' })),
    ).toEqual({
      ok: false,
      status: 422,
      error: 'validation',
      fields: {
        phone: FIELD_MESSAGES.phone,
        name: FIELD_MESSAGES.name,
        channel: FIELD_MESSAGES.channel,
      },
    });
    expect(parseCheckoutInput(body({ phone: 89123456789 }))).toMatchObject({
      fields: { phone: FIELD_MESSAGES.phone },
    });
  });

  it('cleanName: letters required, 60 characters at most, control characters removed', () => {
    expect(cleanName('Анна\u0000\nМария')).toBe('Анна Мария');
    expect(cleanName('a'.repeat(60))).toBe('a'.repeat(60));
    expect(cleanName('a'.repeat(61))).toBeNull();
    expect(cleanName('12345')).toBeNull();
    expect(cleanName('   ')).toBeNull();
    expect(cleanName(42)).toBeNull();
  });
});

describe('itemsHash', () => {
  const lines = [
    { offerKey: 'OC90:Knecht:ORB1', qty: 1, priceClientKop: 52_800 },
    { offerKey: '0451103079:BOSCH:MSK7', qty: 2, priceClientKop: 64_200 },
  ];

  it('is sha256 hex of the canonical payload, independent of line order', () => {
    const expected = createHash('sha256').update(itemsHashPayload(lines)).digest('hex');
    expect(itemsHash(lines)).toBe(expected);
    expect(itemsHash([...lines].reverse())).toBe(expected);
    expect(expected).toMatch(/^[0-9a-f]{64}$/);
  });

  it('changes with a price or a quantity', () => {
    const base = itemsHash(lines);
    expect(itemsHash([{ ...lines[0]!, priceClientKop: 52_900 }, lines[1]!])).not.toBe(base);
    expect(itemsHash([{ ...lines[0]!, qty: 2 }, lines[1]!])).not.toBe(base);
  });
});

describe('tokens and keys', () => {
  it('uuidV7 carries the timestamp, version 7 and the RFC variant', () => {
    const at = Date.UTC(2026, 9, 2, 10, 0, 0);
    const key = uuidV7(at);
    expect(key).toMatch(UUID_V7_RE);
    expect(parseInt(key.replace(/-/g, '').slice(0, 12), 16)).toBe(at);
    expect(uuidV7(at)).not.toBe(key);
    expect(uuidV7(at + 1) > key).toBe(true);
  });

  it('access tokens are 43 base64url characters; pickup codes are 6 digits', () => {
    const token = newAccessToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(newAccessToken()).not.toBe(token);
    expect(orderUrl(token)).toBe(`/o/${token}`);
    for (let i = 0; i < 50; i += 1) expect(newPickupCode()).toMatch(/^\d{6}$/);
  });

  it('cookieSource reads the first occurrence of a cookie', () => {
    const source = cookieSource('a=1; cart=abc; cart=def; broken; =x');
    expect(source.get('cart')).toEqual({ value: 'abc' });
    expect(source.get('a')).toEqual({ value: '1' });
    expect(source.get('missing')).toBeUndefined();
    expect(cookieSource(null).get('cart')).toBeUndefined();
  });

  it('parseCartPart falls back to all', () => {
    expect(parseCartPart('local')).toBe('local');
    expect(parseCartPart(['order', 'local'])).toBe('order');
    expect(parseCartPart('everything')).toBe('all');
    expect(parseCartPart(undefined)).toBe('all');
  });
});
