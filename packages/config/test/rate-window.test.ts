import { describe, expect, it } from 'vitest';
import { dailyCounterKey, mskDayKey } from '../src/rate-window';

describe('mskDayKey', () => {
  it('switches the day at 21:00 UTC (Moscow midnight)', () => {
    expect(mskDayKey(new Date('2026-10-01T20:59:59.999Z'))).toBe('2026-10-01');
    expect(mskDayKey(new Date('2026-10-01T21:00:00.000Z'))).toBe('2026-10-02');
  });

  it('handles year boundaries', () => {
    expect(mskDayKey(new Date('2026-12-31T20:59:59Z'))).toBe('2026-12-31');
    expect(mskDayKey(new Date('2026-12-31T21:00:00Z'))).toBe('2027-01-01');
  });

  it('builds daily counter keys', () => {
    expect(dailyCounterKey('rossko:quota', new Date('2026-10-01T21:00:00Z'))).toBe(
      'rossko:quota:2026-10-02',
    );
  });
});
