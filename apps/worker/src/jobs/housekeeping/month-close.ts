// Step 7 (docs/month-close.md, roadmap r10 «Деньги под контролем»): the owner's messages of the
// month.
//
// - housekeeping/month-close, on the 1st at 09:00 Asia/Yekaterinburg: «Закрытие <месяц>: выручка
//   …, маржа …, операций для акта …, расхождений с ЮKassa: проверить» with the link to
//   /admin/month of the month that ended (loadMonthReport, the same read model as the page).
// - housekeeping/finance-reminders, daily at 09:10: the act (day 3), the bank check (day 5) and
//   the tax payment date (day 25) of settings finance.reminder_days, about the month that ended.
//   A reminder goes out on its day or, after a stopped worker, on one of the next
//   FINANCE_REMINDER_GRACE_DAYS days.
//
// Both are notify/alert outbox rows keyed by the month (`alert:month-close:<YYYY-MM>`,
// `alert:finance-reminder:<kind>:<YYYY-MM>`): a repeated run or a restart sends nothing twice.
// The audience is the owner: the AlertPort sends to the owner's private chat with the seller bot
// (staff.role = owner with tg_user_id) and falls back to the sellers chat only when there is no
// such chat or Telegram refuses it; the monthly close then carries monthCloseFallbackText —
// the operations and the link, without the money figures. The texts are neutral: facts and where
// to look, never a tax amount.
import { NOTIFY_JOBS } from '@detaly/config';
import {
  actOperationCount,
  dayOfMonth,
  FINANCE_REMINDER_KINDS,
  financeReminderText,
  monthCloseFallbackText,
  monthCloseText,
  previousMonth,
  type FinanceReminderKind,
  type MonthKey,
} from '@detaly/domain';
import { enqueueOutbox, loadFinanceSettings, loadMonthReport } from '@detaly/orders';
import type { WorkerDeps } from '../../deps';
import type { NotifyAlertJobData } from '../notify';
import { nudge } from './common';

/** Days after its day of the month a missed reminder still goes out (a stopped worker). */
export const FINANCE_REMINDER_GRACE_DAYS = 2;

export interface MonthCloseResult {
  month: MonthKey;
  /** Operations of the act of the month. */
  operations: number;
  /** Outbox key queued by this run, null when the month was sent before. */
  alerted: string | null;
}

export interface FinanceRemindersResult {
  month: MonthKey;
  /** Outbox keys queued by this run. */
  alerted: string[];
}

export function monthCloseKey(month: MonthKey): string {
  return `month-close:${month}`;
}

export function financeReminderKey(kind: FinanceReminderKind, month: MonthKey): string {
  return `finance-reminder:${kind}:${month}`;
}

function monthUrl(baseUrl: string, month: MonthKey): string {
  return new URL(`/admin/month?m=${month}`, baseUrl).toString();
}

async function queueAlert(deps: WorkerDeps, data: NotifyAlertJobData): Promise<string | null> {
  const key = `alert:${data.dedupeKey}`;
  const queued = await enqueueOutbox(deps.db, {
    queue: 'notify',
    name: NOTIFY_JOBS.alert,
    key,
    data: { ...data },
  });
  return queued ? key : null;
}

/** The monthly close of the month that ended (once per month). */
export async function runMonthClose(deps: WorkerDeps): Promise<MonthCloseResult> {
  const now = deps.now();
  const month = previousMonth(now);
  const report = await loadMonthReport(deps.db, deps.env, month, now);
  const url = monthUrl(deps.env.APP_BASE_URL, month);
  const operations = actOperationCount(report.act.counts, report.settings.rates);
  const alerted = await queueAlert(deps, {
    audience: 'owner',
    text: monthCloseText({
      month,
      revenueKop: report.revenue.totalKop,
      marginKop: report.margin.totals.marginKop,
      marginBp: report.margin.totals.marginBp,
      operations,
      url,
    }),
    fallbackText: monthCloseFallbackText({ month, operations, url }),
    dedupeKey: monthCloseKey(month),
  });
  if (alerted) nudge(deps);
  return { month, operations, alerted };
}

/** The reminders whose day of the month is today (or was at most the grace days ago). */
export async function runFinanceReminders(deps: WorkerDeps): Promise<FinanceRemindersResult> {
  const now = deps.now();
  const month = previousMonth(now);
  const today = dayOfMonth(now);
  const { reminderDays } = await loadFinanceSettings(deps.db, deps.env);
  const alerted: string[] = [];
  for (const kind of FINANCE_REMINDER_KINDS) {
    const day = reminderDays[kind];
    if (today < day || today > day + FINANCE_REMINDER_GRACE_DAYS) continue;
    const key = await queueAlert(deps, {
      audience: 'owner',
      text: financeReminderText(kind, { month, baseUrl: deps.env.APP_BASE_URL }),
      dedupeKey: financeReminderKey(kind, month),
    });
    if (key) alerted.push(key);
  }
  if (alerted.length > 0) nudge(deps);
  return { month, alerted };
}
