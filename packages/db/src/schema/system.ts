// Notifications log, incoming webhook idempotency, external API calls and search log.
import { sql } from 'drizzle-orm';
import {
  boolean,
  index,
  inet,
  integer,
  jsonb,
  pgTable,
  text,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { createdAt, id, kop, kopCheck, namedCheck, tstz, updatedAt } from './columns';
import { apiCallSource, notificationChannel, notificationStatus, webhookSource } from './enums';
import { vinRequests } from './carts';
import { orders } from './orders';
import { staff, users } from './people';

/**
 * The fate of every message. The row is written before sending; dedupe_key is
 * `${order_event_id}:${template}:${channel ?? 'none'}` (decision Б20) or `alert:<key>`.
 * channel is null when nothing could be chosen (status `skipped`, fallback_reason says why).
 * Messages to a fixed chat (sellers chat, alerts) carry chat_id instead of a user or staff id.
 */
export const notifications = pgTable(
  'notifications',
  {
    id: id(),
    userId: uuid().references(() => users.id),
    staffId: uuid().references(() => staff.id),
    orderId: uuid().references(() => orders.id),
    /** Fixed chat (sellers chat, owner's private chat) when there is no user/staff recipient. */
    chatId: text(),
    channel: notificationChannel(),
    template: text().notNull(),
    payload: jsonb().$type<Record<string, unknown>>().notNull().default({}),
    dedupeKey: text().notNull(),
    status: notificationStatus().notNull().default('queued'),
    fallbackReason: text(),
    attempts: integer().notNull().default(0),
    error: text(),
    sentAt: tstz(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    /**
     * Phase 1C (decision С20): a message about a VIN request (no order); dedupe_key is
     * `vin:<vin_request_id>:<template>:<n>:<channel>`.
     */
    vinRequestId: uuid().references(() => vinRequests.id),
  },
  (t) => [
    unique('notifications_dedupe_key_unique').on(t.dedupeKey),
    index('notifications_order_id_idx').on(t.orderId),
    index('notifications_vin_request_id_idx').on(t.vinRequestId),
    namedCheck(
      'notifications',
      'recipient',
      sql`${t.userId} is not null or ${t.staffId} is not null or ${t.chatId} is not null`,
    ),
    namedCheck('notifications', 'attempts', sql`${t.attempts} >= 0`),
  ],
);

/** Incoming webhooks; external_id = object.id (YooKassa has no event id) or MAX update id. */
export const webhookEvents = pgTable(
  'webhook_events',
  {
    id: id(),
    source: webhookSource().notNull(),
    externalId: text().notNull(),
    eventType: text().notNull(),
    payload: jsonb().notNull(),
    receivedAt: tstz().notNull().defaultNow(),
    processedAt: tstz(),
    /** WEBHOOK_RESULTS value written by the engine (processed, duplicate, stale, ...). */
    result: text(),
    /** Client IP as received (X-Real-IP from Caddy), for investigations. */
    ip: inet(),
  },
  (t) => [
    unique('webhook_events_source_external_id_event_type_unique').on(
      t.source,
      t.externalId,
      t.eventType,
    ),
    index('webhook_events_unprocessed_idx')
      .on(t.receivedAt)
      .where(sql`${t.processedAt} is null`),
  ],
);

/** Every external API call: Rossko quota, VIN catalogue cost, provider latency. */
export const apiCalls = pgTable(
  'api_calls',
  {
    id: id(),
    source: apiCallSource().notNull(),
    method: text().notNull(),
    durationMs: integer().notNull(),
    ok: boolean().notNull(),
    error: text(),
    costKop: kop().notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [
    index('api_calls_source_created_at_idx').on(t.source, t.createdAt),
    namedCheck('api_calls', 'duration_ms', sql`${t.durationMs} >= 0`),
    kopCheck('api_calls', 'cost_kop', t.costKop),
  ],
);

/** Demand and load statistics. The client IP is never stored. */
export const searchLog = pgTable(
  'search_log',
  {
    id: id(),
    query: text().notNull(),
    brand: text(),
    article: text(),
    resultsCount: integer().notNull(),
    fromCache: boolean().notNull(),
    latencyMs: integer().notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    index('search_log_created_at_idx').on(t.createdAt),
    namedCheck('search_log', 'results_count', sql`${t.resultsCount} >= 0`),
    namedCheck('search_log', 'latency_ms', sql`${t.latencyMs} >= 0`),
  ],
);
