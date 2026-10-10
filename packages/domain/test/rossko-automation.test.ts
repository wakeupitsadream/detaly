// Step 8 (docs/rossko-automation.md): Rossko without the manual cabinet as pure functions — the
// settings and their parsers, the working days of the pickup point, which deadline alert is due
// (across working hours and weekends), the idempotent keys and texts, the cutoff reminder, the
// shadow auto-order with each of its reasons, the agreement statistics and the verdict thresholds.
import { describe, expect, it } from 'vitest';
import {
  addWorkingDays,
  AUTO_ORDER_REASONS,
  AUTO_ORDER_VERDICT_MIN_AGREEMENT_PCT,
  AUTO_ORDER_VERDICT_MIN_DECISIONS,
  autoOrderLine,
  autoOrderReasonText,
  autoOrderStats,
  autoOrderVerdict,
  cleanRosskoStatusName,
  cutoffReminderDue,
  cutoffReminderKey,
  cutoffReminderText,
  DEADLINE_ALERT_KINDS,
  DEADLINE_ALERT_TEMPLATES,
  deadlineAlertDue,
  deadlineAlertKey,
  deadlineAlertNote,
  deadlineReminderKind,
  DEFAULT_AUTO_ORDER_MAX_TOTAL_KOP,
  DEFAULT_ROSSKO_AUTOMATION_SETTINGS,
  DEFAULT_ROSSKO_ORDER_WITHIN_MINUTES,
  isAutoOrderMaxTotalKop,
  isRosskoOrderWithinMinutes,
  isWorkingDay,
  nextWorkingDayOpen,
  normalizeCutoffTime,
  notPickedUpAt,
  ORDER_NOTIFY_TEMPLATES,
  parseAutoOrderShadow,
  parseCutoffText,
  parseCutoffTimes,
  parseRosskoStatusMap,
  parseWorkHours,
  previousWorkingDayClose,
  resolveRosskoAutomationSettings,
  ROSSKO_CUTOFF_TIMES_MAX,
  ROSSKO_STATUS_MAP_MAX,
  rosskoStatusAction,
  rosskoStatusCodeKey,
  sameRosskoStatusMap,
  shadowMasterOrdered,
  shouldAutoOrder,
  supplierLateAt,
  supplierOverdueAt,
  supplierRefusedText,
  supplierShippedNote,
  unmappedStatusText,
  workingDayBounds,
  workingTimeText,
  type AutoOrderInput,
  type AutoOrderLine,
  type AutoOrderShadowRow,
  type DeadlineAlertOrder,
  type RecheckItemResult,
} from '../src';

/** Mon–Fri 10:00–19:00, the e2e pickup hours; Asia/Yekaterinburg is UTC+5. */
const WEEKDAYS = parseWorkHours('Пн–Пт 10:00–19:00');
/** The founder's real pattern: Mon–Sat 9:00–19:00. */
const MON_SAT = parseWorkHours('Пн–Сб 9:00–19:00');

/** Local Yekaterinburg wall time -> Date. October 2026: the 9th is a Friday, the 12th a Monday. */
function local(wall: string): Date {
  return new Date(`${wall}:00+05:00`);
}

describe('settings', () => {
  it('defaults: nothing mapped, polling off, 120 minutes, 15 000 ₽, no cutoffs', () => {
    expect(DEFAULT_ROSSKO_AUTOMATION_SETTINGS).toEqual({
      statusMap: {},
      pollEnabled: false,
      orderWithinMinutes: 120,
      autoOrderMaxTotalKop: 1_500_000,
      cutoffTimes: [],
    });
    expect(DEFAULT_ROSSKO_ORDER_WITHIN_MINUTES).toBe(120);
    expect(DEFAULT_AUTO_ORDER_MAX_TOTAL_KOP).toBe(1_500_000);
  });

  it('the status map: codes are integers, actions are the four known ones, sorted by number', () => {
    expect(
      parseRosskoStatusMap({ '12': 'refused', '3': 'shipped_to_point', '0': 'ignore' }),
    ).toEqual({ '0': 'ignore', '3': 'shipped_to_point', '12': 'refused' });
    expect(Object.keys(parseRosskoStatusMap({ '12': 'refused', '3': 'ignore' }) ?? {})).toEqual([
      '3',
      '12',
    ]);
    expect(parseRosskoStatusMap({})).toEqual({});
    for (const bad of [
      { '03': 'ignore' },
      { '-1': 'ignore' },
      { '1.5': 'ignore' },
      { abc: 'ignore' },
      { '1234567': 'ignore' },
      { '3': 'order' },
      { '3': null },
      [],
      null,
      'x',
    ]) {
      expect(parseRosskoStatusMap(bad), JSON.stringify(bad)).toBeNull();
    }
    const many = Object.fromEntries(
      Array.from({ length: ROSSKO_STATUS_MAP_MAX + 1 }, (_, i) => [String(i), 'ignore']),
    );
    expect(parseRosskoStatusMap(many)).toBeNull();
    expect(sameRosskoStatusMap({ '3': 'ignore' }, { '3': 'ignore' })).toBe(true);
    expect(sameRosskoStatusMap({ '3': 'ignore' }, { '3': 'refused' })).toBe(false);
    expect(sameRosskoStatusMap({ '3': 'ignore' }, {})).toBe(false);
  });

  it('a code acts only when it is mapped; no code is never mapped', () => {
    const map = { '3': 'shipped_to_point', '7': 'refused' } as const;
    expect(rosskoStatusAction(map, 3)).toBe('shipped_to_point');
    expect(rosskoStatusAction(map, 7)).toBe('refused');
    expect(rosskoStatusAction(map, 5)).toBeNull();
    expect(rosskoStatusAction(map, null)).toBeNull();
    expect(rosskoStatusAction({}, 3)).toBeNull();
    expect(rosskoStatusCodeKey(36)).toBe('36');
    expect(rosskoStatusCodeKey(-1)).toBeNull();
    expect(rosskoStatusCodeKey(1.5)).toBeNull();
  });

  it('cutoff times: «11:00, 16:00» typed any way, sorted, without repeats, at most six', () => {
    expect(parseCutoffText('16:00, 11:00')).toEqual(['11:00', '16:00']);
    expect(parseCutoffText('9:30;  9.30\n16:00')).toEqual(['09:30', '16:00']);
    expect(parseCutoffText('')).toEqual([]);
    expect(parseCutoffText('  ')).toEqual([]);
    expect(parseCutoffText('25:00')).toBeNull();
    expect(parseCutoffText('11:60')).toBeNull();
    expect(parseCutoffText('утром')).toBeNull();
    expect(
      parseCutoffText(['08:00', '09:00', '10:00', '11:00', '12:00', '13:00', '14:00'].join(',')),
    ).toBeNull();
    expect(ROSSKO_CUTOFF_TIMES_MAX).toBe(6);
    expect(normalizeCutoffTime('7:05')).toBe('07:05');
    expect(parseCutoffTimes(['16:00', '11:00'])).toEqual(['11:00', '16:00']);
    expect(parseCutoffTimes(['11:00', 11])).toBeNull();
    expect(parseCutoffTimes('11:00')).toBeNull();
  });

  it('bounds of the editable numbers', () => {
    expect(isRosskoOrderWithinMinutes(120)).toBe(true);
    expect(isRosskoOrderWithinMinutes(15)).toBe(true);
    expect(isRosskoOrderWithinMinutes(14)).toBe(false);
    expect(isRosskoOrderWithinMinutes(1441)).toBe(false);
    expect(isRosskoOrderWithinMinutes(30.5)).toBe(false);
    expect(isAutoOrderMaxTotalKop(0)).toBe(true);
    expect(isAutoOrderMaxTotalKop(50_000_000)).toBe(true);
    expect(isAutoOrderMaxTotalKop(50_000_001)).toBe(false);
    expect(isAutoOrderMaxTotalKop(-1)).toBe(false);
  });

  it('stored rows over the defaults; a malformed row falls back to its default', () => {
    expect(
      resolveRosskoAutomationSettings(
        new Map<string, unknown>([
          ['rossko.order_status_map', { '3': 'refused' }],
          ['rossko.poll_enabled', true],
          ['rossko.order_within_minutes', 60],
          ['rossko.auto_order_max_total_kop', 2_000_000],
          ['rossko.cutoff_times', ['16:00', '11:00']],
        ]),
      ),
    ).toEqual({
      statusMap: { '3': 'refused' },
      pollEnabled: true,
      orderWithinMinutes: 60,
      autoOrderMaxTotalKop: 2_000_000,
      cutoffTimes: ['11:00', '16:00'],
    });
    expect(
      resolveRosskoAutomationSettings(
        new Map<string, unknown>([
          ['rossko.order_status_map', { '3': 'order_it' }],
          ['rossko.poll_enabled', 'yes'],
          ['rossko.order_within_minutes', 5],
          ['rossko.auto_order_max_total_kop', -10],
          ['rossko.cutoff_times', ['noon']],
        ]),
      ),
    ).toEqual(DEFAULT_ROSSKO_AUTOMATION_SETTINGS);
  });
});

describe('working days of the pickup point', () => {
  it('days off, bounds and the n-th working day across a weekend', () => {
    expect(isWorkingDay('2026-10-09', WEEKDAYS)).toBe(true);
    expect(isWorkingDay('2026-10-10', WEEKDAYS)).toBe(false);
    expect(isWorkingDay('2026-10-10', MON_SAT)).toBe(true);
    expect(isWorkingDay('2026-10-11', null)).toBe(true);
    expect(workingDayBounds('2026-10-09', WEEKDAYS)).toEqual({
      open: local('2026-10-09T10:00'),
      close: local('2026-10-09T19:00'),
    });
    expect(workingDayBounds('2026-10-10', WEEKDAYS)).toBeNull();
    expect(addWorkingDays('2026-10-09', 1, WEEKDAYS)).toBe('2026-10-12');
    expect(addWorkingDays('2026-10-09', 3, WEEKDAYS)).toBe('2026-10-14');
    expect(addWorkingDays('2026-10-09', 3, MON_SAT)).toBe('2026-10-13');
    expect(addWorkingDays('2026-10-10', 3, WEEKDAYS)).toBe('2026-10-14');
    expect(addWorkingDays('2026-10-09', 0, WEEKDAYS)).toBe('2026-10-09');
    expect(addWorkingDays('2026-10-09', 3, null)).toBe('2026-10-12');
    expect(() => addWorkingDays('2026-10-09', -1, WEEKDAYS)).toThrow(RangeError);
  });

  it('the end of the working day before a date and the start of the one after it', () => {
    // Monday 12 October: the working day before is Friday 9 October.
    expect(previousWorkingDayClose('2026-10-12', WEEKDAYS)).toEqual(local('2026-10-09T19:00'));
    expect(previousWorkingDayClose('2026-10-12', MON_SAT)).toEqual(local('2026-10-10T19:00'));
    expect(previousWorkingDayClose('2026-10-14', WEEKDAYS)).toEqual(local('2026-10-13T19:00'));
    // Friday 9 October: the next working day is Monday 12 October.
    expect(nextWorkingDayOpen('2026-10-09', WEEKDAYS)).toEqual(local('2026-10-12T10:00'));
    expect(nextWorkingDayOpen('2026-10-09', MON_SAT)).toEqual(local('2026-10-10T09:00'));
    // Without the hours: local midnight.
    expect(previousWorkingDayClose('2026-10-12', null)).toEqual(local('2026-10-12T00:00'));
    expect(nextWorkingDayOpen('2026-10-09', null)).toEqual(local('2026-10-10T00:00'));
  });
});

describe('deadline alerts: which one is due', () => {
  const base: DeadlineAlertOrder = {
    status: 'confirmed',
    statusSince: local('2026-10-09T18:00'),
    hasSupplierOrder: false,
    promisedDate: null,
    itemsNotArrived: 2,
    receivedAt: null,
  };
  const due = (
    order: Partial<DeadlineAlertOrder>,
    now: string,
    schedule: ReturnType<typeof parseWorkHours> = WEEKDAYS,
    orderWithinMinutes = 120,
  ) => deadlineAlertDue({ ...base, ...order }, { now: local(now), schedule, orderWithinMinutes });

  it('«Не заказано у поставщика»: working minutes only, the weekend does not count', () => {
    // Friday 18:00 → 19:00 is 60 minutes; Monday from 10:00.
    expect(due({}, '2026-10-10T12:00')).toBeNull();
    expect(due({}, '2026-10-12T10:59')).toBeNull();
    expect(due({}, '2026-10-12T11:00')).toBeNull(); // exactly 120: not «more than»
    expect(due({}, '2026-10-12T11:01')).toBe('not_ordered');
    // Without the hours every minute counts: Friday 20:01 is 121 minutes later.
    expect(due({}, '2026-10-09T20:01', null)).toBe('not_ordered');
    // The admin's own deadline.
    expect(due({}, '2026-10-12T10:31', WEEKDAYS, 90)).toBe('not_ordered');
    // Stuck in `ordering` counts the same way, from entering `ordering`.
    expect(due({ status: 'ordering' }, '2026-10-12T11:01')).toBe('not_ordered');
    // A created supplier order: Rossko has it.
    expect(due({ hasSupplierOrder: true }, '2026-10-13T12:00')).toBeNull();
  });

  it('«Срок поставщика под угрозой» from the end of the working day before the promise', () => {
    const order = { status: 'ordered_at_supplier' as const, promisedDate: '2026-10-12' };
    expect(supplierLateAt('2026-10-12', WEEKDAYS)).toEqual(local('2026-10-09T19:00'));
    expect(due(order, '2026-10-09T18:59')).toBeNull();
    expect(due(order, '2026-10-09T19:00')).toBe('supplier_late');
    expect(due(order, '2026-10-11T12:00')).toBe('supplier_late');
    expect(due(order, '2026-10-13T09:59')).toBe('supplier_late');
    // Everything arrived, or no promise: nothing.
    expect(due({ ...order, itemsNotArrived: 0 }, '2026-10-09T19:00')).toBeNull();
    expect(due({ ...order, promisedDate: null }, '2026-10-20T12:00')).toBeNull();
    // Mon–Sat: Saturday is the working day before Monday.
    expect(due(order, '2026-10-09T19:00', MON_SAT)).toBeNull();
    expect(due(order, '2026-10-10T19:00', MON_SAT)).toBe('supplier_late');
  });

  it('«Срок сорван» from the opening of the first working day after the promise', () => {
    const order = { status: 'ordered_at_supplier' as const, promisedDate: '2026-10-09' };
    // Promised Friday: overdue at Monday's opening (Mon–Fri), Saturday's (Mon–Sat).
    expect(supplierOverdueAt('2026-10-09', WEEKDAYS)).toEqual(local('2026-10-12T10:00'));
    expect(due(order, '2026-10-10T12:00')).toBe('supplier_late');
    expect(due(order, '2026-10-12T09:59')).toBe('supplier_late');
    expect(due(order, '2026-10-12T10:00')).toBe('supplier_overdue');
    expect(due(order, '2026-10-10T09:00', MON_SAT)).toBe('supplier_overdue');
    // After a gap only the latest: overdue, never «под угрозой» on top of it.
    expect(due(order, '2026-10-20T12:00')).toBe('supplier_overdue');
    // Without the hours: the day after the promise from midnight.
    expect(due(order, '2026-10-10T00:00', null)).toBe('supplier_overdue');
  });

  it('«Не забирают» after more than 3 working days at the point', () => {
    // Arrived Monday 15:00: Tue, Wed, Thu — due Friday at the opening.
    expect(notPickedUpAt(local('2026-10-12T15:00'), WEEKDAYS)).toEqual(local('2026-10-16T10:00'));
    const order = { status: 'ready' as const, receivedAt: local('2026-10-12T15:00') };
    expect(due(order, '2026-10-16T09:59')).toBeNull();
    expect(due(order, '2026-10-16T10:00')).toBe('not_picked_up');
    // Arrived Friday 18:00: Mon, Tue, Wed — Thursday at the opening.
    expect(due({ ...order, receivedAt: local('2026-10-09T18:00') }, '2026-10-15T09:59')).toBeNull();
    expect(due({ ...order, receivedAt: local('2026-10-09T18:00') }, '2026-10-15T10:00')).toBe(
      'not_picked_up',
    );
    // Without the hours: the arrival day + 4 at midnight.
    expect(notPickedUpAt(local('2026-10-12T15:00'), null)).toEqual(local('2026-10-16T00:00'));
    expect(due({ ...order, receivedAt: null }, '2026-10-30T12:00')).toBeNull();
  });

  it('other statuses have no deadline alert', () => {
    for (const status of [
      'draft',
      'awaiting_payment',
      'awaiting_confirmation',
      'awaiting_supplier_invoice',
      'needs_attention',
      'awaiting_client_approval',
      'awaiting_handover_payment',
      'out_for_delivery',
      'handed',
      'completed',
      'cancelled',
      'refund_pending',
      'refunded',
    ] as const) {
      expect(
        due(
          { status, promisedDate: '2026-10-01', receivedAt: local('2026-10-01T12:00') },
          '2026-10-30T12:00',
        ),
        status,
      ).toBeNull();
    }
  });

  it('one alert per order and kind: a stable key in the reminder format, a template each', () => {
    const order = '0192a3b4-0000-7000-8000-000000000001';
    expect(deadlineAlertKey(order, 'not_ordered')).toBe(`reminder:${order}:rossko_not_ordered:1`);
    expect(deadlineAlertKey(order, 'not_ordered')).toBe(deadlineAlertKey(order, 'not_ordered'));
    const keys = DEADLINE_ALERT_KINDS.map((kind) => deadlineAlertKey(order, kind));
    expect(new Set(keys).size).toBe(DEADLINE_ALERT_KINDS.length);
    expect(deadlineReminderKind('supplier_overdue')).toBe('rossko_supplier_overdue');
    for (const kind of DEADLINE_ALERT_KINDS) {
      expect(ORDER_NOTIFY_TEMPLATES).toContain(DEADLINE_ALERT_TEMPLATES[kind]);
    }
  });

  it('the note of each alert; the penalty line only for a prepaid order', () => {
    const input = {
      status: 'confirmed' as const,
      scheme: 'prepay' as const,
      promisedDate: '2026-10-12',
      orderWithinMinutes: 120,
    };
    expect(deadlineAlertNote('not_ordered', input)).toBe(
      'Не заказано у поставщика больше 2 ч рабочего времени — нажмите «Проверить и заказать».',
    );
    expect(deadlineAlertNote('not_ordered', { ...input, status: 'ordering' })).toContain(
      'Заказ у Rossko не завершился больше 2 ч',
    );
    expect(deadlineAlertNote('supplier_late', input)).toBe(
      'Клиенту обещано к пн 12 октября, а детали ещё не приехали — позвоните менеджеру Rossko и уточните срок.',
    );
    const overdue = deadlineAlertNote('supplier_overdue', input);
    expect(overdue.split('\n')).toEqual([
      'Обещали клиенту к пн 12 октября, детали не приехали — позвоните менеджеру Rossko и клиенту.',
      'Просрочка выдачи предоплаченного заказа — риск неустойки 0,5% в день (ст. 23.1 ЗоЗПП).',
    ]);
    expect(
      deadlineAlertNote('supplier_overdue', { ...input, scheme: 'pay_on_handover' }),
    ).not.toContain('23.1');
    expect(deadlineAlertNote('not_picked_up', input)).toBe(
      'Заказ ждёт клиента больше 3 рабочих дней — позвоните клиенту.',
    );
    expect(workingTimeText(90)).toBe('1 ч 30 мин');
    expect(workingTimeText(45)).toBe('45 мин');
  });
});

describe('the cutoff reminder', () => {
  const remind = (now: string, times: string[] = ['11:00', '16:00'], schedule = WEEKDAYS) =>
    cutoffReminderDue({ now: local(now), cutoffTimes: times, schedule });

  it('25 minutes before a cutoff on a working day, the earliest cutoff whose window is open', () => {
    expect(remind('2026-10-15T10:34')).toBeNull();
    expect(remind('2026-10-15T10:35')).toEqual({
      cutoff: '11:00',
      date: '2026-10-15',
      at: local('2026-10-15T11:00'),
      minutesLeft: 25,
      key: 'rossko-cutoff:2026-10-15:11:00',
    });
    // A late run still reminds, with the minutes really left; the cutoff itself is too late.
    expect(remind('2026-10-15T10:59')?.minutesLeft).toBe(1);
    expect(remind('2026-10-15T11:00')).toBeNull();
    expect(remind('2026-10-15T15:35')?.cutoff).toBe('16:00');
    expect(remind('2026-10-15T15:50')?.key).toBe(cutoffReminderKey('2026-10-15', '16:00'));
  });

  it('nothing without cutoff times or on a day off; every day without the hours', () => {
    expect(remind('2026-10-15T10:35', [])).toBeNull();
    expect(remind('2026-10-10T10:35')).toBeNull(); // Saturday, Mon–Fri
    expect(remind('2026-10-10T10:35', ['11:00'], MON_SAT)?.cutoff).toBe('11:00');
    expect(remind('2026-10-11T10:35', ['11:00'], null)?.cutoff).toBe('11:00');
  });

  it('the text with Russian plurals', () => {
    expect(cutoffReminderText({ minutesLeft: 25, cutoff: '11:00', notOrdered: 5 })).toBe(
      'Через 25 минут отсечка Rossko (11:00): не заказано 5 заказов.',
    );
    expect(cutoffReminderText({ minutesLeft: 21, cutoff: '11:00', notOrdered: 1 })).toBe(
      'Через 21 минуту отсечка Rossko (11:00): не заказан 1 заказ.',
    );
    expect(cutoffReminderText({ minutesLeft: 22, cutoff: '16:00', notOrdered: 3 })).toBe(
      'Через 22 минуты отсечка Rossko (16:00): не заказано 3 заказа.',
    );
    expect(cutoffReminderText({ minutesLeft: 25, cutoff: '11:00', notOrdered: 11 })).toContain(
      'не заказано 11 заказов',
    );
  });
});

describe('the shadow auto-order', () => {
  const okItem = (id: string, overrides: Partial<RecheckItemResult> = {}): RecheckItemResult => ({
    orderItemId: id,
    offerKey: `${id}:BRAND:ORB1`,
    status: 'ok',
    qty: 1,
    oldPriceSupplierKop: 50_000,
    freshPriceSupplierKop: 50_000,
    driftBp: 0,
    available: 5,
    alternatives: [],
    ...overrides,
  });
  const line = (id: string, overrides: Partial<AutoOrderLine> = {}): AutoOrderLine => ({
    orderItemId: id,
    qty: 1,
    priceClientKop: 64_000,
    fromVinSelection: false,
    fitCheck: null,
    ...overrides,
  });
  const input = (overrides: Partial<AutoOrderInput> = {}): AutoOrderInput => ({
    lines: [line('a'), line('b')],
    recheck: { items: [okItem('a'), okItem('b')] },
    totalKop: 128_000,
    maxTotalKop: 1_500_000,
    noShowCount: 0,
    driftToleranceBp: 300,
    marginFloorBp: 1_000,
    ...overrides,
  });

  it('«ДА» when every condition holds', () => {
    const result = shouldAutoOrder(input());
    expect(result).toEqual({ decision: 'yes', reasons: [], marginBp: 2187 });
    expect(autoOrderLine(result)).toBe('Автозаказ бы: ДА');
  });

  it('each reason on its own', () => {
    const reasons = (overrides: Partial<AutoOrderInput>) =>
      shouldAutoOrder(input(overrides)).reasons;
    expect(reasons({ recheck: { items: [okItem('a')] } })).toEqual(['not_rechecked']);
    expect(reasons({ lines: [] })).toEqual(['not_rechecked']);
    expect(
      reasons({
        recheck: { items: [okItem('a'), okItem('b', { status: 'insufficient', available: 0 })] },
      }),
    ).toEqual(['unavailable']);
    expect(
      reasons({
        recheck: {
          items: [
            okItem('a'),
            okItem('b', { status: 'unavailable', freshPriceSupplierKop: null, driftBp: null }),
          ],
        },
      }),
    ).toEqual(['unavailable']);
    // Within the tolerance is fine, above it is not.
    expect(
      reasons({
        recheck: {
          items: [okItem('a'), okItem('b', { driftBp: 300, freshPriceSupplierKop: 51_500 })],
        },
      }),
    ).toEqual([]);
    expect(
      reasons({
        recheck: {
          items: [okItem('a'), okItem('b', { driftBp: 301, freshPriceSupplierKop: 51_505 })],
        },
      }),
    ).toEqual(['price_drift']);
    expect(reasons({ lines: [line('a', { fromVinSelection: true }), line('b')] })).toEqual([
      'vin_selection',
    ]);
    expect(
      reasons({ lines: [line('a', { fromVinSelection: true, fitCheck: 'confirmed' }), line('b')] }),
    ).toEqual([]);
    expect(reasons({ lines: [line('a', { fitCheck: 'unconfirmed' }), line('b')] })).toEqual([
      'fit_unconfirmed',
    ]);
    // The master's analog the client took is confirmed.
    expect(reasons({ lines: [line('a', { fitCheck: 'confirmed' }), line('b')] })).toEqual([]);
    expect(reasons({ totalKop: 1_500_000 })).toEqual([]);
    expect(reasons({ totalKop: 1_500_001 })).toEqual(['total_over_limit']);
    expect(reasons({ noShowCount: 1 })).toEqual(['no_show']);
    expect(reasons({ marginFloorBp: 2_188 })).toEqual(['margin_floor']);
    expect(reasons({ marginFloorBp: 2_187 })).toEqual([]);
  });

  it('several reasons in the order of the card line, with the limit named', () => {
    const result = shouldAutoOrder(
      input({
        lines: [line('a', { fitCheck: 'unconfirmed', fromVinSelection: true }), line('b')],
        totalKop: 2_000_000,
        noShowCount: 2,
      }),
    );
    expect(result.decision).toBe('no');
    expect(result.reasons).toEqual(['fit_unconfirmed', 'total_over_limit', 'no_show']);
    // formatRub puts no-break spaces into «15 000 ₽».
    expect(autoOrderLine(result, { maxTotalKop: 1_500_000 }).replace(/\s/gu, ' ')).toBe(
      'Автозаказ бы: НЕТ — мастер не подтвердил деталь после проверки подбора, сумма больше 15 000 ₽, клиент уже не приходил за заказом',
    );
    expect(autoOrderReasonText('total_over_limit')).toBe('сумма больше порога автозаказа');
    expect(AUTO_ORDER_REASONS).toHaveLength(8);
  });

  it('the stored payload is read back strictly', () => {
    expect(
      parseAutoOrderShadow({
        decision: 'no',
        reasons: ['no_show'],
        masterOrdered: true,
        maxTotalKop: 1_500_000,
      }),
    ).toEqual({
      decision: 'no',
      reasons: ['no_show'],
      masterOrdered: true,
      maxTotalKop: 1_500_000,
    });
    expect(parseAutoOrderShadow({ decision: 'yes', reasons: [] })).toEqual({
      decision: 'yes',
      reasons: [],
      masterOrdered: false,
      maxTotalKop: null,
    });
    expect(parseAutoOrderShadow({ decision: 'maybe', reasons: [] })).toBeNull();
    expect(parseAutoOrderShadow({ decision: 'no', reasons: ['because'] })).toBeNull();
    expect(parseAutoOrderShadow(null)).toBeNull();
  });
});

describe('the shadow statistics and the verdict', () => {
  const rows = (agree: number, total: number): AutoOrderShadowRow[] =>
    Array.from({ length: total }, (_, i) =>
      i < agree
        ? { decision: 'yes', reasons: [], masterOrdered: true }
        : { decision: 'no', reasons: ['total_over_limit'], masterOrdered: true },
    );

  it('agreement: «ДА» and ordered, «НЕТ» and not ordered; the reasons are counted', () => {
    const stats = autoOrderStats([
      { decision: 'yes', reasons: [], masterOrdered: true },
      { decision: 'yes', reasons: [], masterOrdered: false },
      { decision: 'no', reasons: ['price_drift', 'no_show'], masterOrdered: false },
      { decision: 'no', reasons: ['no_show'], masterOrdered: true },
    ]);
    expect(stats).toMatchObject({
      decisions: 4,
      yes: 2,
      no: 2,
      agreements: 2,
      yesNotOrdered: 1,
      noButOrdered: 1,
    });
    expect(stats.reasons.no_show).toBe(2);
    expect(stats.reasons.price_drift).toBe(1);
    expect(stats.reasons.margin_floor).toBe(0);
  });

  it('«можно обсуждать» only from 30 decisions and 95 %, else «мало данных» / «рано»', () => {
    expect(AUTO_ORDER_VERDICT_MIN_DECISIONS).toBe(30);
    expect(AUTO_ORDER_VERDICT_MIN_AGREEMENT_PCT).toBe(95);
    expect(autoOrderVerdict(autoOrderStats([]))).toEqual({
      kind: 'few',
      text: 'Мало данных: совпадений 0 из 0, нужно хотя бы 30 решений.',
    });
    expect(autoOrderVerdict(autoOrderStats(rows(29, 29))).kind).toBe('few');
    expect(autoOrderVerdict(autoOrderStats(rows(29, 30)))).toEqual({
      kind: 'discuss',
      text: 'Совпадений 29 из 30 — можно обсуждать автозаказ.',
    });
    expect(autoOrderVerdict(autoOrderStats(rows(28, 30)))).toEqual({
      kind: 'early',
      text: 'Рано: совпадений 28 из 30, нужно не меньше 95%.',
    });
    // Exactly 95 % is enough; one less is not.
    expect(autoOrderVerdict({ decisions: 40, agreements: 38 }).kind).toBe('discuss');
    expect(autoOrderVerdict({ decisions: 40, agreements: 37 }).kind).toBe('early');
  });

  it('«Заказать всё равно» after the decision and before the next one counts as ordered', () => {
    const shadow = {
      orderId: 'o1',
      at: local('2026-10-12T11:00'),
      masterOrdered: false,
      nextAt: local('2026-10-12T15:00'),
    };
    expect(shadowMasterOrdered(shadow, [])).toBe(false);
    expect(shadowMasterOrdered(shadow, [{ orderId: 'o1', at: local('2026-10-12T12:00') }])).toBe(
      true,
    );
    expect(shadowMasterOrdered(shadow, [{ orderId: 'o1', at: local('2026-10-12T16:00') }])).toBe(
      false,
    );
    expect(shadowMasterOrdered(shadow, [{ orderId: 'o2', at: local('2026-10-12T12:00') }])).toBe(
      false,
    );
    expect(shadowMasterOrdered({ ...shadow, masterOrdered: true }, [])).toBe(true);
    expect(
      shadowMasterOrdered({ ...shadow, nextAt: null }, [
        { orderId: 'o1', at: local('2026-10-20T12:00') },
      ]),
    ).toBe(true);
  });
});

describe('the texts of the polling', () => {
  it('names are one line of at most 200 characters', () => {
    expect(cleanRosskoStatusName('  Готов\n к выдаче ')).toBe('Готов к выдаче');
    expect(cleanRosskoStatusName('')).toBeNull();
    expect(cleanRosskoStatusName(null)).toBeNull();
    expect(cleanRosskoStatusName('x'.repeat(300))).toHaveLength(200);
  });

  it('shipped, unmapped and refused texts name the order, the Rossko number and the code', () => {
    expect(
      supplierShippedNote({
        orderNumber: 'DT-000123',
        rosskoOrderId: '70000010',
        statusName: 'Отгружен',
      }),
    ).toBe(
      'Rossko отгрузил заказ DT-000123 на точку — проверьте приёмку (Rossko № 70000010: «Отгружен»).',
    );
    expect(
      unmappedStatusText({
        code: 5,
        name: 'В пути',
        orderNumber: 'DT-000123',
        rosskoOrderId: '70000010',
        adminUrl: 'https://detaly.test/admin/rossko',
      }),
    ).toBe(
      'Rossko: статус «В пути» (код 5) — что это значит? Настройте в /admin/rossko.\n' +
        'Заказ DT-000123, Rossko № 70000010. https://detaly.test/admin/rossko',
    );
    expect(
      unmappedStatusText({
        code: 5,
        name: null,
        orderNumber: 'DT-000123',
        rosskoOrderId: '7',
        adminUrl: 'https://detaly.test/admin/rossko',
      }),
    ).toContain('статус без названия (код 5)');
    expect(
      supplierRefusedText({
        code: 9,
        name: 'Отказ',
        orderNumber: 'DT-000123',
        rosskoOrderId: '70000010',
        parts: 'Knecht OC 90',
        statusLabel: 'требует внимания',
        adminUrl: 'https://detaly.test/admin/orders/1',
      }),
    ).toBe(
      'Rossko: отказ поставщика по заказу DT-000123 (Rossko № 70000010, статус «Отказ» (код 9)): ' +
        'Knecht OC 90. Заказ сейчас «требует внимания» — проверьте позиции. https://detaly.test/admin/orders/1',
    );
  });
});
