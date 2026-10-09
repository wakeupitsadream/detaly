// Step 4 (docs/fit-check.md): fit checks as pure functions — the status transitions, the state
// of a cart line (which lines count as checked at checkout), the SLA in working hours of the
// pickup point, the promise to the client and the admin statistics.
import { describe, expect, it } from 'vitest';
import {
  addWorkingMinutes,
  canRequestFitCheck,
  canTransitionFitCheck,
  cleanFitComment,
  DEFAULT_FIT_CHECK_SLA_MINUTES,
  FIT_CHECK_ANSWERS,
  FIT_CHECK_COMMENT_MAX,
  FIT_CHECK_LINES_MAX,
  FIT_CHECK_RETENTION_DAYS,
  FIT_CHECK_STATUSES,
  FIT_CHECK_TTL_MS,
  FIT_GUARANTEE_CLAIM_LABEL,
  fitCheckExpiresAt,
  fitCheckOverdue,
  fitCheckPendingText,
  fitCheckPromise,
  fitCheckPromiseText,
  fitCheckStats,
  fitGuaranteeClaimLabel,
  fitLineState,
  fitRequestNumber,
  isFitCheckAnswer,
  isFitCheckedState,
  isFitCheckStatus,
  MAX_CART_LINES,
  nextWorkingStart,
  parseWorkHours,
  samePart,
  SELLER_CARD_KINDS,
  sharePercent,
  workingMinutesBetween,
  type FitCheckFacts,
  type FitCheckStatRow,
  type FitCheckStatus,
  type FitLineState,
} from '../src';

/** Mon–Fri 10:00–19:00, the e2e pickup hours; Asia/Yekaterinburg is UTC+5. */
const WEEKDAYS = parseWorkHours('Пн–Пт 10:00–19:00');
/** The founder's real pattern: Mon–Sat 9:00–19:00. */
const MON_SAT = parseWorkHours('Пн–Сб 9:00–19:00');
const MIN = 60_000;
const HOUR = 60 * MIN;

/** Local Yekaterinburg wall time -> Date ('2026-10-09T18:30' is Friday 18:30). */
function local(wall: string): Date {
  return new Date(`${wall}:00+05:00`);
}

const LINE = { brand: 'MANN-FILTER', article: 'W 914/2' };

function check(overrides: Partial<FitCheckFacts> = {}): FitCheckFacts {
  return {
    status: 'pending',
    brand: 'MANN-FILTER',
    article: 'W 914/2',
    analogBrand: null,
    analogArticle: null,
    analogKeptAt: null,
    expiresAt: local('2026-10-10T12:00'),
    ...overrides,
  };
}

describe('statuses and transitions', () => {
  it('seven statuses, four answers of the master, a fit seller card', () => {
    expect(FIT_CHECK_STATUSES).toEqual([
      'pending',
      'fits',
      'analog',
      'not_fit',
      'call_needed',
      'expired',
      'cancelled',
    ]);
    expect(FIT_CHECK_ANSWERS).toEqual(['fits', 'analog', 'not_fit', 'call_needed']);
    expect(SELLER_CARD_KINDS).toEqual(['order', 'qr', 'vin', 'fit']);
    expect(isFitCheckStatus('fits')).toBe(true);
    expect(isFitCheckStatus('ok')).toBe(false);
    expect(isFitCheckAnswer('analog')).toBe(true);
    expect(isFitCheckAnswer('expired')).toBe(false);
    expect(isFitCheckAnswer(undefined)).toBe(false);
  });

  it('only a pending check moves; every other status is final', () => {
    for (const to of FIT_CHECK_STATUSES) {
      expect(canTransitionFitCheck('pending', to)).toBe(to !== 'pending');
    }
    const finals: FitCheckStatus[] = [
      'fits',
      'analog',
      'not_fit',
      'call_needed',
      'expired',
      'cancelled',
    ];
    for (const from of finals) {
      for (const to of FIT_CHECK_STATUSES) expect(canTransitionFitCheck(from, to)).toBe(false);
    }
  });

  it('policy constants', () => {
    expect(FIT_CHECK_COMMENT_MAX).toBe(200);
    expect(FIT_CHECK_TTL_MS).toBe(24 * HOUR);
    expect(FIT_CHECK_RETENTION_DAYS).toBe(90);
    expect(DEFAULT_FIT_CHECK_SLA_MINUTES).toBe(60);
    expect(FIT_CHECK_LINES_MAX).toBe(MAX_CART_LINES);
    expect(fitCheckExpiresAt(local('2026-10-09T18:30')).toISOString()).toBe(
      local('2026-10-10T18:30').toISOString(),
    );
  });

  it('short request number, cleaned comment', () => {
    expect(fitRequestNumber('0192f0c4-1111-7222-8333-0123456789ab')).toBe('6789AB');
    expect(cleanFitComment('  двигатель   1.6,\n2019 ')).toBe('двигатель 1.6, 2019');
    expect(cleanFitComment('   ')).toBeNull();
    expect(cleanFitComment(null)).toBeNull();
  });
});

describe('the state of a cart line', () => {
  const now = local('2026-10-09T12:00');

  it('the same part regardless of case, spaces and punctuation', () => {
    expect(samePart(LINE, { brand: 'mann filter', article: 'W914/2' })).toBe(true);
    expect(samePart(LINE, { brand: 'MANN-FILTER', article: 'W 914/3' })).toBe(false);
    expect(samePart(LINE, { brand: 'KNECHT', article: 'W 914/2' })).toBe(false);
  });

  it('every status of a check of this very part', () => {
    const cases: [Partial<FitCheckFacts>, FitLineState][] = [
      [{ status: 'pending' }, 'pending'],
      [{ status: 'fits' }, 'fits'],
      [{ status: 'analog', analogBrand: 'KNECHT', analogArticle: 'OC 90' }, 'analog_offer'],
      [
        {
          status: 'analog',
          analogBrand: 'KNECHT',
          analogArticle: 'OC 90',
          analogKeptAt: local('2026-10-09T11:00'),
        },
        'analog_kept',
      ],
      [{ status: 'not_fit' }, 'not_fit'],
      [{ status: 'call_needed' }, 'call_needed'],
      [{ status: 'expired' }, 'expired'],
      [{ status: 'cancelled' }, 'none'],
    ];
    for (const [facts, state] of cases) {
      expect(fitLineState(check(facts), LINE, now), JSON.stringify(facts)).toBe(state);
    }
    expect(fitLineState(null, LINE, now)).toBe('none');
  });

  it('a pending check past expires_at reads expired before the worker marks it', () => {
    const facts = check({ expiresAt: local('2026-10-09T12:00') });
    expect(fitLineState(facts, LINE, local('2026-10-09T11:59'))).toBe('pending');
    expect(fitLineState(facts, LINE, local('2026-10-09T12:00'))).toBe('expired');
  });

  it('a line changed after the check (another offer, brand or article) loses it', () => {
    for (const status of ['fits', 'not_fit', 'call_needed', 'pending'] as const) {
      expect(fitLineState(check({ status }), { brand: 'BOSCH', article: 'F026407006' }, now)).toBe(
        'none',
      );
    }
  });

  it('the line replaced by the analog counts as checked, the original after «Оставить» does not', () => {
    const analog = check({ status: 'analog', analogBrand: 'KNECHT', analogArticle: 'OC 90' });
    const replaced = fitLineState(analog, { brand: 'Knecht', article: 'OC90' }, now);
    expect(replaced).toBe('analog_accepted');
    expect(isFitCheckedState(replaced)).toBe(true);
    expect(isFitCheckedState(fitLineState(analog, LINE, now))).toBe(false);
  });

  it('which states count as checked at checkout and which lines may be sent again', () => {
    const states: FitLineState[] = [
      'none',
      'pending',
      'fits',
      'analog_offer',
      'analog_accepted',
      'analog_kept',
      'not_fit',
      'call_needed',
      'expired',
    ];
    expect(states.filter(isFitCheckedState)).toEqual(['fits', 'analog_accepted']);
    expect(states.filter((s) => !canRequestFitCheck(s))).toEqual(['pending']);
  });
});

describe('working hours: the SLA', () => {
  it('counts only the minutes inside the opening hours', () => {
    // Friday 18:30 -> Monday 10:30: 30 minutes on Friday, 30 on Monday.
    expect(
      workingMinutesBetween(local('2026-10-09T18:30'), local('2026-10-12T10:30'), WEEKDAYS),
    ).toBe(60);
    // Within one day.
    expect(
      workingMinutesBetween(local('2026-10-08T11:00'), local('2026-10-08T11:45'), WEEKDAYS),
    ).toBe(45);
    // At night: nothing.
    expect(
      workingMinutesBetween(local('2026-10-08T20:00'), local('2026-10-09T09:59'), WEEKDAYS),
    ).toBe(0);
    // Saturday counts with Mon–Sat hours only.
    expect(
      workingMinutesBetween(local('2026-10-10T08:00'), local('2026-10-10T10:00'), MON_SAT),
    ).toBe(60);
    expect(
      workingMinutesBetween(local('2026-10-10T08:00'), local('2026-10-10T10:00'), WEEKDAYS),
    ).toBe(0);
    // A reversed range and an unknown schedule (every minute counts).
    expect(
      workingMinutesBetween(local('2026-10-09T12:00'), local('2026-10-09T11:00'), WEEKDAYS),
    ).toBe(0);
    expect(workingMinutesBetween(local('2026-10-09T20:00'), local('2026-10-09T21:30'), null)).toBe(
      90,
    );
  });

  it('adds working minutes across the night and the weekend', () => {
    expect(addWorkingMinutes(local('2026-10-09T18:30'), 60, WEEKDAYS).toISOString()).toBe(
      local('2026-10-12T10:30').toISOString(),
    );
    expect(addWorkingMinutes(local('2026-10-08T12:00'), 60, WEEKDAYS).toISOString()).toBe(
      local('2026-10-08T13:00').toISOString(),
    );
    expect(addWorkingMinutes(local('2026-10-08T07:00'), 0, WEEKDAYS).toISOString()).toBe(
      local('2026-10-08T10:00').toISOString(),
    );
    expect(addWorkingMinutes(local('2026-10-08T22:00'), 30, null).toISOString()).toBe(
      local('2026-10-08T22:30').toISOString(),
    );
    expect(() => addWorkingMinutes(local('2026-10-08T22:00'), -1, WEEKDAYS)).toThrow(RangeError);
  });

  it('the next working moment: now while open, else the next opening', () => {
    expect(nextWorkingStart(local('2026-10-08T12:00'), WEEKDAYS)?.toISOString()).toBe(
      local('2026-10-08T12:00').toISOString(),
    );
    expect(nextWorkingStart(local('2026-10-09T19:00'), WEEKDAYS)?.toISOString()).toBe(
      local('2026-10-12T10:00').toISOString(),
    );
    expect(nextWorkingStart(local('2026-10-08T12:00'), null)).toBeNull();
  });

  it('overdue after the SLA in working minutes only (one reminder per request)', () => {
    const sent = local('2026-10-09T18:30');
    expect(fitCheckOverdue(sent, local('2026-10-09T23:59'), 60, WEEKDAYS)).toBe(false);
    expect(fitCheckOverdue(sent, local('2026-10-12T10:29'), 60, WEEKDAYS)).toBe(false);
    expect(fitCheckOverdue(sent, local('2026-10-12T10:30'), 60, WEEKDAYS)).toBe(true);
    expect(fitCheckOverdue(sent, local('2026-10-09T19:00'), 30, WEEKDAYS)).toBe(true);
  });
});

describe('the promise to the client', () => {
  const text = (wall: string, schedule = WEEKDAYS, sla = 60) =>
    fitCheckPromiseText(fitCheckPromise(local(wall), sla, schedule));

  it('in the working hours: «Мастер проверит в течение часа»', () => {
    expect(text('2026-10-08T12:00')).toBe('Мастер проверит в течение часа');
    expect(text('2026-10-08T17:59')).toBe('Мастер проверит в течение часа');
    expect(text('2026-10-08T12:00', WEEKDAYS, 30)).toBe('Мастер проверит в течение часа');
    expect(text('2026-10-08T12:00', WEEKDAYS, 120)).toBe('Мастер проверит в течение 2 часов');
  });

  it('outside them: «Проверим утром — с <opening>» from the pickup schedule', () => {
    // Evening and early morning: the next opening is tomorrow / today in the morning.
    expect(text('2026-10-08T20:00')).toBe('Проверим утром — с 10:00');
    expect(text('2026-10-08T07:00')).toBe('Проверим утром — с 10:00');
    expect(text('2026-10-08T20:00', MON_SAT)).toBe('Проверим утром — с 09:00');
    // Less than the SLA before closing: the morning, never a promise the master cannot keep.
    expect(text('2026-10-08T18:30')).toBe('Проверим утром — с 10:00');
    // Friday evening with Mon–Fri hours: the client must not expect Saturday.
    expect(text('2026-10-09T20:00')).toBe('Проверим в понедельник утром — с 10:00');
    // An afternoon opening is not «утром».
    expect(text('2026-10-08T20:00', parseWorkHours('Ежедневно 13:00–20:00'))).toBe(
      'Проверим завтра — с 13:00',
    );
    expect(text('2026-10-08T08:00', parseWorkHours('Ежедневно 13:00–20:00'))).toBe(
      'Проверим сегодня — с 13:00',
    );
    // Hours not understood.
    expect(text('2026-10-08T12:00', null)).toBe('Мастер проверит в рабочее время');
  });

  it('a pending line says the same', () => {
    const promise = (wall: string) => fitCheckPromise(local(wall), 60, WEEKDAYS);
    expect(fitCheckPendingText(promise('2026-10-08T12:00'))).toBe(
      'Мастер проверяет · ответит в течение часа',
    );
    expect(fitCheckPendingText(promise('2026-10-08T20:00'))).toBe(
      'Мастер проверяет · ответит утром — с 10:00',
    );
    expect(fitCheckPendingText(fitCheckPromise(local('2026-10-08T12:00'), 60, null))).toBe(
      'Мастер проверяет · ответит в рабочее время',
    );
  });
});

describe('admin statistics', () => {
  const sent = local('2026-10-08T12:00');
  const row = (overrides: Partial<FitCheckStatRow>): FitCheckStatRow => ({
    requestId: 'r1',
    status: 'pending',
    createdAt: sent,
    answeredAt: null,
    paid: false,
    ...overrides,
  });

  it('requests, lines, shares, the median in working minutes, the SLA and paid orders', () => {
    const rows: FitCheckStatRow[] = [
      row({ status: 'fits', answeredAt: local('2026-10-08T12:20'), paid: true }),
      row({ status: 'analog', answeredAt: local('2026-10-08T12:40') }),
      row({ requestId: 'r2', status: 'not_fit', answeredAt: local('2026-10-08T14:00') }),
      row({ requestId: 'r2', status: 'expired' }),
      row({ requestId: 'r3', status: 'pending' }),
      row({
        requestId: 'r4',
        status: 'call_needed',
        // Friday 18:30 -> Monday 10:10: 40 working minutes.
        createdAt: local('2026-10-09T18:30'),
        answeredAt: local('2026-10-12T10:10'),
      }),
    ];
    const stats = fitCheckStats(rows, { slaMinutes: 60, schedule: WEEKDAYS });
    expect(stats.requests).toBe(4);
    expect(stats.lines).toBe(6);
    expect(stats.byStatus).toEqual({
      pending: 1,
      fits: 1,
      analog: 1,
      not_fit: 1,
      call_needed: 1,
      expired: 1,
      cancelled: 0,
    });
    expect(stats.answered).toBe(4);
    // 20, 40, 40 (weekend skipped), 120 -> (40 + 40) / 2
    expect(stats.medianAnswerMinutes).toBe(40);
    expect(stats.withinSla).toBe(3);
    expect(stats.checked).toBe(2);
    expect(stats.checkedPaid).toBe(1);
    expect(sharePercent(stats.checkedPaid, stats.checked)).toBe(50);
  });

  it('empty periods have no median and no shares', () => {
    const stats = fitCheckStats([], { slaMinutes: 60, schedule: WEEKDAYS });
    expect(stats).toMatchObject({ requests: 0, lines: 0, answered: 0, medianAnswerMinutes: null });
    expect(sharePercent(0, 0)).toBeNull();
    const odd = fitCheckStats([row({ status: 'fits', answeredAt: local('2026-10-08T12:25') })], {
      slaMinutes: 60,
      schedule: WEEKDAYS,
    });
    expect(odd.medianAnswerMinutes).toBe(25);
  });
});

describe('claims: the fit guarantee label', () => {
  it('only a «не подошла» claim on an item ordered with the guarantee', () => {
    expect(fitGuaranteeClaimLabel('not_fit', { fitGuarantee: true })).toBe(
      FIT_GUARANTEE_CLAIM_LABEL,
    );
    expect(FIT_GUARANTEE_CLAIM_LABEL).toBe('Гарантия подбора: мастер проверил под VIN');
    expect(fitGuaranteeClaimLabel('not_fit', { fitGuarantee: false })).toBeNull();
    expect(fitGuaranteeClaimLabel('defect', { fitGuarantee: true })).toBeNull();
    expect(fitGuaranteeClaimLabel('not_fit', null)).toBeNull();
  });
});
