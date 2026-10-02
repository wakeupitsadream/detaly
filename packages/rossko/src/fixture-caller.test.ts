import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { BUNDLED_FIXTURES, createFixtureCaller, fixtureName } from './fixture-caller';
import { mapCheckoutResult, mapSearchResult } from './mapper';

const FIXTURES_DIR = fileURLToPath(new URL('../fixtures', import.meta.url));

describe('fixtures', () => {
  it('bundled set equals the files on disk', async () => {
    const files = (await readdir(FIXTURES_DIR)).filter((f) => f.endsWith('.json')).sort();
    expect(files.map((f) => f.replace(/\.json$/, ''))).toEqual(
      Object.keys(BUNDLED_FIXTURES).sort(),
    );
    for (const file of files) {
      const onDisk: unknown = JSON.parse(await readFile(`${FIXTURES_DIR}/${file}`, 'utf8'));
      expect(onDisk).toEqual(BUNDLED_FIXTURES[file.replace(/\.json$/, '')]);
    }
  });

  it('every fixture is marked synthetic with a note to verify', () => {
    for (const [name, value] of Object.entries(BUNDLED_FIXTURES)) {
      expect(value, name).toMatchObject({
        _meta: { synthetic: true, note: expect.stringContaining('сверить') as unknown },
      });
    }
  });
});

describe('fixtureName', () => {
  it('derives the file name from method and args', () => {
    expect(fixtureName('GetSearch', { text: 'oc 90' })).toBe('GetSearch.OC90');
    expect(fixtureName('GetSearch', { text: '' })).toBe('GetSearch.NOTFOUND');
    expect(fixtureName('GetCheckout', {})).toBe('GetCheckout.ok');
    expect(fixtureName('GetCheckout', {}, 'itemErrors')).toBe('GetCheckout.itemErrors');
    expect(fixtureName('GetCheckoutDetails', {})).toBe('GetCheckoutDetails');
    expect(fixtureName('GetOrders', { order_ids: { id: ['1'] } })).toBe('GetOrders');
  });
});

describe.each([
  ['bundled', () => createFixtureCaller()],
  ['directory', () => createFixtureCaller(FIXTURES_DIR)],
])('createFixtureCaller (%s)', (_label, make) => {
  it('answers GetSearch by normalized text and strips _meta', async () => {
    const raw = await make().call('GetSearch', { KEY1: '', KEY2: '', text: 'oc-90' });
    expect(raw).not.toHaveProperty('_meta');
    expect(raw).toHaveProperty('SearchResult.success', true);
    expect(mapSearchResult(raw, { localStockIds: ['ORB1'] })).toHaveLength(5);
  });

  it('answers unknown articles with NOTFOUND', async () => {
    const raw = await make().call('GetSearch', { text: 'NO-SUCH-PART' });
    expect(raw).toEqual({ SearchResult: { success: false, message: 'Ничего не найдено' } });
  });

  it('returns copies: mutating a response does not leak into the next one', async () => {
    const caller = make();
    const first = (await caller.call('GetSearch', { text: 'W9142' })) as {
      SearchResult: { success: boolean };
    };
    first.SearchResult.success = false;
    const second = await caller.call('GetSearch', { text: 'W9142' });
    expect(second).toHaveProperty('SearchResult.success', true);
  });
});

describe('createFixtureCaller options', () => {
  it('serves GetCheckout.itemErrors on request', async () => {
    const raw = await createFixtureCaller({ checkoutVariant: 'itemErrors' }).call(
      'GetCheckout',
      {},
    );
    expect(mapCheckoutResult(raw).itemErrors).toHaveLength(1);
  });

  it('fails loudly for a missing non-search fixture in a directory', async () => {
    const caller = createFixtureCaller(fileURLToPath(new URL('../test', import.meta.url)));
    await expect(caller.call('GetOrders', {})).rejects.toThrow(
      'Rossko fixture not found: GetOrders.json',
    );
  });
});
