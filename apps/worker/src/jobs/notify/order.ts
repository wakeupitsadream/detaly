// notify/order {orderEventId, audience, template} (docs/phase-1b-implementation.md section 12.1,
// decisions Б16, Б19, Б20, Б21).
//
// - sellers: a seller card (deps.sellerCards.post) behind a notifications row (chat_id = sellers
//   chat) written before posting, so a retry after success does not post twice;
// - owner: the owner's private chat through the AlertPort (it keeps its own `alert:<key>` row);
// - client: a notifications row with dedupe_key `${order_event_id}:${template}:${channel ?? 'none'}`
//   in status `queued` BEFORE sending, then the Notifier with the available drivers (SMS when
//   configured; client messengers arrive in 1C). Result: sent / skipped + fallback_reason /
//   failed + attempts + error (no PD). A row already final -> nothing is sent again.
//
// After decision_needed (the first one of an approval): sent -> client_approvals.notified_at and
// expires_at = send time + approval.timeout_h, journal approval_notified; skipped or failed ->
// journal approval_unreachable and staff_approval_unreachable to the sellers; the timer does
// not start (Б16).
import {
  and,
  asc,
  clientApprovals,
  eq,
  isNull,
  messengerBindings,
  notifications,
  orderEvents,
  orders,
  sql,
  users,
  type Executor,
} from '@detaly/db';
import {
  isOneOf,
  ORDER_NOTIFY_TEMPLATES,
  type NotificationChannel,
  type NotifyAudience,
  type OrderNotifyTemplate,
} from '@detaly/domain';
import {
  ChannelBlockedError,
  createNotifier,
  renderTemplate,
  selectChannel,
  SmsGatewayError,
  UnrecoverableSmsError,
  type ChannelDriver,
  type NotifyRecipient,
  type NotifyResult,
} from '@detaly/notify';
import {
  enqueueOutbox,
  isUuid,
  loadOrderSettings,
  recordJournalEvent,
  type OrderSettings,
} from '@detaly/orders';
import { UnrecoverableError, type Job } from 'bullmq';
import type { WorkerDeps } from '../../deps';
import { guardedSmsDriver } from './sms';
import { loadTemplateData, type TemplateExtras } from './template-data';

const HOUR_MS = 3_600_000;
const AUDIENCES = ['client', 'sellers', 'owner'] as const satisfies readonly NotifyAudience[];
const SYSTEM_ACTOR = { type: 'system', id: 'notify' } as const;

/** Data of a notify/order job (outbox rows of the engine, reminders and deferred 1A effects). */
export interface NotifyOrderJobData extends TemplateExtras {
  /** orders.id; the event's own order wins when they differ. */
  orderId?: string;
  /** order_events.id: a transition, a reminder or another journal event. */
  orderEventId: string;
  audience: NotifyAudience;
  template: OrderNotifyTemplate;
  /** A repeated decision_needed (12-hour reminder): never starts or moves the approval timer. */
  reminder?: boolean;
}

export type NotifyOrderOutcome =
  | { status: 'sent'; channel: NotificationChannel | null }
  | { status: 'skipped'; fallbackReason: string }
  | { status: 'duplicate'; existing: string }
  | { status: 'missing' };

function parseData(raw: unknown): NotifyOrderJobData {
  const data = (raw ?? {}) as Record<string, unknown>;
  if (
    !isUuid(data.orderEventId) ||
    !isOneOf(AUDIENCES, data.audience) ||
    !isOneOf(ORDER_NOTIFY_TEMPLATES, data.template)
  ) {
    throw new UnrecoverableError('notify/order: bad job data');
  }
  const extras: TemplateExtras = {};
  if (typeof data.readyDays === 'number' && Number.isSafeInteger(data.readyDays)) {
    extras.readyDays = data.readyDays;
  }
  if (typeof data.deadlineDate === 'string') extras.deadlineDate = data.deadlineDate;
  if (typeof data.note === 'string') extras.note = data.note;
  return {
    ...extras,
    ...(isUuid(data.orderId) ? { orderId: data.orderId } : {}),
    orderEventId: data.orderEventId,
    audience: data.audience,
    template: data.template,
    reminder: data.reminder === true,
  };
}

/** The last attempt of a BullMQ job: a failure now is final (notifications.status = failed). */
export function isFinalAttempt(job: Pick<Job, 'attemptsMade' | 'opts'>): boolean {
  return (job.attemptsMade ?? 0) + 1 >= (job.opts?.attempts ?? 1);
}

/** notifications.error / logs: provider and code for known errors, the class name otherwise. */
function safeError(error: unknown): string {
  if (
    error instanceof UnrecoverableSmsError ||
    error instanceof SmsGatewayError ||
    error instanceof ChannelBlockedError
  ) {
    return error.message.slice(0, 200);
  }
  if (error instanceof Error) {
    const code = (error as { code?: unknown }).code;
    return typeof code === 'string' ? `${error.name}:${code}` : error.name;
  }
  return 'unknown';
}

/** Client drivers of 1B: SMS behind the guard. Telegram/MAX client drivers arrive in 1C/2. */
export function clientDrivers(deps: WorkerDeps): ChannelDriver[] {
  return deps.smsDriver ? [guardedSmsDriver(deps, deps.smsDriver)] : [];
}

/** Wakes the outbox dispatcher after a commit that may have queued rows; never throws. */
function nudge(deps: WorkerDeps): void {
  try {
    deps.engine.nudge?.();
  } catch {
    // best effort: the dispatcher polls anyway (decision Б1)
  }
}

function sellersChatId(deps: WorkerDeps): string {
  return deps.env.TG_SELLER_CHAT_ID === undefined ? 'sellers' : String(deps.env.TG_SELLER_CHAT_ID);
}

/** The notifications rows of (event, template) — any channel (Б20 key prefix). */
async function rowsOf(db: Executor, prefix: string) {
  return db
    .select({
      id: notifications.id,
      dedupeKey: notifications.dedupeKey,
      status: notifications.status,
      attempts: notifications.attempts,
    })
    .from(notifications)
    .where(sql`starts_with(${notifications.dedupeKey}, ${prefix})`)
    .orderBy(asc(notifications.createdAt));
}

export async function processNotifyOrder(job: Job, deps: WorkerDeps): Promise<NotifyOrderOutcome> {
  const data = parseData(job.data);
  const [event] = await deps.db
    .select({ id: orderEvents.id, orderId: orderEvents.orderId, payload: orderEvents.payload })
    .from(orderEvents)
    .where(eq(orderEvents.id, data.orderEventId));
  if (!event) {
    // The engine writes the event and its outbox row in one transaction: a missing event is a
    // broken job, not a race.
    throw new UnrecoverableError('notify/order: order event not found');
  }
  if (data.orderId !== undefined && data.orderId !== event.orderId) {
    deps.logger.warn(
      { orderEventId: event.id, template: data.template },
      'notify/order: orderId differs from the event; using the event',
    );
  }
  const settings = await loadOrderSettings(deps.db, deps.env);
  const ctx = { job, deps, data, orderId: event.orderId, settings, payload: event.payload ?? {} };
  switch (data.audience) {
    case 'client':
      return notifyClient(ctx);
    case 'sellers':
      return notifySellers(ctx);
    case 'owner':
      return notifyOwner(ctx);
  }
}

interface NotifyContext {
  job: Job;
  deps: WorkerDeps;
  data: NotifyOrderJobData;
  orderId: string;
  settings: OrderSettings;
  payload: Record<string, unknown>;
}

function paymentIdOf(payload: Record<string, unknown>): string | null {
  return isUuid(payload.paymentId) ? payload.paymentId : null;
}

async function templateData(ctx: NotifyContext, sendAt: Date) {
  return loadTemplateData(ctx.deps.db, {
    env: ctx.deps.env,
    settings: ctx.settings,
    orderId: ctx.orderId,
    audience: ctx.data.audience,
    template: ctx.data.template,
    paymentId: paymentIdOf(ctx.payload),
    extras: ctx.data,
    sendAt,
  });
}

// ---------------------------------------------------------------------------------------------
// Owner
// ---------------------------------------------------------------------------------------------

async function notifyOwner(ctx: NotifyContext): Promise<NotifyOrderOutcome> {
  const { deps, data } = ctx;
  const loaded = await templateData(ctx, deps.now());
  if (loaded === null) return { status: 'missing' };
  const message = renderTemplate(data.template, loaded.data);
  // AlertPort carries text only: the admin link goes in as a line (buttons stay in the card).
  const text = loaded.data.adminUrl ? `${message.text}\n${loaded.data.adminUrl}` : message.text;
  await deps.alerts.send({
    audience: 'owner',
    text,
    dedupeKey: `${data.orderEventId}:${data.template}`,
  });
  return { status: 'sent', channel: 'telegram' };
}

// ---------------------------------------------------------------------------------------------
// Sellers
// ---------------------------------------------------------------------------------------------

async function notifySellers(ctx: NotifyContext): Promise<NotifyOrderOutcome> {
  const { job, deps, data, orderId } = ctx;
  const dedupeKey = `${data.orderEventId}:${data.template}:telegram`;
  await deps.db
    .insert(notifications)
    .values({
      orderId,
      chatId: sellersChatId(deps),
      channel: 'telegram',
      template: data.template,
      payload: { orderEventId: data.orderEventId, audience: 'sellers' },
      dedupeKey,
      status: 'queued',
    })
    .onConflictDoNothing({ target: notifications.dedupeKey });
  const [row] = await rowsOf(deps.db, dedupeKey);
  if (!row) throw new Error('notify/order: notifications row vanished');
  if (row.status !== 'queued') return { status: 'duplicate', existing: row.status };

  // The row stays locked while the card is posted: a concurrent copy of the job waits and then
  // sees `sent`.
  const outcome = await deps.db.transaction(async (tx) => {
    const status = await lockRow(tx, row.id);
    if (status !== 'queued') return { kind: 'duplicate' as const, status };
    try {
      await deps.sellerCards.post({
        orderId,
        template: data.template,
        orderEventId: data.orderEventId,
        note: data.note ?? null,
      });
    } catch (error) {
      const final = isFinalAttempt(job);
      await tx
        .update(notifications)
        .set({
          attempts: sql`${notifications.attempts} + 1`,
          error: safeError(error),
          ...(final ? { status: 'failed' as const } : {}),
          updatedAt: deps.now(),
        })
        .where(eq(notifications.id, row.id));
      return { kind: 'error' as const, error };
    }
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
    return { kind: 'sent' as const };
  });
  if (outcome.kind === 'duplicate')
    return { status: 'duplicate', existing: outcome.status ?? 'missing' };
  if (outcome.kind === 'error') throw outcome.error;
  return { status: 'sent', channel: 'telegram' };
}

/** fallback_reason of a decision_needed whose approval is no longer open. */
export const APPROVAL_CLOSED = 'approval_closed';

interface OpenApproval {
  id: string;
}

/**
 * The open approval a decision_needed job is about: the order still waits for the client and
 * the approval named by the event (payload.approvalId of the engine event or of the reminder)
 * is the open one. null -> the question is closed or replaced; nothing to send.
 */
async function currentApproval(
  db: Executor,
  orderId: string,
  payload: Record<string, unknown>,
): Promise<OpenApproval | null> {
  const [open] = await db
    .select({ id: clientApprovals.id })
    .from(clientApprovals)
    .innerJoin(orders, eq(orders.id, clientApprovals.orderId))
    .where(
      and(
        eq(clientApprovals.orderId, orderId),
        isNull(clientApprovals.decidedAt),
        eq(orders.status, 'awaiting_client_approval'),
      ),
    )
    .limit(1);
  if (!open) return null;
  const expected = isUuid(payload.approvalId) ? payload.approvalId : null;
  return expected === null || expected === open.id ? open : null;
}

/** `select … for update` of a notifications row; its status (null when it is gone). */
async function lockRow(tx: Executor, id: string): Promise<string | null> {
  const [locked] = await tx
    .select({ status: notifications.status })
    .from(notifications)
    .where(eq(notifications.id, id))
    .for('update');
  return locked?.status ?? null;
}

// ---------------------------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------------------------

async function loadRecipient(
  db: Executor,
  orderId: string,
): Promise<{ userId: string; recipient: Extract<NotifyRecipient, { kind: 'client' }> } | null> {
  const [row] = await db
    .select({ userId: users.id, phone: users.phone, anonymizedAt: users.anonymizedAt })
    .from(orders)
    .innerJoin(users, eq(users.id, orders.userId))
    .where(eq(orders.id, orderId));
  if (!row) return null;
  const bindings = await db
    .select({
      channel: messengerBindings.channel,
      chatId: messengerBindings.chatId,
      isPrimary: messengerBindings.isPrimary,
      blockedAt: messengerBindings.blockedAt,
    })
    .from(messengerBindings)
    .where(eq(messengerBindings.userId, row.userId));
  const phone = row.anonymizedAt === null && /^\+\d{10,15}$/.test(row.phone) ? row.phone : null;
  return {
    userId: row.userId,
    recipient: {
      kind: 'client',
      bindings: bindings.map((b) => ({
        channel: b.channel,
        chatId: b.chatId,
        isPrimary: b.isPrimary,
        blocked: b.blockedAt !== null,
      })),
      phone,
    },
  };
}

async function notifyClient(ctx: NotifyContext): Promise<NotifyOrderOutcome> {
  const { job, deps, data, orderId } = ctx;
  const prefix = `${data.orderEventId}:${data.template}:`;
  const existing = await rowsOf(deps.db, prefix);
  const done = existing.find((row) => row.status !== 'queued');
  if (done) return { status: 'duplicate', existing: done.status };

  const target = await loadRecipient(deps.db, orderId);
  if (target === null) return { status: 'missing' };
  const drivers = clientDrivers(deps);
  const available = new Set(drivers.map((driver) => driver.channel));
  const selection = selectChannel(target.recipient, data.template, available);
  const dedupeKey =
    existing[0]?.dedupeKey ??
    `${prefix}${selection.status === 'send' ? selection.channel : 'none'}`;

  await deps.db
    .insert(notifications)
    .values({
      userId: target.userId,
      orderId,
      channel: selection.status === 'send' ? selection.channel : null,
      template: data.template,
      payload: {
        orderEventId: data.orderEventId,
        audience: 'client',
        ...(data.reminder ? { reminder: true } : {}),
      },
      dedupeKey,
      status: 'queued',
    })
    .onConflictDoNothing({ target: notifications.dedupeKey });
  const [row] = await rowsOf(deps.db, dedupeKey);
  if (!row) throw new Error('notify/order: notifications row vanished');
  if (row.status !== 'queued') return { status: 'duplicate', existing: row.status };

  // The row stays locked while the message is sent: a concurrent copy of the job (the guard
  // lets the same dedupe key through) waits and then sees the final status.
  type Outcome =
    | { kind: 'duplicate'; status: string | null }
    | { kind: 'missing' }
    | { kind: 'error'; error: unknown; message: string; final: boolean; unrecoverable: boolean }
    | { kind: 'done'; result: NotifyResult };
  const outcome = await deps.db.transaction(async (tx): Promise<Outcome> => {
    const status = await lockRow(tx, row.id);
    if (status !== 'queued') return { kind: 'duplicate', status };
    const sendAt = deps.now();

    // decision_needed asks the client to act: a job for an approval that was decided (or
    // replaced) meanwhile — a retry after backoff, a late reminder — must not send «нужно ваше
    // решение» about nothing.
    let approval: OpenApproval | null = null;
    if (data.template === 'decision_needed') {
      approval = await currentApproval(tx, orderId, ctx.payload);
      if (approval === null) {
        await tx
          .update(notifications)
          .set({
            status: 'skipped',
            fallbackReason: APPROVAL_CLOSED,
            attempts: sql`${notifications.attempts} + 1`,
            updatedAt: sendAt,
          })
          .where(eq(notifications.id, row.id));
        return {
          kind: 'done',
          result: { status: 'skipped', fallbackReason: APPROVAL_CLOSED, blocked: [] },
        };
      }
    }

    const loaded = await templateData(ctx, sendAt);
    if (loaded === null) return { kind: 'missing' };

    let result: NotifyResult;
    try {
      result = await createNotifier({ drivers }).send(
        target.recipient,
        data.template,
        loaded.data,
        { dedupeKey },
      );
    } catch (error) {
      const unrecoverable = error instanceof UnrecoverableSmsError;
      const final = unrecoverable || isFinalAttempt(job);
      const message = safeError(error);
      await tx
        .update(notifications)
        .set({
          attempts: sql`${notifications.attempts} + 1`,
          error: message,
          ...(final ? { status: 'failed' as const } : {}),
          updatedAt: deps.now(),
        })
        .where(eq(notifications.id, row.id));
      if (final) {
        await afterDecisionNeeded(tx, ctx, approval, {
          outcome: 'failed',
          reason: message,
          sendAt,
        });
      }
      return { kind: 'error', error, message, final, unrecoverable };
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
    for (const blocked of result.blocked) {
      if (blocked.channel === 'sms') continue;
      await tx
        .update(messengerBindings)
        .set({ blockedAt: at, updatedAt: at })
        .where(
          and(
            eq(messengerBindings.userId, target.userId),
            eq(messengerBindings.channel, blocked.channel),
            eq(messengerBindings.chatId, blocked.address),
            isNull(messengerBindings.blockedAt),
          ),
        );
    }
    await afterDecisionNeeded(
      tx,
      ctx,
      approval,
      result.status === 'sent'
        ? { outcome: 'sent', channel: result.channel, sendAt }
        : { outcome: 'skipped', reason: result.fallbackReason, sendAt },
    );
    return { kind: 'done', result };
  });

  switch (outcome.kind) {
    case 'duplicate':
      return { status: 'duplicate', existing: outcome.status ?? 'missing' };
    case 'missing':
      return { status: 'missing' };
    case 'error':
      if (outcome.final) nudge(deps);
      deps.logger.warn(
        { orderId, template: data.template, err: outcome.message, final: outcome.final },
        'client notification failed',
      );
      if (outcome.unrecoverable) throw new UnrecoverableError(outcome.message);
      throw outcome.error;
    case 'done':
      nudge(deps);
      return outcome.result.status === 'sent'
        ? { status: 'sent', channel: outcome.result.channel }
        : { status: 'skipped', fallbackReason: outcome.result.fallbackReason };
  }
}

/**
 * Decision Б16: the approval timer starts only when decision_needed was really delivered.
 * Only the first decision_needed of an open approval counts (a reminder never moves the timer).
 */
async function afterDecisionNeeded(
  tx: Executor,
  ctx: NotifyContext,
  open: OpenApproval | null,
  result:
    | { outcome: 'sent'; channel: NotificationChannel; sendAt: Date }
    | { outcome: 'skipped' | 'failed'; reason: string; sendAt: Date },
): Promise<void> {
  const { deps, data, orderId, settings } = ctx;
  if (data.template !== 'decision_needed' || data.reminder || open === null) return;
  // recordJournalEvent expects the order row lock.
  await tx.select({ id: orders.id }).from(orders).where(eq(orders.id, orderId)).for('update');
  // Re-read under the order lock: the approval the check before sending found.
  const [approval] = await tx
    .select({ id: clientApprovals.id, notifiedAt: clientApprovals.notifiedAt })
    .from(clientApprovals)
    .where(and(eq(clientApprovals.id, open.id), isNull(clientApprovals.decidedAt)))
    .limit(1);
  if (!approval || approval.notifiedAt !== null) return;
  const at = deps.now();

  if (result.outcome === 'sent') {
    const expiresAt = new Date(result.sendAt.getTime() + settings.approvalTimeoutH * HOUR_MS);
    await tx
      .update(clientApprovals)
      .set({ notifiedAt: result.sendAt, expiresAt, updatedAt: at })
      .where(eq(clientApprovals.id, approval.id));
    await recordJournalEvent(tx, {
      orderId,
      type: 'approval_notified',
      actor: SYSTEM_ACTOR,
      payload: {
        approvalId: approval.id,
        channel: result.channel,
        expiresAt: expiresAt.toISOString(),
        orderEventId: data.orderEventId,
      },
      at,
    });
    return;
  }

  const { orderEventId } = await recordJournalEvent(tx, {
    orderId,
    type: 'approval_unreachable',
    actor: SYSTEM_ACTOR,
    payload: { approvalId: approval.id, reason: result.reason, orderEventId: data.orderEventId },
    at,
  });
  await enqueueOutbox(tx, {
    queue: 'notify',
    name: 'order',
    key: `notify:${orderEventId}:staff_approval_unreachable`,
    data: {
      orderId,
      orderEventId,
      audience: 'sellers',
      template: 'staff_approval_unreachable',
    },
  });
}

/** notifications rows of an order event, any audience and template (diagnostics, tests). */
export async function notificationsOfEvent(db: Executor, orderEventId: string) {
  return db
    .select()
    .from(notifications)
    .where(sql`starts_with(${notifications.dedupeKey}, ${`${orderEventId}:`})`)
    .orderBy(asc(notifications.createdAt));
}
