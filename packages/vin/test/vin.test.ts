import { describe, expect, it } from 'vitest';
import {
  createManualResolver,
  InvalidVinError,
  isValidVin,
  maskVin,
  normalizeVin,
  parseManualAnswer,
} from '../src';

describe('isValidVin', () => {
  it.each(['XTA21099043456789', 'WVWZZZ1JZXW000001', '1HGCM82633A004352', 'Z94CB41BAER123456'])(
    'accepts %s',
    (vin) => {
      expect(isValidVin(vin)).toBe(true);
    },
  );

  it.each([
    ['16 characters', 'XTA2109904345678'],
    ['18 characters', 'XTA210990434567890'],
    ['letter I', 'XTA2109904345678I'],
    ['letter O', 'XTAO1099043456789'],
    ['letter Q', 'QTA21099043456789'],
    ['lower case (normalize first)', 'xta21099043456789'],
    ['spaces', 'XTA 21099043456789'],
    ['Cyrillic', 'ХТА21099043456789'],
    ['empty', ''],
  ])('rejects %s', (_name, vin) => {
    expect(isValidVin(vin)).toBe(false);
  });
});

describe('normalizeVin', () => {
  it('trims, removes spaces and dashes, upper-cases', () => {
    expect(normalizeVin('  xta-21099 043456789 ')).toBe('XTA21099043456789');
  });

  it('maps Cyrillic look-alikes to Latin', () => {
    expect(normalizeVin('ХТА21099043456789')).toBe('XTA21099043456789');
    expect(normalizeVin('хта21099043456789')).toBe('XTA21099043456789');
  });

  it('does not guess O/I/Q and rejects wrong lengths', () => {
    expect(normalizeVin('XTAO1099043456789')).toBeNull();
    expect(normalizeVin('XTA2109904345678')).toBeNull();
    expect(normalizeVin('ЖТА21099043456789')).toBeNull();
  });

  it('maskVin keeps only the manufacturer code and the last 4', () => {
    expect(maskVin('XTA21099043456789')).toBe('XTA**********6789');
    expect(maskVin('short')).toBe('*****');
  });
});

describe('ManualResolver', () => {
  it('reports that a seller must answer', async () => {
    const resolver = createManualResolver();
    expect(resolver.provider).toBe('manual');
    await expect(resolver.resolve('XTA21099043456789', 'колодки передние')).resolves.toEqual({
      provider: 'manual',
      status: 'manual_required',
      vehicle: null,
      candidates: [],
    });
  });

  it('rejects an invalid VIN', async () => {
    await expect(createManualResolver().resolve('XTAO1099043456789', '')).rejects.toBeInstanceOf(
      InvalidVinError,
    );
  });
});

describe('parseManualAnswer', () => {
  it('parses "БРЕНД АРТИКУЛ КОЛ-ВО" lines', () => {
    expect(
      parseManualAnswer(
        ['MANN W 914/2 1', 'BOSCH 0986452041 2  # передние', '', 'TRW GDB1330', '  '].join('\n'),
      ),
    ).toEqual({
      candidates: [
        { brand: 'MANN', article: 'W 914/2', quantity: 1, note: null },
        { brand: 'BOSCH', article: '0986452041', quantity: 2, note: 'передние' },
        { brand: 'TRW', article: 'GDB1330', quantity: 1, note: null },
      ],
      errors: [],
    });
  });

  it('reports lines it cannot use with their numbers', () => {
    expect(parseManualAnswer('MANN\nNGK BKR6E 0\nNGK BKR6E 4\r\nTRW GDB1330 100')).toEqual({
      candidates: [{ brand: 'NGK', article: 'BKR6E', quantity: 4, note: null }],
      errors: [
        { line: 1, text: 'MANN', reason: 'too_short' },
        { line: 2, text: 'NGK BKR6E 0', reason: 'bad_quantity' },
        { line: 4, text: 'TRW GDB1330 100', reason: 'bad_quantity' },
      ],
    });
  });
});
