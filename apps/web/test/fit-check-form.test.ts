// Step 4 (docs/fit-check.md): the fields of the fit check form, the addresses shared with the
// proxy and the closed-gate text. Pure: no database, no Redis.
import { describe, expect, it } from 'vitest';
import {
  FIT_FORM_MESSAGES,
  isFitFormErrorCode,
  parseFitForm,
  type FitFormFields,
} from '@/server/fit-checks/form';
import { demoFitLocation, fitAnchor, fitFormAction, lineIdOf } from '@/server/fit-checks/paths';
import { fitClosedText } from '@/server/fit-checks/texts';
import { classifyLimitedRequest } from '@/server/request-limits';

const LINE = '01890000-0000-7000-8000-000000000001';
const OTHER = '01890000-0000-7000-8000-000000000002';

function fields(values: Record<string, string | string[]>): FitFormFields {
  return {
    get: (name) => {
      const value = values[name];
      return Array.isArray(value) ? value[0] : value;
    },
    getAll: (name) => {
      const value = values[name];
      return value === undefined ? [] : Array.isArray(value) ? value : [value];
    },
  };
}

describe('parseFitForm', () => {
  it('normalizes the VIN: lower case, spaces and dashes are accepted', () => {
    const parsed = parseFitForm(fields({ vin: ' xta 21099-0123 45678 ', lines: [LINE] }));
    expect(parsed).toEqual({
      ok: true,
      input: { vin: 'XTA21099012345678', comment: null, lineIds: [LINE], all: false, line: null },
    });
  });

  it('refuses a VIN that is not 17 valid characters; O, I and Q get their own hint', () => {
    expect(parseFitForm(fields({ vin: 'XTA2109901234567', lines: [LINE] }))).toEqual({
      ok: false,
      codes: ['vin'],
    });
    expect(parseFitForm(fields({ vin: 'XTA2109O012345678', lines: [LINE] }))).toEqual({
      ok: false,
      codes: ['vin_oiq'],
    });
    expect(parseFitForm(fields({ lines: [LINE] }))).toEqual({ ok: false, codes: ['vin'] });
  });

  it('the comment: trimmed, whitespace runs as one space, at most 200 characters', () => {
    const ok = parseFitForm(
      fields({ vin: 'XTA21099012345678', comment: '  двигатель   1.6,\n2019 ', lines: [LINE] }),
    );
    expect(ok.ok && ok.input.comment).toBe('двигатель 1.6, 2019');
    const long = parseFitForm(
      fields({ vin: 'XTA21099012345678', comment: 'я'.repeat(201), lines: [LINE] }),
    );
    expect(long).toEqual({ ok: false, codes: ['comment'] });
  });

  it('lines: at least one, unique, lower case; «all» needs none; a malformed id is a stale form', () => {
    expect(parseFitForm(fields({ vin: 'XTA21099012345678' }))).toEqual({
      ok: false,
      codes: ['lines'],
    });
    const dup = parseFitForm(
      fields({ vin: 'XTA21099012345678', lines: [LINE, LINE.toUpperCase(), OTHER], line: LINE }),
    );
    expect(dup.ok && dup.input).toEqual({
      vin: 'XTA21099012345678',
      comment: null,
      lineIds: [LINE, OTHER],
      all: false,
      line: LINE,
    });
    const all = parseFitForm(fields({ vin: 'XTA21099012345678', all: 'on' }));
    expect(all.ok && all.input.all && all.input.lineIds).toEqual([]);
    expect(parseFitForm(fields({ vin: 'XTA21099012345678', lines: ['1; drop table'] }))).toEqual({
      ok: false,
      codes: ['form'],
    });
  });

  it('reports every field at once', () => {
    expect(parseFitForm(fields({ vin: 'x', comment: 'я'.repeat(300) }))).toEqual({
      ok: false,
      codes: ['vin', 'comment', 'lines'],
    });
  });

  it('error codes come back in the URL; their messages are Russian sentences', () => {
    expect(isFitFormErrorCode('lines_foreign')).toBe(true);
    expect(isFitFormErrorCode('XTA21099012345678')).toBe(false);
    for (const message of Object.values(FIT_FORM_MESSAGES)) {
      expect(message).toMatch(/^[А-ЯЁ]/u);
    }
  });
});

describe('addresses', () => {
  it('line ids: a uuid, trimmed and lower case; anything else is null', () => {
    expect(lineIdOf(` ${LINE.toUpperCase()} `)).toBe(LINE);
    expect(lineIdOf('fit-1')).toBeNull();
    expect(lineIdOf(undefined)).toBeNull();
    expect(fitAnchor(LINE)).toBe(`fit-${LINE}`);
    expect(fitFormAction(LINE)).toBe(`/api/fit-checks?line=${LINE}`);
  });

  it('DEMO_MODE: a form post goes back to the line it came from, nothing else in the URL', () => {
    expect(demoFitLocation(new URLSearchParams({ line: LINE }))).toBe(
      `/cart?fit_demo=${LINE}#fit-${LINE}`,
    );
    expect(demoFitLocation(new URLSearchParams({ line: 'XTA21099012345678' }))).toBe('/cart');
    expect(demoFitLocation(new URLSearchParams())).toBe('/cart');
  });

  it('the closed gate sends to the phone of the point (as the closed /vin)', () => {
    expect(fitClosedText('+7 900 000-00-01')).toBe(
      'Проверка откроется вместе с заказами на сайте. Пока позвоните: +7 900 000-00-01',
    );
    expect(fitClosedText(null)).toContain('спросите в пункте выдачи');
  });
});

describe('rate limit classification', () => {
  const headers = new Headers({ origin: 'https://shop.test' });
  const classify = (method: string, pathname: string) =>
    classifyLimitedRequest({ method, pathname, searchParams: new URLSearchParams(), headers });

  it('POST /api/fit-checks counts as fit_check (20 a day per client bucket)', () => {
    expect(classify('POST', '/api/fit-checks')).toEqual({ action: 'count', kind: 'fit_check' });
    expect(classify('POST', '/api/fit-checks/')).toEqual({ action: 'count', kind: 'fit_check' });
    expect(classify('GET', '/api/fit-checks').action).not.toBe('count');
  });

  it('«Заменить» / «Оставить как есть» are cart writes', () => {
    expect(classify('POST', `/api/cart/items/${LINE}/fit`)).toEqual({
      action: 'count',
      kind: 'cart',
    });
  });
});
