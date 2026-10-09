// Fit check cards in the seller bot (step 4, docs/fit-check.md): a press on one line of a card.
//
//   «Подходит» (ffit), «Не подходит» (fnot), «Нужен звонок» (fcall) -> answerFitCheck: only a
//     pending line changes, the card is redrawn with who answered what and when. A second press on
//     an answered line edits nothing and says «Уже отвечено: …»;
//   «Аналог» (fanlg) -> a ForceReply «БРЕНД АРТИКУЛ» (replies.ts) -> resolveFitAnalog: GetSearch
//     through deps.rossko exactly as the VIN preview (cache 15 min, the shared limiter, priority
//     search), the price through priceOffer -> found: answerFitAnalog and the card redrawn; not
//     found: «Не нашёл у поставщика — проверьте артикул», the line keeps waiting.
//
// Staff only (the bot's middleware). Logs carry the request id, the line id, the answer and the
// staff id: never the VIN or the client's comment.
import {
  FIT_CHECK_ANSWER_LABELS,
  FIT_CHECK_STATUS_LABELS,
  formatPromise,
  formatRub,
  promisedDate,
  type FitCheckStatus,
} from '@detaly/domain';
import { workflowAction, type ParsedCallbackData } from '@detaly/notify';
import { loadOrderSettings } from '@detaly/orders';
import {
  answerFitAnalog,
  answerFitCheck,
  loadFitCheck,
  loadFitRequestForStaff,
  resolveFitAnalog,
} from '@detaly/vin';
import type { Context } from 'grammy';
import type { WorkerDeps } from '../../deps';
import type { Awaiting } from './awaiting';
import type { CardService, FitCardRow } from './cards';
import { describeBotError } from './errors';
import { answerQuery, askForReply, REPLY_WITHIN } from './prompts';
import type { StaffMember } from './staff';
import { loadExcludedRules, vinSearch } from './vin';

export const FIT_STALE = 'Карточка устарела, откройте свежую';
export const FIT_ALREADY_ANSWERED = 'Уже отвечено';
/** The longest reply taken for «Аналог» (a brand and an article). */
export const FIT_ANALOG_REPLY_MAX = 200;

/** «Уже отвечено: подходит». */
export function alreadyAnswered(status: FitCheckStatus): string {
  return `${FIT_ALREADY_ANSWERED}: ${FIT_CHECK_STATUS_LABELS[status]}`;
}

async function redraw(
  deps: WorkerDeps,
  cards: CardService,
  card: FitCardRow,
  token: string,
): Promise<void> {
  try {
    await cards.redrawFit(card.id);
  } catch (error) {
    deps.logger.warn(
      { fitRequestId: card.fitRequestId, err: describeBotError(error, token) },
      'seller fit card redraw failed',
    );
  }
}

/** A press on a line of a fit card whose nonce the caller found. Answers the query itself. */
export async function handleFitPress(
  ctx: Context,
  input: {
    deps: WorkerDeps;
    cards: CardService;
    card: FitCardRow;
    parsed: ParsedCallbackData;
    staff: StaffMember;
  },
): Promise<void> {
  const { deps, cards, card, parsed, staff } = input;
  const token = ctx.api.token;
  const spec = workflowAction(parsed.action);
  if (spec?.kind !== 'fit') return answerQuery(ctx, FIT_STALE);
  const check = await loadFitCheck(deps.db, parsed.orderId);
  // The line must belong to this card's request.
  if (check === null || check.requestId !== card.fitRequestId) {
    return answerQuery(ctx, FIT_STALE);
  }
  // Answered already (by another press, the admin), expired or cancelled: nothing is edited.
  if (check.status !== 'pending') {
    return answerQuery(ctx, alreadyAnswered(check.status as FitCheckStatus));
  }

  if (spec.action === 'analog') {
    const request = await loadFitRequestForStaff(deps.db, card.fitRequestId);
    const line = request?.lines.find((l) => l.id === check.id);
    const what = `${check.brand} ${check.article} — ${check.name}`;
    await askForReply(ctx, deps, {
      text:
        `Аналог для строки ${line?.n ?? ''}: ${what}. ` +
        `Ответьте «БРЕНД АРТИКУЛ», например «KNECHT OC90». ${REPLY_WITHIN}`,
      placeholder: 'KNECHT OC90',
      awaiting: { kind: 'fit_analog', fitCheckId: check.id, fitRequestId: card.fitRequestId },
    });
    return answerQuery(ctx, 'Ответьте «БРЕНД АРТИКУЛ» на сообщение');
  }

  let message: string;
  try {
    const result = await answerFitCheck(deps.db, {
      id: check.id,
      answer: spec.action,
      staffId: staff.id,
      now: deps.now(),
    });
    deps.logger.info(
      {
        fitRequestId: card.fitRequestId,
        fitCheckId: check.id,
        answer: spec.action,
        staffId: staff.id,
        ok: result.ok,
      },
      'seller bot fit answer',
    );
    if (!result.ok) {
      return answerQuery(
        ctx,
        result.reason === 'answered' ? alreadyAnswered(result.status) : FIT_STALE,
      );
    }
    message = `Записано: ${FIT_CHECK_ANSWER_LABELS[spec.action].toLowerCase()}`;
  } catch (error) {
    deps.logger.error(
      { fitRequestId: card.fitRequestId, err: describeBotError(error, token) },
      'seller bot fit answer failed',
    );
    return answerQuery(ctx, 'Не получилось, попробуйте ещё раз');
  }
  await answerQuery(ctx, message);
  await redraw(deps, cards, card, token);
}

/** The master's «БРЕНД АРТИКУЛ» (the reply to the «Аналог» prompt). */
export async function handleFitAnalog(
  ctx: Context,
  input: {
    deps: WorkerDeps;
    cards: CardService;
    awaiting: Extract<Awaiting, { kind: 'fit_analog' }>;
    staff: StaffMember;
    text: string;
  },
): Promise<void> {
  const { deps, cards, awaiting, staff, text } = input;
  const check = await loadFitCheck(deps.db, awaiting.fitCheckId);
  if (check === null) {
    await ctx.reply('Проверка не найдена');
    return;
  }
  if (check.status !== 'pending') {
    await ctx.reply(alreadyAnswered(check.status as FitCheckStatus));
    return;
  }
  if (text.length > FIT_ANALOG_REPLY_MAX) {
    await ctx.reply('Слишком длинно: нужно «БРЕНД АРТИКУЛ». Нажмите «Аналог» ещё раз.');
    return;
  }
  const settings = await loadOrderSettings(deps.db, deps.env);
  const now = deps.now();
  const resolved = await resolveFitAnalog({
    text,
    original: { brand: check.brand, article: check.article },
    search: vinSearch(deps),
    pricing: settings.pricing,
    excludedRules: await loadExcludedRules(deps.db),
    eta: settings.eta,
    now,
  });
  if (!resolved.ok) {
    deps.logger.info(
      {
        fitRequestId: check.requestId,
        fitCheckId: check.id,
        answer: 'analog',
        staffId: staff.id,
        ok: false,
        reason: resolved.reason,
      },
      'seller bot fit answer',
    );
    await ctx.reply(`${resolved.message}. Нажмите «Аналог» ещё раз.`);
    return;
  }
  const saved = await answerFitAnalog(deps.db, {
    id: check.id,
    analog: resolved.analog,
    staffId: staff.id,
    now,
  });
  deps.logger.info(
    {
      fitRequestId: check.requestId,
      fitCheckId: check.id,
      answer: 'analog',
      staffId: staff.id,
      ok: saved.ok,
    },
    'seller bot fit answer',
  );
  if (!saved.ok) {
    await ctx.reply(saved.reason === 'answered' ? alreadyAnswered(saved.status) : FIT_STALE);
    return;
  }
  const { analog } = resolved;
  const when = formatPromise(promisedDate([analog.etaDate], settings.eta));
  await ctx.reply(
    `Аналог записан: ${analog.brand} ${analog.article} — ${formatRub(analog.priceClientKop)}, ${when}. Клиент увидит его в корзине.`,
  );
  try {
    await cards.refreshFit(check.requestId);
  } catch (error) {
    deps.logger.warn(
      { fitRequestId: check.requestId, err: describeBotError(error, ctx.api.token) },
      'seller fit card refresh failed',
    );
  }
}
