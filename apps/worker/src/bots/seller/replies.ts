// Text replies of staff to the seller bot's ForceReply prompts (decision С25): «Счёт оплачен»
// (invoice.ts), the claim decision text and the owner's override reason, the master's VIN answer
// and the reason to close a VIN request. Only a reply of the same user to the prompt counts
// (awaiting.ts); any other text — including commands — goes on to the next handler (silence).
//
// Logs: ids, the action, the staff id and the outcome; never the texts (they may hold PD).
import { CLAIM_DECISION_TEXT_MAX } from '@detaly/domain';
import { performStaffAction } from '@detaly/orders';
import type { Context, Middleware } from 'grammy';
import type { WorkerDeps } from '../../deps';
import { takeAwaiting, type Awaiting } from './awaiting';
import type { CardService } from './cards';
import { describeBotError } from './errors';
import { handleInvoiceReply } from './invoice';
import { CLAIM_TEXT_PROMPT } from './order-workflow';
import { askForReply, REPLY_WITHIN } from './prompts';
import { loadStaffMember, type StaffMember } from './staff';
import { handleVinAnswer, handleVinClose } from './vin';

/** Characters of the owner's override reason (claims NOTE_MAX of @detaly/orders). */
export const OVERRIDE_REASON_MAX = 500;

const BUTTON_AGAIN: Record<'cref' | 'crepl' | 'crej', string> = {
  cref: '«Вернуть деньги»',
  crepl: '«Замена»',
  crej: '«Отказать по претензии»',
};

async function refreshCard(
  ctx: Context,
  deps: WorkerDeps,
  cards: CardService,
  orderId: string,
): Promise<void> {
  try {
    await cards.refresh(orderId);
  } catch (error) {
    deps.logger.warn(
      { orderId, err: describeBotError(error, ctx.api.token) },
      'seller card refresh failed',
    );
  }
}

async function handleClaimReason(
  ctx: Context,
  deps: WorkerDeps,
  awaiting: Extract<Awaiting, { kind: 'claim_reason' }>,
  staff: StaffMember,
  text: string,
): Promise<void> {
  const reason = text.trim();
  if (staff.role !== 'owner') return;
  if (reason === '' || reason.length > OVERRIDE_REASON_MAX) {
    await ctx.reply(
      `Причина — от 1 до ${OVERRIDE_REASON_MAX} символов. Нажмите «Вернуть деньги» ещё раз.`,
    );
    return;
  }
  // The reason waits for the answer text in the next prompt (10 minutes, this user only).
  await askForReply(ctx, deps, {
    text: `${CLAIM_TEXT_PROMPT}. Решение: вернуть деньги без приёмки детали. ${REPLY_WITHIN}`,
    awaiting: {
      kind: 'claim_text',
      code: 'cref',
      orderId: awaiting.orderId,
      claimId: awaiting.claimId,
      reason,
    },
  });
}

async function handleClaimText(
  ctx: Context,
  deps: WorkerDeps,
  cards: CardService,
  awaiting: Extract<Awaiting, { kind: 'claim_text' }>,
  staff: StaffMember,
  text: string,
): Promise<void> {
  const answer = text.trim();
  if (answer === '' || answer.length > CLAIM_DECISION_TEXT_MAX) {
    await ctx.reply(
      `Ответ клиенту — от 1 до ${CLAIM_DECISION_TEXT_MAX} символов. Нажмите ${BUTTON_AGAIN[awaiting.code]} ещё раз.`,
    );
    return;
  }
  const result = await performStaffAction(deps.engine, {
    staff: { id: staff.id, role: staff.role, via: 'bot' },
    action: awaiting.code,
    targetId: awaiting.claimId,
    input: { text: answer, ...(awaiting.reason !== null ? { reason: awaiting.reason } : {}) },
  });
  deps.logger.info(
    {
      orderId: awaiting.orderId,
      claimId: awaiting.claimId,
      action: awaiting.code,
      staffId: staff.id,
      override: awaiting.reason !== null,
      ok: result.ok,
    },
    'seller bot action',
  );
  await ctx.reply(
    result.ok
      ? `${result.message}. Клиент увидит ответ на странице заказа.`
      : `${result.message}. Нажмите ${BUTTON_AGAIN[awaiting.code]} ещё раз.`,
  );
  if (result.ok) await refreshCard(ctx, deps, cards, awaiting.orderId);
}

export function replyHandler(input: { deps: WorkerDeps; cards: CardService }): Middleware<Context> {
  const { deps, cards } = input;
  return async (ctx, next) => {
    const text = ctx.message?.text;
    const chatId = ctx.chat?.id;
    const userId = ctx.from?.id;
    if (text === undefined || chatId === undefined || userId === undefined) return next();
    if (text.startsWith('/')) return next();
    const awaiting = await takeAwaiting(
      deps,
      chatId,
      userId,
      ctx.message?.reply_to_message?.message_id,
      ['invoice', 'claim_reason', 'claim_text', 'vin_answer', 'vin_close'],
    );
    // Not a reply to this user's prompt: ordinary chat text, the wait goes on until its TTL.
    if (awaiting === null) return next();
    const staff = await loadStaffMember(deps.db, userId);
    if (staff === null) return;
    switch (awaiting.kind) {
      case 'invoice':
        return handleInvoiceReply(ctx, { deps, cards, awaiting, staff, text });
      case 'claim_reason':
        return handleClaimReason(ctx, deps, awaiting, staff, text);
      case 'claim_text':
        return handleClaimText(ctx, deps, cards, awaiting, staff, text);
      case 'vin_answer':
        return handleVinAnswer(ctx, { deps, cards, awaiting, staff, text });
      case 'vin_close':
        return handleVinClose(ctx, { deps, cards, awaiting, staff, text });
    }
  };
}
