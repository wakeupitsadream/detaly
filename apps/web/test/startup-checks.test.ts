import { describe, expect, it, vi } from 'vitest';
import { logStartupWarnings, startupWarnings, type StartupEnv } from '@/server/startup-checks';

const PAYMENTS = {
  YOOKASSA_SHOP_ID: 'shop',
  YOOKASSA_SECRET_KEY: 'secret',
  YOOKASSA_VAT_CODE: 1,
  YOOKASSA_TAX_SYSTEM_CODE: 2,
} as const;

const PROD_PROXY: StartupEnv = { NODE_ENV: 'production', TRUSTED_IP_HEADER: 'x-real-ip' };

describe('startupWarnings', () => {
  it('warns when production trusts no client IP header', () => {
    expect(startupWarnings({ NODE_ENV: 'production', TRUSTED_IP_HEADER: 'none' })).toEqual([
      'untrusted_client_ip',
    ]);
  });

  it('is quiet behind the proxy and outside production', () => {
    expect(startupWarnings(PROD_PROXY)).toEqual([]);
    expect(startupWarnings({ NODE_ENV: 'development', TRUSTED_IP_HEADER: 'none' })).toEqual([]);
    expect(startupWarnings({ NODE_ENV: 'test', TRUSTED_IP_HEADER: 'none' })).toEqual([]);
    expect(
      startupWarnings({ NODE_ENV: 'development', TRUSTED_IP_HEADER: 'none', ...PAYMENTS }),
    ).toEqual([]);
  });

  it('logs each warning once', () => {
    const warn = vi.fn();
    logStartupWarnings({ NODE_ENV: 'production', TRUSTED_IP_HEADER: 'none' }, { warn });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toEqual({ check: 'untrusted_client_ip' });
    expect(String(warn.mock.calls[0]?.[1])).toContain('TRUSTED_IP_HEADER');
  });
});

describe('YooKassa webhooks (decision Б4)', () => {
  it('payments on with an empty allowlist: webhooks will be refused', () => {
    expect(
      startupWarnings({ ...PROD_PROXY, ...PAYMENTS, YOOKASSA_WEBHOOK_IP_ALLOWLIST: [] }),
    ).toEqual(['yookassa_webhooks_refused']);
    expect(startupWarnings({ ...PROD_PROXY, ...PAYMENTS })).toEqual(['yookassa_webhooks_refused']);
  });

  it('payments on without the trusted header: both warnings', () => {
    expect(
      startupWarnings({
        NODE_ENV: 'production',
        TRUSTED_IP_HEADER: 'none',
        ...PAYMENTS,
        YOOKASSA_WEBHOOK_IP_ALLOWLIST: ['185.71.76.0/27'],
      }),
    ).toEqual(['untrusted_client_ip', 'yookassa_webhooks_refused']);
  });

  it('an invalid allowlist entry is reported', () => {
    expect(
      startupWarnings({ ...PROD_PROXY, ...PAYMENTS, YOOKASSA_WEBHOOK_IP_ALLOWLIST: ['nope/33'] }),
    ).toEqual(['yookassa_allowlist_invalid']);
  });

  it('quiet with a valid allowlist behind the proxy, and while payments are off', () => {
    expect(
      startupWarnings({
        ...PROD_PROXY,
        ...PAYMENTS,
        YOOKASSA_WEBHOOK_IP_ALLOWLIST: ['185.71.76.0/27', '2a02:5180::/32'],
      }),
    ).toEqual([]);
    expect(startupWarnings({ ...PROD_PROXY, YOOKASSA_WEBHOOK_IP_ALLOWLIST: [] })).toEqual([]);
    // Without the receipt codes payments stay off (decision Б6).
    expect(
      startupWarnings({ ...PROD_PROXY, YOOKASSA_SHOP_ID: 'shop', YOOKASSA_SECRET_KEY: 'secret' }),
    ).toEqual([]);
  });

  it('the message names the 403 and the variables', () => {
    const warn = vi.fn();
    logStartupWarnings({ ...PROD_PROXY, ...PAYMENTS }, { warn });
    expect(warn.mock.calls[0]?.[0]).toEqual({ check: 'yookassa_webhooks_refused' });
    expect(String(warn.mock.calls[0]?.[1])).toContain('403');
    expect(String(warn.mock.calls[0]?.[1])).toContain('YOOKASSA_WEBHOOK_IP_ALLOWLIST');
  });
});
