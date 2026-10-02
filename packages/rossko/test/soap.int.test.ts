/**
 * SOAP path end to end on loopback: a real node-soap server (soap.listen on 127.0.0.1:0) with
 * a local WSDL stub, and the real createSoapCaller. No external network.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RosskoCallError } from '../src/errors';
import { BUNDLED_FIXTURES, stripMeta } from '../src/fixture-caller';
import { mapSearchResult, parseSearchResponse } from '../src/mapper';
import { createSoapCaller } from '../src/soap-caller';
import { startSoapStub, type SoapStub } from './soap-server';

const KEY1 = 'test-key1-abcdef';
const KEY2 = 'test-key2-123456';
const local = { localStockIds: ['ORB1'] };

let stub: SoapStub;

beforeAll(async () => {
  stub = await startSoapStub();
});

afterAll(async () => {
  await stub.close();
});

describe('createSoapCaller against soap.listen', () => {
  it('loads the WSDL once for two calls and round-trips GetSearch', async () => {
    const caller = createSoapCaller({ wsdlBase: stub.base, timeoutMs: 5000 });
    const before = stub.wsdlLoads();

    const oc90 = await caller.call('GetSearch', {
      KEY1,
      KEY2,
      text: 'OC90',
      delivery_id: '000000001',
    });
    const gdb = await caller.call('GetSearch', { KEY1, KEY2, text: 'GDB1330' });

    expect(stub.wsdlLoads() - before).toBe(1);
    expect(stub.received[0]).toMatchObject({ KEY1, KEY2, text: 'OC90', delivery_id: '000000001' });

    // Same offers as mapping the fixture directly.
    expect(mapSearchResult(oc90, local)).toEqual(
      mapSearchResult(stripMeta(BUNDLED_FIXTURES['GetSearch.OC90']), local),
    );
    const gdbOffers = mapSearchResult(gdb, local);
    expect(gdbOffers).toEqual(
      mapSearchResult(stripMeta(BUNDLED_FIXTURES['GetSearch.GDB1330']), local),
    );
    // xs:dateTime and xs:decimal stay text: no TZ re-interpretation, '1650,00' is not NaN.
    expect(gdbOffers[1]?.stock.deliveryEnd).toBe('2026-10-08T22:00:00+03:00');
    expect(gdbOffers[2]?.priceSupplierKop).toBe(165000);

    expect(caller.lastRawResponse).toContain('SearchResult');
    expect(caller.lastRawResponse).toContain('GDB1330');
  });

  it('parses success:false (nothing found)', async () => {
    const caller = createSoapCaller({ wsdlBase: stub.base, timeoutMs: 5000 });
    const raw = await caller.call('GetSearch', { KEY1, KEY2, text: 'NOTFOUND' });
    expect(parseSearchResponse(raw, local)).toEqual({
      success: false,
      message: 'Ничего не найдено',
      offers: [],
    });
  });

  it('times out with RosskoCallError.timeout=true and no keys in the message', async () => {
    const caller = createSoapCaller({ wsdlBase: stub.base, timeoutMs: 200 });
    const error = (await caller
      .call('GetSearch', { KEY1, KEY2, text: 'SLOW' })
      .catch((e: unknown) => e)) as RosskoCallError;
    expect(error).toBeInstanceOf(RosskoCallError);
    expect(error.timeout).toBe(true);
    expect(error.message).not.toContain(KEY1);
  });

  it('reports a WSDL load failure and retries it on the next call', async () => {
    const caller = createSoapCaller({ wsdlBase: `${stub.base}/missing`, timeoutMs: 2000 });
    const error = (await caller
      .call('GetSearch', { text: 'OC90' })
      .catch((e: unknown) => e)) as RosskoCallError;
    expect(error).toBeInstanceOf(RosskoCallError);
    expect(error.wsdl).toBe(true);
    const before = stub.wsdlLoads();
    await caller.call('GetSearch', { text: 'OC90' }).catch(() => undefined);
    expect(stub.wsdlLoads() - before).toBe(1);
  });
});
