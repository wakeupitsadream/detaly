/**
 * Outbox rows, journal events and the client reachability check. All of them run inside the
 * caller's transaction (which holds the order row lock).
 */
import type { OutboxQueue } from '@detaly/config';
import {
  and,
  eq,
  isNull,
  messengerBindings,
  orderEvents,
  orders,
  outbox,
  sql,
  users,
} from '@detaly/db';
import type {
  JournalEvent,
  NotificationChannel,
  NotifyAudience,
  OrderNotifyTemplate,
} from '@detaly/domain';
import { selectChannel } from '@detaly/notify';
import { v7 as uuidv7 } from 'uuid';
import { isUuid } from './snapshot';
import type { ActorRef, Tx } from './types';

/** `insert ... on conflict (job_id) do nothing returning`; false when the key was queued already. */
export async function enqueueOutbox(
  tx: Tx,
  input: {
    queue: OutboxQueue;
    name: string;
    /** Logical job key in PLAN format (outbox.job_id). */
    key: string;
    data?: Record<string, unknown>;
    availableAt?: Date;
  },
): Promise<boolean> {
  const rows = await tx
    .insert(outbox)
    .values({
      queue: input.queue,
      name: input.name,
      jobId: input.key,
      data: input.data ?? {},
      ...(input.availableAt ? { availableAt: input.availableAt } : {}),
    })
    .onConflictDoNothing({ target: outbox.jobId })
    .returning({ id: outbox.id });
  return rows.length > 0;
}

/** notify/order outbox row for one rule notification: key `notify:<order_event_id>:<template>`. */
export async function enqueueNotify(
  tx: Tx,
  input: {
    orderId: string;
    orderEventId: string;
    audience: NotifyAudience;
    template: OrderNotifyTemplate;
  },
): Promise<boolean> {
  return enqueueOutbox(tx, {
    queue: 'notify',
    name: 'order',
    key: `notify:${input.orderEventId}:${input.template}`,
    data: {
      orderId: input.orderId,
      orderEventId: input.orderEventId,
      audience: input.audience,
      template: input.template,
    },
  });
}

/** A journal event (JOURNAL_EVENTS) without a status change; the caller holds the lock. */
export async function recordJournalEvent(
  tx: Tx,
  input: {
    orderId: string;
    type: JournalEvent;
    actor: ActorRef;
    payload?: Record<string, unknown>;
    /** Event time (the engine clock); default now() of the database. */
    at?: Date;
  },
): Promise<{ orderEventId: string }> {
  const id = uuidv7();
  await tx.insert(orderEvents).values({
    id,
    orderId: input.orderId,
    type: input.type,
    fromStatus: null,
    toStatus: null,
    actorType: input.actor.type,
    actorId: input.actor.id,
    payload: input.payload ?? {},
    ...(input.at ? { createdAt: input.at } : {}),
  });
  return { orderEventId: id };
}

/** Messenger channels with client drivers. Telegram/MAX bindings appear in 1C/2 with drivers. */
const MESSENGER_CHANNELS: readonly NotificationChannel[] = ['telegram', 'max'];

/**
 * clientReachable (decision Б16): an unblocked messenger binding, or a phone with an enabled
 * SMS provider and the template in the SMS allowlist. The phone itself is not read: only
 * whether the user has a real (not anonymized) one.
 */
export async function canReachClient(
  tx: Tx,
  orderId: string,
  options: {
    smsEnabled: boolean;
    template: OrderNotifyTemplate;
    /** Messenger channels with a working driver (default telegram and max). */
    messengerChannels?: readonly NotificationChannel[];
  },
): Promise<boolean> {
  if (!isUuid(orderId)) return false;
  const [row] = await tx
    .select({
      userId: orders.userId,
      hasPhone: sql<boolean>`${users.phone} like '+%' and ${users.anonymizedAt} is null`,
    })
    .from(orders)
    .innerJoin(users, eq(users.id, orders.userId))
    .where(eq(orders.id, orderId));
  if (!row) return false;
  const bindings = await tx
    .select({
      channel: messengerBindings.channel,
      chatId: messengerBindings.chatId,
      isPrimary: messengerBindings.isPrimary,
    })
    .from(messengerBindings)
    .where(and(eq(messengerBindings.userId, row.userId), isNull(messengerBindings.blockedAt)));
  const available = new Set<NotificationChannel>(options.messengerChannels ?? MESSENGER_CHANNELS);
  if (options.smsEnabled) available.add('sms');
  const selection = selectChannel(
    {
      kind: 'client',
      bindings: bindings.map((b) => ({ ...b, blocked: false })),
      // Only presence matters for the choice; the number is not loaded.
      phone: row.hasPhone ? 'present' : null,
    },
    options.template,
    available,
  );
  return selection.status === 'send';
}
