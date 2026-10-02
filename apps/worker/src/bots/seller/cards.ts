// Seller bot cards (decision Б17, docs/phase-1b-implementation.md section 13.1). A card is one
// Telegram message in the sellers chat and one row of seller_cards with the nonce its buttons
// carry. The nonce is written before Telegram sees it and rotates on every redraw, so a button
// of an older rendering (or a second press of the same one) finds no card: «Карточка устарела».
//
// - post: a new card for the order; the order's older open cards are closed (keyboard removed);
// - refresh: the latest open card is redrawn from the database (e.g. «Выдал» after the receipt);
// - sendHandoverQr: the QR photo of a handover payment, to the sellers chat only (Б28).
//
// The same service backs the bot's button presses (redraw with a menu or the main keyboard);
// the bot builds it over its own Api, the queue jobs over deps.telegram.
import type { Env, Logger } from '@detaly/config';
import {
  and,
  asc,
  desc,
  eq,
  isNull,
  orderItems,
  orders,
  payments,
  sellerCards,
  sql,
  type Db,
} from '@detaly/db';
import { CLIENT_TIME_ZONE, formatRub } from '@detaly/domain';
import { FALLBACK_REASONS, newNonce } from '@detaly/notify';
import {
  availableStaffActions,
  loadClientPhone,
  loadOrderSettings,
  loadOrderSnapshot,
  type StaffActionView,
} from '@detaly/orders';
import { InputFile } from 'grammy';
import QRCode from 'qrcode';
import type { SellerCardPort, SellerTelegramApi, WorkerDeps } from '../../deps';
import { adminUrl } from '../../jobs/notify/template-data';
import {
  headlineFor,
  mainKeyboard,
  menuKeyboard,
  renderCardText,
  type CardData,
  type CardItem,
  type CardMenu,
  type InlineKeyboard,
} from './card-view';
import { describeBotError } from './errors';

export type SellerCardRow = typeof sellerCards.$inferSelect;

/**
 * Cards in the sellers chat are drawn with the owner's buttons: the owner reads the same chat,
 * and a seller pressing an owner-only button («Счёт оплачен») is refused at press time.
 */
export const CARD_ROLE = 'owner' as const;

const QR_CLOCK = new Intl.DateTimeFormat('en-GB', {
  timeZone: CLIENT_TIME_ZONE,
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

/** '2026-10-02T09:45:00Z' -> '14:45' (Asia/Yekaterinburg). */
export function clockTime(instant: Date): string {
  const parts: Record<string, string> = {};
  for (const part of QR_CLOCK.formatToParts(instant)) parts[part.type] = part.value;
  return `${parts.hour}:${parts.minute}`;
}

function description(error: unknown): string {
  const value = (error as { description?: unknown } | null)?.description;
  return typeof value === 'string' ? value : '';
}

/** Telegram refuses an edit that changes nothing; for a redraw that is success. */
export function isNotModified(error: unknown): boolean {
  return description(error).includes('message is not modified');
}

/** The card's message is gone (deleted in the chat, or too old to edit): close the card. */
export function isMessageGone(error: unknown): boolean {
  const text = description(error);
  return text.includes('message to edit not found') || text.includes("message can't be edited");
}

/** A url button needs http(s); the QR payload is a link (VERIFY: Ю9, docs/external.md). */
function httpUrl(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : null;
  } catch {
    return null;
  }
}

export interface CardServiceDeps {
  db: Db;
  env: Env;
  logger: Pick<Logger, 'info' | 'warn' | 'error'>;
  now: () => Date;
  engine: WorkerDeps['engine'];
}

export interface RedrawResult {
  orderNumber: string;
}

export interface CardService extends SellerCardPort {
  /** The card a button belongs to: an order card (any state) by its current nonce. */
  findByNonce(nonce: string): Promise<SellerCardRow | null>;
  /**
   * Takes the card for one press: rotates the nonce away from `nonce` if it is still the
   * current one of an open card. false -> another press (or a redraw) was first.
   */
  claim(card: Pick<SellerCardRow, 'id' | 'nonce'>): Promise<boolean>;
  /** Redraws an open card (main keyboard, or `menu`) with a new nonce; null when it is gone. */
  redraw(cardId: string, menu?: CardMenu | null): Promise<RedrawResult | null>;
  /** The items of the card's order (menus need the brand and article). */
  item(orderId: string, itemId: string): Promise<CardItem | null>;
  /**
   * A stale press on the message of an order card: an open card is redrawn with its current
   * buttons (its keyboard fell behind the nonce, e.g. an edit failed after a press), a closed one
   * loses its keyboard again. Nothing else changes; failures are logged.
   */
  heal(chatId: string, messageId: number): Promise<void>;
}

export function createCardService(
  deps: CardServiceDeps,
  api: SellerTelegramApi | null,
): CardService {
  const { db, env, logger } = deps;

  async function loadCard(
    orderId: string,
    extra: { headline?: string | null; note?: string | null } = {},
  ): Promise<CardData | null> {
    const snapshot = await loadOrderSnapshot(db, orderId, { lock: false });
    if (snapshot === null) return null;
    const settings = await loadOrderSettings(db, env);
    const actions: StaffActionView[] = availableStaffActions(
      snapshot,
      CARD_ROLE,
      settings,
      deps.now(),
    );
    const phone = await loadClientPhone(db, snapshot.order.userId);
    const { order } = snapshot;
    return {
      order: {
        id: order.id,
        number: order.number,
        status: order.status,
        paymentScheme: order.paymentScheme,
        totalKop: order.totalKop,
        createdAt: order.createdAt,
        promisedDate: order.promisedDate,
        attentionReason: order.attentionReason,
        supplierReturnDeadlineAt: order.supplierReturnDeadlineAt,
      },
      items: snapshot.items.map((item) => ({
        id: item.id,
        brand: item.brand,
        article: item.article,
        qty: item.qty,
        state: item.state,
      })),
      phone,
      actions,
      adminUrl: adminUrl(env, order.id),
      headline: extra.headline ?? null,
      note: extra.note ?? null,
    };
  }

  /** Removes the keyboard of a closed card; failures only cost a stale keyboard (logged). */
  async function stripKeyboard(card: Pick<SellerCardRow, 'chatId' | 'messageId' | 'orderId'>) {
    if (api === null || card.messageId === null) return;
    try {
      await api.editMessageReplyMarkup(card.chatId, card.messageId, {
        reply_markup: { inline_keyboard: [] },
      });
    } catch (error) {
      if (isNotModified(error)) return;
      logger.warn(
        { orderId: card.orderId, err: describeBotError(error, env.TG_SELLER_BOT_TOKEN) },
        'seller card: closing an old card failed',
      );
    }
  }

  async function closeOthers(orderId: string, keepId: string): Promise<void> {
    const closed = await db
      .update(sellerCards)
      .set({ closedAt: deps.now() })
      .where(
        and(
          eq(sellerCards.orderId, orderId),
          eq(sellerCards.kind, 'order'),
          isNull(sellerCards.closedAt),
          sql`${sellerCards.id} <> ${keepId}`,
        ),
      )
      .returning({
        chatId: sellerCards.chatId,
        messageId: sellerCards.messageId,
        orderId: sellerCards.orderId,
      });
    for (const card of closed) await stripKeyboard(card);
  }

  async function edit(
    card: Pick<SellerCardRow, 'chatId' | 'messageId'>,
    text: string,
    keyboard: InlineKeyboard,
  ): Promise<void> {
    if (api === null || card.messageId === null) return;
    try {
      await api.editMessageText(card.chatId, card.messageId, text, {
        reply_markup: { inline_keyboard: keyboard },
        link_preview_options: { is_disabled: true },
      });
    } catch (error) {
      if (!isNotModified(error)) throw error;
    }
  }

  function sellerChat(what: string, orderId: string): string | null {
    if (api === null) {
      logger.warn({ orderId }, `seller card: ${what} skipped, TG_SELLER_BOT_TOKEN is empty`);
      return null;
    }
    if (env.TG_SELLER_CHAT_ID === undefined) {
      logger.warn({ orderId }, `seller card: ${what} skipped, TG_SELLER_CHAT_ID is not set`);
      return null;
    }
    return String(env.TG_SELLER_CHAT_ID);
  }

  const service: CardService = {
    async post({ orderId, template, orderEventId, note }) {
      const chatId = sellerChat('post', orderId);
      if (chatId === null || api === null) {
        return { status: 'skipped', fallbackReason: FALLBACK_REASONS.driverUnavailable };
      }
      const data = await loadCard(orderId, { headline: headlineFor(template), note });
      if (data === null) {
        logger.warn({ orderId }, 'seller card: order not found');
        return { status: 'skipped', fallbackReason: 'order_not_found' };
      }
      const nonce = newNonce();
      const [row] = await db
        .insert(sellerCards)
        .values({ orderId, chatId, nonce, kind: 'order', orderEventId: orderEventId ?? null })
        .returning({ id: sellerCards.id });
      const cardId = (row as { id: string }).id;
      let messageId: number;
      try {
        const sent = await api.sendMessage(chatId, renderCardText(data), {
          reply_markup: { inline_keyboard: mainKeyboard(data, nonce) },
          link_preview_options: { is_disabled: true },
        });
        messageId = sent.message_id;
      } catch (error) {
        // No message: the row must not stay open (a refresh would try to edit nothing).
        await db
          .update(sellerCards)
          .set({ closedAt: deps.now() })
          .where(eq(sellerCards.id, cardId));
        throw error;
      }
      await db.update(sellerCards).set({ messageId }).where(eq(sellerCards.id, cardId));
      await closeOthers(orderId, cardId);
      logger.info(
        { orderNumber: data.order.number, template: template ?? null },
        'seller card posted',
      );
      return { status: 'posted' };
    },

    async refresh(orderId) {
      const [card] = await db
        .select({ id: sellerCards.id })
        .from(sellerCards)
        .where(
          and(
            eq(sellerCards.orderId, orderId),
            eq(sellerCards.kind, 'order'),
            isNull(sellerCards.closedAt),
          ),
        )
        .orderBy(desc(sellerCards.createdAt), desc(sellerCards.id))
        .limit(1);
      if (!card) return;
      await service.redraw(card.id);
    },

    async sendHandoverQr({ orderId, paymentId, confirmationData, expiresAt }) {
      const chatId = sellerChat('QR', orderId);
      if (chatId === null || api === null) return;
      const [order] = await db
        .select({ number: orders.number, totalKop: orders.totalKop })
        .from(orders)
        .where(eq(orders.id, orderId));
      if (!order) {
        logger.warn({ orderId }, 'seller QR: order not found');
        return;
      }
      const [payment] = await db
        .select({ amountKop: payments.amountKop })
        .from(payments)
        .where(eq(payments.id, paymentId));
      const amount = formatRub(payment?.amountKop ?? order.totalKop);
      const until = expiresAt ? `, действует до ${clockTime(expiresAt)}` : '';
      const caption = `QR на оплату ${order.number} ${amount}${until}`;
      const png = await QRCode.toBuffer(confirmationData, {
        type: 'png',
        errorCorrectionLevel: 'M',
        margin: 2,
        width: 512,
      });
      const link = httpUrl(confirmationData);
      const nonce = newNonce();
      const [row] = await db
        .insert(sellerCards)
        .values({ orderId, chatId, nonce, kind: 'qr' })
        .returning({ id: sellerCards.id });
      const sent = await api.sendPhoto(chatId, new InputFile(png, `qr-${order.number}.png`), {
        caption,
        ...(link
          ? { reply_markup: { inline_keyboard: [[{ text: 'Ссылка на оплату', url: link }]] } }
          : {}),
      });
      await db
        .update(sellerCards)
        .set({ messageId: sent.message_id })
        .where(eq(sellerCards.id, (row as { id: string }).id));
      if (link === null) {
        // VERIFY: Ю9 — the QR payload of YooKassa is expected to be a link.
        logger.warn({ orderNumber: order.number }, 'seller QR: payload is not a link, no button');
      }
      logger.info({ orderNumber: order.number }, 'seller QR sent');
    },

    async findByNonce(nonce) {
      const [card] = await db
        .select()
        .from(sellerCards)
        .where(and(eq(sellerCards.nonce, nonce), eq(sellerCards.kind, 'order')))
        .limit(1);
      return card ?? null;
    },

    async claim(card) {
      const rows = await db
        .update(sellerCards)
        .set({ nonce: newNonce() })
        .where(
          and(
            eq(sellerCards.id, card.id),
            eq(sellerCards.nonce, card.nonce),
            isNull(sellerCards.closedAt),
          ),
        )
        .returning({ id: sellerCards.id });
      return rows.length > 0;
    },

    async redraw(cardId, menu = null) {
      const [card] = await db.select().from(sellerCards).where(eq(sellerCards.id, cardId));
      if (!card || card.closedAt !== null || card.messageId === null) return null;
      const data = await loadCard(card.orderId);
      if (data === null) return null;
      const nonce = newNonce();
      // Written before Telegram sees it; a card closed meanwhile (a newer one was posted) stays
      // closed and keeps its stripped keyboard.
      const rotated = await db
        .update(sellerCards)
        .set({ nonce, orderItemId: menu?.itemId ?? null })
        .where(and(eq(sellerCards.id, card.id), isNull(sellerCards.closedAt)))
        .returning({ id: sellerCards.id });
      if (rotated.length === 0) return null;
      const keyboard = menu ? menuKeyboard(data, menu, nonce) : mainKeyboard(data, nonce);
      try {
        await edit(card, renderCardText(data, menu), keyboard);
      } catch (error) {
        if (!isMessageGone(error)) throw error;
        await db
          .update(sellerCards)
          .set({ closedAt: deps.now() })
          .where(eq(sellerCards.id, card.id));
        logger.warn({ orderNumber: data.order.number }, 'seller card message is gone, closed');
        return null;
      }
      return { orderNumber: data.order.number };
    },

    async item(orderId, itemId) {
      const [row] = await db
        .select({
          id: orderItems.id,
          brand: orderItems.brand,
          article: orderItems.article,
          qty: orderItems.qty,
          state: orderItems.state,
        })
        .from(orderItems)
        .where(and(eq(orderItems.id, itemId), eq(orderItems.orderId, orderId)))
        .orderBy(asc(orderItems.createdAt))
        .limit(1);
      return row ?? null;
    },

    async heal(chatId, messageId) {
      const [card] = await db
        .select()
        .from(sellerCards)
        .where(
          and(
            eq(sellerCards.chatId, chatId),
            eq(sellerCards.messageId, messageId),
            eq(sellerCards.kind, 'order'),
          ),
        )
        .orderBy(desc(sellerCards.createdAt))
        .limit(1);
      if (!card) return;
      try {
        if (card.closedAt === null) await service.redraw(card.id);
        else await stripKeyboard(card);
      } catch (error) {
        logger.warn(
          { orderId: card.orderId, err: describeBotError(error, env.TG_SELLER_BOT_TOKEN) },
          'seller card: redraw of a stale card failed',
        );
      }
    },
  };
  return service;
}

/** SellerCardPort of the queue jobs (create-deps.ts), over deps.telegram. */
export function createSellerCards(deps: WorkerDeps): SellerCardPort {
  return createCardService(deps, deps.telegram);
}
