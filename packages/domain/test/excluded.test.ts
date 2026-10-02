import { describe, expect, it } from 'vitest';
import {
  DEFAULT_EXCLUDED_RULES,
  isExcluded,
  isValidExcludedPattern,
  matchesExcludedPattern,
  normalizeText,
} from '../src';
import type { ExcludedRule } from '../src/types';

describe('isExcluded with the default keyword rules', () => {
  it.each([
    'Масло моторное 5W-40',
    'Шина зимняя',
    'Антифриз G12',
    'Жидкость тормозная DOT-4',
    'МАСЛО трансмиссионное',
    'Шины летние 205/55 R16',
    'Тосол А-40',
    'Антифризный концентрат',
    'Тормозная жидкость DOT-4',
    'Масла моторные, канистра 4 л',
    'Жидкость охлаждающая G12',
    'Охлаждающая жидкость зелёная 5 кг',
  ])('excludes "%s"', (name) => {
    const result = isExcluded({ name }, DEFAULT_EXCLUDED_RULES);
    expect(result.excluded).toBe(true);
    expect(result.reason).toMatch(/^Маркируемый товар/);
  });

  it.each([
    'Фильтр масляный',
    'Колпачок маслосъёмный',
    'Колпачок маслосъемный',
    'Колодки тормозные',
    'Машина для чего-то',
    'Шиномонтажный набор',
    'Жидкость стеклоомывающая',
    'Шланг тормозной',
    'Датчик температуры охлаждающей жидкости',
    'Насос охлаждающей жидкости',
  ])('keeps "%s"', (name) => {
    expect(isExcluded({ name }, DEFAULT_EXCLUDED_RULES)).toEqual({ excluded: false, reason: null });
  });
});

describe('pattern grammar', () => {
  it('normalizes case and ё', () => {
    expect(normalizeText('ЁЛКА Ёж')).toBe('елка еж');
    expect(matchesExcludedPattern('Жёсткий диск', 'жесткий')).toBe(true);
    expect(matchesExcludedPattern('Жесткий диск', 'ЖЁСТКИЙ')).toBe(true);
  });

  it('token without * is a whole word, with * a word prefix', () => {
    expect(matchesExcludedPattern('Маслосъемный колпачок', 'масло')).toBe(false);
    expect(matchesExcludedPattern('Маслосъемный колпачок', 'масло*')).toBe(true);
  });

  it('all tokens must be present, in any order', () => {
    expect(matchesExcludedPattern('Тормозная жидкость', 'жидкость тормозн*')).toBe(true);
    expect(matchesExcludedPattern('Тормозные колодки', 'жидкость тормозн*')).toBe(false);
  });

  it('punctuation splits words', () => {
    expect(matchesExcludedPattern('DOT-4', 'dot 4')).toBe(true);
    expect(matchesExcludedPattern('масло/фильтр', 'масло')).toBe(true);
  });

  it('invalid patterns never match and are reported', () => {
    expect(isValidExcludedPattern('')).toBe(false);
    expect(isValidExcludedPattern('   ')).toBe(false);
    expect(isValidExcludedPattern('*')).toBe(false);
    expect(isValidExcludedPattern('ма*сло')).toBe(false);
    expect(isValidExcludedPattern('жидкость тормозн*')).toBe(true);
    expect(
      isExcluded({ name: 'что угодно' }, [{ kind: 'keyword', pattern: '*', reason: null }]),
    ).toEqual({
      excluded: false,
      reason: null,
    });
  });
});

describe('group rules', () => {
  const rules: ExcludedRule[] = [
    { kind: 'group', pattern: 'шины', reason: 'Группа: шины' },
    { kind: 'group', pattern: 'масла моторные', reason: null },
  ];

  it('match the product group, not the name', () => {
    expect(isExcluded({ name: 'R16 205/55', group: 'Шины' }, rules)).toEqual({
      excluded: true,
      reason: 'Группа: шины',
    });
    expect(isExcluded({ name: 'Шины', group: null }, rules).excluded).toBe(false);
    expect(isExcluded({ name: 'Шины' }, rules).excluded).toBe(false);
  });

  it('fall back to the pattern as the reason', () => {
    expect(isExcluded({ name: 'X', group: 'Масла моторные' }, rules)).toEqual({
      excluded: true,
      reason: 'масла моторные',
    });
  });

  function isExcludedWithRules(item: { name: string; group?: string | null }) {
    return isExcluded(item, rules);
  }

  it('group text is normalized the same way', () => {
    expect(isExcludedWithRules({ name: 'x', group: 'ШИНЫ ЛЕГКОВЫЕ' }).excluded).toBe(true);
    expect(isExcludedWithRules({ name: 'x', group: 'Фильтры' }).excluded).toBe(false);
  });
});
