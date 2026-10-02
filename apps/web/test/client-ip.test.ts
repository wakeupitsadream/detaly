import { describe, expect, it } from 'vitest';
import { getClientIp, LOCAL_CLIENT } from '@/server/client-ip';

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
