// Button presses of the client bot (docs/phase-1c-implementation.md section 8, decision С5).
// callback_data = `a:<action>:<order id | me>:<nonce>`; the nonce is random and not stored
// (except the slot choice, decision С6).
//
//   the pressing account must have an active (not blocked) telegram binding whose user owns the
//   order -> confirm / approve: performClientAction (the state machine decides) -> refund /
//   refused: only a link to /o/<token> (4 phone digits there, Б24) -> install: slot buttons ->
//   islot: bookInstall(via 'bot').
//
// Step 6 (docs/garage.md), only with GARAGE_ENABLED: «Мои машины» (garage), «Купить снова»
// (rebuy, an order of the client), «Удалить машину» and its confirmation (vdel, vdelok, a car of
// the client) — garage.ts. Without the switch these presses are stale buttons.
//
// Logs: update id, order number, action, outcome. Never a phone, a token or a Telegram id.
import { isClientAction, parseCallbackData, type ParsedCallbackData } from '@detaly/notify';
import {
  bookInstall,
  findBindingUser,
  performClientAction,
  type ApplyResult,
  type ClientAction,
} from '@detaly/orders';
import type { Context, Middleware } from 'grammy';
import type { InlineKeyboardButton, InlineKeyboardMarkup } from 'grammy/types';
import type { WorkerDeps } from '../../deps';
import { orderUrl } from '../../jobs/notify/template-data';
import { describeBotError } from '../seller/errors';
import { unsubscribe } from './bind';
import {
  askDeleteVehicle,
  confirmDeleteVehicle,
  garageEnabled,
  rebuyOrder,
  sendGarage,
  type GarageOutcome,
} from './garage';
import {
  installPaidText,
  loadOwnedOrder,
  parseSlotChoice,
  sendInstallSlots,
  sendOrdersList,
  slotKey,
  slotRequestKey,
  type OwnedOrder,
} from './menu';
import { urlButton } from './orders';
import { CLIENT_STATUS_LABELS, TEXTS } from './texts';

async function answer(ctx: Context, text?: string): Promise<void> {
  try {
    await ctx.answerCallbackQuery(text ? { text } : undefined);
  } catch {
    // An expired query (> 15 min or after a restart) cannot be answered; nothing to do.
  }
}

/** Order page anchors of the critical actions (decision С5). */
const CRITICAL: Readonly<Record<string, { anchor: string; what: string }>> = {
  refund: { anchor: 'decision', what: 'возврат денег' },
  refused: { anchor: 'refuse', what: 'отказ от заказа' },
};

const APPLIED: Readonly<
  Record<
    'confirm' | 'approve',
    { action: ClientAction; done: string; text: (orderNumber: string) => string }
  >
> = {
  confirm: { action: 'confirm', done: TEXTS.confirmed, text: TEXTS.confirmedText },
  approve: { action: 'approve', done: TEXTS.approved, text: TEXTS.approvedText },
};

/**
 * The message's keyboard without the callback buttons of `orderId` whose action is in `actions`
 * (a list of several orders keeps the others' buttons; url buttons always stay).
 */
export function withoutButtons(
  markup: InlineKeyboardMarkup | undefined,
  orderId: string,
  actions: readonly string[],
): InlineKeyboardButton[][] {
  const rows = markup?.inline_keyboard ?? [];
  return rows
    .map((row) =>
      row.filter((button) => {
        if (!('callback_data' in button) || button.callback_data === undefined) return true;
        const parsed = parseCallbackData(button.callback_data);
        return !(parsed && parsed.orderId === orderId && actions.includes(parsed.action));
      }),
    )
    .filter((row) => row.length > 0);
}

async function stripButtons(ctx: Context, orderId: string, actions: readonly string[]) {
  const message = ctx.callbackQuery?.message;
  if (message === undefined || !('reply_markup' in message)) return;
  const keyboard = withoutButtons(message.reply_markup, orderId, actions);
  try {
    await ctx.editMessageReplyMarkup({ reply_markup: { inline_keyboard: keyboard } });
  } catch {
    // VERIFY: the Bot API refuses edits of some old messages and answers 400 «message is not
    // modified» for an unchanged keyboard; either way the answer already told the result.
  }
}

function failureText(result: Extract<ApplyResult, { ok: false }>): string {
  if (result.reason === 'no_rule' && result.status !== null) {
    return TEXTS.notActual(CLIENT_STATUS_LABELS[result.status]);
  }
  return TEXTS.unavailable;
}

interface Outcome {
  ok: boolean;
  orderNumber: string | null;
}

async function applyAction(
  ctx: Context,
  deps: WorkerDeps,
  code: 'confirm' | 'approve',
  order: OwnedOrder,
): Promise<Outcome> {
  const spec = APPLIED[code];
  const result = await performClientAction(deps.engine, {
    orderId: order.id,
    userId: order.userId,
    action: spec.action,
  });
  if (result.ok) {
    await answer(ctx, spec.done);
    await stripButtons(ctx, order.id, ['confirm', 'approve', 'refund', 'refused']);
    await ctx.reply(spec.text(order.number));
    return { ok: true, orderNumber: order.number };
  }
  await answer(ctx, failureText(result));
  // The question is closed (no rule from the current status): the buttons are stale.
  if (result.reason === 'no_rule') {
    await stripButtons(ctx, order.id, ['confirm', 'approve', 'refund', 'refused']);
  }
  return { ok: false, orderNumber: order.number };
}

async function criticalLink(
  ctx: Context,
  deps: WorkerDeps,
  code: string,
  order: OwnedOrder,
): Promise<Outcome> {
  const spec = CRITICAL[code];
  if (spec === undefined) return { ok: false, orderNumber: order.number };
  await answer(ctx, TEXTS.confirmOnPage);
  await ctx.reply(TEXTS.confirmOnPageText(order.number, spec.what), {
    reply_markup: {
      inline_keyboard: [
        [urlButton(TEXTS.confirmOnPage, `${orderUrl(deps.env, order.accessToken)}#${spec.anchor}`)],
      ],
    },
  });
  return { ok: true, orderNumber: order.number };
}

async function bookSlot(
  ctx: Context,
  deps: WorkerDeps,
  parsed: ParsedCallbackData,
  order: OwnedOrder,
): Promise<Outcome> {
  const choice = parseSlotChoice(await deps.redis.get(slotKey(deps.keyPrefix, parsed.nonce)));
  if (choice === null || choice.orderId !== order.id || choice.userId !== order.userId) {
    await answer(ctx, TEXTS.installSlotStale);
    await sendInstallSlots(ctx, deps, order, TEXTS.installSlotStale);
    return { ok: false, orderNumber: order.number };
  }
  const result = await bookInstall(deps.engine, {
    orderId: order.id,
    slotAt: choice.startAt,
    via: 'bot',
    requestKey: slotRequestKey(parsed.nonce),
    actor: { type: 'client', id: order.userId },
  });
  if (result.ok) {
    await answer(ctx, TEXTS.installDoneShort);
    const text = [
      TEXTS.installDone(order.number, `${result.slot.dayText} ${result.slot.timeText}`),
      installPaidText(deps),
    ].join('\n');
    const keyboard = [
      [urlButton('Запись на странице заказа', `${orderUrl(deps.env, order.accessToken)}#install`)],
    ];
    try {
      await ctx.editMessageText(text, { reply_markup: { inline_keyboard: keyboard } });
    } catch {
      // Too old to edit (or the same text after a repeated press): say it in a new message.
      await ctx.reply(text, { reply_markup: { inline_keyboard: keyboard } });
    }
    return { ok: true, orderNumber: order.number };
  }
  switch (result.reason) {
    case 'slot_taken':
    case 'bad_slot': {
      const lead = result.reason === 'slot_taken' ? TEXTS.installSlotTaken : TEXTS.installBadSlot;
      await answer(ctx, lead);
      await sendInstallSlots(ctx, deps, order, lead);
      break;
    }
    case 'already_booked':
      await answer(ctx, TEXTS.installBooked);
      await stripButtons(ctx, order.id, ['islot', 'install']);
      break;
    case 'not_allowed':
      await answer(ctx, TEXTS.installStatus(CLIENT_STATUS_LABELS[order.status]));
      await stripButtons(ctx, order.id, ['islot', 'install']);
      break;
  }
  return { ok: false, orderNumber: order.number };
}

/** The «Мои машины» codes (step 6). */
const GARAGE_CODES: ReadonlySet<string> = new Set(['garage', 'rebuy', 'vdel', 'vdelok']);

/** A press of «Мои машины», «Купить снова», «Удалить машину» or its confirmation. */
async function garagePress(
  ctx: Context,
  deps: WorkerDeps,
  parsed: ParsedCallbackData,
  userId: string,
): Promise<GarageOutcome> {
  switch (parsed.action) {
    case 'garage':
      await answer(ctx);
      return { ok: (await sendGarage(ctx, deps, userId)) >= 0, orderNumber: null };
    case 'rebuy': {
      const order = await loadOwnedOrder(deps, parsed.orderId, userId);
      if (order === null) {
        await answer(ctx, TEXTS.notYours);
        return { ok: false, orderNumber: null };
      }
      // The search may take a few seconds: the spinner stops first.
      await answer(ctx, TEXTS.rebuyChecking);
      return rebuyOrder(ctx, deps, order);
    }
    case 'vdel':
      await answer(ctx);
      return askDeleteVehicle(ctx, deps, userId, parsed.orderId);
    case 'vdelok': {
      const outcome = await confirmDeleteVehicle(ctx, deps, userId, parsed.orderId);
      // A car already gone is said by a message (confirmDeleteVehicle), not twice.
      await answer(ctx, outcome.ok ? TEXTS.deletedShort : undefined);
      return outcome;
    }
    default:
      await answer(ctx, TEXTS.staleButton);
      return { ok: false, orderNumber: null };
  }
}

export function clientCallbackHandler(deps: WorkerDeps): Middleware<Context> {
  const token = deps.env.TG_CLIENT_BOT_TOKEN;
  return async (ctx) => {
    const query = ctx.callbackQuery;
    const from = ctx.from;
    if (query === undefined || from === undefined) return;
    const parsed = parseCallbackData(query.data ?? '');
    // Staff codes never act here: the client bot knows only the client ones.
    if (parsed === null || !isClientAction(parsed.action)) return answer(ctx, TEXTS.staleButton);

    const binding = await findBindingUser(deps.db, {
      channel: 'telegram',
      externalUserId: String(from.id),
    });
    if (binding === null) return answer(ctx, TEXTS.notYours);
    if (binding.blocked) return answer(ctx, TEXTS.blocked);

    const log = (outcome: Outcome) =>
      deps.logger.info(
        {
          updateId: ctx.update.update_id,
          orderNumber: outcome.orderNumber,
          action: parsed.action,
          ok: outcome.ok,
        },
        'client bot action',
      );

    try {
      if (parsed.action === 'orders') {
        await answer(ctx);
        await sendOrdersList(ctx, deps, binding.userId);
        return log({ ok: true, orderNumber: null });
      }
      if (parsed.action === 'unsub') {
        const changed = await unsubscribe(ctx, deps);
        await answer(ctx, TEXTS.stopped);
        if (changed) await ctx.reply(TEXTS.stopped);
        return;
      }
      if (GARAGE_CODES.has(parsed.action)) {
        // Step 6: without GARAGE_ENABLED nothing about a car is shown or changed.
        if (!garageEnabled(deps.env)) return answer(ctx, TEXTS.staleButton);
        const outcome = await garagePress(ctx, deps, parsed, binding.userId);
        deps.logger.info(
          {
            updateId: ctx.update.update_id,
            orderNumber: outcome.orderNumber,
            action: parsed.action,
            ok: outcome.ok,
            ...outcome.counts,
          },
          'client bot action',
        );
        return;
      }

      // Order actions: the order must be the bound user's (decision С5).
      const order = await loadOwnedOrder(deps, parsed.orderId, binding.userId);
      if (order === null) {
        log({ ok: false, orderNumber: null });
        return answer(ctx, TEXTS.notYours);
      }
      switch (parsed.action) {
        case 'confirm':
        case 'approve':
          return log(await applyAction(ctx, deps, parsed.action, order));
        case 'refund':
        case 'refused':
          return log(await criticalLink(ctx, deps, parsed.action, order));
        case 'install': {
          await answer(ctx);
          const shown = await sendInstallSlots(ctx, deps, order);
          return log({ ok: shown > 0, orderNumber: order.number });
        }
        case 'islot':
          return log(await bookSlot(ctx, deps, parsed, order));
        default:
          return answer(ctx, TEXTS.staleButton);
      }
    } catch (error) {
      deps.logger.error(
        {
          updateId: ctx.update.update_id,
          action: parsed.action,
          err: describeBotError(error, token),
        },
        'client bot action failed',
      );
      await answer(ctx, TEXTS.failed);
    }
  };
}
