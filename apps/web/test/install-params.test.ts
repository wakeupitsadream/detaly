import { describe, expect, it } from 'vitest';
import { durationWords, horizonWords } from '@/lib/install-params';
import { INSTALL_JOB_MIN, INSTALL_WINDOW_OPTIONS } from '@/server/install/config';

describe('install params wording', () => {
  it('says typical durations in words', () => {
    expect(durationWords(60)).toBe('час');
    expect(durationWords(120)).toBe('два часа');
    expect(durationWords(120, 'gen')).toBe('двух часов');
    expect(durationWords(90, 'gen')).toBe('полутора часов');
  });

  it('falls back to minutes with the right plural', () => {
    expect(durationWords(75)).toBe('75 минут');
    expect(durationWords(21)).toBe('21 минута');
    expect(durationWords(45, 'gen')).toBe('45 минут');
    expect(durationWords(52)).toBe('52 минуты');
  });

  it('says the horizon in weeks or days', () => {
    expect(horizonWords(14)).toBe('две недели');
    expect(horizonWords(7)).toBe('неделю');
    expect(horizonWords(10)).toBe('10 дней');
    expect(horizonWords(3)).toBe('3 дня');
  });

  it('the planner uses the same job length the texts describe', () => {
    expect(INSTALL_WINDOW_OPTIONS.jobMin).toBe(INSTALL_JOB_MIN);
  });
});
