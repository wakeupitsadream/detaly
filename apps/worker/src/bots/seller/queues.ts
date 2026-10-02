// /queues (owner, decision Б30): job counts per queue and the latest 10 dead-letter entries with
// «Повторить». A dead-letter id (`notify|<job id>`) does not fit the callback id format, so the
// buttons carry the entry's position and the message nonce; the position -> id map of one
// rendering lives in Redis under that nonce and is taken once (GETDEL) by the first press.
import { formatReplyBy, newNonce, buildCallbackData } from '@detaly/notify';
import type { Context, Middleware } from 'grammy';
import type { DeadLetterView, QueueStats, WorkerDeps } from '../../deps';
import type { InlineKeyboard } from './card-view';
import { describeBotError } from './errors';
import { loadStaffMember } from './staff';

export const DEAD_LETTER_LIMIT = 10;
/** How long the buttons of a /queues message stay valid. */
export const QUEUES_BUTTONS_TTL_SEC = 24 * 60 * 60;
const ERROR_MAX = 120;

export function deadLetterKey(keyPrefix: string, nonce: string): string {
  return `${keyPrefix}seller:dlq:${nonce}`;
}

function statsLine(stats: QueueStats): string {
  return `${stats.queue}: ждут ${stats.waiting} · в работе ${stats.active} · отложено ${stats.delayed} · с ошибкой ${stats.failed}`;
}

function deadLetterLine(index: number, entry: DeadLetterView): string {
  const when = formatReplyBy(entry.failedAt) ?? entry.failedAt;
  const error =
    entry.error.length > ERROR_MAX ? `${entry.error.slice(0, ERROR_MAX)}…` : entry.error;
  return `${index}. ${entry.queue}/${entry.name} · ${when} · ${error || 'без описания'}`;
}

export interface QueuesView {
  text: string;
  keyboard: InlineKeyboard;
}

/** Renders /queues and stores the button map under a new nonce. */
export async function renderQueues(
  deps: Pick<WorkerDeps, 'inspector' | 'redis' | 'keyPrefix'>,
): Promise<QueuesView> {
  const [stats, entries] = await Promise.all([
    deps.inspector.stats(),
    deps.inspector.deadLetters(DEAD_LETTER_LIMIT),
  ]);
  const lines = ['Очереди', ...stats.map(statsLine), ''];
  if (entries.length === 0) {
    lines.push('Dead-letter: пусто');
    return { text: lines.join('\n'), keyboard: [] };
  }
  lines.push(`Dead-letter, последние ${entries.length}:`);
  const nonce = newNonce();
  const map: Record<string, string> = {};
  const keyboard: InlineKeyboard = [];
  entries.forEach((entry, i) => {
    const position = String(i + 1);
    map[position] = entry.id;
    lines.push(deadLetterLine(i + 1, entry));
    keyboard.push([
      {
        text: `Повторить ${position}: ${entry.queue}/${entry.name}`,
        callback_data: buildCallbackData('dlq', position, nonce),
      },
    ]);
  });
  await deps.redis.set(
    deadLetterKey(deps.keyPrefix, nonce),
    JSON.stringify(map),
    'EX',
    QUEUES_BUTTONS_TTL_SEC,
  );
  return { text: lines.join('\n'), keyboard };
}

/** /queues: the owner gets the overview; anyone else gets silence. */
export function queuesCommand(deps: WorkerDeps): Middleware<Context> {
  return async (ctx) => {
    const userId = ctx.from?.id;
    if (userId === undefined) return;
    const staff = await loadStaffMember(deps.db, userId);
    if (staff === null || staff.role !== 'owner') return;
    let view: QueuesView;
    try {
      view = await renderQueues(deps);
    } catch (error) {
      deps.logger.error(
        { err: describeBotError(error, deps.env.TG_SELLER_BOT_TOKEN) },
        '/queues failed',
      );
      await ctx.reply('Очереди недоступны: Redis не отвечает');
      return;
    }
    await ctx.reply(view.text, {
      ...(view.keyboard.length > 0 ? { reply_markup: { inline_keyboard: view.keyboard } } : {}),
      link_preview_options: { is_disabled: true },
    });
  };
}

/**
 * «Повторить» of a dead-letter entry. The caller checked the owner role. Returns the text for
 * answerCallbackQuery; the /queues message is redrawn with fresh buttons.
 */
export async function retryDeadLetterPress(
  ctx: Context,
  deps: WorkerDeps,
  input: { position: string; nonce: string; staffId: string },
): Promise<string> {
  const raw = await deps.redis.getdel(deadLetterKey(deps.keyPrefix, input.nonce));
  let id: string | undefined;
  try {
    id = raw === null ? undefined : (JSON.parse(raw) as Record<string, string>)[input.position];
  } catch {
    id = undefined;
  }
  if (id === undefined) return 'Список устарел, отправьте /queues ещё раз';
  const retried = await deps.inspector.retryDeadLetter(id);
  deps.logger.info({ action: 'dlq', staffId: input.staffId, ok: retried }, 'seller bot action');
  const message = retried ? 'Задача возвращена в очередь' : 'Задача уже убрана из dead-letter';
  const chatId = ctx.callbackQuery?.message?.chat.id;
  const messageId = ctx.callbackQuery?.message?.message_id;
  if (chatId !== undefined && messageId !== undefined) {
    try {
      const view = await renderQueues(deps);
      await ctx.api.editMessageText(chatId, messageId, view.text, {
        reply_markup: { inline_keyboard: view.keyboard },
        link_preview_options: { is_disabled: true },
      });
    } catch (error) {
      deps.logger.warn(
        { err: describeBotError(error, deps.env.TG_SELLER_BOT_TOKEN) },
        '/queues redraw failed',
      );
    }
  }
  return message;
}
