// Phase 1C buttons of an order card (docs/phase-1c-implementation.md section 9 items 1–4,
// decisions С6, С8, С9, С17, С25). The id of the button is the claim (cret, cref, crepl, crej,
// cclose), the booking (bconf, bdecl, bdone, bnoshow) or the order (pphoto).
//
// The card is drawn with the owner's buttons; what the pressing staff member may do is decided
// again here with availableStaffActions1C for HIS role: a refused guard («Сначала «Принял
// возврат»» for a seller's «Вернуть деньги») is answered with its reason and changes nothing.
//
// - pphoto / cret: ForceReply for a photo (photos.ts takes the reply);
// - cref / crepl / crej: ForceReply «Текст ответа клиенту» -> decideClaim (replies.ts); the
//   owner's «Вернуть деньги (нужна причина)» asks for the override reason first;
// - cclose, bconf, bdecl, bdone, bnoshow: applied at once (performStaffAction), the card redrawn.
import { eq, orders } from '@detaly/db';
import { workflowAction, type ParsedCallbackData } from '@detaly/notify';
import {
  loadStaffActions1C,
  performStaffAction,
  type StaffActionCode1C,
  type StaffActionView1C,
} from '@detaly/orders';
import type { Context } from 'grammy';
import type { WorkerDeps } from '../../deps';
import type { CardService, SellerCardRow } from './cards';
import { describeBotError } from './errors';
import { STORAGE_OFF } from './photos';
import { answerQuery, askForReply, REPLY_WITHIN } from './prompts';
import type { StaffMember } from './staff';

export const ACTION_GONE = 'Действие уже недоступно — карточка обновлена';
export const CLAIM_TEXT_PROMPT = 'Текст ответа клиенту (он увидит его на странице заказа)';
export const OVERRIDE_REASON_PROMPT = 'Причина возврата без приёмки детали';
export const RETURN_PHOTO_PROMPT = 'Пришлите фото возвращённой детали';
export const PACKAGING_PHOTO_PROMPT = 'Пришлите фото упаковки';

const DECISION_NAMES: Record<'cref' | 'crepl' | 'crej', string> = {
  cref: 'вернуть деньги',
  crepl: 'замена',
  crej: 'отказ',
};

/** Codes applied at once (no prompt). */
const DIRECT_CODES: ReadonlySet<string> = new Set<StaffActionCode1C>([
  'cclose',
  'bconf',
  'bdecl',
  'bdone',
  'bnoshow',
]);

/** The target id a 1C button carries. */
function targetOf(view: StaffActionView1C, orderId: string): string {
  return view.claimId ?? view.bookingId ?? orderId;
}

async function orderNumber(deps: WorkerDeps, orderId: string): Promise<string> {
  const [row] = await deps.db
    .select({ number: orders.number })
    .from(orders)
    .where(eq(orders.id, orderId));
  return row?.number ?? '';
}

/** Whether `code` is a phase 1C order-card code (claims, bookings, the packaging photo). */
export function isOrderWorkflowCode(code: string): code is StaffActionCode1C {
  const spec = workflowAction(code);
  return (
    spec !== null && (spec.kind === 'claim' || spec.kind === 'booking' || spec.kind === 'photo')
  );
}

/**
 * A press of a 1C button on an order card whose nonce and target were checked by the caller.
 * Answers the query itself.
 */
export async function handleOrderWorkflowPress(
  ctx: Context,
  input: {
    deps: WorkerDeps;
    cards: CardService;
    card: SellerCardRow;
    parsed: ParsedCallbackData;
    staff: StaffMember;
  },
): Promise<void> {
  const { deps, cards, card, parsed, staff } = input;
  const code = parsed.action as StaffActionCode1C;
  const token = ctx.api.token;
  const views = (await loadStaffActions1C(deps.engine, card.orderId, staff.role)) ?? [];
  const view = views.find((v) => v.code === code && targetOf(v, card.orderId) === parsed.orderId);
  if (view === undefined) {
    // Decided, closed or moved on since the card was drawn: show the current buttons.
    await answerQuery(ctx, ACTION_GONE);
    if (await cards.claim(card)) await cards.redraw(card.id).catch(() => null);
    return;
  }
  if (!view.enabled) {
    // A refused guard: its reason, nothing changes (not even the nonce).
    await answerQuery(ctx, view.disabledReason ?? 'Действие сейчас недоступно');
    return;
  }

  if (code === 'pphoto' || code === 'cret') {
    if (deps.files.kind === 'none') {
      await answerQuery(ctx, STORAGE_OFF);
      return;
    }
    const number = await orderNumber(deps, card.orderId);
    const asked = await askForReply(ctx, deps, {
      text:
        code === 'cret'
          ? `${RETURN_PHOTO_PROMPT} по заказу ${number} — без фото возврат не принимается. ${REPLY_WITHIN}`
          : `${PACKAGING_PHOTO_PROMPT} по заказу ${number}. ${REPLY_WITHIN}`,
      awaiting:
        code === 'cret'
          ? { kind: 'photo', purpose: 'return', orderId: card.orderId, claimId: parsed.orderId }
          : { kind: 'photo', purpose: 'packaging', orderId: card.orderId, claimId: null },
    });
    await answerQuery(ctx, asked ? 'Пришлите фото ответом на сообщение' : undefined);
    return;
  }

  if (code === 'cref' || code === 'crepl' || code === 'crej') {
    const number = await orderNumber(deps, card.orderId);
    if (code === 'cref' && view.needsReason === true) {
      // The owner refunds without «Принял возврат»: the reason goes to the order journal.
      await askForReply(ctx, deps, {
        text: `${OVERRIDE_REASON_PROMPT} по заказу ${number} (запишется в журнал заказа, клиенту не видна). ${REPLY_WITHIN}`,
        awaiting: { kind: 'claim_reason', orderId: card.orderId, claimId: parsed.orderId },
      });
      await answerQuery(ctx, 'Сначала причина, затем текст ответа клиенту');
      return;
    }
    await askForReply(ctx, deps, {
      text: `${CLAIM_TEXT_PROMPT}. Заказ ${number}, решение: ${DECISION_NAMES[code]}. ${REPLY_WITHIN}`,
      awaiting: {
        kind: 'claim_text',
        code,
        orderId: card.orderId,
        claimId: parsed.orderId,
        reason: null,
      },
    });
    await answerQuery(ctx, 'Напишите ответ клиенту ответом на сообщение');
    return;
  }

  if (!DIRECT_CODES.has(code)) {
    await answerQuery(ctx, ACTION_GONE);
    return;
  }
  if (!(await cards.claim(card))) {
    await answerQuery(ctx, 'Карточка устарела, откройте свежую');
    return;
  }
  let message: string;
  try {
    const result = await performStaffAction(deps.engine, {
      staff: { id: staff.id, role: staff.role, via: 'bot' },
      action: code,
      targetId: parsed.orderId,
    });
    message = result.message;
  } catch (error) {
    deps.logger.error(
      { orderId: card.orderId, action: code, err: describeBotError(error, token) },
      'seller bot action failed',
    );
    message = 'Не получилось, попробуйте ещё раз';
  }
  await answerQuery(ctx, message);
  let number: string | null = null;
  try {
    number = (await cards.redraw(card.id))?.orderNumber ?? null;
  } catch (error) {
    deps.logger.warn(
      { orderId: card.orderId, err: describeBotError(error, token) },
      'seller card redraw failed',
    );
  }
  deps.logger.info({ orderNumber: number, action: code, staffId: staff.id }, 'seller bot action');
}
