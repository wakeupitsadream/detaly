// server/admin-auth.ts: Basic auth parsing, the constant-time check and the admin paths.
import { describe, expect, it } from 'vitest';
import {
  ADMIN_CHALLENGE,
  checkAdminAuth,
  decodeBasicAuth,
  isAdminPath,
  secretsEqual,
} from '@/server/admin-auth';

const EXPECTED = 'admin:пароль с пробелами и: двоеточием';

function headers(authorization?: string): Headers {
  return new Headers(authorization === undefined ? {} : { authorization });
}

function basic(credentials: string): string {
  return `Basic ${Buffer.from(credentials, 'utf8').toString('base64')}`;
}

describe('decodeBasicAuth', () => {
  it('decodes user:password as UTF-8 (the challenge announces charset="UTF-8")', () => {
    expect(ADMIN_CHALLENGE).toBe('Basic realm="admin", charset="UTF-8"');
    expect(decodeBasicAuth(basic(EXPECTED))).toBe(EXPECTED);
    expect(decodeBasicAuth(`basic   ${Buffer.from('a:b').toString('base64')}  `)).toBe('a:b');
  });

  it('rejects other schemes, garbage, a missing colon and oversized headers', () => {
    expect(decodeBasicAuth('Bearer abc')).toBeNull();
    expect(decodeBasicAuth('Basic')).toBeNull();
    expect(decodeBasicAuth('Basic !!!')).toBeNull();
    expect(decodeBasicAuth(basic('no-colon'))).toBeNull();
    expect(decodeBasicAuth(basic(`admin:${'x'.repeat(2000)}`))).toBeNull();
  });
});

describe('checkAdminAuth', () => {
  it('is disabled without ADMIN_BASIC_AUTH, whatever the request carries', () => {
    expect(checkAdminAuth(headers(basic(EXPECTED)), undefined)).toBe('disabled');
    expect(checkAdminAuth(headers(), '')).toBe('disabled');
  });

  it('tells a missing header from wrong credentials', () => {
    expect(checkAdminAuth(headers(), EXPECTED)).toBe('missing');
    expect(checkAdminAuth(headers('   '), EXPECTED)).toBe('missing');
    expect(checkAdminAuth(headers(basic('admin:wrong')), EXPECTED)).toBe('invalid');
    expect(checkAdminAuth(headers(basic(`${EXPECTED} `)), EXPECTED)).toBe('invalid');
    expect(checkAdminAuth(headers(basic(EXPECTED.slice(0, -1))), EXPECTED)).toBe('invalid');
    expect(checkAdminAuth(headers('Bearer x'), EXPECTED)).toBe('invalid');
    expect(checkAdminAuth(headers(basic(EXPECTED)), EXPECTED)).toBe('ok');
  });

  it('compares digests, so secrets of any length are comparable', () => {
    expect(secretsEqual('a', 'a')).toBe(true);
    expect(secretsEqual('a', 'a'.repeat(100))).toBe(false);
    expect(secretsEqual('', 'x')).toBe(false);
  });
});

describe('isAdminPath', () => {
  it('matches /admin and /api/admin in every spelling the router may serve', () => {
    for (const path of [
      '/admin',
      '/admin/',
      '/admin/orders/1',
      '/admin//orders',
      '/%61dmin',
      '/x/../admin',
      '/api/admin/orders/1/actions',
      '/api/%61dmin/orders',
    ]) {
      expect(isAdminPath(path), path).toBe(true);
    }
  });

  it('leaves other paths alone', () => {
    for (const path of ['/', '/administrator', '/adminx', '/api/administer', '/o/admin', '/api']) {
      expect(isAdminPath(path), path).toBe(false);
    }
  });
});
