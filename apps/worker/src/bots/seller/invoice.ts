// «Счёт оплачен» (owner, docs/phase-1b-implementation.md section 13.1 step 4): the press asks for
// the number and date of the payment order with a ForceReply; the next text of the same user in
// the same chat (within 10 minutes) is that reference and becomes
// performStaffAction('invpaid', {paymentRef}). The wait lives in Redis, not in memory, so a
// worker restart in between does not lose it.
import { performStaffAction } from '@detaly/orders';
import type { Context, Middleware } from 'grammy';
import type { WorkerDeps } from '../../deps';
import type { CardService } from './cards';
import { loadStaffMember } from './staff';

export const INVOICE_REPLY_TTL_SEC = 10 * 60;

export const INVOICE_PROMPT = 'Номер и дата платёжного поручения';

/** `<prefix>seller:await:<chat>:<user>` (section 13.1). */
export function awaitKey(keyPrefix: string, chatId: number, userId: number): string {
  return `${keyPrefix}seller:await:${chatId}:${userId}`;
}

interface AwaitingInvoice {
  orderId: string;
}

/** Sends the ForceReply prompt and remembers which order the next reply is about. */
export async function askInvoiceReference(
  ctx: Context,
  deps: Pick<WorkerDeps, 'redis' | 'keyPrefix'>,
  order: { id: string; number: string },
): Promise<void> {
  const chatId = ctx.chat?.id;
  const userId = ctx.from?.id;
  if (chatId === undefined || userId === undefined) return;
  const value: AwaitingInvoice = { orderId: order.id };
  await deps.redis.set(
    awaitKey(deps.keyPrefix, chatId, userId),
    JSON.stringify(value),
    'EX',
    INVOICE_REPLY_TTL_SEC,
  );
  await ctx.api.sendMessage(
    chatId,
    `${INVOICE_PROMPT} по заказу ${order.number}. Ответьте на это сообщение в течение 10 минут.`,
    {
      reply_markup: {
        force_reply: true,
        input_field_placeholder: '№ 512 от 02.10.2026',
      },
    },
  );
}

function parseAwaiting(raw: string | null): AwaitingInvoice | null {
  if (raw === null) return null;
  try {
    const value = JSON.parse(raw) as Partial<AwaitingInvoice>;
    return typeof value.orderId === 'string' ? { orderId: value.orderId } : null;
  } catch {
    return null;
  }
}

/**
 * Text messages of staff: the answer to a pending «Счёт оплачен» prompt, otherwise silence.
 * Commands are left to their handlers (an unknown command stays silent as in phase 0).
 */
export function invoiceReplyHandler(input: {
  deps: WorkerDeps;
  cards: CardService;
}): Middleware<Context> {
  const { deps, cards } = input;
  return async (ctx, next) => {
    const text = ctx.message?.text;
    const chatId = ctx.chat?.id;
    const userId = ctx.from?.id;
    if (text === undefined || chatId === undefined || userId === undefined) return next();
    if (text.startsWith('/')) return next();
    // GETDEL: the reference is taken once, a second message is ordinary chat text.
    const awaiting = parseAwaiting(
      await deps.redis.getdel(awaitKey(deps.keyPrefix, chatId, userId)),
    );
    if (awaiting === null) return next();
    const staff = await loadStaffMember(deps.db, userId);
    if (staff === null || staff.role !== 'owner') return;
    const result = await performStaffAction(deps.engine, {
      staff: { id: staff.id, role: staff.role, via: 'bot' },
      action: 'invpaid',
      targetId: awaiting.orderId,
      input: { paymentRef: text },
    });
    deps.logger.info(
      { orderId: awaiting.orderId, action: 'invpaid', staffId: staff.id, ok: result.ok },
      'seller bot action',
    );
    await ctx.reply(
      result.ok ? result.message : `${result.message}. Нажмите «Счёт оплачен» ещё раз.`,
    );
    if (result.ok) {
      try {
        await cards.refresh(awaiting.orderId);
      } catch (error) {
        deps.logger.warn(
          { orderId: awaiting.orderId, err: (error as Error).name },
          'seller card refresh failed',
        );
      }
    }
  };
}
