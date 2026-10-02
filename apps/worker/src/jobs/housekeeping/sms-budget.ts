// housekeeping/sms-budget, hourly (decision Б21, PLAN section 1): when SMS spending of the
// calendar month (Asia/Yekaterinburg) reaches 80% of SMS_MONTHLY_BUDGET_RUB the owner gets one
// alert a month; at 100% one more (SMS stop, `sms_budget_exhausted`). The alerts are notify/alert
// outbox rows keyed by month and threshold, so the database keeps them to one each.
import { NOTIFY_JOBS } from '@detaly/config';
import { formatRub } from '@detaly/domain';
import { enqueueOutbox } from '@detaly/orders';
import type { WorkerDeps } from '../../deps';
import type { NotifyAlertJobData } from '../notify';
import { smsSpending, type SmsSpending } from '../notify/sms';
import { nudge } from './common';

export interface SmsBudgetResult extends SmsSpending {
  /** Outbox key of the alert queued by this run, null when nothing new was queued. */
  alerted: string | null;
}

export async function runSmsBudget(deps: WorkerDeps): Promise<SmsBudgetResult> {
  const spending = await smsSpending(deps.db, deps.env.SMS_MONTHLY_BUDGET_RUB, deps.now());
  if (spending.state === 'ok' || spending.budgetRub === null) {
    return { ...spending, alerted: null };
  }
  const threshold = spending.state === 'exhausted' ? 100 : 80;
  const budget = formatRub(spending.budgetRub * 100);
  const spent = formatRub(spending.spentKop);
  const text =
    threshold === 100
      ? `SMS-бюджет за ${spending.month} исчерпан: ${spent} из ${budget}. SMS не отправляются до следующего месяца или увеличения SMS_MONTHLY_BUDGET_RUB.`
      : `SMS-бюджет за ${spending.month}: потрачено ${spent} из ${budget} (80% и больше).`;
  const dedupeKey = `sms-budget:${spending.month}:${threshold}`;
  const data: NotifyAlertJobData = { audience: 'owner', text, dedupeKey };
  const queued = await enqueueOutbox(deps.db, {
    queue: 'notify',
    name: NOTIFY_JOBS.alert,
    key: `alert:${dedupeKey}`,
    data: { ...data },
  });
  if (queued) nudge(deps);
  return { ...spending, alerted: queued ? `alert:${dedupeKey}` : null };
}
