import { describe, expect, it } from 'vitest';
import {
  CONSENT_USER_AGENT_MAX,
  consentIp,
  HONEYPOT_FIELD,
  isHoneypotTripped,
  isSameOrigin,
  userAgentForConsent,
} from '@/server/request-guards';

const BASE = 'https://detaly.example';

function headers(values: Record<string, string>): Headers {
  return new Headers(values);
}

describe('isSameOrigin', () => {
  it('accepts an Origin equal to the APP_BASE_URL origin', () => {
    expect(isSameOrigin(headers({ origin: 'https://detaly.example' }), BASE)).toBe(true);
    expect(isSameOrigin(headers({ origin: 'https://detaly.example' }), `${BASE}/some/path`)).toBe(
      true,
    );
    expect(
      isSameOrigin(headers({ origin: 'http://127.0.0.1:3100' }), 'http://127.0.0.1:3100'),
    ).toBe(true);
  });

  it('rejects any other Origin, even with Sec-Fetch-Site: same-origin', () => {
    for (const origin of [
      'https://evil.example',
      'http://detaly.example',
      'https://detaly.example:8443',
      'https://sub.detaly.example',
      'null',
      '',
    ]) {
      expect(isSameOrigin(headers({ origin, 'sec-fetch-site': 'same-origin' }), BASE), origin).toBe(
        false,
      );
    }
  });

  it('without Origin accepts only Sec-Fetch-Site: same-origin', () => {
    expect(isSameOrigin(headers({ 'sec-fetch-site': 'same-origin' }), BASE)).toBe(true);
    expect(isSameOrigin(headers({ 'sec-fetch-site': 'cross-site' }), BASE)).toBe(false);
    expect(isSameOrigin(headers({ 'sec-fetch-site': 'same-site' }), BASE)).toBe(false);
    expect(isSameOrigin(headers({ 'sec-fetch-site': 'none' }), BASE)).toBe(false);
    expect(isSameOrigin(headers({}), BASE)).toBe(false);
  });

  it('fails closed on a broken base URL', () => {
    expect(isSameOrigin(headers({ origin: 'x' }), 'not a url')).toBe(false);
  });
});

describe('honeypot', () => {
  it('is the "website" field', () => {
    expect(HONEYPOT_FIELD).toBe('website');
  });

  it('trips on any filled value', () => {
    expect(isHoneypotTripped('https://spam.example')).toBe(true);
    expect(isHoneypotTripped('x')).toBe(true);
    expect(isHoneypotTripped(['a'])).toBe(true);
    expect(isHoneypotTripped(1)).toBe(true);
  });

  it('passes empty values', () => {
    expect(isHoneypotTripped(undefined)).toBe(false);
    expect(isHoneypotTripped(null)).toBe(false);
    expect(isHoneypotTripped('')).toBe(false);
    expect(isHoneypotTripped('   ')).toBe(false);
  });
});

describe('consentIp', () => {
  it('stores no IP for the untrusted shared bucket', () => {
    expect(consentIp('local')).toBeNull();
    expect(consentIp(null)).toBeNull();
    expect(consentIp('')).toBeNull();
  });

  it('keeps valid IPv4 and IPv6 literals, dropping a zone id', () => {
    expect(consentIp('203.0.113.7')).toBe('203.0.113.7');
    expect(consentIp('2001:db8::1')).toBe('2001:db8::1');
    expect(consentIp('fe80::1%eth0')).toBe('fe80::1');
  });

  it('rejects anything else', () => {
    expect(consentIp('999.1.1.1')).toBeNull();
    expect(consentIp('example.com')).toBeNull();
  });
});

describe('userAgentForConsent', () => {
  it('keeps the user agent, trimmed to 512 characters without control characters', () => {
    expect(userAgentForConsent(headers({ 'user-agent': ' Mozilla/5.0 ' }))).toBe('Mozilla/5.0');
    const long = userAgentForConsent(headers({ 'user-agent': 'A'.repeat(600) }));
    expect(long).toHaveLength(CONSENT_USER_AGENT_MAX);
    expect(userAgentForConsent({ get: () => 'a\u0000b\tc' })).toBe('a b c');
  });

  it('is null without the header', () => {
    expect(userAgentForConsent(headers({}))).toBeNull();
    expect(userAgentForConsent(headers({ 'user-agent': '   ' }))).toBeNull();
  });
});
