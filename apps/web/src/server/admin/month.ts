/**
 * /admin/month, /admin/month/act and /admin/month/rates (step 7, docs/month-close.md, roadmap
 * r10 «Деньги под контролем»): the read models of the month close over @detaly/orders
 * (loadMonthReport, loadLatestReconciliation), the parties of the act from env, and the editor of
 * the contract rates (a GET draft with the preview of the act, then the audited save).
 *
 * Every figure comes from stored rows (integer kopecks); nothing here is a tax amount or advice.
 */
import type { Env } from '@detaly/config';
import type { Database } from '@detaly/db';
import {
  ACT_OPERATIONS,
  addMonths,
  buildAct,
  CONTRACT_RATE_MAX_KOP,
  CONTRACT_TURNOVER_MAX_BP,
  isIsoDate,
  isMonthKey,
  monthKeyOf,
  previousMonth,
  type ActOperation,
  type ActSummary,
  type ContractRates,
  type IsoDate,
  type MonthKey,
} from '@detaly/domain';
import {
  loadLatestReconciliation,
  loadMonthReport,
  type MonthReport,
  type ReconciliationSnapshot,
} from '@detaly/orders';
import { parseRubToKop } from './form-fields';

/** The first month the admin offers (before it there is nothing to close). */
export const FIRST_MONTH: MonthKey = '2024-01';

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/** `?m=YYYY-MM`: a month from FIRST_MONTH up to the current one; the previous month otherwise. */
export function parseMonthParam(raw: string | string[] | undefined, now: Date): MonthKey {
  const value = first(raw);
  if (isMonthKey(value) && value >= FIRST_MONTH && value <= monthKeyOf(now)) return value;
  return previousMonth(now);
}

/** A month posted by a form: the same range, null otherwise. */
export function postedMonth(value: string, now: Date): MonthKey | null {
  return isMonthKey(value) && value >= FIRST_MONTH && value <= monthKeyOf(now) ? value : null;
}

export function monthPath(path: string, month: MonthKey): string {
  return `${path}?m=${month}`;
}

// ---------------------------------------------------------------------------------------------
// The parties of the act (env only: no requisites in the source)
// ---------------------------------------------------------------------------------------------

export interface ActParty {
  /** «ИП Иванов Иван Иванович» / the contractor's name as configured; null when not set. */
  name: string | null;
  inn: string | null;
  /** ОГРНИП (15 digits) or ОГРН (13 digits). */
  ogrn: { label: 'ОГРНИП' | 'ОГРН'; value: string } | null;
  address: string | null;
}

export interface ActContract {
  number: string | null;
  date: IsoDate | null;
  /** The seller (SELLER_REQUISITES_*): the customer of the pickup point's services. */
  customer: ActParty;
  /** The pickup point (CONTRACTOR_REQUISITES_*): the contractor. */
  contractor: ActParty;
  /** Env variables of the act that are not set (named on the screen, never printed). */
  missing: string[];
}

function ogrnOf(value: string | undefined): ActParty['ogrn'] {
  if (!value) return null;
  return { label: value.length === 13 ? 'ОГРН' : 'ОГРНИП', value };
}

type ContractEnv = Pick<
  Env,
  | 'SELLER_REQUISITES_NAME'
  | 'SELLER_REQUISITES_INN'
  | 'SELLER_REQUISITES_OGRNIP'
  | 'SELLER_REQUISITES_ADDRESS'
  | 'CONTRACTOR_REQUISITES_NAME'
  | 'CONTRACTOR_REQUISITES_INN'
  | 'CONTRACTOR_REQUISITES_OGRNIP'
  | 'CONTRACTOR_REQUISITES_ADDRESS'
  | 'CONTRACT_NUMBER'
  | 'CONTRACT_DATE'
>;

export function actContractFromEnv(env: ContractEnv): ActContract {
  const required: [keyof ContractEnv, string | undefined][] = [
    ['SELLER_REQUISITES_NAME', env.SELLER_REQUISITES_NAME],
    ['SELLER_REQUISITES_INN', env.SELLER_REQUISITES_INN],
    ['CONTRACTOR_REQUISITES_NAME', env.CONTRACTOR_REQUISITES_NAME],
    ['CONTRACTOR_REQUISITES_INN', env.CONTRACTOR_REQUISITES_INN],
    ['CONTRACT_NUMBER', env.CONTRACT_NUMBER],
  ];
  return {
    number: env.CONTRACT_NUMBER ?? null,
    date: env.CONTRACT_DATE && isIsoDate(env.CONTRACT_DATE) ? env.CONTRACT_DATE : null,
    customer: {
      name: env.SELLER_REQUISITES_NAME ? `ИП ${env.SELLER_REQUISITES_NAME}` : null,
      inn: env.SELLER_REQUISITES_INN ?? null,
      ogrn: ogrnOf(env.SELLER_REQUISITES_OGRNIP),
      address: env.SELLER_REQUISITES_ADDRESS ?? null,
    },
    contractor: {
      name: env.CONTRACTOR_REQUISITES_NAME ?? null,
      inn: env.CONTRACTOR_REQUISITES_INN ?? null,
      ogrn: ogrnOf(env.CONTRACTOR_REQUISITES_OGRNIP),
      address: env.CONTRACTOR_REQUISITES_ADDRESS ?? null,
    },
    missing: required.filter(([, value]) => !value).map(([key]) => key),
  };
}

// ---------------------------------------------------------------------------------------------
// /admin/month
// ---------------------------------------------------------------------------------------------

export interface AdminMonthData {
  month: MonthKey;
  /** The previous and the next month of the switcher (null outside the range). */
  prev: MonthKey | null;
  next: MonthKey | null;
  /** The month is still running: its figures grow until it ends. */
  running: boolean;
  report: MonthReport;
  reconciliation: ReconciliationSnapshot | null;
  /** YooKassa is configured (YOOKASSA_*): «Сверить» can ask it. */
  paymentsConfigured: boolean;
}

export async function loadAdminMonth(
  db: Database,
  env: Env,
  month: MonthKey,
  now: Date,
  paymentsConfigured: boolean,
): Promise<AdminMonthData> {
  const current = monthKeyOf(now);
  const prev = addMonths(month, -1);
  const next = addMonths(month, 1);
  return {
    month,
    prev: prev >= FIRST_MONTH ? prev : null,
    next: next <= current ? next : null,
    running: month === current,
    report: await loadMonthReport(db, env, month, now),
    reconciliation: await loadLatestReconciliation(db, month),
    paymentsConfigured,
  };
}

// ---------------------------------------------------------------------------------------------
// The rates editor
// ---------------------------------------------------------------------------------------------

/** Draft fields of the GET form (rubles as typed) and the hidden fields of the save form. */
export function rateField(operation: ActOperation): string {
  return `rate_${operation}`;
}
export function kopField(operation: ActOperation): string {
  return `kop_${operation}`;
}
export const STORAGE_FIELD = 'storage';
export const TURNOVER_FIELD = 'turnover';
export const TURNOVER_BP_FIELD = 'turnover_bp';

/** 15000 -> '150', 15050 -> '150,50' (the value of a rate input). */
export function rubInputValue(kop: number): string {
  const rest = kop % 100;
  return rest === 0 ? String(kop / 100) : `${(kop - rest) / 100},${String(rest).padStart(2, '0')}`;
}

/** 150 bp -> '1,5' (the value of the turnover input, percent). */
export function percentInputValue(bp: number): string {
  const whole = Math.floor(bp / 100);
  const rest = bp % 100;
  if (rest === 0) return String(whole);
  return `${whole},${String(rest).padStart(2, '0').replace(/0$/u, '')}`;
}

/** '1,5' / '1.25' / '' -> bp; null for anything else. */
export function parsePercentToBp(raw: string): number | null {
  const text = raw.replace(/\s/gu, '').replace(',', '.');
  if (text === '') return 0;
  const match = /^(\d{1,3})(?:\.(\d{1,2}))?$/u.exec(text);
  if (!match?.[1]) return null;
  return Number(match[1]) * 100 + Number((match[2] ?? '').padEnd(2, '0'));
}

export interface RatesDraftField {
  text: string;
  error: string | null;
}

export interface RatesDraft {
  fields: Record<string, RatesDraftField>;
  storage: boolean;
  /** The draft rates, null while a field has an error. */
  rates: ContractRates | null;
}

/** The GET draft (`draft=1`): the typed values with their errors and the rates they make. */
export function parseRatesDraft(
  params: Record<string, string | string[] | undefined>,
): RatesDraft | null {
  if (first(params.draft) !== '1') return null;
  const fields: Record<string, RatesDraftField> = {};
  const perOperationKop: Partial<Record<ActOperation, number>> = {};
  const storage = first(params[STORAGE_FIELD]) === 'on';
  let valid = true;
  for (const operation of ACT_OPERATIONS) {
    const name = rateField(operation);
    const text = (first(params[name]) ?? '').trim().slice(0, 20);
    if (operation === 'store_day' && !storage) {
      fields[name] = { text, error: null };
      continue;
    }
    const kop = text === '' ? 0 : parseRubToKop(text);
    if (kop === null || kop > CONTRACT_RATE_MAX_KOP) {
      fields[name] = { text, error: 'Сумма в рублях, например 150 или 99,50' };
      valid = false;
      continue;
    }
    fields[name] = { text, error: null };
    perOperationKop[operation] = kop;
  }
  const turnoverText = (first(params[TURNOVER_FIELD]) ?? '').trim().slice(0, 10);
  const turnoverBp = parsePercentToBp(turnoverText);
  if (turnoverBp === null || turnoverBp > CONTRACT_TURNOVER_MAX_BP) {
    fields[TURNOVER_FIELD] = { text: turnoverText, error: 'Процент от 0 до 100, например 1,5' };
    valid = false;
  } else {
    fields[TURNOVER_FIELD] = { text: turnoverText, error: null };
  }
  return {
    fields,
    storage,
    rates:
      valid && turnoverBp !== null
        ? { perOperationKop: perOperationKop as ContractRates['perOperationKop'], turnoverBp }
        : null,
  };
}

const INT_RE = /^\d{1,9}$/u;

/** The hidden fields of «Сохранить ставки» (kopecks and bp) -> rates; null when malformed. */
export function ratesFromSaveForm(form: URLSearchParams): ContractRates | null {
  const storage = form.get(STORAGE_FIELD) === 'on';
  const perOperationKop: Partial<Record<ActOperation, number>> = {};
  for (const operation of ACT_OPERATIONS) {
    if (operation === 'store_day' && !storage) continue;
    const raw = (form.get(kopField(operation)) ?? '').trim();
    if (!INT_RE.test(raw)) return null;
    const kop = Number(raw);
    if (kop > CONTRACT_RATE_MAX_KOP) return null;
    perOperationKop[operation] = kop;
  }
  const rawBp = (form.get(TURNOVER_BP_FIELD) ?? '').trim();
  if (!INT_RE.test(rawBp)) return null;
  const turnoverBp = Number(rawBp);
  if (turnoverBp > CONTRACT_TURNOVER_MAX_BP) return null;
  return { perOperationKop: perOperationKop as ContractRates['perOperationKop'], turnoverBp };
}

export interface AdminRatesData {
  month: MonthKey;
  rates: ContractRates;
  version: string;
  updatedAt: Date | null;
  updatedBy: string | null;
  draft: RatesDraft | null;
  /** The act of the month with the current rates and, for a valid draft, with the draft. */
  current: ActSummary;
  preview: ActSummary | null;
}

export async function loadAdminRates(
  db: Database,
  env: Env,
  month: MonthKey,
  params: Record<string, string | string[] | undefined>,
  now: Date,
): Promise<AdminRatesData> {
  const report = await loadMonthReport(db, env, month, now);
  const { settings } = report;
  const draft = parseRatesDraft(params);
  const base = report.act.summary.turnoverBaseKop;
  return {
    month,
    rates: settings.rates,
    version: settings.ratesVersion,
    updatedAt: settings.ratesUpdatedAt,
    updatedBy: settings.ratesUpdatedBy,
    draft,
    current: report.act.summary,
    preview: draft?.rates ? buildAct(report.act.counts, draft.rates, base) : null,
  };
}
