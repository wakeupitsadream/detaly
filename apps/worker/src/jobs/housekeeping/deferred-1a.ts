// housekeeping/deferred-1a, every 10 minutes (decision Б26). Phase 1A recorded what it could not
// do yet in order_events.payload: `deferredNotify` (['client:order_cancelled', ...]) and
// `deferredEffects` (['create_payment', 'cancel_at_supplier_task']). This job queues them:
//
// - each notification -> outbox notify/order with key `deferred:<event_id>:<n>` and the 1A
//   event as orderEventId (so notifications.dedupe_key is the same as for an engine event);
// - create_payment is skipped: the payment is created lazily on /o/<token> (Б5);
// - cancel_at_supplier_task is the sellers' notification staff_cancel_at_supplier_task (as in
//   the engine); it is added when deferredNotify does not carry it already;
// - anything else is recorded as skipped in the journal.
//
// The journal is never edited: a `deferred_1a_processed` event marks the 1A event as done, and
// the outbox keys make a repeated pass (or a crash between the two) queue nothing twice.
import { eq, orderEvents, orders, sql } from '@detaly/db';
import {
  isOneOf,
  ORDER_NOTIFY_TEMPLATES,
  type NotifyAudience,
  type OrderNotifyTemplate,
} from '@detaly/domain';
import { enqueueOutbox, recordJournalEvent } from '@detaly/orders';
import type { WorkerDeps } from '../../deps';
import type { NotifyOrderJobData } from '../notify/order';
import { BATCH, HOUSEKEEPING_ACTOR, nudge } from './common';

const AUDIENCES = ['client', 'sellers', 'owner'] as const satisfies readonly NotifyAudience[];

/** Effects done by the engine or web elsewhere: nothing to queue. */
const SKIPPED_EFFECTS = new Set(['create_payment']);

export interface DeferredPlan {
  notify: { audience: NotifyAudience; template: OrderNotifyTemplate }[];
  /** Entries that could not be understood or have no 1B equivalent (journal only). */
  skipped: string[];
}

/** Pure: what a 1A payload owes. Order is stable, so `deferred:<event>:<n>` keys are too. */
export function planDeferred(payload: Record<string, unknown>): DeferredPlan {
  const plan: DeferredPlan = { notify: [], skipped: [] };
  const has = (audience: NotifyAudience, template: OrderNotifyTemplate) =>
    plan.notify.some((n) => n.audience === audience && n.template === template);
  const notify = Array.isArray(payload.deferredNotify) ? payload.deferredNotify : [];
  for (const entry of notify) {
    const [audience, template] = typeof entry === 'string' ? entry.split(':') : [];
    if (isOneOf(AUDIENCES, audience) && isOneOf(ORDER_NOTIFY_TEMPLATES, template)) {
      if (!has(audience, template)) plan.notify.push({ audience, template });
    } else {
      plan.skipped.push(`notify:${String(entry)}`);
    }
  }
  const effects = Array.isArray(payload.deferredEffects) ? payload.deferredEffects : [];
  for (const effect of effects) {
    if (typeof effect === 'string' && SKIPPED_EFFECTS.has(effect)) continue;
    if (effect === 'cancel_at_supplier_task') {
      if (!has('sellers', 'staff_cancel_at_supplier_task')) {
        plan.notify.push({ audience: 'sellers', template: 'staff_cancel_at_supplier_task' });
      }
      continue;
    }
    plan.skipped.push(`effect:${String(effect)}`);
  }
  return plan;
}

export interface Deferred1aResult {
  events: number;
  queued: number;
}

export async function runDeferred1a(deps: WorkerDeps): Promise<Deferred1aResult> {
  // 1A events that owe something besides create_payment and were not processed yet.
  const rows = await deps.db
    .select({ id: orderEvents.id, orderId: orderEvents.orderId, payload: orderEvents.payload })
    .from(orderEvents)
    .where(
      sql`(
        (jsonb_typeof(${orderEvents.payload} -> 'deferredNotify') = 'array'
          and jsonb_array_length(${orderEvents.payload} -> 'deferredNotify') > 0)
        or (jsonb_typeof(${orderEvents.payload} -> 'deferredEffects') = 'array'
          and exists (
            select 1 from jsonb_array_elements(${orderEvents.payload} -> 'deferredEffects') as e(v)
            where e.v <> '"create_payment"'::jsonb
          ))
      )
      and not exists (
        select 1 from ${orderEvents} as d
        where d.order_id = ${orderEvents.orderId}
          and d.type = 'deferred_1a_processed'
          and d.payload ->> 'eventId' = ${orderEvents.id}::text
      )`,
    )
    .orderBy(orderEvents.createdAt)
    .limit(BATCH);

  const result: Deferred1aResult = { events: 0, queued: 0 };
  for (const row of rows) {
    const plan = planDeferred(row.payload ?? {});
    const queued = await deps.db.transaction(async (tx) => {
      // recordJournalEvent expects the order row lock.
      await tx
        .select({ id: orders.id })
        .from(orders)
        .where(eq(orders.id, row.orderId))
        .for('update');
      let count = 0;
      for (const [n, spec] of plan.notify.entries()) {
        const data: NotifyOrderJobData = {
          orderId: row.orderId,
          orderEventId: row.id,
          audience: spec.audience,
          template: spec.template,
        };
        const inserted = await enqueueOutbox(tx, {
          queue: 'notify',
          name: 'order',
          key: `deferred:${row.id}:${n}`,
          data: { ...data },
        });
        if (inserted) count += 1;
      }
      await recordJournalEvent(tx, {
        orderId: row.orderId,
        type: 'deferred_1a_processed',
        actor: HOUSEKEEPING_ACTOR,
        payload: {
          eventId: row.id,
          queued: plan.notify.map((spec) => `${spec.audience}:${spec.template}`),
          ...(plan.skipped.length > 0 ? { skipped: plan.skipped } : {}),
        },
        at: deps.now(),
      });
      return count;
    });
    result.events += 1;
    result.queued += queued;
  }
  if (result.queued > 0) nudge(deps);
  return result;
}
