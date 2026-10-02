import { describe, expect, it } from 'vitest';
import { normalizeArticle, rubToKop } from './normalize';

describe('normalizeArticle', () => {
  it.each([
    ['W 914/2', 'W9142'],
    ['oc-90', 'OC90'],
    ['  gdb 1330 ', 'GDB1330'],
    ['0 451 103 079', '0451103079'],
    ['EDGE 5W-40', 'EDGE5W40'],
    // Cyrillic look-alikes typed on a Russian layout
    ['ОС90', 'OC90'],
    ['w914/2', 'W9142'],
    ['', ''],
    ['//--', ''],
  ])('%j -> %j', (input, expected) => {
    expect(normalizeArticle(input)).toBe(expected);
  });

  it('drops Cyrillic letters without a Latin twin', () => {
    expect(normalizeArticle('Ж-Б 90')).toBe('90');
    expect(normalizeArticle('Фильтр 90')).toBe('TP90');
  });
});

describe('rubToKop', () => {
  it.each<[string | number, number]>([
    ['1234.50', 123450],
    ['1234.5', 123450],
    ['1234', 123400],
    ['0.01', 1],
    ['0', 0],
    ['1 234,50', 123450],
    ['1 234.50', 123450],
    [' 412.50 ', 41250],
    ['10.005', 1001],
    ['10.004', 1000],
    ['10.999', 1100],
    [412.5, 41250],
    [1234.5, 123450],
    [0.1, 10],
    [19.99, 1999],
    // a classic float trap: 1.15 * 100 = 114.99999999999999
    [1.15, 115],
    ['1.15', 115],
    [455, 45500],
  ])('%j -> %d', (input, expected) => {
    expect(rubToKop(input)).toBe(expected);
  });

  it.each<string | number>(['', 'abc', '-1', '1.2.3', '1e3', Number.NaN, Infinity, -5, '12,34,5'])(
    'rejects %j',
    (input) => {
      expect(() => rubToKop(input)).toThrow(RangeError);
    },
  );

  it('rejects amounts beyond safe integers', () => {
    expect(() => rubToKop('999999999999999999999')).toThrow(RangeError);
  });
});
