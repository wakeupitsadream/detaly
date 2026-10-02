import { describe, expect, it } from 'vitest';
import { smsBudgetPeriod, smsBudgetState } from '../src';

describe('smsBudgetState', () => {
  const budgetRub = 1_000; // 100 000 kop

  it('79% ok, 80% alert, 100% exhausted', () => {
    expect(smsBudgetState({ spentKop: 0, budgetRub })).toBe('ok');
    expect(smsBudgetState({ spentKop: 79_000, budgetRub })).toBe('ok');
    expect(smsBudgetState({ spentKop: 79_999, budgetRub })).toBe('ok');
    expect(smsBudgetState({ spentKop: 80_000, budgetRub })).toBe('alert');
    expect(smsBudgetState({ spentKop: 99_999, budgetRub })).toBe('alert');
    expect(smsBudgetState({ spentKop: 100_000, budgetRub })).toBe('exhausted');
    expect(smsBudgetState({ spentKop: 150_000, budgetRub })).toBe('exhausted');
  });

  it('no budget configured -> ok; a zero budget -> exhausted', () => {
    expect(smsBudgetState({ spentKop: 10_000_000, budgetRub: undefined })).toBe('ok');
    expect(smsBudgetState({ spentKop: 10_000_000, budgetRub: null })).toBe('ok');
    expect(smsBudgetState({ spentKop: 0, budgetRub: 0 })).toBe('exhausted');
  });

  it('odd budgets: thresholds in integer kopecks', () => {
    // 333 ₽ -> 80% = 26 640 kop
    expect(smsBudgetState({ spentKop: 26_639, budgetRub: 333 })).toBe('ok');
    expect(smsBudgetState({ spentKop: 26_640, budgetRub: 333 })).toBe('alert');
    expect(smsBudgetState({ spentKop: 33_300, budgetRub: 333 })).toBe('exhausted');
  });
});

describe('smsBudgetPeriod', () => {
  it('calendar month in Asia/Yekaterinburg (UTC+5)', () => {
    expect(smsBudgetPeriod(new Date('2026-10-15T12:00:00Z'))).toEqual({
      month: '2026-10',
      from: new Date('2026-09-30T19:00:00Z'),
      to: new Date('2026-10-31T19:00:00Z'),
    });
    // 31 Oct 20:00 UTC is already 1 Nov in Orenburg.
    expect(smsBudgetPeriod(new Date('2026-10-31T20:00:00Z')).month).toBe('2026-11');
    expect(smsBudgetPeriod(new Date('2026-10-31T18:59:59Z')).month).toBe('2026-10');
    expect(smsBudgetPeriod(new Date('2026-12-31T19:00:00Z'))).toEqual({
      month: '2027-01',
      from: new Date('2026-12-31T19:00:00Z'),
      to: new Date('2027-01-31T19:00:00Z'),
    });
  });
});
