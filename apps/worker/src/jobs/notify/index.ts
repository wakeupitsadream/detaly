// Processor of the `notify` queue (docs/phase-1b-implementation.md section 12.1):
// `order` — order notifications to the client, the sellers chat or the owner;
// `alert` — a plain alert through the AlertPort (sellers chat / owner's private chat);
// `vin` — a VIN request message to the client or the sellers card (phase 1C, decision С20).
import { NOTIFY_JOBS } from '@detaly/config';
import { UnrecoverableError, type Job } from 'bullmq';
import type { WorkerDeps } from '../../deps';
import { unknownJob } from '../unknown-job';
import { processNotifyOrder, type NotifyOrderOutcome } from './order';
import { processNotifyVin, type NotifyVinOutcome } from './vin';

export { isFinalAttempt, notificationsOfEvent, type NotifyOrderJobData } from './order';
export { guardedSmsDriver, smsSpending, type SmsSpending } from './sms';
export { processNotifyVin, type NotifyVinJobData, type NotifyVinOutcome } from './vin';

/** Data of a notify/alert job: Russian text without PD and the AlertPort dedupe key. */
export interface NotifyAlertJobData {
  audience: 'sellers' | 'owner';
  text: string;
  dedupeKey: string;
}

function parseAlert(raw: unknown): NotifyAlertJobData {
  const data = (raw ?? {}) as Record<string, unknown>;
  if (
    (data.audience !== 'sellers' && data.audience !== 'owner') ||
    typeof data.text !== 'string' ||
    data.text.trim() === '' ||
    typeof data.dedupeKey !== 'string' ||
    data.dedupeKey === ''
  ) {
    throw new UnrecoverableError('notify/alert: bad job data');
  }
  return { audience: data.audience, text: data.text, dedupeKey: data.dedupeKey };
}

export type NotifyJobResult = NotifyOrderOutcome | NotifyVinOutcome | { status: 'alerted' };

export async function processNotify(job: Job, deps: WorkerDeps): Promise<NotifyJobResult> {
  switch (job.name) {
    case NOTIFY_JOBS.order:
      return processNotifyOrder(job, deps);
    case NOTIFY_JOBS.alert: {
      const alert = parseAlert(job.data);
      await deps.alerts.send(alert);
      return { status: 'alerted' };
    }
    case NOTIFY_JOBS.vin:
      return processNotifyVin(job, deps);
    default:
      return unknownJob(deps, 'notify', job.name);
  }
}
