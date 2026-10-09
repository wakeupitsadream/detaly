// Step 5 (docs/kits.md): the lines of a maintenance kit in the VIN-answer format and their check
// by the VIN preview rule, on the bundled Rossko fixtures (no network, no database).
import {
  basePricingConfig,
  DEFAULT_EXCLUDED_RULES,
  kitLineState,
  KIT_LINES_MAX,
  KIT_MAIN_LINES_MAX,
  type EtaSettings,
  type MarkupRule,
  type VinPreviewLine,
} from '@detaly/domain';
import { createFixtureCaller, createRosskoClient, createUnlimitedLimiter } from '@detaly/rossko';
import { describe, expect, it } from 'vitest';
import {
  checkKitLines,
  kitLineText,
  parseKitText,
  previewVinAnswer,
  type KitTextLine,
  type VinSearch,
} from '../src';

const RULES: MarkupRule[] = [{ fromKop: 0, toKop: null, localBp: 2800, orderBp: 2800 }];
const ETA: EtaSettings = { bufferDays: 1, invoiceLagDays: 0, prepayInvoice: false };
const NOW = new Date('2026-10-05T07:00:00Z');

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

function check(lines: readonly KitTextLine[], search: VinSearch = fixtureSearch()) {
  return checkKitLines({
    lines,
    search,
    pricing: basePricingConfig(RULES),
    excludedRules: DEFAULT_EXCLUDED_RULES,
    eta: ETA,
    now: NOW,
  });
}

type Ok = Extract<VinPreviewLine, { status: 'ok' }>;

const KIT = `MANN W914/2 1 — Фильтр масляный
или KNECHT OC90
MANN C26003 1 – Фильтр воздушный

# свечи: комплект на четыре цилиндра
NGK BKR6E 4 - Свечи зажигания
или BOSCH FR7DCX+
или: NGK BKR6E-11 4`;

describe('parseKitText', () => {
  it('reads main lines, alternatives «или …» and roles after a dash', () => {
    const { lines, errors } = parseKitText(KIT);
    expect(errors).toEqual([]);
    expect(
      lines.map((line) => [
        line.line,
        line.alternative,
        line.brand,
        line.article,
        line.qty,
        line.role,
      ]),
    ).toEqual([
      [1, false, 'MANN', 'W914/2', 1, 'Фильтр масляный'],
      [2, true, 'KNECHT', 'OC90', 1, null],
      [3, false, 'MANN', 'C26003', 1, 'Фильтр воздушный'],
      [6, false, 'NGK', 'BKR6E', 4, 'Свечи зажигания'],
      // without its own quantity an alternative takes the main line's
      [7, true, 'BOSCH', 'FR7DCX+', 4, null],
      [8, true, 'NGK', 'BKR6E-11', 4, null],
    ]);
    expect(lines.map((line) => line.articleNorm)).toEqual([
      'W9142',
      'OC90',
      'C26003',
      'BKR6E',
      'FR7DCX',
      'BKR6E11',
    ]);
  });

  it('keeps an alternative’s own quantity and a role with dashes inside', () => {
    const { lines, errors } = parseKitText(
      'NGK BKR6E 4 — Свечи — комплект\nили BOSCH FR7DCX+ 2\nTRW GDB1330 — Колодки передние',
    );
    expect(errors).toEqual([]);
    expect(lines.map((line) => [line.qty, line.role])).toEqual([
      [4, 'Свечи — комплект'],
      [2, null],
      [1, 'Колодки передние'],
    ]);
  });

  it('a trailing dash is no role and never part of the article', () => {
    const { lines } = parseKitText('MANN W914/2 1 —');
    expect(lines[0]).toMatchObject({ article: 'W914/2', articleNorm: 'W9142', qty: 1, role: null });
  });

  it('reports a bad line with its number and still reads the rest', () => {
    const { lines, errors } = parseKitText(
      [
        'или KNECHT OC90 1',
        'MANN',
        'или KNECHT OC90 1',
        'NGK BKR6E 0',
        'TRW GDB1330 1',
        'TRW GDB1330 2',
        `MANN C26003 1 — ${'Ф'.repeat(61)}`,
      ].join('\n'),
    );
    expect(lines.map((line) => line.line)).toEqual([5]);
    expect(errors).toEqual([
      {
        line: 1,
        raw: 'или KNECHT OC90 1',
        message: '«или …» — аналог строки выше: сначала напишите основную позицию',
      },
      {
        line: 2,
        raw: 'MANN',
        message: 'Нужно «БРЕНД АРТИКУЛ [КОЛ-ВО]», например «MANN W914/2 1»',
      },
      { line: 3, raw: 'или KNECHT OC90 1', message: 'Сначала исправьте основную строку выше' },
      { line: 4, raw: 'NGK BKR6E 0', message: 'Количество — целое число от 1 до 99' },
      { line: 6, raw: 'TRW GDB1330 2', message: 'Та же деталь, что в строке 5' },
      {
        line: 7,
        raw: `MANN C26003 1 — ${'Ф'.repeat(61)}`,
        message: 'Название позиции — до 60 символов',
      },
    ]);
  });

  it('limits alternatives per line, main lines and all lines', () => {
    const three = parseKitText('NGK BKR6E 4\nили BOSCH FR7DCX+\nили NGK BKR611\nили X Y123 4');
    expect(three.errors).toEqual([
      { line: 4, raw: 'или X Y123 4', message: 'Не больше 2 аналогов на позицию' },
    ]);
    const mains = Array.from({ length: KIT_MAIN_LINES_MAX + 1 }, (_, i) => `BRAND A${100 + i} 1`);
    expect(parseKitText(mains.join('\n')).errors).toEqual([
      {
        line: KIT_MAIN_LINES_MAX + 1,
        raw: `BRAND A${100 + KIT_MAIN_LINES_MAX} 1`,
        message: `Не больше ${KIT_MAIN_LINES_MAX} позиций в наборе`,
      },
    ]);
    const many = Array.from({ length: 7 }, (_, i) =>
      [`MAIN M${100 + i} 1`, `или ALT A${100 + i}`, `или ALT B${100 + i}`].join('\n'),
    );
    const all = parseKitText(many.join('\n'));
    expect(all.lines).toHaveLength(KIT_LINES_MAX);
    expect(all.errors[0]?.message).toBe(`Не больше ${KIT_LINES_MAX} строк в наборе (с аналогами)`);
  });

  it('writes a line back in the same format', () => {
    const { lines } = parseKitText(KIT);
    const text = lines.map((line) => kitLineText(line)).join('\n');
    expect(text).toBe(
      [
        'MANN W914/2 1 — Фильтр масляный',
        'или KNECHT OC90 1',
        'MANN C26003 1 — Фильтр воздушный',
        'NGK BKR6E 4 — Свечи зажигания',
        'или BOSCH FR7DCX+ 4',
        'или NGK BKR6E-11 4',
      ].join('\n'),
    );
    expect(parseKitText(text).lines.map(({ line: _line, raw: _raw, ...rest }) => rest)).toEqual(
      lines.map(({ line: _line, raw: _raw, ...rest }) => rest),
    );
  });
});

describe('checkKitLines', () => {
  it('prices every line by the VIN preview rule, one search per article', async () => {
    const calls: string[] = [];
    const { lines } = parseKitText(KIT);
    const checks = await check(lines, fixtureSearch(calls));
    expect(checks.map((line) => kitLineState(line))).toEqual([
      'ok',
      'ok',
      'ok',
      'ok',
      'ok',
      'unavailable',
    ]);
    expect(calls.sort()).toEqual(['BKR6E', 'BKR6E11', 'C26003', 'FR7DCX', 'OC90', 'W9142']);
    const [oil, oc90, air, plugs, bosch] = checks as Ok[];
    // the same line the VIN preview gives for the same text: one rule
    const preview = await previewVinAnswer({
      text: 'MANN W914/2 1\nKNECHT OC90 1\nMANN C26003 1\nNGK BKR6E 4\nBOSCH FR7DCX+ 4',
      search: fixtureSearch(),
      pricing: basePricingConfig(RULES),
      excludedRules: DEFAULT_EXCLUDED_RULES,
      eta: ETA,
      now: NOW,
    });
    for (const [index, line] of [oil, oc90, air, plugs, bosch].entries()) {
      const fromPreview = preview.lines[index] as Ok;
      expect(line?.offerKey).toBe(fromPreview.offerKey);
      expect(line?.priceClientKop).toBe(fromPreview.priceClientKop);
      expect(line?.etaDate).toBe(fromPreview.etaDate);
    }
    // Orenburg first: Knecht OC 90 at ORB1 (412.50 ₽ -> 528 ₽), the air filter at ORB1 too.
    expect(oc90).toMatchObject({ offerKey: 'OC90:Knecht:ORB1', priceClientKop: 52_800 });
    expect(air).toMatchObject({ offerKey: 'C26003:MANN-FILTER:ORB1', priceClientKop: 88_400 });
    expect(plugs).toMatchObject({ offerKey: 'BKR6E:NGK:ORB1', priceClientKop: 31_400, qty: 4 });
    expect(bosch).toMatchObject({ offerKey: 'FR7DCX:BOSCH:MSK7', priceClientKop: 25_500, qty: 4 });
    expect(oil).toMatchObject({ offerKey: 'W9142:MANN-FILTER:MSK7', priceClientKop: 79_800 });
  });

  it('marked goods, an unknown article and a silent supplier, line by line', async () => {
    const lines = parseKitText('CASTROL EDGE5W40 1\nACME NOPE123 1\nKNECHT OC90 1').lines;
    const failing: VinSearch = async (article) => {
      if (article === 'OC90') throw new Error('timeout');
      return (await rossko.search(article)).offers;
    };
    const checks = await check(lines, failing);
    expect(checks.map((line) => kitLineState(line))).toEqual([
      'excluded',
      'unavailable',
      'supplier',
    ]);
  });

  it('a quantity the stock cannot give is not offered (LUCAS pads are sold by 2)', async () => {
    const one = await check(parseKitText('LUCAS GDB1330 1').lines);
    const two = await check(parseKitText('LUCAS GDB1330 2').lines);
    expect([...one, ...two].map((line) => kitLineState(line))).toEqual(['unavailable', 'ok']);
  });
});
