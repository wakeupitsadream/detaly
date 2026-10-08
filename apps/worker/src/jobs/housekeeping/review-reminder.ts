// The one review reminder of housekeeping/reminders (step 3, docs/reviews.md):
//
// | kind   | when                                                  | to     | template        |
// | review | reviews.reminder_days (3) after `completed`, once     | client | review_reminder |
// |        | key reminder:<order>:review:1                         |        |                 |
//
// Only while the order is still completed, no review link of it was opened (journal
// `review_link_opened`), no claim was opened after the handover, a review link is set
// (REVIEW_URL_*) and the client has an unblocked messenger: the template is not in the SMS
// allowlist. The outbox key and the notifications row of notify/order make it go out once
// however often the job runs or the worker restarts; notify/order checks the same facts again
// right before sending (a link opened meanwhile cancels it). The order itself never changes.
import { reviewPlatforms, type Env } from '@detaly/config';
import {
  and,
  asc,
  claims,
  eq,
  gt,
  messengerBindings,
  orderEvents,
  orders,
  outbox,
  sql,
  type Executor,
  type SQL,
} from '@detaly/db';
import {
  REVIEW_REMINDER_GRACE_DAYS,
  reviewReminderVerdict,
  type JournalEvent,
  type ReviewReminderFacts,
  type ReviewReminderVerdict,
} from '@detaly/domain';
import type { OrderSettings } from '@detaly/orders';
import type { WorkerDeps } from '../../deps';
import { BATCH, DAY_MS, notAfter, queueReminder } from './common';

const LINK_OPENED: JournalEvent = 'review_link_opened';

/** Outbox key of the reminder of an order (queueReminder: `reminder:<order>:<kind>:<n>`). */
export function reviewReminderKey(orderId: string): string {
  return `reminder:${orderId}:review:1`;
}

/** A review link of the order was opened (the redirect journals the first open per platform). */
function linkOpenedSql(): SQL {
  return sql`exists (select 1 from ${orderEvents} where ${orderEvents.orderId} = ${orders.id} and ${orderEvents.type} = ${LINK_OPENED})`;
}

/** A claim opened after the handover (a delay claim before it does not count). */
function claimAfterHandoverSql(): SQL {
  return sql`exists (select 1 from ${claims} where ${claims.orderId} = ${orders.id} and ${claims.openedAt} >= ${orders.handedAt})`;
}

/** An unblocked messenger binding of the client: the reminder never goes by SMS. */
function messengerSql(): SQL {
  return sql`exists (select 1 from ${messengerBindings} where ${messengerBindings.userId} = ${orders.userId} and ${messengerBindings.blockedAt} is null)`;
}

/** The facts of one order (null: no such order). */
export async function loadReviewReminderFacts(
  db: Executor,
  input: {
    orderId: string;
    now: Date;
    settings: Pick<OrderSettings, 'reviewReminderDays'>;
    env: Pick<Env, 'REVIEW_URL_YANDEX' | 'REVIEW_URL_2GIS'>;
  },
): Promise<ReviewReminderFacts | null> {
  const [row] = await db
    .select({
      status: orders.status,
      completedAt: orders.completedAt,
      linkOpened: sql<boolean>`${linkOpenedSql()}`,
      claimAfterHandover: sql<boolean>`${claimAfterHandoverSql()}`,
      hasMessenger: sql<boolean>`${messengerSql()}`,
    })
    .from(orders)
    .where(eq(orders.id, input.orderId));
  if (!row) return null;
  return {
    status: row.status,
    completedAt: row.completedAt,
    now: input.now,
    reminderDays: input.settings.reviewReminderDays,
    linkOpened: row.linkOpened === true,
    claimAfterHandover: row.claimAfterHandover === true,
    linksConfigured: reviewPlatforms(input.env).length > 0,
    hasMessenger: row.hasMessenger === true,
  };
}

/** The verdict for one order now; 'not_completed' for a missing order. */
export async function reviewReminderCheck(
  db: Executor,
  input: Parameters<typeof loadReviewReminderFacts>[1],
): Promise<ReviewReminderVerdict> {
  const facts = await loadReviewReminderFacts(db, input);
  return facts === null ? 'not_completed' : reviewReminderVerdict(facts);
}

/**
 * Queues the reminders due now (a batch per run). Without a review link or with
 * reviews.reminder_days = 0 nothing is read at all.
 */
export async function runReviewReminders(
  deps: WorkerDeps,
  now: Date,
  settings: Pick<OrderSettings, 'reviewReminderDays'>,
  add: (kind: string, queued: boolean) => void,
): Promise<void> {
  const days = settings.reviewReminderDays;
  if (days <= 0 || reviewPlatforms(deps.env).length === 0) return;
  const nowMs = now.getTime();
  // Completed `days` ago, at most REVIEW_REMINDER_GRACE_DAYS late (after a long stop of the
  // worker or when the links are set long after launch, old orders get nothing).
  const dueBefore = new Date(nowMs - days * DAY_MS);
  const notBefore = new Date(nowMs - (days + REVIEW_REMINDER_GRACE_DAYS) * DAY_MS);
  const rows = await deps.db
    .select({ id: orders.id })
    .from(orders)
    .where(
      and(
        eq(orders.status, 'completed'),
        notAfter(orders.completedAt, dueBefore),
        gt(orders.completedAt, notBefore),
        // Queued before: the next runs skip it (the batch is never filled by old orders).
        sql`not exists (select 1 from ${outbox} where ${outbox.jobId} = 'reminder:' || ${orders.id}::text || ':review:1')`,
        sql`not ${linkOpenedSql()}`,
        sql`not ${claimAfterHandoverSql()}`,
        messengerSql(),
      ),
    )
    .orderBy(asc(orders.completedAt))
    .limit(BATCH);
  for (const order of rows) {
    const verdict = await reviewReminderCheck(deps.db, {
      orderId: order.id,
      now,
      settings,
      env: deps.env,
    });
    if (verdict !== 'due') continue;
    add(
      'review',
      await queueReminder(deps, {
        orderId: order.id,
        kind: 'review',
        n: 1,
        audience: 'client',
        template: 'review_reminder',
      }),
    );
  }
}
