// AlertPort over the seller bot's Telegram API (docs/phase-1b-implementation.md section 9.6,
// decision Б19). `owner` goes to the owner's private chat (staff.role='owner', tg_user_id) and
// falls back to the sellers chat when Telegram refuses it (403: the owner never started the bot;
// 400: chat not found); `sellers` goes to TG_SELLER_CHAT_ID.
//
// A notifications row (chat_id, dedupe_key = `alert:<dedupeKey>`) is written before the send:
// a key that was sent (or skipped) once is never sent again, so a retried job or a repeated
// dead-letter event does not spam the chat. Without a bot token the row is `skipped`.
//
// An owner alert with `fallbackText` (step 7: the monthly close) sends that text instead when it
// lands in the sellers chat, so the figures meant for the owner stay out of the shared chat.
import type { Logger } from '@detaly/config';
import { and, asc, eq, isNotNull, notifications, sql, staff, type Db } from '@detaly/db';
import { FALLBACK_REASONS, type TelegramSender } from '@detaly/notify';
import type { AlertPort } from './deps';
import { redactText, safeErrorMessage } from './dead-letter/safe-error';

/** notifications.template of alerts. */
export const ALERT_TEMPLATE = 'alert';

/** A queued row younger than this belongs to a send in flight: a second caller backs off. */
export const ALERT_IN_FLIGHT_MS = 2 * 60_000;

/** Telegram allows 4096 characters; alerts are short, the cap protects against a huge error. */
const ALERT_TEXT_MAX = 3500;

export function alertDedupeKey(key: string): string {
  return `alert:${key}`;
}

export interface CreateAlertsOptions {
  db: Db;
  /** Seller bot API (deps.telegram); null without TG_SELLER_BOT_TOKEN. */
  telegram: TelegramSender | null;
  /** TG_SELLER_CHAT_ID. */
  sellerChatId: number | null | undefined;
  logger: Pick<Logger, 'info' | 'warn' | 'error'>;
  now?: () => Date;
}

interface Target {
  chatId: string;
  /** staff.id when the chat is the owner's private chat. */
  staffId: string | null;
  owner: boolean;
}

function telegramErrorCode(error: unknown): number | null {
  const code = (error as { error_code?: unknown } | null)?.error_code;
  return typeof code === 'number' ? code : null;
}

/** The owner's private chat is unusable (bot not started, user unknown): use the next chat. */
function isUnreachableChat(error: unknown): boolean {
  const code = telegramErrorCode(error);
  return code === 403 || code === 400;
}

export function createAlerts(options: CreateAlertsOptions): AlertPort {
  const { db, telegram, sellerChatId, logger } = options;
  const now = options.now ?? (() => new Date());

  async function ownerTarget(): Promise<Target | null> {
    const [owner] = await db
      .select({ id: staff.id, tgUserId: staff.tgUserId })
      .from(staff)
      .where(and(eq(staff.role, 'owner'), eq(staff.isActive, true), isNotNull(staff.tgUserId)))
      .orderBy(asc(staff.createdAt))
      .limit(1);
    if (!owner || owner.tgUserId === null) return null;
    return { chatId: String(owner.tgUserId), staffId: owner.id, owner: true };
  }

  async function targetsFor(audience: 'sellers' | 'owner'): Promise<Target[]> {
    const sellers: Target | null =
      sellerChatId === undefined || sellerChatId === null
        ? null
        : { chatId: String(sellerChatId), staffId: null, owner: false };
    const list = audience === 'owner' ? [await ownerTarget(), sellers] : [sellers];
    return list.filter((target): target is Target => target !== null);
  }

  return {
    async send({ audience, text, dedupeKey, fallbackText }) {
      const key = alertDedupeKey(dedupeKey);
      const body = redactText(text, ALERT_TEXT_MAX);
      const fallbackBody =
        audience === 'owner' && fallbackText !== undefined && fallbackText.trim() !== ''
          ? redactText(fallbackText, ALERT_TEXT_MAX)
          : null;
      /** The text a target gets: the sellers chat of an owner alert may get the fallback. */
      const textFor = (target: Target): string =>
        !target.owner && fallbackBody !== null ? fallbackBody : body;

      const [existing] = await db
        .select({
          id: notifications.id,
          status: notifications.status,
          updatedAt: notifications.updatedAt,
        })
        .from(notifications)
        .where(eq(notifications.dedupeKey, key))
        .limit(1);
      if (existing?.status === 'sent' || existing?.status === 'skipped') return;
      if (
        existing?.status === 'queued' &&
        now().getTime() - existing.updatedAt.getTime() < ALERT_IN_FLIGHT_MS
      ) {
        return;
      }

      const targets = await targetsFor(audience);
      const first = targets[0];
      if (first === undefined) {
        // notifications needs a recipient: without any chat there is nothing to record.
        logger.warn({ audience, dedupeKey: key }, 'alert has no chat (TG_SELLER_CHAT_ID unset)');
        return;
      }

      let rowId = existing?.id;
      if (rowId === undefined) {
        const [inserted] = await db
          .insert(notifications)
          .values({
            chatId: first.chatId,
            staffId: first.staffId,
            channel: 'telegram',
            template: ALERT_TEMPLATE,
            payload: { audience, text: textFor(first) },
            dedupeKey: key,
            status: 'queued',
          })
          .onConflictDoNothing({ target: notifications.dedupeKey })
          .returning({ id: notifications.id });
        // Lost the race to a concurrent send of the same key.
        if (!inserted) return;
        rowId = inserted.id;
      }

      if (telegram === null) {
        await db
          .update(notifications)
          .set({ status: 'skipped', fallbackReason: FALLBACK_REASONS.driverUnavailable })
          .where(eq(notifications.id, rowId));
        logger.warn({ audience, dedupeKey: key }, 'alert skipped: TG_SELLER_BOT_TOKEN is empty');
        return;
      }

      let lastError: unknown = null;
      for (const [index, target] of targets.entries()) {
        const sent = textFor(target);
        try {
          await telegram.sendMessage(target.chatId, sent, {
            link_preview_options: { is_disabled: true },
          });
          await db
            .update(notifications)
            .set({
              status: 'sent',
              sentAt: now(),
              chatId: target.chatId,
              staffId: target.staffId,
              payload: { audience, text: sent },
              fallbackReason: index > 0 ? 'owner_chat_unreachable' : null,
              attempts: sql`${notifications.attempts} + 1`,
              error: null,
            })
            .where(eq(notifications.id, rowId));
          logger.info({ audience, dedupeKey: key, owner: target.owner }, 'alert sent');
          return;
        } catch (error) {
          lastError = error;
          // Only an unreachable owner chat falls through to the sellers chat.
          if (!(target.owner && isUnreachableChat(error))) break;
        }
      }

      const message = safeErrorMessage(lastError);
      await db
        .update(notifications)
        .set({ status: 'failed', attempts: sql`${notifications.attempts} + 1`, error: message })
        .where(eq(notifications.id, rowId));
      logger.error({ audience, dedupeKey: key, err: message }, 'alert failed');
      throw new Error(`alert failed: ${message}`);
    },
  };
}
