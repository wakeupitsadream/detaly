// The mileage at the handover (step 6, docs/garage.md), only with GARAGE_ENABLED and only for an
// order with a car of «Моя машина»:
//
//   «Выдал» done -> «Пробег? (ответьте числом или нажмите «Пропустить»)» in the chat of the
//     press, with the «Пропустить» button (mskip); the wait of this staff member and chat is
//     kept in Redis (awaiting.ts, 10 minutes, a reply to this message only);
//   a reply «85000», «85 000 км» -> recordHandoverMileage (source `handover`): the mileage only
//     grows; the same number again changes nothing; a smaller one is asked once more and written
//     as a correction only when the staff answers the same number again;
//   «Пропустить» -> the wait is dropped, the question says «Пропущено».
//
// It never blocks the handover: the question goes out after the order is handed and the card is
// redrawn, and any failure here is logged and swallowed. Staff only (the bot's middleware).
// Messages and logs carry no VIN and no phone; logs carry ids, the staff id and the outcome.
import { eq, orders } from '@detaly/db';
import {
  formatDayMonth,
  formatMileage,
  parseMileage,
  vehicleLabel,
  type IsoDate,
} from '@detaly/domain';
import { buildCallbackData, newNonce, type ParsedCallbackData } from '@detaly/notify';
import { loadOrderVehicle, recordHandoverMileage } from '@detaly/orders';
import type { Context } from 'grammy';
import type { WorkerDeps } from '../../deps';
import { setAwaiting, takeAwaiting, type Awaiting } from './awaiting';
import { describeBotError } from './errors';
import { answerQuery, REPLY_WITHIN } from './prompts';
import type { StaffMember } from './staff';

/** The question, word for word (docs/garage.md). */
export const MILEAGE_QUESTION = 'Пробег? (ответьте числом или нажмите «Пропустить»)';
export const MILEAGE_SKIP_LABEL = 'Пропустить';
export const MILEAGE_SKIPPED = 'Пропущено';
export const MILEAGE_STALE = 'Вопрос уже закрыт';
export const MILEAGE_NOT_A_NUMBER =
  'Нужно число километров, например 85000. Ответьте на вопрос ещё раз или нажмите «Пропустить».';

type MileageWait = Extract<Awaiting, { kind: 'mileage' }>;

function skipKeyboard(orderId: string) {
  return {
    inline_keyboard: [
      [
        {
          text: MILEAGE_SKIP_LABEL,
          callback_data: buildCallbackData('mskip', orderId, newNonce()),
        },
      ],
    ],
  };
}

/** «85 000 км на 1 октября». */
function storedText(km: number, at: string | null): string {
  return `${formatMileage(km)}${at ? ` на ${formatDayMonth(at as IsoDate)}` : ''}`;
}

/** Removes the «Пропустить» button of a question (best effort: the message may be too old). */
async function closeQuestion(ctx: Context, chatId: number, messageId: number): Promise<void> {
  try {
    await ctx.api.editMessageReplyMarkup(chatId, messageId, {
      reply_markup: { inline_keyboard: [] },
    });
  } catch {
    // VERIFY: the Bot API refuses edits of some old messages; the answer already says the result.
  }
}

/**
 * After a successful «Выдал»: the question about the odometer when the order has a car
 * (GARAGE_ENABLED). Returns whether it was asked; never throws.
 */
export async function askHandoverMileage(
  ctx: Context,
  deps: WorkerDeps,
  orderId: string,
): Promise<boolean> {
  if (!deps.env.GARAGE_ENABLED) return false;
  const chatId = ctx.chat?.id ?? ctx.callbackQuery?.message?.chat.id;
  const userId = ctx.from?.id;
  if (chatId === undefined || userId === undefined) return false;
  try {
    const vehicle = await loadOrderVehicle(deps.db, orderId);
    if (vehicle === null) return false;
    const [order] = await deps.db
      .select({ number: orders.number })
      .from(orders)
      .where(eq(orders.id, orderId));
    const lines = [
      MILEAGE_QUESTION,
      `Заказ ${order?.number ?? ''} · ${vehicleLabel(vehicle)}`,
      vehicle.mileageKm !== null
        ? `Записано раньше: ${storedText(vehicle.mileageKm, vehicle.mileageAt)}.`
        : null,
      REPLY_WITHIN,
    ].filter((line): line is string => line !== null);
    const prompt = await ctx.api.sendMessage(chatId, lines.join('\n'), {
      reply_markup: skipKeyboard(orderId),
      link_preview_options: { is_disabled: true },
    });
    await setAwaiting(deps, chatId, userId, {
      kind: 'mileage',
      orderId,
      vehicleId: vehicle.id,
      correction: null,
      promptMessageId: prompt.message_id,
    });
    deps.logger.info({ orderId, action: 'mileage_asked' }, 'seller bot action');
    return true;
  } catch (error) {
    deps.logger.warn(
      { orderId, err: describeBotError(error, ctx.api.token) },
      'seller bot: mileage question failed',
    );
    return false;
  }
}

/** The staff's reply to the question (replies.ts found the wait and took it). */
export async function handleMileageReply(
  ctx: Context,
  input: { deps: WorkerDeps; awaiting: MileageWait; staff: StaffMember; text: string },
): Promise<void> {
  const { deps, awaiting, staff, text } = input;
  const chatId = ctx.chat?.id;
  const userId = ctx.from?.id;
  if (chatId === undefined || userId === undefined) return;
  const km = parseMileage(text);
  if (km === null) {
    // The same question stays open for another try.
    await setAwaiting(deps, chatId, userId, awaiting);
    await ctx.reply(MILEAGE_NOT_A_NUMBER);
    return;
  }
  const correction = awaiting.correction !== null && km === awaiting.correction;
  const result = await recordHandoverMileage(deps.db, {
    orderId: awaiting.orderId,
    mileageKm: km,
    correction,
    now: deps.now(),
  });
  deps.logger.info(
    {
      orderId: awaiting.orderId,
      action: 'mileage',
      staffId: staff.id,
      ok: result.ok,
      ...(result.ok ? { changed: result.changed, correction } : { reason: result.reason }),
    },
    'seller bot action',
  );
  await closeQuestion(ctx, chatId, awaiting.promptMessageId);
  if (!result.ok && result.reason === 'lower') {
    const prompt = await ctx.api.sendMessage(
      chatId,
      [
        `Записано раньше: ${storedText(result.storedKm, result.storedAt)}. Пробег не уменьшается.`,
        `Если ${formatMileage(km)} — исправление ошибки, ответьте этим числом ещё раз или нажмите «Пропустить».`,
        REPLY_WITHIN,
      ].join('\n'),
      { reply_markup: skipKeyboard(awaiting.orderId) },
    );
    await setAwaiting(deps, chatId, userId, {
      ...awaiting,
      correction: km,
      promptMessageId: prompt.message_id,
    });
    return;
  }
  if (!result.ok) {
    await ctx.reply('У заказа больше нет машины — пробег не записан.');
    return;
  }
  await ctx.reply(
    result.changed
      ? `Пробег записан: ${formatMileage(result.mileageKm)}.`
      : `Пробег ${formatMileage(result.mileageKm)} уже записан.`,
  );
}

/** «Пропустить» under the question: the presser's wait for this question is dropped. */
export async function handleMileageSkip(
  ctx: Context,
  deps: WorkerDeps,
  parsed: ParsedCallbackData,
  staff: StaffMember,
): Promise<void> {
  const message = ctx.callbackQuery?.message;
  const userId = ctx.from?.id;
  if (message === undefined || userId === undefined) return answerQuery(ctx, MILEAGE_STALE);
  const chatId = message.chat.id;
  const taken = await takeAwaiting(deps, chatId, userId, message.message_id, ['mileage']);
  if (taken === null || taken.orderId !== parsed.orderId) {
    // Answered, skipped, expired, or another staff member's question (his button stays).
    return answerQuery(ctx, MILEAGE_STALE);
  }
  deps.logger.info(
    { orderId: taken.orderId, action: 'mileage_skipped', staffId: staff.id },
    'seller bot action',
  );
  try {
    const text = 'text' in message && typeof message.text === 'string' ? message.text : '';
    // «Ответьте … в течение 10 минут» no longer applies: the question is closed.
    const kept = text
      .split('\n')
      .filter((line) => line !== REPLY_WITHIN)
      .join('\n');
    await ctx.api.editMessageText(chatId, message.message_id, `${kept}\n${MILEAGE_SKIPPED}.`, {
      reply_markup: { inline_keyboard: [] },
    });
  } catch {
    await closeQuestion(ctx, chatId, message.message_id);
  }
  return answerQuery(ctx, MILEAGE_SKIPPED);
}
