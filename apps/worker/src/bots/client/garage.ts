// «Мои машины» of the client bot (step 6, docs/garage.md), only with GARAGE_ENABLED:
//
//   /garage, «Мои машины»   -> one message per car (newest first): «Lada Vesta 1.6, 2019», the
//                              last 4 characters of the VIN and the mileage, the latest orders
//                              (number, date, «Бренд Артикул»); buttons «Купить снова DT-…» per
//                              order and «Удалить машину»;
//   «Купить снова» (rebuy)  -> createRepeatProposal of @detaly/vin: today's offers and prices of
//                              the order's parts by the VIN preview rule (priceOffer), marked goods
//                              and parts the supplier lacks left out with a note -> a message with
//                              the lines, the total and the /p/<token> link button;
//   «Удалить машину» (vdel) -> a confirmation; «Да, удалить» (vdelok) deletes the row (the
//                              orders keep everything else and lose the link).
//
// The pressing account's binding owns the car or the order (callbacks.ts checks the binding).
// Messages never carry more of a VIN than its last 4 characters; logs carry the update id, the
// order number, the action and counts — never a VIN, a phone or the proposal token.
import {
  formatDayMonth,
  formatMileage,
  formatPromise,
  formatRub,
  localDate,
  promisedDate,
  safeMul,
  vehicleLabel,
  vinTail,
  type IsoDate,
} from '@detaly/domain';
import { itemsLine, newNonce } from '@detaly/notify';
import {
  deleteUserVehicle,
  loadGarage,
  loadOrderSettings,
  loadUserVehicle,
  type GarageVehicleView,
} from '@detaly/orders';
import { createRepeatProposal, REPEAT_SKIP_LABELS, type RepeatSkipped } from '@detaly/vin';
import type { Context } from 'grammy';
import type { InlineKeyboardButton } from 'grammy/types';
import type { WorkerDeps } from '../../deps';
import { baseUrl } from '../../jobs/notify/template-data';
import { loadExcludedRules, vinSearch } from '../seller/vin';
import type { OwnedOrder } from './menu';
import { callbackButton, LIST_TARGET, urlButton } from './orders';
import { TEXTS } from './texts';

export interface RenderedGarageMessage {
  text: string;
  keyboard: InlineKeyboardButton[][];
}

/** «Мои машины» is on (GARAGE_ENABLED): the command, the button and the presses exist. */
export function garageEnabled(env: Pick<WorkerDeps['env'], 'GARAGE_ENABLED'>): boolean {
  return env.GARAGE_ENABLED === true;
}

/** One car as a message of «Мои машины» (pure: the tests read the text and the buttons). */
export function renderGarageVehicle(
  view: GarageVehicleView,
  nonce: () => string = newNonce,
): RenderedGarageMessage {
  const { vehicle } = view;
  const mileage =
    vehicle.mileageKm === null
      ? null
      : `${formatMileage(vehicle.mileageKm)}${
          vehicle.mileageAt ? ` на ${formatDayMonth(vehicle.mileageAt as IsoDate)}` : ''
        }`;
  const lines: string[] = [vehicleLabel(vehicle)];
  const details = TEXTS.garageDetails(vehicle.vin ? vinTail(vehicle.vin) : null, mileage);
  if (details) lines.push(details);
  if (view.orders.length === 0) {
    lines.push('', TEXTS.garageNoOrders);
  } else {
    lines.push('', TEXTS.garageOrdersHead);
    for (const order of view.orders) {
      lines.push(
        TEXTS.garageOrderLine(
          order.number,
          formatDayMonth(localDate(order.createdAt)),
          itemsLine(order.items),
        ),
      );
    }
  }
  const keyboard: InlineKeyboardButton[][] = view.orders.map((order) => [
    callbackButton(TEXTS.rebuyButton(order.number), 'rebuy', order.id, nonce),
  ]);
  keyboard.push([callbackButton(TEXTS.deleteButton, 'vdel', vehicle.id, nonce)]);
  return { text: lines.join('\n'), keyboard };
}

/** «Мои машины»: a message per car, or the empty text. Returns the number of cars. */
export async function sendGarage(ctx: Context, deps: WorkerDeps, userId: string): Promise<number> {
  const garage = await loadGarage(deps.db, userId);
  if (garage.length === 0) {
    await ctx.reply(TEXTS.garageEmpty);
    return 0;
  }
  for (const view of garage) {
    const message = renderGarageVehicle(view);
    await ctx.reply(message.text, {
      reply_markup: { inline_keyboard: message.keyboard },
      link_preview_options: { is_disabled: true },
    });
  }
  return garage.length;
}

/** «Не вошли: CASTROL EDGE 5W-40 — не продаём онлайн; …». */
function skippedList(skipped: readonly RepeatSkipped[]): string {
  return skipped.map((s) => `${s.brand} ${s.article} — ${REPEAT_SKIP_LABELS[s.reason]}`).join('; ');
}

export interface GarageOutcome {
  ok: boolean;
  orderNumber: string | null;
  /** Counts for the log line (never the token). */
  counts?: Record<string, number | boolean>;
}

/** «Купить снова» on an order of the pressing client (ownership checked by the caller). */
export async function rebuyOrder(
  ctx: Context,
  deps: WorkerDeps,
  order: OwnedOrder,
): Promise<GarageOutcome> {
  const settings = await loadOrderSettings(deps.db, deps.env);
  const now = deps.now();
  const result = await createRepeatProposal(deps.db, {
    orderId: order.id,
    userId: order.userId,
    search: vinSearch(deps),
    pricing: settings.pricing,
    excludedRules: await loadExcludedRules(deps.db),
    eta: settings.eta,
    now,
  });
  if (!result.ok) {
    switch (result.reason) {
      case 'not_found':
        await ctx.reply(TEXTS.notYours);
        break;
      case 'empty':
        await ctx.reply(TEXTS.rebuyEmpty(order.number));
        break;
      case 'supplier_unavailable':
        await ctx.reply(TEXTS.rebuySupplier);
        break;
      case 'none_available':
        await ctx.reply(TEXTS.rebuyNone(order.number, skippedList(result.skipped)));
        break;
    }
    return {
      ok: false,
      orderNumber: order.number,
      counts: { skipped: result.skipped.length },
    };
  }
  const dates = result.lines.map((line) => line.etaDate);
  const promise = dates.length > 0 ? formatPromise(promisedDate(dates, settings.eta)) : null;
  const text = [
    TEXTS.rebuyHead(result.orderNumber),
    ...result.lines.map((line) =>
      TEXTS.rebuyLine(
        `${line.brand} ${line.article}`,
        line.qty,
        formatRub(safeMul(line.priceClientKop, line.qty)),
      ),
    ),
    TEXTS.rebuyTotal(formatRub(result.totalKop), promise),
    result.skipped.length > 0 ? TEXTS.rebuySkipped(skippedList(result.skipped)) : null,
    TEXTS.rebuyExpires(formatDayMonth(localDate(result.expiresAt))),
  ]
    .filter((line): line is string => line !== null)
    .join('\n');
  // The /p/<token> link: a bearer secret, sent only into the client's own chat.
  await ctx.reply(text, {
    reply_markup: {
      inline_keyboard: [[urlButton(TEXTS.rebuyOpen, `${baseUrl(deps.env)}/p/${result.token}`)]],
    },
    link_preview_options: { is_disabled: true },
  });
  return {
    ok: true,
    orderNumber: result.orderNumber,
    counts: {
      lines: result.lines.length,
      skipped: result.skipped.length,
      duplicate: result.duplicate,
    },
  };
}

/** «Удалить машину»: the confirmation (the car must be the client's own). */
export async function askDeleteVehicle(
  ctx: Context,
  deps: WorkerDeps,
  userId: string,
  vehicleId: string,
): Promise<GarageOutcome> {
  const vehicle = await loadUserVehicle(deps.db, { userId, vehicleId });
  if (vehicle === null) {
    await ctx.reply(TEXTS.vehicleGone);
    return { ok: false, orderNumber: null };
  }
  await ctx.reply(TEXTS.deleteAsk(vehicleLabel(vehicle)), {
    reply_markup: {
      inline_keyboard: [
        [
          callbackButton(TEXTS.deleteYes, 'vdelok', vehicle.id),
          callbackButton(TEXTS.deleteNo, 'garage', LIST_TARGET),
        ],
      ],
    },
  });
  return { ok: true, orderNumber: null };
}

/** «Да, удалить»: the row goes (hard delete), the orders keep everything but the link. */
export async function confirmDeleteVehicle(
  ctx: Context,
  deps: WorkerDeps,
  userId: string,
  vehicleId: string,
): Promise<GarageOutcome> {
  const vehicle = await loadUserVehicle(deps.db, { userId, vehicleId });
  const deleted = vehicle !== null && (await deleteUserVehicle(deps.db, { userId, vehicleId }));
  if (!deleted || vehicle === null) {
    await ctx.reply(TEXTS.vehicleGone);
    return { ok: false, orderNumber: null };
  }
  const text = TEXTS.deleted(vehicleLabel(vehicle));
  try {
    await ctx.editMessageText(text, { reply_markup: { inline_keyboard: [] } });
  } catch {
    // Too old to edit: say it in a new message.
    await ctx.reply(text);
  }
  return { ok: true, orderNumber: null };
}
