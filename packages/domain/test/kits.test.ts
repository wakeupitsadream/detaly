// Step 5 (docs/kits.md): the pure helpers of maintenance kits — slugs, the header the master
// types, the shape of the lines, the publish rule, totals and the words of an alternative.
import { describe, expect, it } from 'vitest';
import {
  formatKitYears,
  groupKitLines,
  KIT_SLUG_RE,
  kitInstallHours,
  kitInstallText,
  kitLineState,
  kitModelSlug,
  kitOptionDelta,
  kitOptionHint,
  kitPublishProblems,
  kitSlugCandidates,
  kitTitle,
  kitTotals,
  pickKitSlug,
  slugify,
  validateKitHeader,
  type EtaSettings,
  type KitHeaderInput,
  type VinPreviewLine,
} from '../src';

const MAKES = new Set(['lada', 'hyundai', 'mercedes-benz']);
const ETA: EtaSettings = { bufferDays: 1, invoiceLagDays: 0, prepayInvoice: false };

function input(over: Partial<KitHeaderInput> = {}): KitHeaderInput {
  return {
    make: 'lada',
    model: ' Vesta ',
    engine: '1.6 16V,  106 л.с.',
    yearsFrom: '2015',
    yearsTo: '',
    note: '',
    ...over,
  };
}

describe('slugs', () => {
  it.each([
    ['Vesta', 'vesta'],
    ['Нива Travel', 'niva-travel'],
    ['Гранта', 'granta'],
    ['Largus Cross', 'largus-cross'],
    ['1.6 16V', '1-6-16v'],
    ['Škoda', 'skoda'],
    ['Citroën C4', 'citroen-c4'],
    ['Солярис', 'solyaris'],
    ['Нива Легенд', 'niva-legend'],
    ['Жигули', 'zhiguli'],
    ['Ёлка — щит', 'elka-schit'],
    ['  --  ', ''],
  ])('slugify(%j) = %j', (text, slug) => {
    expect(slugify(text)).toBe(slug);
    if (slug !== '') expect(slug).toMatch(KIT_SLUG_RE);
  });

  it('cuts a long slug without a hyphen at the end', () => {
    const slug = slugify(`${'а'.repeat(63)} б`, 64);
    expect(slug.length).toBeLessThanOrEqual(64);
    expect(slug).toMatch(KIT_SLUG_RE);
  });

  it('the model slug is the model in the URL', () => {
    expect(kitModelSlug('Solaris')).toBe('solaris');
    expect(kitModelSlug('Niva Legend')).toBe('niva-legend');
  });

  it('a kit is addressed by its engine before the comma, then the whole engine, then the year', () => {
    expect(kitSlugCandidates('1.6 16V, 106 л.с.', 2015)).toEqual([
      '1-6-16v',
      '1-6-16v-106-l-s',
      '1-6-16v-2015',
      '1-6-16v-106-l-s-2015',
    ]);
    expect(kitSlugCandidates('1.6', 2017)).toEqual(['1-6', '1-6-2017']);
    expect(pickKitSlug('1.6 16V, 106 л.с.', 2015, new Set())).toBe('1-6-16v');
    expect(pickKitSlug('1.6 16V, 113 л.с.', 2019, new Set(['1-6-16v']))).toBe('1-6-16v-113-l-s');
    expect(
      pickKitSlug('1.6', 2015, new Set(['1-6', '1-6-2015'])),
      'every candidate taken: a number',
    ).toBe('1-6-2');
    expect(pickKitSlug('1.6', 2015, new Set(['1-6', '1-6-2015', '1-6-2']))).toBe('1-6-3');
  });
});

describe('validateKitHeader', () => {
  it('cleans the fields: spaces collapsed, the model slug, years, no note', () => {
    const check = validateKitHeader(input(), { makes: MAKES, maxYear: 2027 });
    expect(check).toEqual({
      ok: true,
      header: {
        makeSlug: 'lada',
        model: 'Vesta',
        modelSlug: 'vesta',
        engine: '1.6 16V, 106 л.с.',
        yearsFrom: 2015,
        yearsTo: null,
        note: null,
      },
    });
  });

  it('keeps the last year and the note', () => {
    const check = validateKitHeader(input({ yearsTo: '2022', note: ' замена ≈ 1 ч ' }), {
      makes: MAKES,
      maxYear: 2027,
    });
    expect(check.ok && check.header).toMatchObject({ yearsTo: 2022, note: 'замена ≈ 1 ч' });
  });

  it.each<[string, Partial<KitHeaderInput>, keyof KitHeaderInput, string]>([
    ['an unknown make', { make: 'zaz' }, 'make', 'Выберите марку из списка'],
    ['no model', { model: '  ' }, 'model', 'Модель, например Vesta'],
    [
      'a model of signs only',
      { model: '—' },
      'model',
      'Модель — буквами или цифрами, например Vesta',
    ],
    ['a long model', { model: 'x'.repeat(61) }, 'model', 'Модель — до 60 символов'],
    ['no engine', { engine: '' }, 'engine', 'Двигатель, например «1.6 16V, 106 л.с.»'],
    ['a long engine', { engine: '1'.repeat(81) }, 'engine', 'Двигатель — до 80 символов'],
    ['no year', { yearsFrom: '' }, 'yearsFrom', 'Год начала — четыре цифры, от 1970 до 2027'],
    [
      'a two-digit year',
      { yearsFrom: '15' },
      'yearsFrom',
      'Год начала — четыре цифры, от 1970 до 2027',
    ],
    [
      'a year ahead',
      { yearsFrom: '2030' },
      'yearsFrom',
      'Год начала — четыре цифры, от 1970 до 2027',
    ],
    [
      'the end before the start',
      { yearsTo: '2010' },
      'yearsTo',
      'Год окончания не раньше года начала',
    ],
    [
      'a broken end year',
      { yearsTo: '20x2' },
      'yearsTo',
      'Год окончания — четыре цифры до 2027 или пусто (выпускается)',
    ],
    ['a long note', { note: 'x'.repeat(301) }, 'note', 'Заметка — до 300 символов'],
  ])('refuses %s', (_what, over, field, message) => {
    const check = validateKitHeader(input(over), { makes: MAKES, maxYear: 2027 });
    expect(check.ok).toBe(false);
    if (!check.ok) expect(check.errors[field]).toBe(message);
  });

  it('reports every bad field at once', () => {
    const check = validateKitHeader(input({ make: '', model: '', engine: '', yearsFrom: '' }), {
      makes: MAKES,
      maxYear: 2027,
    });
    expect(check.ok ? [] : Object.keys(check.errors).sort()).toEqual(
      ['engine', 'make', 'model', 'yearsFrom'].sort(),
    );
  });
});

describe('words of a kit', () => {
  it('years and the title', () => {
    expect(formatKitYears(2015, null)).toBe('с 2015 г.');
    expect(formatKitYears(2015, 2022)).toBe('2015–2022');
    expect(formatKitYears(2019, 2019)).toBe('2019 г.');
    expect(kitTitle('Lada', 'Vesta', '1.6 16V, 106 л.с.')).toBe('ТО Lada Vesta 1.6 16V, 106 л.с.');
  });

  it.each([
    ['замена ≈ 1 ч', '1'],
    ['Замена 1,5 часа', '1,5'],
    ['замена ~2 ч, масло в сервисе', '2'],
    ['≈ 1.5 ч', '1,5'],
    ['замены 3 часов хватит', '3'],
    ['проверить у мастера', null],
    ['2 часа', null],
    ['замена ≈ 0 ч', null],
    ['замена ≈ 40 ч', null],
    ['замена ≈ 1 чек', null],
    ['', null],
  ])('the replacement time of the note %j: %j', (note, hours) => {
    expect(kitInstallHours(note)).toBe(hours);
  });

  it('says the replacement time without a price', () => {
    expect(kitInstallText('1,5')).toBe(
      'Замена ≈ 1,5 ч — можно записаться на установку после оформления',
    );
    expect(kitInstallHours(null)).toBeNull();
  });
});

describe('groupKitLines', () => {
  it('main lines in position order with their alternatives', () => {
    const groups = groupKitLines([
      { id: 'c', position: 3, alternativeOf: null },
      { id: 'a', position: 1, alternativeOf: null },
      { id: 'b', position: 2, alternativeOf: 'a' },
      { id: 'd', position: 4, alternativeOf: 'c' },
      { id: 'e', position: 5, alternativeOf: 'c' },
    ]);
    expect(groups.map((g) => [g.main.id, g.alternatives.map((alt) => alt.id)])).toEqual([
      ['a', ['b']],
      ['c', ['d', 'e']],
    ]);
  });

  it('leaves out an alternative of an unknown line or of another alternative', () => {
    const groups = groupKitLines([
      { id: 'a', position: 1, alternativeOf: null },
      { id: 'b', position: 2, alternativeOf: 'a' },
      { id: 'c', position: 3, alternativeOf: 'b' },
      { id: 'd', position: 4, alternativeOf: 'zz' },
    ]);
    expect(groups).toEqual([
      {
        main: { id: 'a', position: 1, alternativeOf: null },
        alternatives: [{ id: 'b', position: 2, alternativeOf: 'a' }],
      },
    ]);
  });
});

describe('kitLineState and kitPublishProblems', () => {
  const error = (
    reason: Extract<VinPreviewLine, { status: 'error' }>['reason'],
  ): VinPreviewLine => ({
    line: 1,
    raw: 'X Y 1',
    status: 'error',
    reason,
    message: '',
  });

  it('maps the preview reasons', () => {
    expect(kitLineState(error('excluded'))).toBe('excluded');
    expect(kitLineState(error('not_found'))).toBe('unavailable');
    expect(kitLineState(error('brand_mismatch'))).toBe('unavailable');
    expect(kitLineState(error('no_stock'))).toBe('unavailable');
    expect(kitLineState(error('supplier_unavailable'))).toBe('supplier');
    expect(kitLineState(error('parse'))).toBe('invalid');
  });

  it('publishes when every main line is found and nothing is marked goods', () => {
    expect(
      kitPublishProblems([
        { line: 1, alternative: false, state: 'ok' },
        { line: 2, alternative: true, state: 'unavailable' },
        { line: 3, alternative: true, state: 'supplier' },
        { line: 4, alternative: false, state: 'ok' },
      ]),
    ).toEqual([]);
  });

  it('refuses a main line not found, a marked good anywhere, a silent supplier, an empty kit', () => {
    expect(
      kitPublishProblems([
        { line: 1, alternative: false, state: 'unavailable' },
        { line: 2, alternative: true, state: 'excluded' },
        { line: 3, alternative: false, state: 'excluded' },
        { line: 5, alternative: false, state: 'supplier' },
        { line: 6, alternative: false, state: 'invalid' },
      ]),
    ).toEqual([
      'Строка 1: нет у поставщика',
      'Строка 2: маркируемый товар — в набор нельзя',
      'Строка 3: маркируемый товар — в набор нельзя',
      'Строка 5: поставщик не ответил — проверьте позже',
      'Строка 6: строку не прочитать',
    ]);
    expect(kitPublishProblems([])).toEqual(['В наборе нет ни одной позиции']);
    expect(kitPublishProblems([{ line: 1, alternative: true, state: 'ok' }])).toEqual([
      'В наборе нет ни одной позиции',
    ]);
  });
});

describe('totals and alternatives', () => {
  it('sums price × quantity and promises the latest date with the buffer', () => {
    expect(
      kitTotals(
        [
          { priceClientKop: 79_800, qty: 1, etaDate: '2026-10-12' },
          { priceClientKop: 31_400, qty: 4, etaDate: '2026-10-09' },
        ],
        ETA,
      ),
    ).toEqual({ totalKop: 205_400, itemsCount: 5, promised: '2026-10-13' });
    expect(kitTotals([], ETA)).toEqual({ totalKop: 0, itemsCount: 0, promised: null });
  });

  it('moves the promise off a day the pickup point is closed', () => {
    // Saturday 2026-10-10 + 1 buffer day = Sunday 2026-10-11, closed: Monday.
    const day = { openMin: 600, closeMin: 1140 };
    const totals = kitTotals([{ priceClientKop: 100, qty: 1, etaDate: '2026-10-10' }], {
      ...ETA,
      pickupSchedule: [null, day, day, day, day, day, day],
    });
    expect(totals.promised).toBe('2026-10-12');
  });

  it('compares an alternative with its main line by line totals and dates', () => {
    const main = { priceClientKop: 79_800, qty: 1, etaDate: '2026-10-12' };
    const cheaper = kitOptionDelta(main, { priceClientKop: 52_800, qty: 1, etaDate: '2026-10-09' });
    expect(cheaper).toEqual({ deltaKop: -27_000, faster: true, slower: false });
    expect(kitOptionHint(cheaper)).toBe('дешевле на 270 ₽ · быстрее');
    const dearer = kitOptionDelta(
      { priceClientKop: 31_400, qty: 4, etaDate: '2026-10-09' },
      { priceClientKop: 35_000, qty: 4, etaDate: '2026-10-13' },
    );
    expect(kitOptionHint(dearer)).toBe('дороже на 144 ₽ · дольше');
    expect(kitOptionHint(kitOptionDelta(main, { ...main, etaDate: '2026-10-10' }))).toBe('быстрее');
    expect(kitOptionHint(kitOptionDelta(main, main))).toBe('та же цена');
  });
});
