// previewVinAnswer on the bundled Rossko fixtures (fixture caller, no network, no database):
// typos of the master (W9142X, BOSH, quantity 0), choice of the offer, errors line by line.
import {
  addDays,
  DEFAULT_EXCLUDED_RULES,
  formatPromise,
  localDate,
  type EtaSettings,
  type MarkupRule,
  type Offer,
  type VinPreviewLine,
} from '@detaly/domain';
import {
  createFixtureCaller,
  createRosskoClient,
  createUnlimitedLimiter,
  RosskoCallError,
} from '@detaly/rossko';
import { describe, expect, it } from 'vitest';
import {
  brandMatches,
  isVinPreviewSendable,
  previewVinAnswer,
  vinLinePromisedDate,
  type VinSearch,
} from '../src';

const RULES: MarkupRule[] = [{ fromKop: 0, toKop: null, localBp: 2800, orderBp: 2800 }];
const ETA: EtaSettings = { bufferDays: 1, invoiceLagDays: 0, prepayInvoice: false };
const NOW = new Date('2026-10-05T07:00:00Z');
const TODAY = localDate(NOW);

const rossko = createRosskoClient({
  caller: createFixtureCaller(),
  key1: 'k1',
  key2: 'k2',
  localStockIds: ['ORB1'],
  limiter: createUnlimitedLimiter(),
  allowCheckout: false,
});

function fixtureSearch(calls: string[] = []): VinSearch {
  return async (article) => {
    calls.push(article);
    return (await rossko.search(article)).offers;
  };
}

function preview(text: string, search: VinSearch = fixtureSearch()) {
  return previewVinAnswer({
    text,
    search,
    markupRules: RULES,
    excludedRules: DEFAULT_EXCLUDED_RULES,
    eta: ETA,
    now: NOW,
  });
}

type Ok = Extract<VinPreviewLine, { status: 'ok' }>;
type Err = Extract<VinPreviewLine, { status: 'error' }>;

function ok(line: VinPreviewLine | undefined): Ok {
  expect(line?.status).toBe('ok');
  return line as Ok;
}

function err(line: VinPreviewLine | undefined): Err {
  expect(line?.status).toBe('error');
  return line as Err;
}

describe('previewVinAnswer', () => {
  it('«MANN W914/2 1» — ok, price ceil(wholesale × 1.28) to the ruble, date from the stock', async () => {
    const result = await preview('MANN W914/2 1');
    const line = ok(result.lines[0]);
    // MANN-FILTER W 914/2 at MSK7: 623.40 ₽ wholesale, 3 days.
    expect(line).toMatchObject({
      line: 1,
      raw: 'MANN W914/2 1',
      brand: 'MANN-FILTER',
      article: 'W 914/2',
      qty: 1,
      searchArticleNorm: 'W9142',
      offerKey: 'W9142:MANN-FILTER:MSK7',
      priceSupplierKop: 62_340,
      priceClientKop: Math.ceil((62_340 * 1.28) / 100) * 100,
      markupBp: 2800,
      isLocal: false,
      etaDate: addDays(TODAY, 3),
      note: null,
    });
    expect(line.priceClientKop).toBe(79_800);
    expect(formatPromise(vinLinePromisedDate(line, ETA))).toBe(
      formatPromise(addDays(TODAY, 3 + ETA.bufferDays)),
    );
    expect(result).toMatchObject({ okCount: 1, errorCount: 0, totalKop: 79_800, comment: null });
    expect(result.checkedAt).toBe(NOW.toISOString());
    expect(isVinPreviewSendable(result)).toBe(true);
  });

  it('typos: W9142X -> not_found, BOSH -> brand_mismatch with the brands, quantity 0 -> parse', async () => {
    const result = await preview(
      ['MANN W9142X 1', 'BOSH OC90 1', 'MAHLE OC90 0', 'NOTFOUND 1', 'OC90 1'].join('\n'),
    );
    expect(err(result.lines[0])).toMatchObject({ line: 1, reason: 'not_found' });
    const mismatch = err(result.lines[1]);
    expect(mismatch).toMatchObject({ line: 2, reason: 'brand_mismatch' });
    expect(mismatch.brands).toEqual(['Knecht', 'MAHLE']);
    expect(mismatch.message).toContain('Knecht, MAHLE');
    expect(err(result.lines[2])).toMatchObject({ line: 3, reason: 'parse' });
    // A single word is not «БРЕНД АРТИКУЛ».
    expect(err(result.lines[3])).toMatchObject({ line: 4, reason: 'parse' });
    // 'OC90 1': brand OC90 and article '1' — no article.
    expect(err(result.lines[4])).toMatchObject({ line: 5, reason: 'parse' });
    expect(result).toMatchObject({ okCount: 0, errorCount: 5, totalKop: 0 });
    expect(isVinPreviewSendable(result)).toBe(false);
  });

  it('a local stock wins over a cheaper remote one; not enough there -> the remote stock', async () => {
    const result = await preview('Knecht OC 90 2\nKNECHT OC90 7');
    // ORB1 (local, 412.50 ₽, 6 pcs) before MSK7 (389.00 ₽, 24 pcs).
    expect(ok(result.lines[0])).toMatchObject({ offerKey: 'OC90:Knecht:ORB1', isLocal: true });
    expect(ok(result.lines[1])).toMatchObject({ offerKey: 'OC90:Knecht:MSK7', isLocal: false });
    expect(result.totalKop).toBe(
      ok(result.lines[0]).priceClientKop * 2 + ok(result.lines[1]).priceClientKop * 7,
    );
  });

  it('a cross of another brand with the same article is offered when the master names it', async () => {
    const line = ok((await preview('mahle oc90')).lines[0]);
    expect(line).toMatchObject({ brand: 'MAHLE', offerKey: 'OC90:MAHLE:EKB2', qty: 1 });
  });

  it('two brands with one article: the named one; the earlier date wins among its stocks', async () => {
    const result = await preview('TRW GDB1330 2');
    // TRW at ORB1 (local, 2 pcs) — local first even though SPB3 is cheaper.
    expect(ok(result.lines[0])).toMatchObject({ offerKey: 'GDB1330:TRW:ORB1' });
    const more = await preview('TRW GDB1330 3');
    expect(ok(more.lines[0])).toMatchObject({ offerKey: 'GDB1330:TRW:SPB3' });
  });

  it('no_stock: more than any stock has, or a quantity off the multiplicity', async () => {
    const result = await preview('Knecht OC90 30\nLUCAS GDB1330 1');
    expect(err(result.lines[0])).toMatchObject({ reason: 'no_stock' });
    expect(err(result.lines[0]).message).toContain('24');
    expect(err(result.lines[1])).toMatchObject({ reason: 'no_stock' });
    expect(err(result.lines[1]).message).toContain('по 2 шт.');
  });

  it('marked goods -> excluded', async () => {
    const line = err((await preview('CASTROL EDGE5W40 1')).lines[0]);
    expect(line.reason).toBe('excluded');
    expect(line.message).toContain('Не продаём онлайн');
  });

  it('a supplier failure fails only the lines of that article', async () => {
    const calls: string[] = [];
    const base = fixtureSearch(calls);
    const search: VinSearch = (article) =>
      article === 'GDB1330'
        ? Promise.reject(new RosskoCallError('GetSearch', 'timeout', { timeout: true }))
        : base(article);
    const result = await preview('TRW GDB1330 1\nMANN W914/2 1\nLUCAS GDB 1330 2', search);
    expect(err(result.lines[0])).toMatchObject({ reason: 'supplier_unavailable' });
    ok(result.lines[1]);
    expect(err(result.lines[2])).toMatchObject({ reason: 'supplier_unavailable' });
    expect(calls).toEqual(['W9142']);
  });

  it('one GetSearch per distinct normalized article', async () => {
    const calls: string[] = [];
    const result = await preview(
      'Knecht OC 90 1\nMAHLE oc-90 1\nMANN W 914/2\nMANN W914/2 # дубль',
      fixtureSearch(calls),
    );
    expect(calls.sort()).toEqual(['OC90', 'W9142']);
    // The same offer twice: the second line asks for one line with the quantity.
    expect(err(result.lines[3])).toMatchObject({ reason: 'parse', line: 4 });
    expect(err(result.lines[3]).message).toContain('строке 3');
  });

  it('«>» lines are the comment to the client; notes and empty lines are kept apart', async () => {
    const result = await preview(
      ['> Подобрал по VIN, фильтр оригинал', '', 'MANN W914/2 1 # на ТО', '>  и прокладку'].join(
        '\r\n',
      ),
    );
    expect(result.comment).toBe('Подобрал по VIN, фильтр оригинал\nи прокладку');
    expect(ok(result.lines[0])).toMatchObject({ line: 3, note: 'на ТО' });
    expect(result.lines).toHaveLength(1);
  });

  it('a comment alone is not sendable', async () => {
    const result = await preview('> позвоните мастеру');
    expect(result).toMatchObject({ okCount: 0, errorCount: 0, lines: [] });
    expect(isVinPreviewSendable(result)).toBe(false);
  });

  it('more than 20 positions: the extra lines are parse errors, not searched', async () => {
    const calls: string[] = [];
    const text = Array.from({ length: 22 }, () => 'NOTFOUND X1').join('\n');
    const result = await preview(text, fixtureSearch(calls));
    expect(result.lines).toHaveLength(22);
    expect(err(result.lines[20])).toMatchObject({ reason: 'parse', line: 21 });
    expect(err(result.lines[20]).message).toContain('20 позиций');
    expect(err(result.lines[0])).toMatchObject({ reason: 'parse' });
  });

  it('more than 10 distinct articles: the 11th is a parse error (checkout limit)', async () => {
    const calls: string[] = [];
    const text = Array.from({ length: 11 }, (_, i) => `ACME ART${i}00 1`).join('\n');
    const result = await preview(text, fixtureSearch(calls));
    expect(calls).toHaveLength(10);
    expect(err(result.lines[10])).toMatchObject({ reason: 'parse', line: 11 });
    expect(err(result.lines[9])).toMatchObject({ reason: 'not_found' });
  });

  it('a leading-zero last word stays in the article (BOSCH 0 451 103 079)', async () => {
    const calls: string[] = [];
    const result = await preview('BOSCH 0 451 103 079', fixtureSearch(calls));
    expect(calls).toEqual(['0451103079']);
    // Only a cross in the OC90 answer, not found by its own article in the fixtures.
    expect(err(result.lines[0])).toMatchObject({ reason: 'not_found' });
  });
});

describe('brandMatches', () => {
  const offer = (brand: string) => ({ brand }) as Offer;
  it('exact (case, hyphens) first, then the first word of the supplier brand', () => {
    const offers = [offer('MANN-FILTER'), offer('Mann')];
    expect(brandMatches(offers, 'mann').map((o) => o.brand)).toEqual(['Mann']);
    expect(brandMatches([offer('MANN-FILTER')], 'MANN').map((o) => o.brand)).toEqual([
      'MANN-FILTER',
    ]);
    expect(brandMatches([offer('MANN-FILTER')], 'mann filter')).toHaveLength(1);
    expect(brandMatches([offer('BOSCH')], 'BOSH')).toHaveLength(0);
    expect(brandMatches([offer('BOSCH')], '')).toHaveLength(0);
  });
});
