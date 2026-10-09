// VIN request cards in the seller bot (docs/phase-1c-implementation.md section 9 item 5,
// decisions С13, С25): the buttons of a `vin` card and the master's answer in lines.
//
//   «Взять в работу» (vtake)     -> takeVinRequest, the card redrawn;
//   «Ответить строками» (vans),
//   «Исправить» (vfix)           -> ForceReply with the format -> the lines (replies.ts) ->
//                                   previewVinAnswer (GetSearch through deps.rossko: cache 15 min,
//                                   the shared limiter, priority search) -> saveVinPreview -> a
//                                   new card with the preview (✓/✗ per line, the total), the
//                                   older cards of the request closed;
//   «Отправить клиенту» (vsend)  -> only while the preview has no errors: sendVinProposal (the
//                                   proposal cart, /p/<token>, notify/vin vin_proposal);
//   «Закрыть заявку» (vclose)    -> ForceReply for the reason -> closeVinRequest.
//
// Logs carry the request id, counts and the staff id: never the phone, the VIN, the texts or
// the proposal token (decision С28).
import { eq, excludedGroups, vinRequests, type Db } from '@detaly/db';
import { DEFAULT_EXCLUDED_RULES, type ExcludedRule } from '@detaly/domain';
import type { ParsedCallbackData } from '@detaly/notify';
import { loadOrderSettings } from '@detaly/orders';
import { searchFailure } from '@detaly/rossko';
import {
  closeVinRequest,
  previewVinAnswer,
  saveVinPreview,
  sendVinProposal,
  takeVinRequest,
  VIN_ANSWER_TEXT_MAX,
  VIN_CLOSE_REASON_MAX,
  type VinSearch,
} from '@detaly/vin';
import type { Context } from 'grammy';
import type { WorkerDeps } from '../../deps';
import type { Awaiting } from './awaiting';
import { VIN_PREVIEW_HEADLINE, type CardService, type VinCardRow } from './cards';
import { describeBotError } from './errors';
import { answerQuery, askForReply, REPLY_WITHIN } from './prompts';
import type { StaffMember } from './staff';
import { isVinFinished, VIN_ANSWER_FORMAT, vinChannelLabel } from './vin-view';

export const VIN_CLOSED = 'Заявка уже закрыта';
export const VIN_ANSWER_PROMPT = 'Ответ строками на заявку VIN';
export const VIN_CLOSE_PROMPT = 'Причина закрытия заявки (клиенту не уходит)';
/** How much of the previous answer «Исправить» quotes in its prompt. */
const PREVIOUS_ANSWER_MAX = 2500;

/** A supplier answer that is an error, not "nothing found": the line is supplier_unavailable. */
class SupplierSearchError extends Error {
  constructor() {
    super('GetSearch refused');
    this.name = 'SupplierSearchError';
  }
}

/** Active excluded_groups rules; the domain defaults when the table is empty (as recheck). */
export async function loadExcludedRules(db: Db): Promise<ExcludedRule[]> {
  const rows = await db
    .select({
      kind: excludedGroups.kind,
      pattern: excludedGroups.pattern,
      reason: excludedGroups.reason,
    })
    .from(excludedGroups)
    .where(eq(excludedGroups.active, true));
  return rows.length > 0 ? rows : [...DEFAULT_EXCLUDED_RULES];
}

/** GetSearch of the preview: cached (15 min) and limited like every search of the worker. */
export function vinSearch(deps: Pick<WorkerDeps, 'rossko'>): VinSearch {
  return async (article) => {
    const result = await deps.rossko.search(article, { priority: 'search' });
    if (result.offers.length === 0 && result.message !== null) {
      // An error answer looks like "nothing found": never read it as "no such article".
      if (searchFailure({ success: false, message: result.message }) !== null) {
        throw new SupplierSearchError();
      }
    }
    return result.offers;
  };
}

async function requestState(
  deps: WorkerDeps,
  id: string,
): Promise<{
  status: (typeof vinRequests.$inferSelect)['status'];
  answerText: string | null;
  channel: (typeof vinRequests.$inferSelect)['channel'];
} | null> {
  const [row] = await deps.db
    .select({
      status: vinRequests.status,
      answerText: vinRequests.answerText,
      channel: vinRequests.channel,
    })
    .from(vinRequests)
    .where(eq(vinRequests.id, id));
  return row ?? null;
}

async function redraw(deps: WorkerDeps, cards: CardService, card: VinCardRow, token: string) {
  try {
    await cards.redrawVin(card.id);
  } catch (error) {
    deps.logger.warn(
      { vinRequestId: card.vinRequestId, err: describeBotError(error, token) },
      'seller VIN card redraw failed',
    );
  }
}

/** A press on a VIN card whose nonce the caller found. Answers the query itself. */
export async function handleVinPress(
  ctx: Context,
  input: {
    deps: WorkerDeps;
    cards: CardService;
    card: VinCardRow;
    parsed: ParsedCallbackData;
    staff: StaffMember;
  },
): Promise<void> {
  const { deps, cards, card, parsed, staff } = input;
  const token = ctx.api.token;
  const code = parsed.action;
  const id = card.vinRequestId;
  const state = await requestState(deps, id);
  if (state === null) return answerQuery(ctx, 'Заявка не найдена');
  if (isVinFinished(state.status)) {
    await answerQuery(ctx, VIN_CLOSED);
    if (await cards.claim(card)) await redraw(deps, cards, card, token);
    return;
  }

  switch (code) {
    case 'vans':
    case 'vfix': {
      const previous =
        code === 'vfix' && state.answerText
          ? `\n\nБыло:\n${state.answerText.slice(0, PREVIOUS_ANSWER_MAX)}`
          : '';
      await askForReply(ctx, deps, {
        text: `${VIN_ANSWER_PROMPT}. ${VIN_ANSWER_FORMAT}\n${REPLY_WITHIN}${previous}`,
        placeholder: 'MANN W914/2 1',
        awaiting: { kind: 'vin_answer', vinRequestId: id },
      });
      return answerQuery(ctx, 'Ответьте строками на сообщение');
    }
    case 'vclose':
      await askForReply(ctx, deps, {
        text: `${VIN_CLOSE_PROMPT}. ${REPLY_WITHIN}`,
        awaiting: { kind: 'vin_close', vinRequestId: id },
      });
      return answerQuery(ctx, 'Напишите причину ответом на сообщение');
    case 'vtake':
    case 'vsend':
      break;
    default:
      return answerQuery(ctx, 'Карточка устарела, откройте свежую');
  }

  // vtake / vsend change the request: the card is taken first (a second press is stale).
  if (!(await cards.claim(card))) return answerQuery(ctx, 'Карточка устарела, откройте свежую');
  let message: string;
  try {
    if (code === 'vtake') {
      const result = await takeVinRequest(deps.db, { id, staffId: staff.id, now: deps.now() });
      message = result.ok ? 'Заявка в работе' : VIN_CLOSED;
    } else {
      const result = await sendVinProposal(
        { db: deps.db, now: deps.now, nudge: deps.engine.nudge },
        { id, staffId: staff.id },
      );
      if (result.ok) {
        message = result.duplicate
          ? 'Эта подборка уже отправлена клиенту'
          : `Подборка отправлена клиенту (${vinChannelLabel(state.channel)})`;
      } else if (result.reason === 'has_errors') {
        message = 'В ответе есть ошибки — нажмите «Исправить»';
      } else if (result.reason === 'empty') {
        message = 'Нет позиций для отправки — ответьте строками';
      } else {
        message = VIN_CLOSED;
      }
      deps.logger.info(
        {
          vinRequestId: id,
          action: code,
          staffId: staff.id,
          ok: result.ok,
          ...(result.ok ? { n: result.n, duplicate: result.duplicate } : { reason: result.reason }),
        },
        'seller bot VIN action',
      );
    }
  } catch (error) {
    deps.logger.error(
      { vinRequestId: id, action: code, err: describeBotError(error, token) },
      'seller bot VIN action failed',
    );
    message = 'Не получилось, попробуйте ещё раз';
  }
  await answerQuery(ctx, message);
  await redraw(deps, cards, card, token);
}

/**
 * The lines of the master's answer (the reply to the «Ответ строками» prompt): the preview is
 * checked with GetSearch, saved, and posted as a new card of the request.
 */
export async function handleVinAnswer(
  ctx: Context,
  input: {
    deps: WorkerDeps;
    cards: CardService;
    awaiting: Extract<Awaiting, { kind: 'vin_answer' }>;
    staff: StaffMember;
    text: string;
  },
): Promise<void> {
  const { deps, cards, awaiting, staff, text } = input;
  const id = awaiting.vinRequestId;
  if (text.length > VIN_ANSWER_TEXT_MAX) {
    await ctx.reply(
      'Ответ слишком длинный — не больше 20 позиций. Нажмите «Ответить строками» ещё раз.',
    );
    return;
  }
  const settings = await loadOrderSettings(deps.db, deps.env);
  const now = deps.now();
  const preview = await previewVinAnswer({
    text,
    search: vinSearch(deps),
    pricing: settings.pricing,
    excludedRules: await loadExcludedRules(deps.db),
    eta: settings.eta,
    now,
  });
  const saved = await saveVinPreview(deps.db, {
    id,
    answerText: text,
    preview,
    staffId: staff.id,
    now,
  });
  deps.logger.info(
    {
      vinRequestId: id,
      action: 'vin_answer',
      staffId: staff.id,
      ok: saved.ok,
      okCount: preview.okCount,
      errorCount: preview.errorCount,
    },
    'seller bot VIN answer',
  );
  if (!saved.ok) {
    await ctx.reply(`${VIN_CLOSED} — ответ не сохранён`);
    return;
  }
  const posted = await cards.postVinCard({ vinRequestId: id, headline: VIN_PREVIEW_HEADLINE });
  if (posted.status !== 'posted') {
    // No sellers chat configured (a private chat with the bot): the old card shows the preview.
    await cards.refreshVin(id);
    await ctx.reply(
      preview.errorCount > 0
        ? `Превью сохранено: ошибок ${preview.errorCount} — нажмите «Исправить»`
        : 'Превью сохранено — проверьте и нажмите «Отправить клиенту»',
    );
  }
}

/** The reason of «Закрыть заявку» (the reply to its prompt). */
export async function handleVinClose(
  ctx: Context,
  input: {
    deps: WorkerDeps;
    cards: CardService;
    awaiting: Extract<Awaiting, { kind: 'vin_close' }>;
    staff: StaffMember;
    text: string;
  },
): Promise<void> {
  const { deps, cards, awaiting, staff, text } = input;
  const id = awaiting.vinRequestId;
  const result = await closeVinRequest(deps.db, {
    id,
    reason: text.trim().slice(0, VIN_CLOSE_REASON_MAX),
    now: deps.now(),
  });
  deps.logger.info(
    { vinRequestId: id, action: 'vclose', staffId: staff.id, ok: result.ok },
    'seller bot VIN action',
  );
  await ctx.reply(
    result.ok ? 'Заявка закрыта' : 'Заявку не закрыть: по подборке уже оформлен заказ',
  );
  try {
    await cards.refreshVin(id);
  } catch (error) {
    deps.logger.warn(
      { vinRequestId: id, err: describeBotError(error, ctx.api.token) },
      'seller VIN card refresh failed',
    );
  }
}
