// Seller bot cards (decision Б17, docs/phase-1b-implementation.md section 13.1). A card is one
// Telegram message in the sellers chat and one row of seller_cards with the nonce its buttons
// carry. The nonce is written before Telegram sees it and rotates on every redraw, so a button
// of an older rendering (or a second press of the same one) finds no card: «Карточка устарела».
//
// - post: a new card for the order; the order's older open cards are closed (keyboard removed);
// - refresh: the latest open card is redrawn from the database (e.g. «Выдал» after the receipt);
// - sendHandoverQr: the QR photo of a handover payment, to the sellers chat only (Б28);
// - postVin / refreshVin: VIN request cards (phase 1C, kind 'vin', docs/phase-1c-implementation.md
//   section 9 item 5): the same nonce discipline — a new card closes the request's older open
//   cards, every redraw rotates the nonce.
// - postFit / refreshFit: fit check cards (step 4, kind 'fit', docs/fit-check.md): a new card
//   closes the request's older open cards; the nonce stays for the life of the card, because a
//   press is about one line and only a pending line takes an answer (a second press on an
//   answered line gets «Уже отвечено», not «Карточка устарела»).
//
// Phase 1C order cards also carry the open claims, the active booking and the packaging photo
// count (card-view.ts), with the availableStaffActions1C buttons.
//
// The same service backs the bot's button presses (redraw with a menu or the main keyboard);
// the bot builds it over its own Api, the queue jobs over deps.telegram.
import type { Env, Logger } from '@detaly/config';
import {
  and,
  asc,
  desc,
  eq,
  inArray,
  isNull,
  orderItems,
  orders,
  payments,
  sellerCards,
  sql,
  type Db,
} from '@detaly/db';
import {
  CLIENT_TIME_ZONE,
  DateError,
  etaDate,
  formatPromise,
  formatRub,
  MoneyError,
  priceOffer,
  promisedDate,
} from '@detaly/domain';
import { FALLBACK_REASONS, newNonce } from '@detaly/notify';
import {
  availableStaffActions,
  availableStaffActions1C,
  bookingSlot,
  loadClientPhone,
  loadOrderPhotos,
  loadOrderSettings,
  loadOrderSnapshot,
  type StaffActionView,
} from '@detaly/orders';
import { loadFitRequestForStaff, loadFitSlaMinutes, loadVinRequestForStaff } from '@detaly/vin';
import { InputFile } from 'grammy';
import QRCode from 'qrcode';
import type {
  SellerCardPort,
  SellerCardPostResult,
  SellerTelegramApi,
  WorkerDeps,
} from '../../deps';
import { adminUrl, baseUrl } from '../../jobs/notify/template-data';
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
import { fitKeyboard, renderFitCardText, type FitAnalogPrice, type FitCardData } from './fit-view';
import { renderVinCardText, vinKeyboard, type VinCardData } from './vin-view';

/** An order card (kinds order, qr): since phase 1C seller_cards.order_id is null for VIN cards. */
export type SellerCardRow = typeof sellerCards.$inferSelect & { orderId: string };

/** A VIN request card (kind vin): seller_cards.vin_request_id is set, order_id is null. */
export type VinCardRow = typeof sellerCards.$inferSelect & { vinRequestId: string };

/** A fit check card (kind fit, step 4): seller_cards.fit_request_id is set. */
export type FitCardRow = typeof sellerCards.$inferSelect & { fitRequestId: string };

/** The card behind a button: an order card, a VIN request card or a fit check card. */
export type AnyCardRow =
  | { type: 'order'; card: SellerCardRow }
  | { type: 'vin'; card: VinCardRow }
  | { type: 'fit'; card: FitCardRow };

/** The row as an order card, or null for a VIN request card. */
function orderCard(row: typeof sellerCards.$inferSelect | undefined): SellerCardRow | null {
  if (row === undefined || row.orderId === null) return null;
  return { ...row, orderId: row.orderId };
}

/** The row as a VIN request card, or null. */
function vinCard(row: typeof sellerCards.$inferSelect | undefined): VinCardRow | null {
  if (row === undefined || row.kind !== 'vin' || row.vinRequestId === null) return null;
  return { ...row, vinRequestId: row.vinRequestId };
}

/** The row as a fit check card, or null. */
function fitCard(row: typeof sellerCards.$inferSelect | undefined): FitCardRow | null {
  if (row === undefined || row.kind !== 'fit' || row.fitRequestId === null) return null;
  return { ...row, fitRequestId: row.fitRequestId };
}

/** APP_BASE_URL/admin/fit-checks (Basic auth): the requests, their answers and the statistics. */
export function fitAdminUrl(env: Pick<Env, 'APP_BASE_URL'>): string {
  return `${baseUrl(env)}/admin/fit-checks`;
}

/** «Ответьте в течение часа» from settings `fit_check.sla_minutes`. */
export function fitSlaStaffText(slaMinutes: number): string {
  if (slaMinutes <= 60) return 'Ответьте в течение часа (рабочее время)';
  const hours = Math.ceil(slaMinutes / 60);
  // «в течение 21 часа», «в течение 2 часов» (genitive after «в течение»).
  const noun = hours % 10 === 1 && hours % 100 !== 11 ? 'часа' : 'часов';
  return `Ответьте в течение ${hours} ${noun} (рабочее время)`;
}

/** APP_BASE_URL/admin/vin/<id> (Basic auth: the photos and the full phone are there). */
export function vinAdminUrl(env: Pick<Env, 'APP_BASE_URL'>, vinRequestId: string): string {
  return `${baseUrl(env)}/admin/vin/${vinRequestId}`;
}

/** First line of the VIN card posted after the master's answer. */
export const VIN_PREVIEW_HEADLINE = 'Превью ответа · заявка VIN';

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
  /** The card a button belongs to: an order or a VIN request card (any state) by its nonce. */
  findAnyByNonce(nonce: string): Promise<AnyCardRow | null>;
  /**
   * A new VIN card with a headline («Превью ответа» after the master's answer); closes the
   * request's older open cards. postVin is this without a headline.
   */
  postVinCard(input: {
    vinRequestId: string;
    headline?: string | null;
    note?: string | null;
  }): Promise<SellerCardPostResult>;
  /** Redraws an open VIN card with a new nonce; null when it is gone. */
  redrawVin(cardId: string): Promise<{ vinRequestId: string } | null>;
  /**
   * Step 4: a new fit check card (the SLA reminder adds `note`); closes the request's older open
   * cards. postFit is this.
   */
  postFitCard(input: { requestId: string; note?: string | null }): Promise<SellerCardPostResult>;
  /** Redraws an open fit check card (same nonce); null when it is gone. */
  redrawFit(cardId: string): Promise<{ requestId: string } | null>;
  /** The open order card behind a Telegram message (a photo sent in reply to it). */
  openOrderCardAt(chatId: string, messageId: number): Promise<SellerCardRow | null>;
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
    const actions1C = availableStaffActions1C(snapshot, CARD_ROLE, settings, deps.now());
    const phone = await loadClientPhone(db, snapshot.order.userId);
    const packaging = await loadOrderPhotos(db, orderId, ['packaging']);
    const { order } = snapshot;
    const itemOf = (id: string | null) => snapshot.items.find((item) => item.id === id) ?? null;
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
      actions1C,
      // Open claims only, without texts (the client's description may hold PD).
      claims: snapshot.claims
        .filter((claim) => claim.closedAt === null)
        .map((claim) => {
          const item = itemOf(claim.orderItemId);
          return {
            id: claim.id,
            kind: claim.kind,
            item: item
              ? { brand: item.brand, article: item.article, fitGuarantee: item.fitGuarantee }
              : null,
            deadlineAt: claim.deadlineAt,
            returnAccepted: claim.returnAcceptedAt !== null,
            photoCount: claim.photoCount,
            decision: claim.decision,
          };
        }),
      bookings: snapshot.bookings
        .filter((booking) => booking.status === 'requested' || booking.status === 'confirmed')
        .map((booking) => {
          const slot = bookingSlot(booking.slotAt);
          return {
            id: booking.id,
            dayText: slot.dayText,
            timeText: slot.timeText,
            status: booking.status,
          };
        }),
      packagingPhotos: packaging.length,
      adminUrl: adminUrl(env, order.id),
      headline: extra.headline ?? null,
      note: extra.note ?? null,
    };
  }

  /** Removes the keyboard of a closed card; failures only cost a stale keyboard (logged). */
  async function stripKeyboard(
    card: Pick<typeof sellerCards.$inferSelect, 'chatId' | 'messageId' | 'orderId'>,
  ) {
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

  async function closeOtherVinCards(vinRequestId: string, keepId: string): Promise<void> {
    const closed = await db
      .update(sellerCards)
      .set({ closedAt: deps.now() })
      .where(
        and(
          eq(sellerCards.vinRequestId, vinRequestId),
          eq(sellerCards.kind, 'vin'),
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

  async function loadVinCard(
    vinRequestId: string,
    extra: { headline?: string | null; note?: string | null } = {},
  ): Promise<VinCardData | null> {
    // The masked view: phone •••4567, digit runs of the texts hidden, photo keys never shown.
    const request = await loadVinRequestForStaff(db, vinRequestId);
    if (request === null) return null;
    const settings = await loadOrderSettings(db, env);
    return {
      request,
      headline: extra.headline ?? null,
      note: extra.note ?? null,
      adminUrl: vinAdminUrl(env, vinRequestId),
      eta: settings.eta,
    };
  }

  async function postVinCard(input: {
    vinRequestId: string;
    headline?: string | null;
    note?: string | null;
  }): Promise<SellerCardPostResult> {
    const { vinRequestId } = input;
    if (api === null) {
      logger.warn({ vinRequestId }, 'seller VIN card skipped, TG_SELLER_BOT_TOKEN is empty');
      return { status: 'skipped', fallbackReason: FALLBACK_REASONS.driverUnavailable };
    }
    if (env.TG_SELLER_CHAT_ID === undefined) {
      logger.warn({ vinRequestId }, 'seller VIN card skipped, TG_SELLER_CHAT_ID is not set');
      return { status: 'skipped', fallbackReason: FALLBACK_REASONS.driverUnavailable };
    }
    const chatId = String(env.TG_SELLER_CHAT_ID);
    const data = await loadVinCard(vinRequestId, input);
    if (data === null) {
      logger.warn({ vinRequestId }, 'seller VIN card: request not found');
      return { status: 'skipped', fallbackReason: 'vin_not_found' };
    }
    const nonce = newNonce();
    const [row] = await db
      .insert(sellerCards)
      .values({ vinRequestId, chatId, nonce, kind: 'vin' })
      .returning({ id: sellerCards.id });
    const cardId = (row as { id: string }).id;
    let messageId: number;
    try {
      const sent = await api.sendMessage(chatId, renderVinCardText(data), {
        reply_markup: { inline_keyboard: vinKeyboard(data, nonce) },
        link_preview_options: { is_disabled: true },
      });
      messageId = sent.message_id;
    } catch (error) {
      // No message: the row must not stay open (a refresh would try to edit nothing).
      await db.update(sellerCards).set({ closedAt: deps.now() }).where(eq(sellerCards.id, cardId));
      throw error;
    }
    await db.update(sellerCards).set({ messageId }).where(eq(sellerCards.id, cardId));
    await closeOtherVinCards(vinRequestId, cardId);
    logger.info({ vinRequestId, status: data.request.status }, 'seller VIN card posted');
    return { status: 'posted' };
  }

  async function closeOtherFitCards(requestId: string, keepId: string): Promise<void> {
    const closed = await db
      .update(sellerCards)
      .set({ closedAt: deps.now() })
      .where(
        and(
          eq(sellerCards.fitRequestId, requestId),
          eq(sellerCards.kind, 'fit'),
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

  /**
   * The request with the price and date of every analog, as the client's cart prices it
   * (priceOffer with the settings of now, the pickup date with the eta buffer).
   */
  async function loadFitCard(requestId: string, note: string | null): Promise<FitCardData | null> {
    const request = await loadFitRequestForStaff(db, requestId);
    if (request === null) return null;
    const settings = await loadOrderSettings(db, env);
    const now = deps.now();
    const analogPrices = new Map<string, FitAnalogPrice>();
    for (const line of request.lines) {
      if (line.analog === null) continue;
      try {
        const { priceClientKop } = priceOffer(settings.pricing, line.analog.offer);
        let promiseText: string | null = null;
        try {
          promiseText = formatPromise(
            promisedDate([etaDate(line.analog.offer.stock, now)], settings.eta),
          );
        } catch (error) {
          if (!(error instanceof DateError)) throw error;
        }
        analogPrices.set(line.id, { priceText: formatRub(priceClientKop), promiseText });
      } catch (error) {
        if (!(error instanceof MoneyError)) throw error;
      }
    }
    return {
      request,
      analogPrices,
      note,
      slaText: fitSlaStaffText(await loadFitSlaMinutes(db)),
      adminUrl: fitAdminUrl(env),
    };
  }

  async function postFitCard(input: {
    requestId: string;
    note?: string | null;
  }): Promise<SellerCardPostResult> {
    const { requestId } = input;
    if (api === null) {
      logger.warn(
        { fitRequestId: requestId },
        'seller fit card skipped, TG_SELLER_BOT_TOKEN is empty',
      );
      return { status: 'skipped', fallbackReason: FALLBACK_REASONS.driverUnavailable };
    }
    if (env.TG_SELLER_CHAT_ID === undefined) {
      logger.warn(
        { fitRequestId: requestId },
        'seller fit card skipped, TG_SELLER_CHAT_ID is not set',
      );
      return { status: 'skipped', fallbackReason: FALLBACK_REASONS.driverUnavailable };
    }
    const chatId = String(env.TG_SELLER_CHAT_ID);
    const data = await loadFitCard(requestId, input.note ?? null);
    if (data === null) {
      logger.warn({ fitRequestId: requestId }, 'seller fit card: request not found');
      return { status: 'skipped', fallbackReason: 'fit_not_found' };
    }
    const nonce = newNonce();
    const [row] = await db
      .insert(sellerCards)
      .values({ fitRequestId: requestId, chatId, nonce, kind: 'fit' })
      .returning({ id: sellerCards.id });
    const cardId = (row as { id: string }).id;
    let messageId: number;
    try {
      const sent = await api.sendMessage(chatId, renderFitCardText(data), {
        reply_markup: { inline_keyboard: fitKeyboard(data, nonce) },
        link_preview_options: { is_disabled: true },
      });
      messageId = sent.message_id;
    } catch (error) {
      // No message: the row must not stay open (a refresh would try to edit nothing).
      await db.update(sellerCards).set({ closedAt: deps.now() }).where(eq(sellerCards.id, cardId));
      throw error;
    }
    await db.update(sellerCards).set({ messageId }).where(eq(sellerCards.id, cardId));
    await closeOtherFitCards(requestId, cardId);
    logger.info(
      { fitRequestId: requestId, lines: data.request.lines.length, reminder: input.note != null },
      'seller fit card posted',
    );
    return { status: 'posted' };
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

    async postVin({ vinRequestId, note }) {
      return postVinCard({ vinRequestId, note: note ?? null });
    },

    async postFit({ requestId, note }) {
      return postFitCard({ requestId, note: note ?? null });
    },

    postFitCard,

    async refreshFit(requestId) {
      // Without a bot there is no message to redraw.
      if (api === null) return;
      const [card] = await db
        .select({ id: sellerCards.id })
        .from(sellerCards)
        .where(
          and(
            eq(sellerCards.fitRequestId, requestId),
            eq(sellerCards.kind, 'fit'),
            isNull(sellerCards.closedAt),
          ),
        )
        .orderBy(desc(sellerCards.createdAt), desc(sellerCards.id))
        .limit(1);
      if (!card) return;
      await service.redrawFit(card.id);
    },

    async redrawFit(cardId) {
      const [row] = await db.select().from(sellerCards).where(eq(sellerCards.id, cardId));
      const card = fitCard(row);
      if (!card || card.closedAt !== null || card.messageId === null) return null;
      const data = await loadFitCard(card.fitRequestId, null);
      if (data === null) return null;
      try {
        await edit(card, renderFitCardText(data), fitKeyboard(data, card.nonce));
      } catch (error) {
        if (!isMessageGone(error)) throw error;
        await db
          .update(sellerCards)
          .set({ closedAt: deps.now() })
          .where(eq(sellerCards.id, card.id));
        logger.warn({ fitRequestId: card.fitRequestId }, 'seller fit card message is gone, closed');
        return null;
      }
      return { requestId: card.fitRequestId };
    },

    postVinCard,

    async refreshVin(vinRequestId) {
      // Without a bot there is no message to redraw (and no reason to touch the database).
      if (api === null) return;
      const [card] = await db
        .select({ id: sellerCards.id })
        .from(sellerCards)
        .where(
          and(
            eq(sellerCards.vinRequestId, vinRequestId),
            eq(sellerCards.kind, 'vin'),
            isNull(sellerCards.closedAt),
          ),
        )
        .orderBy(desc(sellerCards.createdAt), desc(sellerCards.id))
        .limit(1);
      if (!card) return;
      await service.redrawVin(card.id);
    },

    async redrawVin(cardId) {
      const [row] = await db.select().from(sellerCards).where(eq(sellerCards.id, cardId));
      const card = vinCard(row);
      if (!card || card.closedAt !== null || card.messageId === null) return null;
      const data = await loadVinCard(card.vinRequestId);
      if (data === null) return null;
      const nonce = newNonce();
      const rotated = await db
        .update(sellerCards)
        .set({ nonce })
        .where(and(eq(sellerCards.id, card.id), isNull(sellerCards.closedAt)))
        .returning({ id: sellerCards.id });
      if (rotated.length === 0) return null;
      try {
        await edit(card, renderVinCardText(data), vinKeyboard(data, nonce));
      } catch (error) {
        if (!isMessageGone(error)) throw error;
        await db
          .update(sellerCards)
          .set({ closedAt: deps.now() })
          .where(eq(sellerCards.id, card.id));
        logger.warn({ vinRequestId: card.vinRequestId }, 'seller VIN card message is gone, closed');
        return null;
      }
      return { vinRequestId: card.vinRequestId };
    },

    async findAnyByNonce(nonce) {
      const [row] = await db
        .select()
        .from(sellerCards)
        .where(
          and(eq(sellerCards.nonce, nonce), inArray(sellerCards.kind, ['order', 'vin', 'fit'])),
        )
        .limit(1);
      const vin = vinCard(row);
      if (vin) return { type: 'vin', card: vin };
      const fit = fitCard(row);
      if (fit) return { type: 'fit', card: fit };
      const order = row?.kind === 'order' ? orderCard(row) : null;
      return order ? { type: 'order', card: order } : null;
    },

    async openOrderCardAt(chatId, messageId) {
      const [row] = await db
        .select()
        .from(sellerCards)
        .where(
          and(
            eq(sellerCards.chatId, chatId),
            eq(sellerCards.messageId, messageId),
            eq(sellerCards.kind, 'order'),
            isNull(sellerCards.closedAt),
          ),
        )
        .orderBy(desc(sellerCards.createdAt))
        .limit(1);
      return orderCard(row);
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
      const [row] = await db.select().from(sellerCards).where(eq(sellerCards.id, cardId));
      const card = orderCard(row);
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
      const [row] = await db
        .select()
        .from(sellerCards)
        .where(
          and(
            eq(sellerCards.chatId, chatId),
            eq(sellerCards.messageId, messageId),
            inArray(sellerCards.kind, ['order', 'vin', 'fit']),
          ),
        )
        .orderBy(desc(sellerCards.createdAt))
        .limit(1);
      const fit = fitCard(row);
      if (fit) {
        try {
          if (fit.closedAt === null) await service.redrawFit(fit.id);
          else await stripKeyboard(fit);
        } catch (error) {
          logger.warn(
            {
              fitRequestId: fit.fitRequestId,
              err: describeBotError(error, env.TG_SELLER_BOT_TOKEN),
            },
            'seller fit card: redraw of a stale card failed',
          );
        }
        return;
      }
      const vin = vinCard(row);
      if (vin) {
        try {
          if (vin.closedAt === null) await service.redrawVin(vin.id);
          else await stripKeyboard(vin);
        } catch (error) {
          logger.warn(
            {
              vinRequestId: vin.vinRequestId,
              err: describeBotError(error, env.TG_SELLER_BOT_TOKEN),
            },
            'seller VIN card: redraw of a stale card failed',
          );
        }
        return;
      }
      const card = orderCard(row);
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
