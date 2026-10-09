// Dependencies of every job processor and the seller bot (docs/phase-1b-implementation.md
// section 4.3). Processors have one signature, `(job, deps) => Promise<unknown>`; ports hide
// Telegram and BullMQ details so processors are tested with recording fakes
// (test/helpers/test-deps.ts). create-deps.ts (wave 3, worker-core) builds the real object.
import type { Env, Logger, QueueName, Redis } from '@detaly/config';
import type { Db } from '@detaly/db';
import type { OrderNotifyTemplate } from '@detaly/domain';
import type { FileStore } from '@detaly/files';
import type { ChannelDriver } from '@detaly/notify';
import type { EngineDeps } from '@detaly/orders';
import type { PaymentProvider, ReceiptProvider } from '@detaly/payments';
import type { RosskoClient } from '@detaly/rossko';
import type { Job } from 'bullmq';
import type { Api } from 'grammy';
import type { Queues } from './queues';

/**
 * Seller bot cards (decision Б17): the bot renders them from the database state, one message and
 * one nonce per card (table seller_cards).
 */
/**
 * What SellerCardPort.post did: `skipped` when nothing reached the chat (no seller bot token or
 * chat id, or the order is gone), so the notifications row is not recorded as `sent`.
 */
export type SellerCardPostResult =
  { status: 'posted' } | { status: 'skipped'; fallbackReason: string };

export interface SellerCardPort {
  /** A new card for the order; closes the order's older open cards. */
  post(input: {
    orderId: string;
    /** The staff template that caused the card (staff_new_order, staff_problem, ...). */
    template?: OrderNotifyTemplate | null;
    orderEventId?: string | null;
    /** Extra line without PD. */
    note?: string | null;
  }): Promise<SellerCardPostResult>;
  /** Redraws the latest open card of the order (new buttons, e.g. «Выдал» after the receipt). */
  refresh(orderId: string): Promise<void>;
  /** QR photo of the handover payment, to the sellers chat only (never to the client). */
  sendHandoverQr(input: {
    orderId: string;
    paymentId: string;
    /** payments.confirmation_data (QR payload). */
    confirmationData: string;
    expiresAt: Date | null;
  }): Promise<void>;
  /**
   * Phase 1C: a new card of a VIN request (seller_cards kind 'vin'); closes its older open
   * cards. `note` is an extra line without PD («Без ответа 4 ч»).
   */
  postVin(input: { vinRequestId: string; note?: string | null }): Promise<SellerCardPostResult>;
  /** Phase 1C: redraws the latest open card of the VIN request (preview, status). */
  refreshVin(vinRequestId: string): Promise<void>;
  /**
   * Step 4 (docs/fit-check.md): a new fit check card of a request (seller_cards kind 'fit');
   * closes its older open cards. `note` is an extra line without PD (the SLA reminder).
   */
  postFit(input: { requestId: string; note?: string | null }): Promise<SellerCardPostResult>;
  /** Step 4: redraws the open fit check card of the request (answers, expiry, cancellation). */
  refreshFit(requestId: string): Promise<void>;
}

/** Alerts to the sellers chat or the owner's private chat (Б19); deduplicated by key. */
export interface AlertPort {
  send(input: {
    audience: 'sellers' | 'owner';
    /** Russian text without PD. */
    text: string;
    /** notifications.dedupe_key = `alert:<dedupeKey>`. */
    dedupeKey: string;
  }): Promise<void>;
}

export interface QueueStats {
  queue: QueueName;
  waiting: number;
  active: number;
  delayed: number;
  failed: number;
  completed: number;
}

/** A job parked in dead-letter (decision Б30); `error` has no PD. */
export interface DeadLetterView {
  /** dead-letter job id: `${queue}|${original job id}`. */
  id: string;
  queue: string;
  name: string;
  jobId: string | null;
  error: string;
  failedAt: string;
}

/** `/queues` in the seller bot. */
export interface QueueInspector {
  stats(): Promise<QueueStats[]>;
  deadLetters(limit: number): Promise<DeadLetterView[]>;
  /** Puts the job back into its queue with its original id; false when it is gone. */
  retryDeadLetter(id: string): Promise<boolean>;
}

/**
 * Telegram Bot API of the seller bot token (grammY `Api`; it satisfies TelegramSender of
 * @detaly/notify). null when TG_SELLER_BOT_TOKEN is empty.
 */
export type SellerTelegramApi = Api;

/**
 * Telegram Bot API of the client bot (TG_CLIENT_BOT_TOKEN, phase 1C): client notifications go
 * through createTelegramDriver over it, the client bot polls with its own Bot. null without the
 * token (Telegram is then skipped for clients).
 */
export type ClientTelegramApi = Api;

export interface WorkerDeps {
  db: Db;
  /** Commands client (createRedis): heartbeat, SMS limits, bot state. */
  redis: Redis;
  logger: Logger;
  env: Env;
  now: () => Date;
  /**
   * Prefix of the worker's own Redis keys (Rossko limiter and cache, SMS limits): '' in
   * production, shared with web for the Rossko quota; tests: `test:<uuid>:`. BullMQ and the
   * heartbeat have their own `detaly:` keys (bullPrefix, heartbeatKey).
   */
  keyPrefix: string;
  /** BullMQ prefix (BULLMQ_PREFIX in production). */
  bullPrefix: string;
  /** Heartbeat key (HEARTBEAT_KEY in production). */
  heartbeatKey: string;
  queues: Queues;
  /** The order engine with `nudge` (PUBLISH OUTBOX_CHANNEL). */
  engine: EngineDeps;
  /** null while payments are off (decision Б6: the 4 YooKassa variables are not all set). */
  payments: PaymentProvider | null;
  receipts: ReceiptProvider | null;
  rossko: RosskoClient;
  /** null with SMS_PROVIDER=none. */
  smsDriver: ChannelDriver | null;
  telegram: SellerTelegramApi | null;
  /** Phase 1C: the client bot API; null without TG_CLIENT_BOT_TOKEN. */
  clientTelegram: ClientTelegramApi | null;
  /** Phase 1C: the MAX driver is phase 2 — always null, selectChannel skips MAX. */
  maxDriver: ChannelDriver | null;
  /** Phase 1C: photos (FILES_STORAGE; `none` throws FilesDisabledError on put). */
  files: FileStore;
  /** Phase 1C: HTTP for downloading Telegram files (photos sent to the bots); tests fake it. */
  fetch: typeof fetch;
  sellerCards: SellerCardPort;
  alerts: AlertPort;
  inspector: QueueInspector;
}

/** The final signature of every queue processor. */
export type JobProcessor = (job: Job, deps: WorkerDeps) => Promise<unknown>;
