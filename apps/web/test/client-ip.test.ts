import { describe, expect, it } from 'vitest';
import { getClientIp, LOCAL_CLIENT, rateLimitSubject } from '@/server/client-ip';
import { clientBucket } from '@/server/rate-limit';

function headers(values: Record<string, string>): Headers {
  return new Headers(values);
}

describe('getClientIp', () => {
  it('ignores X-Real-IP unless TRUSTED_IP_HEADER=x-real-ip', () => {
    expect(getClientIp(headers({ 'x-real-ip': '203.0.113.7' }), 'none')).toBe(LOCAL_CLIENT);
  });

  it('uses X-Real-IP when trusted', () => {
    expect(getClientIp(headers({ 'x-real-ip': '203.0.113.7' }), 'x-real-ip')).toBe('203.0.113.7');
    expect(getClientIp(headers({ 'x-real-ip': ' 2001:DB8::1 ' }), 'x-real-ip')).toBe('2001:db8::1');
  });

  it('never reads X-Forwarded-For (client-controlled)', () => {
    expect(getClientIp(headers({ 'x-forwarded-for': '198.51.100.1' }), 'x-real-ip')).toBe(
      LOCAL_CLIENT,
    );
    expect(getClientIp(headers({ 'x-forwarded-for': '198.51.100.1' }), 'none')).toBe(LOCAL_CLIENT);
  });

  it('falls back to the shared bucket for missing or malformed values', () => {
    expect(getClientIp(headers({}), 'x-real-ip')).toBe(LOCAL_CLIENT);
    expect(getClientIp(headers({ 'x-real-ip': '' }), 'x-real-ip')).toBe(LOCAL_CLIENT);
    expect(getClientIp(headers({ 'x-real-ip': 'evil, 1.2.3.4' }), 'x-real-ip')).toBe(LOCAL_CLIENT);
    expect(getClientIp(headers({ 'x-real-ip': 'a'.repeat(60) }), 'x-real-ip')).toBe(LOCAL_CLIENT);
    expect(getClientIp(headers({ 'x-real-ip': 'random-bucket' }), 'x-real-ip')).toBe(LOCAL_CLIENT);
  });
});

describe('rateLimitSubject', () => {
  it('buckets IPv6 by /64: two addresses of one /64 share a bucket', () => {
    const a = rateLimitSubject('2001:db8:1:2:aaaa:bbbb:cccc:dddd');
    const b = rateLimitSubject('2001:db8:1:2::1');
    expect(a).toBe('2001:0db8:0001:0002::/64');
    expect(b).toBe(a);
    expect(clientBucket('s'.repeat(32), a)).toBe(clientBucket('s'.repeat(32), b));
    expect(rateLimitSubject('2001:db8:1:3::1')).not.toBe(a);
  });

  it('expands :: anywhere and drops a zone id', () => {
    expect(rateLimitSubject('::1')).toBe('0000:0000:0000:0000::/64');
    expect(rateLimitSubject('fe80::1%eth0')).toBe('fe80:0000:0000:0000::/64');
    expect(rateLimitSubject('2001:db8::')).toBe('2001:0db8:0000:0000::/64');
    expect(rateLimitSubject('2001:DB8:0:0:1:2:3:4')).toBe('2001:0db8:0000:0000::/64');
  });

  it('maps IPv4-mapped IPv6 to IPv4 and keeps IPv4 as is', () => {
    expect(rateLimitSubject('::ffff:203.0.113.7')).toBe('203.0.113.7');
    expect(rateLimitSubject('::ffff:cb00:7107')).toBe('203.0.113.7');
    expect(rateLimitSubject('203.0.113.7')).toBe('203.0.113.7');
  });

  it('sends anything unparseable to the shared bucket', () => {
    expect(rateLimitSubject(LOCAL_CLIENT)).toBe(LOCAL_CLIENT);
    for (const bad of [':::', '1::2::3', '1:2:3:4:5:6:7:8:9', '::ffff:300.1.1.1', 'g::1']) {
      expect(rateLimitSubject(bad), bad).toBe(LOCAL_CLIENT);
    }
  });
});
