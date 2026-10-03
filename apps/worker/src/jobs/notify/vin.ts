// notify/vin (docs/phase-1c-implementation.md decision С20, section 7.2 item 3): a VIN request
// message — to the client (vin_received, vin_proposal through the Notifier: messenger bindings,
// SMS by the allowlist) or the sellers card (sellerCards.postVin). The notifications row
// (vin_request_id, dedupe `vin:<id>:<template>:<n>:<channel>`) is written before sending and
// locked while sending, as in notify/order: a retry or a second copy of the job never sends twice.
//
// - client: n is the proposal number (job data, else vin_requests.proposal_count) for
//   vin_proposal and 0 for vin_received. The proposal link is always the request's current
//   proposal; a closed request gets nothing; an undelivered proposal is reported to the sellers
//   chat (call the client).
// - sellers: template `staff_vin_card`, n = 0 for the first card and 1 for the 4-hour reminder
//   (housekeeping/reminders); the reminder is skipped once the request got an answer.
//
// Logs carry the request id, the template and the outcome only: no phone, VIN or texts (С28).
import { carts, eq, notifications, sql, users, vinRequests, type Executor } from '@detaly/db';
import {
  isOneOf,
  VIN_NOTIFY_TEMPLATES,
  VIN_OPEN_STATUSES,
  type NotificationChannel,
  type VinNotifyTemplate,
} from '@detaly/domain';
import {
  createNotifier,
  selectChannel,
  UnrecoverableSmsError,
  vinRequestNumber,
  type NotifyRecipient,
  type NotifyResult,
  type VinTemplateData,
} from '@detaly/notify';
import { isUuid } from '@detaly/orders';
import { UnrecoverableError, type Job } from 'bullmq';
import type { WorkerDeps } from '../../deps';
import { isFinalAttempt } from './order';
import {
  clientDrivers,
  loadBindings,
  lockRow,
  markBlocked,
  nudge,
  rowsOf,
  safeError,
  sellersChatId,
  smsPhone,
} from './shared';
import { baseUrl } from './template-data';

/** notifications.template of the sellers card of a VIN request. */
export const VIN_CARD_TEMPLATE = 'staff_vin_card';

/** fallback_reason values of notify/vin. */
export const VIN_SKIP_REASONS = {
  /** The request was closed before the message went out. */
  closed: 'vin_closed',
  /** vin_proposal without a proposal cart / token. */
  noProposal: 'proposal_missing',
  /** The 4-hour reminder after the request got an answer. */
  answered: 'vin_answered',
} as const;

export interface NotifyVinJobData {
  vinRequestId: string;
  audience: 'client' | 'sellers';
  /** Client template; absent for the sellers card. */
  template?: VinNotifyTemplate | null;
  /** Outbox key of the job (logs and diagnostics; the dedupe key is built from the fields). */
  key: string;
  /** Number of the proposal sent (vin_requests.proposal_count) for vin_proposal. */
  n?: number;
  /** Extra line of the sellers card without PD («Без ответа 4 ч»). */
  note?: string | null;
  /** The 4-hour reminder card (decision С15): skipped once the request got an answer. */
  reminder?: boolean;
}

export type NotifyVinOutcome =
  | {
      status: 'sent' | 'skipped' | 'failed' | 'duplicate';
      channel: string | null;
      fallbackReason?: string;
    }
  | { status: 'posted' };

const AUDIENCES = ['client', 'sellers'] as const;
const NOTE_MAX = 200;

function parseData(raw: unknown): NotifyVinJobData {
  const data = (raw ?? {}) as Record<string, unknown>;
  if (!isUuid(data.vinRequestId) || !isOneOf(AUDIENCES, data.audience)) {
    throw new UnrecoverableError('notify/vin: bad job data');
  }
  const template = isOneOf(VIN_NOTIFY_TEMPLATES, data.template) ? data.template : null;
  if (data.audience === 'client' && template === null) {
    throw new UnrecoverableError('notify/vin: bad client template');
  }
  const n =
    typeof data.n === 'number' && Number.isSafeInteger(data.n) && data.n >= 0 ? data.n : undefined;
  return {
    vinRequestId: data.vinRequestId,
    audience: data.audience,
    template,
    key: typeof data.key === 'string' ? data.key : '',
    ...(n === undefined ? {} : { n }),
    note:
      typeof data.note === 'string' && data.note.trim() !== ''
        ? data.note.slice(0, NOTE_MAX)
        : null,
    reminder: data.reminder === true,
  };
}

type VinRow = Pick<
  typeof vinRequests.$inferSelect,
  'id' | 'userId' | 'phone' | 'status' | 'proposalCartId' | 'proposalCount' | 'preview'
>;

async function loadRequest(db: Executor, id: string): Promise<VinRow | null> {
  const [row] = await db
    .select({
      id: vinRequests.id,
      userId: vinRequests.userId,
      phone: vinRequests.phone,
      status: vinRequests.status,
      proposalCartId: vinRequests.proposalCartId,
      proposalCount: vinRequests.proposalCount,
      preview: vinRequests.preview,
    })
    .from(vinRequests)
    .where(eq(vinRequests.id, id));
  return row ?? null;
}

export async function processNotifyVin(job: Job, deps: WorkerDeps): Promise<NotifyVinOutcome> {
  const data = parseData(job.data);
  const request = await loadRequest(deps.db, data.vinRequestId);
  if (request === null) {
    // createVinRequest / sendVinProposal write the request and the outbox row in one
    // transaction: a missing request is a broken job, not a race.
    throw new UnrecoverableError('notify/vin: VIN request not found');
  }
  const outcome =
    data.audience === 'sellers'
      ? await notifySellers(job, deps, data, request)
      : await notifyClient(job, deps, data, request);
  deps.logger.info(
    {
      vinRequestId: request.id,
      audience: data.audience,
      template: data.template ?? VIN_CARD_TEMPLATE,
      status: outcome.status,
      ...('channel' in outcome ? { channel: outcome.channel } : {}),
    },
    'notify/vin done',
  );
  return outcome;
}

// ---------------------------------------------------------------------------------------------
// Sellers
// ---------------------------------------------------------------------------------------------

async function notifySellers(
  job: Job,
  deps: WorkerDeps,
  data: NotifyVinJobData,
  request: VinRow,
): Promise<NotifyVinOutcome> {
  const n = data.n ?? (data.reminder ? 1 : 0);
  const dedupeKey = `vin:${request.id}:${VIN_CARD_TEMPLATE}:${n}:telegram`;
  await deps.db
    .insert(notifications)
    .values({
      chatId: sellersChatId(deps),
      vinRequestId: request.id,
      channel: 'telegram',
      template: VIN_CARD_TEMPLATE,
      payload: {
        vinRequestId: request.id,
        audience: 'sellers',
        n,
        reminder: data.reminder === true,
      },
      dedupeKey,
      status: 'queued',
    })
    .onConflictDoNothing({ target: notifications.dedupeKey });
  const [row] = await rowsOf(deps.db, dedupeKey);
  if (!row) throw new Error('notify/vin: notifications row vanished');
  if (row.status !== 'queued') return { status: 'duplicate', channel: null };

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
    if (data.reminder) {
      // The reminder waits for the opening hours: by then the request may have an answer.
      const [current] = await tx
        .select({ status: vinRequests.status })
        .from(vinRequests)
        .where(eq(vinRequests.id, request.id));
      if (!current || !isOneOf(VIN_OPEN_STATUSES, current.status)) {
        return skip(VIN_SKIP_REASONS.answered);
      }
    }
    let posted;
    try {
      posted = await deps.sellerCards.postVin({
        vinRequestId: request.id,
        note: data.note ?? null,
      });
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
    // Nothing reached the sellers chat (no bot token / chat id): never recorded as `sent`.
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
      return { status: 'duplicate', channel: null };
    case 'error':
      throw outcome.error;
    case 'skipped':
      return { status: 'skipped', channel: null, fallbackReason: outcome.fallbackReason };
    case 'posted':
      return { status: 'posted' };
  }
}

// ---------------------------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------------------------

/** The client of the request: its user (bindings) and the request phone for SMS. */
async function loadRecipient(
  db: Executor,
  request: VinRow,
): Promise<{ userId: string | null; recipient: Extract<NotifyRecipient, { kind: 'client' }> }> {
  const [user] = await db
    .select({ id: users.id, anonymizedAt: users.anonymizedAt })
    .from(users)
    .where(request.userId === null ? eq(users.phone, request.phone) : eq(users.id, request.userId));
  if (!user) {
    return {
      userId: null,
      recipient: { kind: 'client', bindings: [], phone: smsPhone(request.phone, null) },
    };
  }
  return {
    userId: user.id,
    recipient: {
      kind: 'client',
      bindings: await loadBindings(db, user.id),
      phone: smsPhone(request.phone, user.anonymizedAt),
    },
  };
}

/**
 * Why a client message must not go out any more; null when it may. A proposal job always links
 * the request's current proposal (vin_requests.proposal_cart_id), so a late job of a replaced
 * proposal cannot send a dead link.
 */
async function staleReason(db: Executor, requestId: string): Promise<string | null> {
  const [current] = await db
    .select({ status: vinRequests.status })
    .from(vinRequests)
    .where(eq(vinRequests.id, requestId));
  return !current || current.status === 'closed' ? VIN_SKIP_REASONS.closed : null;
}

async function templateData(
  db: Executor,
  deps: WorkerDeps,
  template: VinNotifyTemplate,
  requestId: string,
): Promise<VinTemplateData | null> {
  const [current] = await db
    .select({
      preview: vinRequests.preview,
      token: carts.proposalToken,
      sellerNote: carts.sellerNote,
    })
    .from(vinRequests)
    .leftJoin(carts, eq(carts.id, vinRequests.proposalCartId))
    .where(eq(vinRequests.id, requestId));
  const data: VinTemplateData = {
    brandName: deps.env.BRAND_NAME,
    requestNumber: vinRequestNumber(requestId),
  };
  if (template === 'vin_proposal') {
    if (!current?.token) return null;
    data.proposalUrl = `${baseUrl(deps.env)}/p/${current.token}`;
    data.comment = current.sellerNote ?? current.preview?.comment ?? null;
  }
  return data;
}

async function notifyClient(
  job: Job,
  deps: WorkerDeps,
  data: NotifyVinJobData,
  request: VinRow,
): Promise<NotifyVinOutcome> {
  const template = data.template as VinNotifyTemplate;
  const n = data.n ?? (template === 'vin_proposal' ? request.proposalCount : 0);
  const prefix = `vin:${request.id}:${template}:${n}:`;
  const existing = await rowsOf(deps.db, prefix);
  const done = existing.find((row) => row.status !== 'queued');
  if (done) return { status: 'duplicate', channel: null };

  const target = await loadRecipient(deps.db, request);
  const drivers = clientDrivers(deps);
  const available = new Set(drivers.map((driver) => driver.channel));
  const selection = selectChannel(target.recipient, template, available);
  const dedupeKey =
    existing[0]?.dedupeKey ??
    `${prefix}${selection.status === 'send' ? selection.channel : 'none'}`;

  await deps.db
    .insert(notifications)
    .values({
      // notifications needs a recipient: the user, or (a request without a user row) a marker.
      ...(target.userId === null ? { chatId: 'vin-client' } : { userId: target.userId }),
      vinRequestId: request.id,
      channel: selection.status === 'send' ? selection.channel : null,
      template,
      payload: { vinRequestId: request.id, audience: 'client', n },
      dedupeKey,
      status: 'queued',
    })
    .onConflictDoNothing({ target: notifications.dedupeKey });
  const [row] = await rowsOf(deps.db, dedupeKey);
  if (!row) throw new Error('notify/vin: notifications row vanished');
  if (row.status !== 'queued') return { status: 'duplicate', channel: null };

  type Outcome =
    | { kind: 'duplicate' }
    | { kind: 'error'; error: unknown; message: string; final: boolean; unrecoverable: boolean }
    | { kind: 'done'; result: NotifyResult };
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
      return { kind: 'done', result: { status: 'skipped', fallbackReason, blocked: [] } };
    };
    const stale = await staleReason(tx, request.id);
    if (stale !== null) return skip(stale);
    const message = await templateData(tx, deps, template, request.id);
    if (message === null) return skip(VIN_SKIP_REASONS.noProposal);

    let result: NotifyResult;
    try {
      result = await createNotifier({ drivers }).send(target.recipient, template, message, {
        dedupeKey,
      });
    } catch (error) {
      const unrecoverable = error instanceof UnrecoverableSmsError;
      const final = unrecoverable || isFinalAttempt(job);
      const text = safeError(error);
      await tx
        .update(notifications)
        .set({
          attempts: sql`${notifications.attempts} + 1`,
          error: text,
          ...(final ? { status: 'failed' as const } : {}),
          updatedAt: deps.now(),
        })
        .where(eq(notifications.id, row.id));
      return { kind: 'error', error, message: text, final, unrecoverable };
    }

    const at = deps.now();
    if (result.status === 'sent') {
      await tx
        .update(notifications)
        .set({
          status: 'sent',
          channel: result.channel,
          sentAt: at,
          fallbackReason: result.fallbackReason,
          attempts: sql`${notifications.attempts} + 1`,
          error: null,
          payload: sql`${notifications.payload} || ${JSON.stringify({
            externalId: result.externalId,
          })}::jsonb`,
          updatedAt: at,
        })
        .where(eq(notifications.id, row.id));
    } else {
      await tx
        .update(notifications)
        .set({
          status: 'skipped',
          fallbackReason: result.fallbackReason,
          attempts: sql`${notifications.attempts} + 1`,
          updatedAt: at,
        })
        .where(eq(notifications.id, row.id));
    }
    if (target.userId !== null) await markBlocked(tx, target.userId, result.blocked, at);
    return { kind: 'done', result };
  });

  switch (outcome.kind) {
    case 'duplicate':
      return { status: 'duplicate', channel: null };
    case 'error':
      deps.logger.warn(
        { vinRequestId: request.id, template, err: outcome.message, final: outcome.final },
        'VIN client notification failed',
      );
      if (outcome.final) await afterProposal(deps, template, request.id, n, 'failed');
      if (outcome.unrecoverable) throw new UnrecoverableError(outcome.message);
      throw outcome.error;
    case 'done': {
      const { result } = outcome;
      nudge(deps);
      if (result.status === 'sent') {
        await afterProposal(deps, template, request.id, n, null);
        return { status: 'sent', channel: result.channel as NotificationChannel };
      }
      await afterProposal(deps, template, request.id, n, result.fallbackReason);
      return { status: 'skipped', channel: null, fallbackReason: result.fallbackReason };
    }
  }
}

/** Skip reasons that are not a delivery problem (nothing to tell the sellers). */
const QUIET_REASONS: readonly string[] = [VIN_SKIP_REASONS.closed];

/**
 * After a vin_proposal: the seller card is redrawn (it may show where the proposal went), and an
 * undelivered proposal (no messenger and no SMS, a blocked bot without SMS, a final error) goes
 * to the sellers chat as a task to call the client. Best effort: never fails the job.
 */
async function afterProposal(
  deps: WorkerDeps,
  template: VinNotifyTemplate,
  requestId: string,
  n: number,
  undelivered: string | null,
): Promise<void> {
  if (template !== 'vin_proposal') return;
  try {
    await deps.sellerCards.refreshVin(requestId);
    if (undelivered !== null && !QUIET_REASONS.includes(undelivered)) {
      await deps.alerts.send({
        audience: 'sellers',
        text: `Заявка VIN № ${vinRequestNumber(requestId)}: подборку не удалось отправить клиенту (${undelivered}). Позвоните клиенту — телефон в админке.`,
        dedupeKey: `vin:${requestId}:proposal_undelivered:${n}`,
      });
    }
  } catch (error) {
    deps.logger.warn(
      { vinRequestId: requestId, err: safeError(error) },
      'notify/vin: seller follow-up failed',
    );
  }
}
