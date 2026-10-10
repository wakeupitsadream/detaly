/**
 * Step 7 (docs/month-close.md, roadmap r10 «Деньги под контролем»): the pure part of the month
 * close. Month boundaries in Asia/Yekaterinburg, the contract rates of the pickup point
 * (settings `contract.rates`), the act lines from the counted operations, the margin estimate per
 * order item and price group, the diff of two payment or refund lists (the database against the
 * provider), storage days, the finance settings (acquiring estimate, reminder days) and the texts
 * of the owner's messages.
 *
 * Money is integer kopecks and every amount comes from stored rows (receipts, refunds, order
 * items at the prices of the order, supplier returns); nothing is recomputed from today's prices.
 * There is no tax arithmetic here: the page lists facts and a checklist, the tax is the bank's.
 * The act is a services act between two sole proprietors paid per operation: its texts never use
 * the words of a profit split (a test checks the act).
 */
import {
  addDays,
  CLIENT_TIME_ZONE,
  DateError,
  diffDays,
  formatDayMonth,
  isIsoDate,
  localDate,
} from './dates';
import { floorDiv, formatRub, MoneyError, safeMul } from './money';
import { formatBpPercent, roundDiv } from './pricing';
import { PRICE_GROUPS, type PriceGroup } from './statuses';
import type {
  BasisPoints,
  ContractRatesSetting,
  FinanceReminderDaysSetting,
  IsoDate,
  Kop,
} from './types';

// ---------------------------------------------------------------------------------------------
// Months
// ---------------------------------------------------------------------------------------------

/** A calendar month 'YYYY-MM' (the `m` of /admin/month?m=2026-09). */
export type MonthKey = string;

const MONTH_KEY_RE = /^(\d{4})-(0[1-9]|1[0-2])$/;

/** 'YYYY-MM' of the years 2000–2099 (an admin URL parameter, so no far-off months). */
export function isMonthKey(value: unknown): value is MonthKey {
  if (typeof value !== 'string') return false;
  const match = MONTH_KEY_RE.exec(value);
  if (match === null) return false;
  const year = Number(match[1]);
  return year >= 2000 && year <= 2099;
}

function monthParts(month: MonthKey): [number, number] {
  if (!isMonthKey(month)) throw new DateError(`invalid month '${String(month)}'`);
  return [Number(month.slice(0, 4)), Number(month.slice(5, 7))];
}

/** The month of an instant in `timeZone` (default Asia/Yekaterinburg). */
export function monthKeyOf(instant: Date, timeZone: string = CLIENT_TIME_ZONE): MonthKey {
  return localDate(instant, timeZone).slice(0, 7);
}

/** '2026-12' + 1 -> '2027-01'; n may be negative. */
export function addMonths(month: MonthKey, n: number): MonthKey {
  if (!Number.isSafeInteger(n)) throw new DateError('months must be an integer');
  const [year, mon] = monthParts(month);
  const index = year * 12 + (mon - 1) + n;
  const y = Math.floor(index / 12);
  const m = index - y * 12 + 1;
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}`;
}

/** The month before the one `now` falls in (the month the 1st of the month closes). */
export function previousMonth(now: Date, timeZone: string = CLIENT_TIME_ZONE): MonthKey {
  return addMonths(monthKeyOf(now, timeZone), -1);
}

export function monthFirstDay(month: MonthKey): IsoDate {
  monthParts(month);
  return `${month}-01`;
}

export function monthLastDay(month: MonthKey): IsoDate {
  return addDays(monthFirstDay(addMonths(month, 1)), -1);
}

const wallClocks = new Map<string, Intl.DateTimeFormat>();

function wallClock(timeZone: string): Intl.DateTimeFormat {
  let formatter = wallClocks.get(timeZone);
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    wallClocks.set(timeZone, formatter);
  }
  return formatter;
}

/** Offset of `timeZone` from UTC at `instant`, in ms (Asia/Yekaterinburg: +5 h). */
export function zoneOffsetMs(instant: Date, timeZone: string = CLIENT_TIME_ZONE): number {
  if (!(instant instanceof Date) || Number.isNaN(instant.getTime())) {
    throw new DateError('invalid instant');
  }
  const parts = wallClock(timeZone).formatToParts(instant);
  const get = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(parts.find((part) => part.type === type)?.value ?? Number.NaN);
  const wall = Date.UTC(
    get('year'),
    get('month') - 1,
    get('day'),
    get('hour') % 24,
    get('minute'),
    get('second'),
  );
  return wall - (instant.getTime() - instant.getUTCMilliseconds());
}

/** The instant a calendar day starts in `timeZone`: '2026-10-01' -> 2026-09-30T19:00:00Z. */
export function zonedDayStart(date: IsoDate, timeZone: string = CLIENT_TIME_ZONE): Date {
  if (!isIsoDate(date)) throw new DateError(`invalid date '${String(date)}'`);
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const utc = Date.UTC(y, m - 1, d);
  // Two passes: the offset of the guess is the right one even next to a DST change.
  const guess = utc - zoneOffsetMs(new Date(utc), timeZone);
  return new Date(utc - zoneOffsetMs(new Date(guess), timeZone));
}

export interface MonthBounds {
  month: MonthKey;
  /** The first instant of the month (inclusive). */
  start: Date;
  /** The first instant of the next month (exclusive). */
  end: Date;
  firstDay: IsoDate;
  lastDay: IsoDate;
}

/** [start, end) of a month in `timeZone`: every query of the month close uses these. */
export function monthBounds(month: MonthKey, timeZone: string = CLIENT_TIME_ZONE): MonthBounds {
  return {
    month,
    start: zonedDayStart(monthFirstDay(month), timeZone),
    end: zonedDayStart(monthFirstDay(addMonths(month, 1)), timeZone),
    firstDay: monthFirstDay(month),
    lastDay: monthLastDay(month),
  };
}

/** start <= instant < end. */
export function inMonth(instant: Date, bounds: Pick<MonthBounds, 'start' | 'end'>): boolean {
  const t = instant.getTime();
  return t >= bounds.start.getTime() && t < bounds.end.getTime();
}

const MONTHS_NOMINATIVE = [
  'январь',
  'февраль',
  'март',
  'апрель',
  'май',
  'июнь',
  'июль',
  'август',
  'сентябрь',
  'октябрь',
  'ноябрь',
  'декабрь',
] as const;

const MONTHS_GENITIVE = [
  'января',
  'февраля',
  'марта',
  'апреля',
  'мая',
  'июня',
  'июля',
  'августа',
  'сентября',
  'октября',
  'ноября',
  'декабря',
] as const;

/** '2026-09' -> 'сентябрь 2026' («за сентябрь 2026»). */
export function monthTitle(month: MonthKey): string {
  const [year, mon] = monthParts(month);
  return `${MONTHS_NOMINATIVE[mon - 1] as string} ${year}`;
}

/** '2026-09' -> 'сентября 2026' («Закрытие сентября 2026»). */
export function monthGenitive(month: MonthKey): string {
  const [year, mon] = monthParts(month);
  return `${MONTHS_GENITIVE[mon - 1] as string} ${year}`;
}

/** '2026-09-30' -> '30 сентября 2026 г.' (the date of the act). */
export function formatLongDate(date: IsoDate): string {
  return `${formatDayMonth(date)} ${date.slice(0, 4)} г.`;
}

// ---------------------------------------------------------------------------------------------
// The act of the pickup point: operations, rates, lines
// ---------------------------------------------------------------------------------------------

/**
 * Operations of the services contract with the pickup point (PLAN section 7 item 11): the act
 * counts them per month from the journal (packages/orders/src/finance.ts says where each comes
 * from). The order is the order of the act's table.
 */
export const ACT_OPERATIONS = [
  'receive',
  'store_day',
  'handover',
  'return_accept',
  'vin_selection',
  'fit_check',
  'claim_diagnostics',
] as const;
export type ActOperation = (typeof ACT_OPERATIONS)[number];

/** The names of the services in the act and their units. */
export const ACT_OPERATION_TITLES: Readonly<Record<ActOperation, { title: string; unit: string }>> =
  {
    receive: { title: 'Приёмка детали от поставщика', unit: 'шт.' },
    store_day: { title: 'Хранение заказа', unit: 'сут.' },
    handover: { title: 'Выдача заказа покупателю', unit: 'шт.' },
    return_accept: { title: 'Приём возврата от покупателя', unit: 'шт.' },
    vin_selection: { title: 'Подбор запчастей по VIN', unit: 'шт.' },
    fit_check: { title: 'Проверка применимости детали', unit: 'шт.' },
    claim_diagnostics: { title: 'Диагностика детали по претензии', unit: 'шт.' },
  };

/** The settings key of the contract rates (SettingsValues). */
export const CONTRACT_RATES_KEY = 'contract.rates';
/** A rate per operation is at most 100 000 ₽ (a typo guard, not a business rule). */
export const CONTRACT_RATE_MAX_KOP = 10_000_000;
/** The turnover rate is 0–100 %. */
export const CONTRACT_TURNOVER_MAX_BP = 10_000;

/** Operations whose rate the contract always has; storage may be left out of it. */
export type RequiredRateOperation = Exclude<ActOperation, 'store_day'>;

/**
 * settings `contract.rates`: a price per operation in kopecks and a rate in bp on the value of
 * the orders handed in the month («стоимость обработанных заказов», PLAN section 7 item 11).
 * `store_day` absent: storage is not a service of the contract (no line in the act).
 */
export type ContractRates = ContractRatesSetting;

/** Rates are not decided yet: every rate 0 (the act page says «Ставки не заданы»). */
export const DEFAULT_CONTRACT_RATES: ContractRates = {
  perOperationKop: {
    receive: 0,
    store_day: 0,
    handover: 0,
    return_accept: 0,
    vin_selection: 0,
    fit_check: 0,
    claim_diagnostics: 0,
  },
  turnoverBp: 0,
};

const isRateKop = (value: unknown): value is Kop =>
  typeof value === 'number' &&
  Number.isSafeInteger(value) &&
  value >= 0 &&
  value <= CONTRACT_RATE_MAX_KOP;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** The stored value in its normal form (fixed key order), or null when it is malformed. */
export function parseContractRates(raw: unknown): ContractRates | null {
  if (!isRecord(raw) || !isRecord(raw.perOperationKop)) return null;
  const source = raw.perOperationKop;
  const known = new Set<string>(ACT_OPERATIONS);
  if (Object.keys(source).some((key) => !known.has(key))) return null;
  const perOperationKop: Partial<Record<ActOperation, Kop>> = {};
  for (const operation of ACT_OPERATIONS) {
    const value = source[operation];
    if (value === undefined && operation === 'store_day') continue;
    if (!isRateKop(value)) return null;
    perOperationKop[operation] = value;
  }
  const turnoverBp = raw.turnoverBp;
  if (
    typeof turnoverBp !== 'number' ||
    !Number.isSafeInteger(turnoverBp) ||
    turnoverBp < 0 ||
    turnoverBp > CONTRACT_TURNOVER_MAX_BP
  ) {
    return null;
  }
  return {
    perOperationKop: perOperationKop as ContractRates['perOperationKop'],
    turnoverBp,
  };
}

/** True once any rate is above zero. */
export function contractRatesSet(rates: ContractRates): boolean {
  return (
    rates.turnoverBp > 0 || Object.values(rates.perOperationKop).some((value) => (value ?? 0) > 0)
  );
}

export function sameContractRates(a: ContractRates, b: ContractRates): boolean {
  return JSON.stringify(parseContractRates(a)) === JSON.stringify(parseContractRates(b));
}

/** The rate of an operation, null when the contract does not have it (storage left out). */
export function rateOf(rates: ContractRates, operation: ActOperation): Kop | null {
  const value = rates.perOperationKop[operation];
  return value === undefined ? null : value;
}

/** One counted operation (a CSV row of the act). `ref` names it when there is no order. */
export interface ActFact {
  operation: ActOperation;
  /** When it happened; storage days carry the start of the local day. */
  at: Date;
  orderNumber: string | null;
  /** «VIN 0192a3b4», «проверка 0192a3b4» for the operations without an order. */
  ref: string | null;
}

export type ActCounts = Record<ActOperation, number>;

export function emptyActCounts(): ActCounts {
  return Object.fromEntries(ACT_OPERATIONS.map((operation) => [operation, 0])) as ActCounts;
}

export function countActFacts(facts: readonly ActFact[]): ActCounts {
  const counts = emptyActCounts();
  for (const fact of facts) counts[fact.operation] += 1;
  return counts;
}

export interface ActLine {
  key: ActOperation | 'turnover';
  title: string;
  unit: string;
  quantity: number;
  /** Price of one unit. */
  rateKop: Kop;
  sumKop: Kop;
}

export interface ActSummary {
  /** Every operation of the contract (zero quantities too), then the turnover line. */
  lines: ActLine[];
  totalKop: Kop;
  /** False while every rate is zero: «Ставки не заданы». */
  ratesSet: boolean;
  /** Value of the orders handed in the month: the base of the turnover rate. */
  turnoverBaseKop: Kop;
  turnoverBp: BasisPoints;
}

/** n × bp / 10 000 rounded half up (a fee in kopecks). */
export function percentOfKop(baseKop: Kop, bp: BasisPoints): Kop {
  if (!Number.isSafeInteger(baseKop) || baseKop < 0) {
    throw new MoneyError('base must be a non-negative integer number of kopecks');
  }
  if (!Number.isSafeInteger(bp) || bp < 0)
    throw new MoneyError('bp must be a non-negative integer');
  return roundDiv(safeMul(baseKop, bp), 10_000);
}

/**
 * The act: one line per operation of the contract (count × rate), and the turnover line when the
 * contract has a turnover rate. The words of the lines are fixed above: services and their
 * quantities only.
 */
export function buildAct(
  counts: ActCounts,
  rates: ContractRates,
  turnoverBaseKop: Kop,
): ActSummary {
  const lines: ActLine[] = [];
  for (const operation of ACT_OPERATIONS) {
    const rate = rateOf(rates, operation);
    if (rate === null) continue;
    const quantity = counts[operation];
    if (!Number.isSafeInteger(quantity) || quantity < 0) {
      throw new MoneyError(`count of ${operation} must be a non-negative integer`);
    }
    const { title, unit } = ACT_OPERATION_TITLES[operation];
    lines.push({
      key: operation,
      title,
      unit,
      quantity,
      rateKop: rate,
      sumKop: safeMul(quantity, rate),
    });
  }
  if (rates.turnoverBp > 0) {
    const fee = percentOfKop(turnoverBaseKop, rates.turnoverBp);
    lines.push({
      key: 'turnover',
      title: `Обработка заказов: ${formatBpPercent(rates.turnoverBp)} от стоимости выданных заказов (${formatRub(turnoverBaseKop)})`,
      unit: 'усл.',
      quantity: 1,
      rateKop: fee,
      sumKop: fee,
    });
  }
  const totalKop = lines.reduce((sum, line) => sum + line.sumKop, 0);
  if (!Number.isSafeInteger(totalKop)) throw new MoneyError('act total overflow');
  return {
    lines,
    totalKop,
    ratesSet: contractRatesSet(rates),
    turnoverBaseKop,
    turnoverBp: rates.turnoverBp,
  };
}

/** Act number of a month: «09/2026». */
export function actNumber(month: MonthKey): string {
  const [year, mon] = monthParts(month);
  return `${String(mon).padStart(2, '0')}/${year}`;
}

/** 123456 -> '1234,56' (a CSV cell for Excel with the Russian locale). */
export function csvAmount(kop: number): string {
  if (!Number.isSafeInteger(kop)) throw new MoneyError('amount must be a safe integer');
  const abs = Math.abs(kop);
  return `${kop < 0 ? '-' : ''}${Math.floor(abs / 100)},${String(abs % 100).padStart(2, '0')}`;
}

function csvCell(value: string): string {
  return /[";\n\r]/u.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

const CSV_DATE_TIME = new Intl.DateTimeFormat('ru-RU', {
  timeZone: CLIENT_TIME_ZONE,
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

/**
 * Operations the act lists: the counted facts of the services in the contract (storage left out
 * of it is not an operation of the act). The figure of «операций для акта».
 */
export function actOperationCount(counts: ActCounts, rates: ContractRates): number {
  return ACT_OPERATIONS.reduce(
    (sum, operation) => sum + (rateOf(rates, operation) === null ? 0 : counts[operation]),
    0,
  );
}

/**
 * The CSV of the act («Скачать CSV»): every counted operation of the contract's services with
 * its date, the order number (or the request it belongs to), the service and its rate;
 * `;`-separated, CRLF lines, the Excel-friendly decimal comma. Storage rows carry the day only.
 */
export function actCsv(facts: readonly ActFact[], rates: ContractRates): string {
  const rows = [['Дата', 'Заказ', 'Операция', 'Ставка, ₽']];
  const sorted = facts
    .filter((fact) => rateOf(rates, fact.operation) !== null)
    .sort(
      (a, b) =>
        a.at.getTime() - b.at.getTime() ||
        ACT_OPERATIONS.indexOf(a.operation) - ACT_OPERATIONS.indexOf(b.operation) ||
        (a.orderNumber ?? a.ref ?? '').localeCompare(b.orderNumber ?? b.ref ?? ''),
    );
  for (const fact of sorted) {
    const when =
      fact.operation === 'store_day'
        ? CSV_DATE_TIME.format(fact.at).slice(0, 10)
        : CSV_DATE_TIME.format(fact.at).replace(',', '');
    rows.push([
      when,
      fact.orderNumber ?? fact.ref ?? '',
      ACT_OPERATION_TITLES[fact.operation].title,
      csvAmount(rateOf(rates, fact.operation) ?? 0),
    ]);
  }
  return `${rows.map((row) => row.map(csvCell).join(';')).join('\r\n')}\r\n`;
}

// ---------------------------------------------------------------------------------------------
// Storage days
// ---------------------------------------------------------------------------------------------

/**
 * The calendar days of [from, to) inside the month: the nights an order spent at the point
 * (arrived on the 28th, handed on the 3rd: the 28th–30th count in September, the 1st and the 2nd
 * in October). `to` null: still at the point (counted to the end of the month).
 */
export function storageDays(from: IsoDate, to: IsoDate | null, month: MonthKey): IsoDate[] {
  const first = monthFirstDay(month);
  const afterLast = monthFirstDay(addMonths(month, 1));
  const start = from > first ? from : first;
  const end = to === null || to > afterLast ? afterLast : to;
  const days: IsoDate[] = [];
  for (let day = start; day < end; day = addDays(day, 1)) days.push(day);
  return days;
}

export function storageDaysInMonth(from: IsoDate, to: IsoDate | null, month: MonthKey): number {
  const first = monthFirstDay(month);
  const afterLast = monthFirstDay(addMonths(month, 1));
  const start = from > first ? from : first;
  const end = to === null || to > afterLast ? afterLast : to;
  return start < end ? diffDays(start, end) : 0;
}

// ---------------------------------------------------------------------------------------------
// Margin estimate
// ---------------------------------------------------------------------------------------------

/** The settings key of the acquiring estimate (SettingsValues). */
export const FINANCE_ACQUIRING_KEY = 'finance.acquiring_bp';
/**
 * 2.8 % — an estimate of the card acquiring fee (PLAN section 10, «непроверено»): replace it with
 * the real tariff of the shop's contract in settings.
 */
export const DEFAULT_ACQUIRING_BP = 280;
/** The estimate is 0–20 %. */
export const ACQUIRING_MAX_BP = 2_000;

export function parseAcquiringBp(raw: unknown): BasisPoints | null {
  return typeof raw === 'number' && Number.isSafeInteger(raw) && raw >= 0 && raw <= ACQUIRING_MAX_BP
    ? raw
    : null;
}

/** The acquiring estimate of a revenue, rounded half up. */
export function acquiringEstimateKop(revenueKop: Kop, acquiringBp: BasisPoints): Kop {
  return percentOfKop(revenueKop, acquiringBp);
}

/**
 * `total` split by `weights` exactly (the largest remainder; ties to the earlier weight). All
 * weights zero: evenly. The delivery cost of a supplier order goes to its items by purchase value.
 */
export function splitProportionally(totalKop: Kop, weights: readonly number[]): Kop[] {
  if (!Number.isSafeInteger(totalKop) || totalKop < 0) {
    throw new MoneyError('total must be a non-negative integer number of kopecks');
  }
  if (weights.length === 0) return [];
  if (weights.some((w) => !Number.isSafeInteger(w) || w < 0)) {
    throw new MoneyError('weights must be non-negative integers');
  }
  const sum = weights.reduce((acc, w) => acc + w, 0);
  const effective = sum === 0 ? weights.map(() => 1) : weights;
  const total = sum === 0 ? weights.length : sum;
  const shares = effective.map((w) => floorDiv(safeMul(totalKop, w), total));
  const remainders = effective.map((w, index) => ({
    index,
    rest: safeMul(totalKop, w) - safeMul(shares[index] as number, total),
  }));
  let left = totalKop - shares.reduce((acc, s) => acc + s, 0);
  remainders.sort((a, b) => b.rest - a.rest || a.index - b.index);
  for (const { index } of remainders) {
    if (left <= 0) break;
    shares[index] = (shares[index] as number) + 1;
    left -= 1;
  }
  return shares;
}

/** One handed order item: the prices of the order (never today's), the delivery share. */
export interface MarginLine {
  orderId: string;
  orderNumber: string;
  group: PriceGroup;
  /** price_client × qty */
  revenueKop: Kop;
  /** price_supplier_at_order × qty */
  purchaseKop: Kop;
  /** Its share of the supplier order's delivery_cost (0 when unknown). */
  deliveryKop: Kop;
}

export interface MarginTotals {
  items: number;
  revenueKop: Kop;
  purchaseKop: Kop;
  acquiringKop: Kop;
  deliveryKop: Kop;
  /** revenue − purchase − acquiring − delivery; negative when sold below cost. */
  marginKop: number;
  /** marginKop / revenueKop in bp (rounded down); null without revenue. */
  marginBp: number | null;
}

export interface MarginReport {
  acquiringBp: BasisPoints;
  totals: MarginTotals;
  /** PRICE_GROUPS order, groups with items only. */
  groups: (MarginTotals & { group: PriceGroup })[];
  /** Orders with a negative margin, the worst first. */
  negativeOrders: (MarginTotals & { orderId: string; orderNumber: string })[];
}

function emptyTotals(): MarginTotals {
  return {
    items: 0,
    revenueKop: 0,
    purchaseKop: 0,
    acquiringKop: 0,
    deliveryKop: 0,
    marginKop: 0,
    marginBp: null,
  };
}

function addLine(totals: MarginTotals, line: MarginLine, acquiringKop: Kop): void {
  totals.items += 1;
  totals.revenueKop += line.revenueKop;
  totals.purchaseKop += line.purchaseKop;
  totals.acquiringKop += acquiringKop;
  totals.deliveryKop += line.deliveryKop;
  totals.marginKop += line.revenueKop - line.purchaseKop - acquiringKop - line.deliveryKop;
}

function finish<T extends MarginTotals>(totals: T): T {
  for (const value of [totals.revenueKop, totals.purchaseKop, totals.marginKop]) {
    if (!Number.isSafeInteger(value)) throw new MoneyError('margin overflow');
  }
  totals.marginBp =
    totals.revenueKop > 0 ? floorDiv(safeMul(totals.marginKop, 10_000), totals.revenueKop) : null;
  return totals;
}

/**
 * Margin of a month: per item price_client − price_supplier_at_order − the acquiring estimate
 * (settings finance.acquiring_bp on the item's revenue) − its delivery share; totals per price
 * group and the orders that ended below zero.
 */
export function marginReport(lines: readonly MarginLine[], acquiringBp: BasisPoints): MarginReport {
  const totals = emptyTotals();
  const groups = new Map<PriceGroup, MarginTotals & { group: PriceGroup }>();
  const orders = new Map<string, MarginTotals & { orderId: string; orderNumber: string }>();
  for (const line of lines) {
    const acquiring = acquiringEstimateKop(line.revenueKop, acquiringBp);
    addLine(totals, line, acquiring);
    let group = groups.get(line.group);
    if (group === undefined) {
      group = { ...emptyTotals(), group: line.group };
      groups.set(line.group, group);
    }
    addLine(group, line, acquiring);
    let order = orders.get(line.orderId);
    if (order === undefined) {
      order = { ...emptyTotals(), orderId: line.orderId, orderNumber: line.orderNumber };
      orders.set(line.orderId, order);
    }
    addLine(order, line, acquiring);
  }
  return {
    acquiringBp,
    totals: finish(totals),
    groups: PRICE_GROUPS.flatMap((group) => {
      const found = groups.get(group);
      return found ? [finish(found)] : [];
    }),
    negativeOrders: [...orders.values()]
      .map(finish)
      .filter((order) => order.marginKop < 0)
      .sort((a, b) => a.marginKop - b.marginKop || a.orderNumber.localeCompare(b.orderNumber)),
  };
}

/** Signed rubles: -123450 -> '−1 234,50 ₽'. */
export function formatRubSigned(kop: number): string {
  if (!Number.isSafeInteger(kop)) throw new MoneyError('amount must be a safe integer');
  return kop < 0 ? `\u2212${formatRub(-kop)}` : formatRub(kop);
}

/** A margin in bp as percent: 1234 -> '12,34%', null -> '—'. */
export function formatMarginBp(bp: number | null): string {
  return bp === null ? '—' : formatBpPercent(bp);
}

// ---------------------------------------------------------------------------------------------
// Reconciliation with the payment provider
// ---------------------------------------------------------------------------------------------

/** One payment or refund on one side: the provider id, the amount and the status. */
export interface ReconItem {
  id: string;
  amountKop: number;
  status: string;
  /** The order number on the database side (shown next to the difference). */
  label?: string | null;
}

export const RECON_DIFF_KINDS = [
  'missing_in_db',
  'missing_at_provider',
  'amount',
  'status',
] as const;
export type ReconDiffKind = (typeof RECON_DIFF_KINDS)[number];

export interface ReconDiff {
  kind: ReconDiffKind;
  id: string;
  label: string | null;
  dbAmountKop: number | null;
  providerAmountKop: number | null;
  dbStatus: string | null;
  providerStatus: string | null;
}

export interface ReconDiffResult {
  dbCount: number;
  providerCount: number;
  /** On both sides with the same amount and status. */
  matched: number;
  differences: ReconDiff[];
}

/**
 * The two lists compared by id: missing on either side, a different amount, a different status
 * (statuses compared as given: the caller maps the provider's vocabulary to ours first). A repeated
 * id counts once. Sorted by kind, then by label and id.
 */
export function diffByIds(
  db: readonly ReconItem[],
  provider: readonly ReconItem[],
): ReconDiffResult {
  const byId = (list: readonly ReconItem[]) => {
    const map = new Map<string, ReconItem>();
    for (const item of list) if (!map.has(item.id)) map.set(item.id, item);
    return map;
  };
  const ours = byId(db);
  const theirs = byId(provider);
  const differences: ReconDiff[] = [];
  let matched = 0;
  for (const item of ours.values()) {
    const other = theirs.get(item.id);
    const base = { id: item.id, label: item.label ?? null };
    if (other === undefined) {
      differences.push({
        ...base,
        kind: 'missing_at_provider',
        dbAmountKop: item.amountKop,
        providerAmountKop: null,
        dbStatus: item.status,
        providerStatus: null,
      });
      continue;
    }
    let same = true;
    if (other.amountKop !== item.amountKop) {
      same = false;
      differences.push({
        ...base,
        kind: 'amount',
        dbAmountKop: item.amountKop,
        providerAmountKop: other.amountKop,
        dbStatus: item.status,
        providerStatus: other.status,
      });
    }
    if (other.status !== item.status) {
      same = false;
      differences.push({
        ...base,
        kind: 'status',
        dbAmountKop: item.amountKop,
        providerAmountKop: other.amountKop,
        dbStatus: item.status,
        providerStatus: other.status,
      });
    }
    if (same) matched += 1;
  }
  for (const item of theirs.values()) {
    if (ours.has(item.id)) continue;
    differences.push({
      kind: 'missing_in_db',
      id: item.id,
      label: item.label ?? null,
      dbAmountKop: null,
      providerAmountKop: item.amountKop,
      dbStatus: null,
      providerStatus: item.status,
    });
  }
  differences.sort(
    (a, b) =>
      RECON_DIFF_KINDS.indexOf(a.kind) - RECON_DIFF_KINDS.indexOf(b.kind) ||
      (a.label ?? '').localeCompare(b.label ?? '') ||
      a.id.localeCompare(b.id),
  );
  return { dbCount: ours.size, providerCount: theirs.size, matched, differences };
}

// ---------------------------------------------------------------------------------------------
// Supplier returns and the owner's monthly messages
// ---------------------------------------------------------------------------------------------

/** Days after «Сдал водителю» without «Деньги вернулись» before the owner is alerted. */
export const SUPPLIER_REFUND_WAIT_DAYS = 10;
/** The sellers are reminded this many days before orders.supplier_return_deadline_at… */
export const SUPPLIER_RETURN_WARN_DAYS = [3, 1] as const;

/** The settings key of the reminder days of the month (SettingsValues). */
export const FINANCE_REMINDER_DAYS_KEY = 'finance.reminder_days';
export const FINANCE_REMINDER_KINDS = ['act', 'bank_check', 'tax'] as const;
export type FinanceReminderKind = (typeof FINANCE_REMINDER_KINDS)[number];
export type FinanceReminderDays = FinanceReminderDaysSetting;

/**
 * Days of the month for the owner's reminders: the act on the 3rd, the bank check on the 5th, the
 * tax on the 25th. Settings, not facts: the docs say to confirm the dates with the bank and the
 * tax office; only the payment of the tax by the 25th is confirmed (TAX_PAYMENT_DAY).
 */
export const DEFAULT_FINANCE_REMINDER_DAYS: FinanceReminderDays = {
  act: 3,
  bank_check: 5,
  tax: 25,
};
/** The tax is paid by the 25th of the next month (the one deadline the founder confirmed). */
export const TAX_PAYMENT_DAY = 25;
/** A reminder day is 1–28 (every month has it). */
export const FINANCE_REMINDER_DAY_MAX = 28;

export function parseFinanceReminderDays(raw: unknown): FinanceReminderDays | null {
  if (!isRecord(raw)) return null;
  const known = new Set<string>(FINANCE_REMINDER_KINDS);
  if (Object.keys(raw).some((key) => !known.has(key))) return null;
  const out: Partial<FinanceReminderDays> = {};
  for (const kind of FINANCE_REMINDER_KINDS) {
    const value = raw[kind];
    if (
      typeof value !== 'number' ||
      !Number.isSafeInteger(value) ||
      value < 1 ||
      value > FINANCE_REMINDER_DAY_MAX
    ) {
      return null;
    }
    out[kind] = value;
  }
  return out as FinanceReminderDays;
}

/** «Закрытие сентября 2026: …» to the owner on the 1st (the job and its test share it). */
export function monthCloseText(input: {
  month: MonthKey;
  revenueKop: number;
  marginKop: number;
  marginBp: number | null;
  operations: number;
  url: string;
}): string {
  const margin =
    input.marginBp === null
      ? formatRubSigned(input.marginKop)
      : `${formatRubSigned(input.marginKop)} (${formatMarginBp(input.marginBp)})`;
  return (
    `Закрытие ${monthGenitive(input.month)}: выручка по чекам ${formatRubSigned(input.revenueKop)}, ` +
    `маржа ${margin}, операций для акта ${input.operations}, расхождений с ЮKassa: проверить.\n` +
    `Отчёт: ${input.url}`
  );
}

/**
 * The same message for the sellers chat (the owner has no private chat with the bot): the act's
 * operations and the link, no money figures in a chat the pickup point reads.
 */
export function monthCloseFallbackText(input: {
  month: MonthKey;
  operations: number;
  url: string;
}): string {
  return (
    `Закрытие ${monthGenitive(input.month)}: операций для акта ${input.operations}. ` +
    `Отчёт месяца — в админке: ${input.url}`
  );
}

/** The owner's reminders of the month (neutral wording: facts and where to look). */
export function financeReminderText(
  kind: FinanceReminderKind,
  input: { month: MonthKey; baseUrl: string },
): string {
  const base = input.baseUrl.replace(/\/+$/u, '');
  const page = `${base}/admin/month?m=${input.month}`;
  switch (kind) {
    case 'act':
      return `Акт для пункта выдачи за ${monthTitle(input.month)}: проверьте операции и распечатайте — ${base}/admin/month/act?m=${input.month}`;
    case 'bank_check':
      return `Сверьте операции в интернет-банке за ${monthTitle(input.month)}. Список для сверки — ${page}`;
    case 'tax':
      return `Срок уплаты налога АУСН — до ${TAX_PAYMENT_DAY}-го (за ${monthTitle(input.month)}).`;
  }
}

/** Local day of the month (1–31) of an instant. */
export function dayOfMonth(instant: Date, timeZone: string = CLIENT_TIME_ZONE): number {
  return Number(localDate(instant, timeZone).slice(8, 10));
}
