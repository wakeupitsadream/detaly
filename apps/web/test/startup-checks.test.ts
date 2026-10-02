import { describe, expect, it, vi } from 'vitest';
import { logStartupWarnings, startupWarnings } from '@/server/startup-checks';

describe('startupWarnings', () => {
  it('warns when production trusts no client IP header', () => {
    expect(startupWarnings({ NODE_ENV: 'production', TRUSTED_IP_HEADER: 'none' })).toEqual([
      'untrusted_client_ip',
    ]);
  });

  it('is quiet behind the proxy and outside production', () => {
    expect(startupWarnings({ NODE_ENV: 'production', TRUSTED_IP_HEADER: 'x-real-ip' })).toEqual([]);
    expect(startupWarnings({ NODE_ENV: 'development', TRUSTED_IP_HEADER: 'none' })).toEqual([]);
    expect(startupWarnings({ NODE_ENV: 'test', TRUSTED_IP_HEADER: 'none' })).toEqual([]);
  });

  it('logs each warning once', () => {
    const warn = vi.fn();
    logStartupWarnings({ NODE_ENV: 'production', TRUSTED_IP_HEADER: 'none' }, { warn });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toEqual({ check: 'untrusted_client_ip' });
    expect(String(warn.mock.calls[0]?.[1])).toContain('TRUSTED_IP_HEADER');
  });
});
