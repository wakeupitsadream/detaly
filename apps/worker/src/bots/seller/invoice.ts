// «Счёт оплачен» (owner, docs/phase-1b-implementation.md section 13.1 step 4): the press asks for
// the number and date of the payment order with a ForceReply; the reply of the same user to that
// prompt (within 10 minutes) is the reference and becomes performStaffAction('invpaid',
// {paymentRef}). Only a reply to the prompt counts: an ordinary message of the owner in the
// sellers chat must not mark a supplier invoice as paid. The wait lives in Redis (awaiting.ts),
// not in memory, so a worker restart in between does not lose it.
import { performStaffAction } from '@detaly/orders';
import type { Context } from 'grammy';
import type { WorkerDeps } from '../../deps';
import { AWAIT_TTL_SEC, setAwaiting, type Awaiting } from './awaiting';
import type { CardService } from './cards';
import type { StaffMember } from './staff';

export { awaitKey } from './awaiting';

export const INVOICE_REPLY_TTL_SEC = AWAIT_TTL_SEC;

export const INVOICE_PROMPT = 'Номер и дата платёжного поручения';

/** Sends the ForceReply prompt and remembers which order the next reply is about. */
export async function askInvoiceReference(
  ctx: Context,
  deps: Pick<WorkerDeps, 'redis' | 'keyPrefix'>,
  order: { id: string; number: string },
): Promise<void> {
  const chatId = ctx.chat?.id;
  const userId = ctx.from?.id;
  if (chatId === undefined || userId === undefined) return;
  const prompt = await ctx.api.sendMessage(
    chatId,
    `${INVOICE_PROMPT} по заказу ${order.number}. Ответьте на это сообщение в течение 10 минут.`,
    {
      reply_markup: {
        force_reply: true,
        input_field_placeholder: '№ 512 от 02.10.2026',
      },
    },
  );
  await setAwaiting(deps, chatId, userId, {
    kind: 'invoice',
    orderId: order.id,
    promptMessageId: prompt.message_id,
  });
}

/** The reply to a «Счёт оплачен» prompt (taken from Redis by replies.ts): owner only. */
export async function handleInvoiceReply(
  ctx: Context,
  input: {
    deps: WorkerDeps;
    cards: CardService;
    awaiting: Extract<Awaiting, { kind: 'invoice' }>;
    staff: StaffMember;
    text: string;
  },
): Promise<void> {
  const { deps, cards, awaiting, staff, text } = input;
  if (staff.role !== 'owner') return;
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
}
