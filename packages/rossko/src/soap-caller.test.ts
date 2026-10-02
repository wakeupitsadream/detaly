import { describe, expect, it, vi } from 'vitest';
import { RosskoCallError } from './errors';
import { createSoapCaller } from './soap-caller';

const KEY1 = 'secret-key-one-123';
const KEY2 = 'secret-key-two-456';

function fakeClient(impl: (args: unknown, opts: unknown) => Promise<unknown>) {
  return { GetSearchAsync: vi.fn(impl), GetOrdersAsync: vi.fn(impl) };
}

describe('createSoapCaller (injected client factory)', () => {
  it('creates one client per method lazily, with the WSDL url, timeout and text deserializers', async () => {
    const client = fakeClient(() =>
      Promise.resolve([{ SearchResult: { success: true } }, '<xml/>']),
    );
    const createClient = vi.fn(() => Promise.resolve(client));
    const caller = createSoapCaller({
      wsdlBase: 'https://example.test/v2.1/',
      timeoutMs: 1500,
      createClient,
    });
    expect(createClient).not.toHaveBeenCalled();

    await caller.call('GetSearch', { text: 'A' });
    await caller.call('GetSearch', { text: 'B' });
    await caller.call('GetOrders', {});

    expect(createClient).toHaveBeenCalledTimes(2);
    expect(createClient.mock.calls.map((c) => (c as unknown[])[0])).toEqual([
      'https://example.test/v2.1/GetSearch?wsdl',
      'https://example.test/v2.1/GetOrders?wsdl',
    ]);
    const opts = (createClient.mock.calls[0] as unknown[])[1] as Record<string, unknown>;
    expect(opts).toMatchObject({ disableCache: true, wsdl_options: { timeout: 1500 } });
    const deserializer = opts.customDeserializer as Record<string, (t: string) => unknown>;
    expect(deserializer.decimal?.('1234.50')).toBe('1234.50');
    expect(deserializer.dateTime?.('2026-10-08T22:00:00')).toBe('2026-10-08T22:00:00');
    expect(client.GetSearchAsync).toHaveBeenCalledWith({ text: 'A' }, { timeout: 1500 });
    expect(caller.lastRawResponse).toBe('<xml/>');
  });

  it('shares one pending WSDL load between concurrent calls', async () => {
    const client = fakeClient(() => Promise.resolve([{}]));
    const createClient = vi.fn(
      () => new Promise<typeof client>((r) => setTimeout(() => r(client), 5)),
    );
    const caller = createSoapCaller({ wsdlBase: 'http://x', timeoutMs: 100, createClient });
    await Promise.all([caller.call('GetSearch', {}), caller.call('GetSearch', {})]);
    expect(createClient).toHaveBeenCalledTimes(1);
  });

  it('forgets a failed WSDL load and retries on the next call', async () => {
    const client = fakeClient(() => Promise.resolve([{ ok: 1 }]));
    const createClient = vi
      .fn<() => Promise<typeof client>>()
      .mockRejectedValueOnce(
        Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }),
      )
      .mockResolvedValue(client);
    const caller = createSoapCaller({ wsdlBase: 'http://x', timeoutMs: 100, createClient });

    const failure = await caller.call('GetSearch', {}).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(RosskoCallError);
    expect(failure).toMatchObject({ wsdl: true, code: 'ECONNREFUSED', method: 'GetSearch' });

    await expect(caller.call('GetSearch', {})).resolves.toEqual({ ok: 1 });
    await expect(caller.call('GetSearch', {})).resolves.toEqual({ ok: 1 });
    expect(createClient).toHaveBeenCalledTimes(2);
  });

  it('keeps the client after a call error (only WSDL failures reset it)', async () => {
    const client = fakeClient(() => Promise.reject(new Error('soap:Server: boom')));
    const createClient = vi.fn(() => Promise.resolve(client));
    const caller = createSoapCaller({ wsdlBase: 'http://x', timeoutMs: 100, createClient });
    await expect(caller.call('GetSearch', {})).rejects.toThrow(
      'Rossko GetSearch: soap:Server: boom',
    );
    await expect(caller.call('GetSearch', {})).rejects.toThrow(RosskoCallError);
    expect(createClient).toHaveBeenCalledTimes(1);
  });

  it('masks keys in error messages and flags timeouts', async () => {
    const client = fakeClient(() =>
      Promise.reject(
        Object.assign(
          new Error(`timeout of 100ms exceeded; body KEY1=${KEY1} <KEY2>${KEY2}</KEY2>`),
          {
            code: 'ECONNABORTED',
          },
        ),
      ),
    );
    const caller = createSoapCaller({
      wsdlBase: 'http://x',
      timeoutMs: 100,
      createClient: () => Promise.resolve(client),
    });
    const error = (await caller
      .call('GetSearch', { KEY1, KEY2 })
      .catch((e: unknown) => e)) as RosskoCallError;
    expect(error).toBeInstanceOf(RosskoCallError);
    expect(error.timeout).toBe(true);
    expect(error.message).not.toContain(KEY1);
    expect(error.message).not.toContain(KEY2);
    expect(error.cause).toBeUndefined();
  });

  it('reports an operation missing from the WSDL', async () => {
    const caller = createSoapCaller({
      wsdlBase: 'http://x',
      timeoutMs: 100,
      createClient: () => Promise.resolve({}),
    });
    await expect(caller.call('GetCheckout', {})).rejects.toThrow('operation not found in WSDL');
  });
});
