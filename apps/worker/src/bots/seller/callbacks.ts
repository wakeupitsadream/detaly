// Button presses of the seller bot (docs/phase-1b-implementation.md section 13.1 step 3, table
// 13.2, decisions Б17–Б19). callback_data = `a:<action>:<id>:<nonce>`:
//
//   parseCallbackData -> the card by its nonce (none or closed -> «Карточка устарела», and the
//   message's own card is redrawn so its buttons catch up with the nonce) -> the id
//   belongs to the card's order -> role (invpaid, dlq: owner only; a seller is refused and the
//   card does not change) -> claim the card (the nonce rotates: a second press is stale) ->
//   menu (aliases, new ETA, item problem, «Назад») or performStaffAction ->
//   answerCallbackQuery(message) -> redraw with a new nonce.
//
// Logs carry the order number, the action and the staff id; never a phone or an order token.
import { and, desc, eq, orderEvents, orders, type Db } from '@detaly/db';
import {
  addDays,
  localDate,
  type RecheckAlternative,
  type RecheckItemResult,
} from '@detaly/domain';
import {
  actionTarget,
  isEventAction,
  isOwnerOnlyAction,
  menuAction,
  parseCallbackData,
  type ParsedCallbackData,
} from '@detaly/notify';
import { isUuid, performStaffAction, type StaffActionCode } from '@detaly/orders';
import type { Context, Middleware } from 'grammy';
import type { WorkerDeps } from '../../deps';
import {
  ALTERNATIVE_CODES,
  alternativeLabel,
  alternativeMenu,
  etaMenu,
  problemMenu,
  type CardMenu,
} from './card-view';
import type { CardService, SellerCardRow } from './cards';
import { describeBotError } from './errors';
import { askInvoiceReference } from './invoice';
import { retryDeadLetterPress } from './queues';
import { loadStaffMember, type StaffMember } from './staff';

export const STALE_CARD = 'Карточка устарела, откройте свежую';
export const OWNER_ONLY_MESSAGE = 'Только владелец';
export const ACTION_FAILED = 'Не получилось, попробуйте ещё раз';
export const INVOICE_NOT_DUE = 'Счёт Rossko уже не ждёт оплаты';

/** Event codes a staff member may press on a card (the client codes are not staff actions). */
const STAFF_EVENT_CODES: ReadonlySet<string> = new Set<StaffActionCode>([
  'recheck',
  'refused',
  'cancel',
  'anyway',
  'invpaid',
  'came',
  'rcpt',
  'qr',
  'handed',
  'noshow',
  'icancel',
  'iarr',
]);

/** The alternatives of one item from the latest recheck_result (same source as the engine). */
export async function latestAlternatives(
  db: Db,
  orderId: string,
  itemId: string,
): Promise<RecheckAlternative[]> {
  const [row] = await db
    .select({ payload: orderEvents.payload })
    .from(orderEvents)
    .where(and(eq(orderEvents.orderId, orderId), eq(orderEvents.type, 'recheck_result')))
    .orderBy(desc(orderEvents.createdAt), desc(orderEvents.id))
    .limit(1);
  const items = (row?.payload as { items?: unknown } | undefined)?.items;
  if (!Array.isArray(items)) return [];
  const result = (items as RecheckItemResult[]).find((r) => r.orderItemId === itemId);
  return Array.isArray(result?.alternatives) ? result.alternatives : [];
}

async function answer(ctx: Context, text?: string): Promise<void> {
  try {
    await ctx.answerCallbackQuery(text ? { text } : undefined);
  } catch {
    // An expired query (> 15 min or after a restart) cannot be answered; nothing to do.
  }
}

/** The card's order owns the id: the order itself or one of its items. */
async function targetBelongs(
  cards: CardService,
  card: SellerCardRow,
  parsed: ParsedCallbackData,
): Promise<boolean> {
  const target = actionTarget(parsed.action);
  if (target === null || target === 'dead_letter') return false;
  if (!isUuid(parsed.orderId)) return false;
  if (target === 'order') return parsed.orderId === card.orderId;
  if (target === 'order_or_item' && parsed.orderId === card.orderId) return true;
  return (await cards.item(card.orderId, parsed.orderId)) !== null;
}

interface PressOutcome {
  message: string;
  menu: CardMenu | null;
}

/** What a press does once the card is claimed. */
async function runPress(
  deps: WorkerDeps,
  cards: CardService,
  card: SellerCardRow,
  parsed: ParsedCallbackData,
  staff: StaffMember,
): Promise<PressOutcome> {
  const actor = { id: staff.id, role: staff.role, via: 'bot' as const };
  const code = parsed.action;
  const targetId = parsed.orderId;
  const perform = async (
    action: StaffActionCode,
    input: Parameters<typeof performStaffAction>[1]['input'] = {},
  ) => performStaffAction(deps.engine, { staff: actor, action, targetId, input });

  if (code === 'back') return { message: '', menu: null };

  if (isEventAction(code)) {
    if (!STAFF_EVENT_CODES.has(code)) return { message: STALE_CARD, menu: null };
    const result = await perform(code as StaffActionCode);
    return { message: result.message, menu: null };
  }

  const spec = menuAction(code);
  const item = await cards.item(card.orderId, targetId);
  if (spec === null || item === null) return { message: STALE_CARD, menu: null };

  switch (spec.kind) {
    case 'open': {
      if (spec.menu === 'eta') {
        return { message: 'Выберите новый срок', menu: etaMenu(item, localDate(deps.now())) };
      }
      if (spec.menu === 'problem') return { message: 'Что случилось?', menu: problemMenu(item) };
      // Aliases: the engine reads the last recheck_result and says when there are none; the
      // labels come from the same alternatives the choice (alt1..3) reads by index.
      const result = await perform('ialt');
      const alternatives = await latestAlternatives(deps.db, card.orderId, item.id);
      const labels =
        (result.menu ?? []).length > 0
          ? alternatives.slice(0, ALTERNATIVE_CODES.length).map(alternativeLabel)
          : [];
      return labels.length > 0
        ? { message: result.message, menu: alternativeMenu(item, labels) }
        : { message: result.message, menu: null };
    }
    case 'alternative': {
      const alternative = (await latestAlternatives(deps.db, card.orderId, item.id))[spec.index];
      if (alternative === undefined) {
        return { message: 'Аналог больше не доступен — откройте меню ещё раз', menu: null };
      }
      return { message: (await perform('ialt', { alternative })).message, menu: null };
    }
    case 'eta': {
      const etaDate = addDays(localDate(deps.now()), spec.days);
      return { message: (await perform('ieta', { etaDate })).message, menu: null };
    }
    case 'problem':
      return { message: (await perform('iprob', { problem: spec.problem })).message, menu: null };
    case 'back':
    case 'dead_letter':
      return { message: STALE_CARD, menu: null };
  }
}

export function callbackHandler(input: {
  deps: WorkerDeps;
  cards: CardService;
}): Middleware<Context> {
  const { deps, cards } = input;
  const token = deps.env.TG_SELLER_BOT_TOKEN;

  return async (ctx) => {
    const query = ctx.callbackQuery;
    const userId = ctx.from?.id;
    if (!query || userId === undefined) return;
    const parsed = parseCallbackData(query.data ?? '');
    if (parsed === null) return answer(ctx, STALE_CARD);

    const staff = await loadStaffMember(deps.db, userId);
    // Left the team since the cache was filled: a stranger now (empty answer, no change).
    if (staff === null) return answer(ctx);
    if (isOwnerOnlyAction(parsed.action) && staff.role !== 'owner') {
      return answer(ctx, OWNER_ONLY_MESSAGE);
    }

    if (parsed.action === 'dlq') {
      const message = await retryDeadLetterPress(ctx, deps, {
        position: parsed.orderId,
        nonce: parsed.nonce,
        staffId: staff.id,
      });
      return answer(ctx, message);
    }

    const card = await cards.findByNonce(parsed.nonce);
    const message = query.message;
    if (
      card === null ||
      card.closedAt !== null ||
      message === undefined ||
      card.chatId !== String(message.chat.id) ||
      card.messageId !== message.message_id
    ) {
      await answer(ctx, STALE_CARD);
      // The keyboard of this message is behind its card (a double press, an edit that failed
      // after a press): show the current buttons so the next press works.
      if (message !== undefined) await cards.heal(String(message.chat.id), message.message_id);
      return;
    }
    if (!(await targetBelongs(cards, card, parsed))) return answer(ctx, STALE_CARD);

    if (parsed.action === 'invpaid') {
      // The card stays as it is until the payment reference arrives (invoice.ts).
      const [order] = await deps.db
        .select({ id: orders.id, number: orders.number, status: orders.status })
        .from(orders)
        .where(eq(orders.id, card.orderId));
      if (!order) return answer(ctx, STALE_CARD);
      if (order.status !== 'awaiting_supplier_invoice') {
        // Paid already (admin, another press) or the order moved on: no prompt, fresh buttons.
        await answer(ctx, INVOICE_NOT_DUE);
        if (await cards.claim(card)) await cards.redraw(card.id).catch(() => null);
        return;
      }
      await askInvoiceReference(ctx, deps, order);
      return answer(ctx, 'Ответьте номером и датой платёжного поручения');
    }

    if (!(await cards.claim(card))) return answer(ctx, STALE_CARD);

    let outcome: PressOutcome;
    try {
      outcome = await runPress(deps, cards, card, parsed, staff);
    } catch (error) {
      deps.logger.error(
        { orderId: card.orderId, action: parsed.action, err: describeBotError(error, token) },
        'seller bot action failed',
      );
      outcome = { message: ACTION_FAILED, menu: null };
    }
    await answer(ctx, outcome.message || undefined);

    let orderNumber: string | null = null;
    try {
      orderNumber = (await cards.redraw(card.id, outcome.menu))?.orderNumber ?? null;
    } catch (error) {
      deps.logger.warn(
        { orderId: card.orderId, err: describeBotError(error, token) },
        'seller card redraw failed',
      );
    }
    deps.logger.info(
      {
        orderNumber,
        action: parsed.action,
        staffId: staff.id,
        menu: outcome.menu !== null,
      },
      'seller bot action',
    );
  };
}
