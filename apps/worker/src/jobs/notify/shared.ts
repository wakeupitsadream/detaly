// Pieces shared by notify/order and notify/vin: the client drivers (decision С1), the
// notifications row helpers (row before sending, lock while sending) and error texts without PD.
import {
  and,
  asc,
  eq,
  isNull,
  messengerBindings,
  notifications,
  sql,
  type Executor,
} from '@detaly/db';
import {
  ChannelBlockedError,
  createTelegramDriver,
  SmsGatewayError,
  TelegramRateLimitError,
  UnrecoverableSmsError,
  type ChannelAddress,
  type ChannelDriver,
  type MessengerBindingInfo,
} from '@detaly/notify';
import type { WorkerDeps } from '../../deps';
import { guardedSmsDriver } from './sms';

/**
 * Client drivers (docs/phase-1c-implementation.md decision С1, section 7.2 item 1): MAX when
 * configured (phase 2: deps.maxDriver is null in 1C), Telegram over the client bot
 * (TG_CLIENT_BOT_TOKEN; the packaging photo is read from the FileStore), SMS behind the guard.
 * selectChannel picks among them by the client's bindings and the SMS allowlist.
 */
export function clientDrivers(deps: WorkerDeps): ChannelDriver[] {
  const drivers: ChannelDriver[] = [];
  if (deps.maxDriver) drivers.push(deps.maxDriver);
  if (deps.clientTelegram) {
    drivers.push(
      createTelegramDriver({
        api: deps.clientTelegram,
        loadPhoto: async (key) => (await deps.files.get(key))?.bytes ?? null,
      }),
    );
  }
  if (deps.smsDriver) drivers.push(guardedSmsDriver(deps, deps.smsDriver));
  return drivers;
}

/** notifications.error / logs: provider and code for known errors, the class name otherwise. */
export function safeError(error: unknown): string {
  if (
    error instanceof UnrecoverableSmsError ||
    error instanceof SmsGatewayError ||
    error instanceof ChannelBlockedError ||
    error instanceof TelegramRateLimitError
  ) {
    return error.message.slice(0, 200);
  }
  if (error instanceof Error) {
    const code = (error as { code?: unknown }).code;
    return typeof code === 'string' ? `${error.name}:${code}` : error.name;
  }
  return 'unknown';
}

/** The notifications rows whose dedupe key starts with `prefix` (any channel, decision Б20). */
export async function rowsOf(db: Executor, prefix: string) {
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

/** `select … for update` of a notifications row; its status (null when it is gone). */
export async function lockRow(tx: Executor, id: string): Promise<string | null> {
  const [locked] = await tx
    .select({ status: notifications.status })
    .from(notifications)
    .where(eq(notifications.id, id))
    .for('update');
  return locked?.status ?? null;
}

/** Messenger bindings of a user as channel selection needs them. */
export async function loadBindings(db: Executor, userId: string): Promise<MessengerBindingInfo[]> {
  const rows = await db
    .select({
      channel: messengerBindings.channel,
      chatId: messengerBindings.chatId,
      isPrimary: messengerBindings.isPrimary,
      blockedAt: messengerBindings.blockedAt,
    })
    .from(messengerBindings)
    .where(eq(messengerBindings.userId, userId));
  return rows.map((b) => ({
    channel: b.channel,
    chatId: b.chatId,
    isPrimary: b.isPrimary,
    blocked: b.blockedAt !== null,
  }));
}

/** A phone the SMS driver may use: E.164 of a user that is not anonymized. */
export function smsPhone(
  phone: string | null | undefined,
  anonymizedAt: Date | null,
): string | null {
  return anonymizedAt === null && typeof phone === 'string' && /^\+\d{10,15}$/.test(phone)
    ? phone
    : null;
}

/**
 * messenger_bindings.blocked_at for the chats the Notifier found blocked (Telegram 403 / «chat
 * not found»): later messages go straight to the next channel (decision С4, V2).
 */
export async function markBlocked(
  tx: Executor,
  userId: string,
  blocked: readonly ChannelAddress[],
  at: Date,
): Promise<void> {
  for (const item of blocked) {
    if (item.channel === 'sms') continue;
    await tx
      .update(messengerBindings)
      .set({ blockedAt: at, updatedAt: at })
      .where(
        and(
          eq(messengerBindings.userId, userId),
          eq(messengerBindings.channel, item.channel),
          eq(messengerBindings.chatId, item.address),
          isNull(messengerBindings.blockedAt),
        ),
      );
  }
}

/** The sellers chat id for notifications.chat_id. */
export function sellersChatId(deps: Pick<WorkerDeps, 'env'>): string {
  return deps.env.TG_SELLER_CHAT_ID === undefined ? 'sellers' : String(deps.env.TG_SELLER_CHAT_ID);
}

/** Wakes the outbox dispatcher after a commit that may have queued rows; never throws. */
export function nudge(deps: Pick<WorkerDeps, 'engine'>): void {
  try {
    deps.engine.nudge?.();
  } catch {
    // best effort: the dispatcher polls anyway (decision Б1)
  }
}
