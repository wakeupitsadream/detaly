/**
 * POST /api/cart/items/<id>/fit (step 4, docs/fit-check.md): the client's answer to the master's
 * analog on a cart line.
 *
 * - `replace` («Заменить»): the analog offer is found again through the supplier cache (priority
 *   search, the same as «В корзину»), priced with priceOffer (cartLineFromOffer) and takes the
 *   place of the line in the cart — the line keeps its id, so the check stays with it and the
 *   line now matches the analog: it counts as checked. When the cart already has that offer, the
 *   quantity goes to that line, the check moves with it and the old line goes.
 * - `keep` («Оставить как есть»): fit_checks.analog_kept_at; the line keeps its part, unchecked.
 *
 * Origin (403), the `cart` cookie (only a line of the caller's own cart, 404), a urlencoded or
 * JSON body. A form without JavaScript gets 303 back to the line; JSON gets {ok}. Rate limit:
 * the `cart` writes of src/proxy.ts. Logs: codes only, never the cart token.
 */
import type { Env } from '@detaly/config';
import { and, cartItems, carts, eq, fitChecks, isNull, type Database } from '@detaly/db';
import {
  ARTICLE_NORM_RE,
  CartError,
  cartLineFromOffer,
  cartTotals,
  fitLineState,
  MAX_LINE_QTY,
  MAX_ORDER_TOTAL_KOP,
  offerViewId,
  validateQty,
  type CartLine,
  type Offer,
} from '@detaly/domain';
import type { RosskoClient } from '@detaly/rossko';
import { fitFactsOf, latestFitChecksOfLines } from '@detaly/vin';
import { readBoundedText } from '../body';
import { findActiveCart, readCartToken } from '../cart-store';
import { lineValues, type CartSettings } from '../cart/cart-service';
import { requestCookies } from '../cart/http';
import { errorInfo } from '../errors';
import { isSameOrigin } from '../request-guards';
import { jsonResponse, messagePage, seeOther, wantsJson } from '../vin/http';
import { lineIdOf } from './form';

export const FIT_LINE_ACTIONS = ['replace', 'keep'] as const;
export type FitLineAction = (typeof FIT_LINE_ACTIONS)[number];

export interface FitLineActionDeps {
  db: Database;
  env: Pick<Env, 'APP_BASE_URL'>;
  supplier: { rossko: Pick<RosskoClient, 'search'> };
  loadSettings: () => Promise<CartSettings>;
  logger: {
    info(details: Record<string, unknown>, message: string): void;
    error(details: Record<string, unknown>, message: string): void;
  };
  now?: () => Date;
}

export const FIT_LINE_MESSAGES = {
  forbiddenOrigin: 'Запрос отклонён: откройте корзину на сайте и повторите',
  notFound: 'Этой позиции уже нет в корзине',
  notOffered: 'Мастер больше не предлагает здесь аналог — обновите страницу',
  gone: 'Аналога больше нет у поставщика — позвоните нам, подберём другой',
  unavailable: 'Поставщик сейчас не отвечает, попробуйте через минуту',
  total: 'Сумма корзины стала бы слишком большой — уменьшите количество или позвоните нам',
  form: 'Не удалось прочитать форму — обновите страницу',
  internal: 'Не получилось — попробуйте ещё раз или позвоните нам',
} as const;

class FitLineError extends Error {
  override name = 'FitLineError';
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const MAX_BODY_BYTES = 2 * 1024;

async function actionOf(request: Request): Promise<FitLineAction | null> {
  const type = (request.headers.get('content-type') ?? '').toLowerCase();
  const body = await readBoundedText(request, MAX_BODY_BYTES);
  if (!body.ok) return null;
  let value: unknown;
  if (type.startsWith('application/x-www-form-urlencoded')) {
    value = new URLSearchParams(body.text).get('action');
  } else if (type.startsWith('application/json')) {
    try {
      value = (JSON.parse(body.text) as { action?: unknown }).action;
    } catch {
      return null;
    }
  }
  return (FIT_LINE_ACTIONS as readonly unknown[]).includes(value) ? (value as FitLineAction) : null;
}

/** The analog offer at the supplier now: the same offer, else the same brand and article. */
function freshAnalog(offers: readonly Offer[], analog: Offer): Offer | null {
  const usable = offers.filter(
    (offer) => Number.isSafeInteger(offer.priceSupplierKop) && offer.priceSupplierKop > 0,
  );
  const key = offerViewId(analog);
  const same = usable.filter((offer) => offerViewId(offer) === key);
  const pool =
    same.length > 0
      ? same
      : usable.filter(
          (offer) =>
            offer.articleNorm === analog.articleNorm &&
            offer.brand.toUpperCase() === analog.brand.toUpperCase(),
        );
  // Orenburg first, then the cheapest (as the master's choice was made).
  return (
    [...pool].sort(
      (a, b) =>
        Number(b.stock.isLocal) - Number(a.stock.isLocal) ||
        a.priceSupplierKop - b.priceSupplierKop,
    )[0] ?? null
  );
}

/** The client's quantity on the analog's step and stock (0: none can be sold). */
function analogQty(qty: number, offer: Offer): number {
  const step = Math.max(1, Math.trunc(offer.stock.multiplicity) || 1);
  const cap = Math.min(
    Math.max(qty, step),
    Number.isSafeInteger(offer.stock.count) ? offer.stock.count : 0,
    MAX_LINE_QTY,
  );
  return Math.floor(cap / step) * step;
}

export async function handleFitLineAction(
  request: Request,
  lineIdRaw: string,
  deps: FitLineActionDeps,
): Promise<Response> {
  const json = wantsJson(request);
  const lineId = lineIdOf(lineIdRaw);
  const back = lineId ? `/cart#fit-${lineId}` : '/cart';
  const fail = (status: number, message: string): Response =>
    json
      ? jsonResponse(status, { error: 'fit_line', message })
      : messagePage(status, 'Не получилось', message, { href: back, label: 'Вернуться в корзину' });

  if (!isSameOrigin(request.headers, deps.env.APP_BASE_URL)) {
    return fail(403, FIT_LINE_MESSAGES.forbiddenOrigin);
  }
  if (lineId === null) return fail(404, FIT_LINE_MESSAGES.notFound);
  const action = await actionOf(request);
  if (action === null) return fail(400, FIT_LINE_MESSAGES.form);
  const now = (deps.now ?? (() => new Date()))();

  try {
    const token = readCartToken(requestCookies(request));
    const cart = token === null ? null : await findActiveCart(deps.db, token);
    const line = cart?.lines.find((l) => l.id === lineId) ?? null;
    if (cart === null || line === null) return fail(404, FIT_LINE_MESSAGES.notFound);
    const check = (await latestFitChecksOfLines(deps.db, cart.cart.id, [lineId])).get(lineId);
    const state = check ? fitLineState(fitFactsOf(check), line.offer, now) : 'none';
    if (!check || (state !== 'analog_offer' && state !== 'analog_kept')) {
      return fail(409, FIT_LINE_MESSAGES.notOffered);
    }

    if (action === 'keep') {
      await deps.db
        .update(fitChecks)
        .set({ analogKeptAt: now })
        .where(
          and(
            eq(fitChecks.id, check.id),
            eq(fitChecks.status, 'analog'),
            isNull(fitChecks.analogKeptAt),
          ),
        );
      deps.logger.info({ action }, 'fit analog answer');
      return json ? jsonResponse(200, { ok: true }) : seeOther(back);
    }

    const analog = check.analogOffer;
    if (analog === null || !ARTICLE_NORM_RE.test(analog.articleNorm)) {
      return fail(409, FIT_LINE_MESSAGES.notOffered);
    }
    let offers: Offer[];
    try {
      ({ offers } = await deps.supplier.rossko.search(analog.articleNorm, { priority: 'search' }));
    } catch {
      return fail(503, FIT_LINE_MESSAGES.unavailable);
    }
    const offer = freshAnalog(offers, analog);
    const settings = await deps.loadSettings();
    const qty = offer ? analogQty(line.qty, offer) : 0;
    if (offer === null || qty === 0) return fail(409, FIT_LINE_MESSAGES.gone);
    let next: Omit<CartLine, 'id'>;
    try {
      next = cartLineFromOffer(offer, analog.articleNorm, qty, {
        pricing: settings.pricing,
        excludedRules: settings.excludedRules,
        eta: settings.eta,
        now,
      });
    } catch (error) {
      if (error instanceof CartError) return fail(409, FIT_LINE_MESSAGES.gone);
      throw error;
    }

    await deps.db.transaction(async (tx) => {
      // The cart row first (the lock order of the cart API and checkout), then its lines.
      const [locked] = await tx
        .select({ id: carts.id, status: carts.status })
        .from(carts)
        .where(eq(carts.id, cart.cart.id))
        .for('update');
      if (!locked || locked.status !== 'active') {
        throw new FitLineError(404, FIT_LINE_MESSAGES.notFound);
      }
      const rows = await tx
        .select({
          id: cartItems.id,
          offerKey: cartItems.offerKey,
          searchArticleNorm: cartItems.searchArticleNorm,
          qty: cartItems.qty,
        })
        .from(cartItems)
        .where(eq(cartItems.cartId, locked.id));
      const current = rows.find((row) => row.id === lineId);
      // Changed in another tab meanwhile: nothing is replaced.
      if (!current || current.offerKey !== line.offerKey) {
        throw new FitLineError(409, FIT_LINE_MESSAGES.notOffered);
      }
      const existing = rows.find((row) => row.id !== lineId && row.offerKey === next.offerKey);
      if (existing) {
        // The analog is in the cart already: one line with both quantities when it fits the stock.
        const merged = existing.qty + next.qty;
        const fits =
          merged <= MAX_LINE_QTY &&
          validateQty(merged, {
            available: offer.stock.count,
            multiplicity: offer.stock.multiplicity,
          }).ok;
        if (fits) {
          await tx
            .update(cartItems)
            .set({ qty: merged, updatedAt: now })
            .where(eq(cartItems.id, existing.id));
        }
        await tx
          .update(fitChecks)
          .set({ cartItemId: existing.id })
          .where(eq(fitChecks.id, check.id));
        await tx.delete(cartItems).where(eq(cartItems.id, lineId));
      } else {
        await tx
          .update(cartItems)
          .set({ ...lineValues(next, now), updatedAt: now })
          .where(eq(cartItems.id, lineId));
      }
      await tx.update(carts).set({ updatedAt: now }).where(eq(carts.id, locked.id));
      const all = await tx
        .select({
          qty: cartItems.qty,
          priceClientKop: cartItems.priceClientKop,
          priceSupplierKop: cartItems.priceSupplierKop,
        })
        .from(cartItems)
        .where(eq(cartItems.cartId, locked.id));
      if (cartTotals(all).subtotalKop > MAX_ORDER_TOTAL_KOP) {
        throw new FitLineError(422, FIT_LINE_MESSAGES.total);
      }
    });
    deps.logger.info({ action }, 'fit analog answer');
    return json ? jsonResponse(200, { ok: true }) : seeOther(back);
  } catch (error) {
    if (error instanceof FitLineError) return fail(error.status, error.message);
    deps.logger.error(errorInfo(error), 'fit analog answer failed');
    return fail(500, FIT_LINE_MESSAGES.internal);
  }
}
