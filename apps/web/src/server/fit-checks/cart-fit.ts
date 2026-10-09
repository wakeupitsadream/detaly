/**
 * What the cart shows about fit checks (step 4, docs/fit-check.md): the state of every line
 * (fitLineState of its latest check: a line changed since the check has none), the analog the
 * master offers priced exactly as the cart prices (priceOffer with the settings of now, the pickup
 * date with the eta buffer), the promise under «Отправить мастеру» from the pickup schedule, the
 * last VIN of this cart for the form, the closed gate and the guarantee switch.
 *
 * Plain data: the page passes it to client components (the sheet, the demo state, the refresh).
 */
import type { Env } from '@detaly/config';
import type { Executor } from '@detaly/db';
import {
  DEFAULT_FIT_CHECK_SLA_MINUTES,
  DateError,
  FIT_CHECK_COMMENT_MAX,
  etaDate,
  fitCheckPendingText,
  fitCheckPromise,
  fitCheckPromiseText,
  fitLineState,
  formatPromise,
  formatRub,
  MoneyError,
  priceOffer,
  promisedDate,
  type FitLineState,
  type RepricedLine,
} from '@detaly/domain';
import { fitFactsOf, loadCartFitChecks, loadFitSlaMinutes, type FitCheckRow } from '@detaly/vin';
import { telHref } from '../brand';
import type { CartSettings } from '../cart/cart-service';
import { gatePhone } from '../checkout-gate';
import { fitClosedMessage } from './submit-handler';
import { FIT_FORM_MESSAGES, isFitFormErrorCode, lineIdOf, type FitFormErrorCode } from './form';

export interface FitAnalogView {
  brand: string;
  article: string;
  name: string;
  /** '450 ₽' (priceOffer with the settings of now). */
  priceText: string;
  /** 'к пт 10 октября'; null without a usable date. */
  promiseText: string | null;
}

export interface FitLineView {
  state: FitLineState;
  /** The master's analog (analog_offer, analog_kept). */
  analog: FitAnalogView | null;
}

/** What every fit check form and line block of the cart shares (plain data for the client). */
export interface FitShared {
  /** The checkout gate is open: checks are accepted. Closed: the sheet explains and gives the phone. */
  open: boolean;
  closedMessage: string;
  /** PICKUP_PHONE (else the seller's): the closed gate and «Нужен звонок». */
  phone: { text: string; href: string } | null;
  /** DEMO_MODE: nothing leaves the browser (the form answers itself). */
  demo: boolean;
  /** FIT_GUARANTEE_ENABLED: «Не подойдёт по применимости — вернём деньги» under the badge. */
  guarantee: boolean;
  /** The VIN of this cart's latest request (pre-fills the form). */
  lastVin: string | null;
  /** «Мастер проверит в течение часа» / «Проверим утром — с 10:00». */
  promiseText: string;
  /** «Мастер проверяет · ответит в течение часа». */
  pendingText: string;
  commentMax: number;
  /** Messages the form shows itself (the same texts as the server's). */
  messages: { vin: string; lines: string; internal: string };
}

export interface CartFitView {
  shared: FitShared;
  anyPending: boolean;
  /** By cart line id. */
  lines: Record<string, FitLineView>;
  /** `?check=<line>`: the form of this line opens. */
  openLine: string | null;
  /** `?fit_error=<code>` (a form post without JavaScript came back). */
  error: { code: FitFormErrorCode; message: string } | null;
  /** `?fit=sent`: «Отправили мастеру». */
  sent: boolean;
  /** `?fit_demo=<line>` (DEMO_MODE, a form post without JavaScript): that line shows the demo answer. */
  demoLine: string | null;
}

export interface CartFitQuery {
  check?: string;
  fit?: string;
  fit_error?: string;
  fit_demo?: string;
}

function analogView(
  check: FitCheckRow,
  settings: Pick<CartSettings, 'pricing' | 'eta'>,
  now: Date,
): FitAnalogView | null {
  const offer = check.analogOffer;
  if (offer === null || check.analogBrand === null || check.analogArticle === null) return null;
  let priceText: string;
  try {
    priceText = formatRub(priceOffer(settings.pricing, offer).priceClientKop);
  } catch (error) {
    if (error instanceof MoneyError) return null;
    throw error;
  }
  let promiseText: string | null = null;
  try {
    promiseText = formatPromise(promisedDate([etaDate(offer.stock, now)], settings.eta));
  } catch (error) {
    if (!(error instanceof DateError)) throw error;
  }
  return {
    brand: check.analogBrand,
    article: check.analogArticle,
    name: check.analogName ?? offer.name,
    priceText,
    promiseText,
  };
}

function phoneLink(phone: string | null): { text: string; href: string } | null {
  return phone ? { text: phone, href: telHref(phone) } : null;
}

/**
 * The fit view of a cart. `db` null (DEMO_MODE): no checks, nothing read; only the query of a
 * form post without JavaScript (`fit_demo`) marks a line.
 */
export async function loadCartFitView(input: {
  db: Executor | null;
  cartId: string;
  lines: readonly RepricedLine[];
  settings: Pick<CartSettings, 'pricing' | 'eta'>;
  env: Pick<Env, 'FIT_GUARANTEE_ENABLED' | 'PICKUP_PHONE' | 'SELLER_REQUISITES_PHONE'>;
  now: Date;
  gateOpen: boolean;
  query: CartFitQuery;
}): Promise<CartFitView> {
  const { db, settings, now } = input;
  const ids = new Set(input.lines.map((line) => line.id));
  const loaded = db === null ? null : await loadCartFitChecks(db, input.cartId);
  const sla = db === null ? DEFAULT_FIT_CHECK_SLA_MINUTES : await loadFitSlaMinutes(db);
  const promise = fitCheckPromise(now, sla, settings.eta.pickupSchedule);

  const lines: Record<string, FitLineView> = {};
  let anyPending = false;
  for (const line of input.lines) {
    const check = loaded?.latest.get(line.id) ?? null;
    const state = check === null ? 'none' : fitLineState(fitFactsOf(check), line.offer, now);
    if (state === 'pending') anyPending = true;
    lines[line.id] = {
      state,
      analog:
        check !== null && (state === 'analog_offer' || state === 'analog_kept')
          ? analogView(check, settings, now)
          : null,
    };
  }

  const openLine = lineIdOf(input.query.check);
  const demoLine = lineIdOf(input.query.fit_demo);
  const code = input.query.fit_error;
  return {
    shared: {
      open: input.gateOpen,
      closedMessage: fitClosedMessage(input.env),
      phone: phoneLink(gatePhone(input.env)),
      demo: db === null,
      guarantee: input.env.FIT_GUARANTEE_ENABLED,
      lastVin: loaded?.lastVin ?? null,
      promiseText: fitCheckPromiseText(promise),
      pendingText: fitCheckPendingText(promise),
      commentMax: FIT_CHECK_COMMENT_MAX,
      messages: {
        vin: FIT_FORM_MESSAGES.vin,
        lines: FIT_FORM_MESSAGES.lines,
        internal: FIT_FORM_MESSAGES.internal,
      },
    },
    anyPending,
    lines,
    openLine: openLine !== null && ids.has(openLine) ? openLine : null,
    error: isFitFormErrorCode(code) ? { code, message: FIT_FORM_MESSAGES[code] } : null,
    sent: input.query.fit === 'sent',
    // Only the demo answers itself: outside it the query never fakes an answer.
    demoLine: db === null && demoLine !== null && ids.has(demoLine) ? demoLine : null,
  };
}
