// Small helpers shared by the seller bot handlers: answering a button press and asking for a
// reply with a ForceReply prompt that is remembered in Redis (awaiting.ts, decision С25).
import type { Context } from 'grammy';
import type { WorkerDeps } from '../../deps';
import { setAwaiting, type Awaiting } from './awaiting';

/** Answers a callback query; an expired query (> 15 min, a restart) cannot be answered. */
export async function answerQuery(ctx: Context, text?: string): Promise<void> {
  try {
    await ctx.answerCallbackQuery(text ? { text } : undefined);
  } catch {
    // nothing to do
  }
}

/** The tail of every prompt: only a reply to this message counts. */
export const REPLY_WITHIN = 'Ответьте на это сообщение в течение 10 минут.';

/**
 * Sends a ForceReply prompt to the chat of the press and remembers what its reply is about
 * (one wait per chat and user, the newest wins). false when the update has no chat or user.
 */
export async function askForReply(
  ctx: Context,
  deps: Pick<WorkerDeps, 'redis' | 'keyPrefix'>,
  input: {
    text: string;
    placeholder?: string;
    /** The wait without its prompt id (filled in after Telegram answered). */
    awaiting: DistributiveOmit<Awaiting, 'promptMessageId'>;
  },
): Promise<boolean> {
  const chatId = ctx.chat?.id ?? ctx.callbackQuery?.message?.chat.id;
  const userId = ctx.from?.id;
  if (chatId === undefined || userId === undefined) return false;
  const prompt = await ctx.api.sendMessage(chatId, input.text, {
    reply_markup: {
      force_reply: true,
      ...(input.placeholder ? { input_field_placeholder: input.placeholder.slice(0, 64) } : {}),
    },
    link_preview_options: { is_disabled: true },
  });
  await setAwaiting(deps, chatId, userId, {
    ...input.awaiting,
    promptMessageId: prompt.message_id,
  } as Awaiting);
  return true;
}

/** Omit over every member of a union. */
export type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
