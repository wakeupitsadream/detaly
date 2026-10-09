// notify/fit (step 4, docs/fit-check.md): the sellers card of a fit check request.
//
// - card: the first card of a new request (n = 0);
// - reminder: the card posted again with «Без ответа …» once the request waited longer than
//   `fit_check.sla_minutes` of working time (housekeeping/fit-checks, n = 1); skipped when no line
//   waits any more (answered, expired or cancelled meanwhile);
// - refresh: the open card redrawn (an answer from the admin, an expiry, a cancellation).
//
// The card and the reminder write a notifications row first (chat_id of the sellers chat, dedupe
// `fit:<request id>:staff_fit_card:<n>:telegram`) and lock it while posting, as notify/vin does:
// a retry or a second copy of the job never posts twice. Nothing reached the chat (no bot token or
// chat id) -> `skipped`, never `sent`.
//
// Logs carry the request id, the kind and the outcome: never the VIN or the comment.
import { and, eq, fitChecks, notifications, sql } from '@detaly/db';
import { isOneOf } from '@detaly/domain';
import { isUuid } from '@detaly/orders';
import { FIT_NOTIFY_KINDS, type FitNotifyJob } from '@detaly/vin';
import { UnrecoverableError, type Job } from 'bullmq';
import type { WorkerDeps } from '../../deps';
import { isFinalAttempt } from './order';
import { lockRow, rowsOf, safeError, sellersChatId } from './shared';

/** notifications.template of the sellers card of a fit check request. */
export const FIT_CARD_TEMPLATE = 'staff_fit_card';

/** fallback_reason of a reminder for a request nobody waits on any more. */
export const FIT_ANSWERED = 'fit_answered';

const NOTE_MAX = 200;

export type NotifyFitOutcome =
  { status: 'posted' | 'refreshed' } | { status: 'skipped' | 'duplicate'; fallbackReason?: string };

function parseData(raw: unknown): FitNotifyJob {
  const data = (raw ?? {}) as Record<string, unknown>;
  if (!isUuid(data.requestId) || !isOneOf(FIT_NOTIFY_KINDS, data.kind)) {
    throw new UnrecoverableError('notify/fit: bad job data');
  }
  return {
    requestId: data.requestId,
    kind: data.kind,
    key: typeof data.key === 'string' ? data.key : '',
    note:
      typeof data.note === 'string' && data.note.trim() !== ''
        ? data.note.slice(0, NOTE_MAX)
        : null,
  };
}

/** A line of the request still waits for the master. */
async function stillWaiting(deps: WorkerDeps, requestId: string): Promise<boolean> {
  const [row] = await deps.db
    .select({ id: fitChecks.id })
    .from(fitChecks)
    .where(and(eq(fitChecks.requestId, requestId), eq(fitChecks.status, 'pending')))
    .limit(1);
  return row !== undefined;
}

export async function processNotifyFit(job: Job, deps: WorkerDeps): Promise<NotifyFitOutcome> {
  const data = parseData(job.data);
  const outcome = data.kind === 'refresh' ? await refresh(deps, data) : await post(job, deps, data);
  deps.logger.info(
    { fitRequestId: data.requestId, kind: data.kind, status: outcome.status },
    'notify/fit done',
  );
  return outcome;
}

async function refresh(deps: WorkerDeps, data: FitNotifyJob): Promise<NotifyFitOutcome> {
  await deps.sellerCards.refreshFit(data.requestId);
  return { status: 'refreshed' };
}

async function post(job: Job, deps: WorkerDeps, data: FitNotifyJob): Promise<NotifyFitOutcome> {
  const n = data.kind === 'reminder' ? 1 : 0;
  const dedupeKey = `fit:${data.requestId}:${FIT_CARD_TEMPLATE}:${n}:telegram`;
  await deps.db
    .insert(notifications)
    .values({
      chatId: sellersChatId(deps),
      channel: 'telegram',
      template: FIT_CARD_TEMPLATE,
      payload: { fitRequestId: data.requestId, audience: 'sellers', n },
      dedupeKey,
      status: 'queued',
    })
    .onConflictDoNothing({ target: notifications.dedupeKey });
  const [row] = await rowsOf(deps.db, dedupeKey);
  if (!row) throw new Error('notify/fit: notifications row vanished');
  if (row.status !== 'queued') return { status: 'duplicate' };

  type Outcome =
    | { kind: 'duplicate' }
    | { kind: 'error'; error: unknown }
    | { kind: 'skipped'; fallbackReason: string }
    | { kind: 'posted' };
  const outcome = await deps.db.transaction(async (tx): Promise<Outcome> => {
    const status = await lockRow(tx, row.id);
    if (status !== 'queued') return { kind: 'duplicate' };
    const skip = async (fallbackReason: string): Promise<Outcome> => {
      await tx
        .update(notifications)
        .set({
          status: 'skipped',
          fallbackReason,
          attempts: sql`${notifications.attempts} + 1`,
          updatedAt: deps.now(),
        })
        .where(eq(notifications.id, row.id));
      return { kind: 'skipped', fallbackReason };
    };
    // The reminder waits for nothing once every line has its answer (or expired).
    if (data.kind === 'reminder' && !(await stillWaiting(deps, data.requestId))) {
      return skip(FIT_ANSWERED);
    }
    let posted;
    try {
      posted = await deps.sellerCards.postFit({ requestId: data.requestId, note: data.note });
    } catch (error) {
      await tx
        .update(notifications)
        .set({
          attempts: sql`${notifications.attempts} + 1`,
          error: safeError(error),
          ...(isFinalAttempt(job) ? { status: 'failed' as const } : {}),
          updatedAt: deps.now(),
        })
        .where(eq(notifications.id, row.id));
      return { kind: 'error', error };
    }
    if (posted.status === 'skipped') return skip(posted.fallbackReason);
    const at = deps.now();
    await tx
      .update(notifications)
      .set({
        status: 'sent',
        sentAt: at,
        attempts: sql`${notifications.attempts} + 1`,
        error: null,
        updatedAt: at,
      })
      .where(eq(notifications.id, row.id));
    return { kind: 'posted' };
  });
  switch (outcome.kind) {
    case 'duplicate':
      return { status: 'duplicate' };
    case 'error':
      throw outcome.error;
    case 'skipped':
      return { status: 'skipped', fallbackReason: outcome.fallbackReason };
    case 'posted':
      return { status: 'posted' };
  }
}
