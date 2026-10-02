/**
 * What the /cart page shows, computed from re-priced lines and settings: client-safe line
 * views (no supplier price or markup), the sum, the order's promised date, the minimum-order
 * hint and the payment scheme explanation (docs/phase-1a-implementation.md section 5.2).
 * Pure: `now` is not needed (dates come from the lines).
 */
import {
  checkOrderMinimums,
  choosePaymentScheme,
  explainPaymentScheme,
  formatPromise,
  formatRub,
  MAX_LINE_QTY,
  promisedDate,
  safeMul,
  splitAdvice,
  splitCartLines,
  cartTotals,
  type IsoDate,
  type OrderMinimumsResult,
  type RepricedLine,
} from '@detaly/domain';
import type { CartSettings } from './cart-service';

/** One cart line as rendered: client price only. */
export interface CartLineView {
  id: string;
  brand: string;
  article: string;
  name: string;
  isLocal: boolean;
  qty: number;
  /** Quantity step (Rossko multiplicity). */
  multiplicity: number;
  /** Largest quantity the form offers: stock and MAX_LINE_QTY, a multiple of the step. */
  maxQty: number;
  priceClientKop: number;
  priceText: string;
  lineTotalText: string;
  /** 'к чт 8 октября', or null when the line has no date. */
  promiseText: string | null;
}

export interface PaymentNotice {
  /** Both Orenburg and to-order lines. */
  mixed: boolean;
  sentences: string[];
  /** Offer "Разделить на два заказа" (/checkout?part=local). */
  offerSplit: boolean;
}

export interface CartSummaryView {
  lines: CartLineView[];
  subtotalKop: number;
  subtotalText: string;
  itemsCount: number;
  /** Promised date of one order with all lines, 'к пт 9 октября'. */
  promiseText: string | null;
  minimums: OrderMinimumsResult;
  payment: PaymentNotice;
}

export const MIXED_CART_TEXT =
  'В корзине есть детали в Оренбурге и под заказ. Одним заказом — предоплата 100%.';
/** Shown on /cart when some prices could not be re-checked now. */
export const STALE_PRICES_TEXT = 'Не удалось обновить цены, проверим при оформлении';
export const FINAL_SCHEME_NOTE = 'Окончательно способ оплаты определим после ввода телефона.';

function promiseFor(dates: readonly (IsoDate | null)[], settings: CartSettings): string | null {
  const known = dates.filter((d): d is IsoDate => d !== null);
  if (known.length === 0) return null;
  try {
    return formatPromise(promisedDate(known, settings.eta));
  } catch {
    return null;
  }
}

export function toLineView(line: RepricedLine, settings: CartSettings): CartLineView {
  const step = Math.max(1, line.multiplicity);
  const cap = Math.min(Number.isSafeInteger(line.available) ? line.available : 0, MAX_LINE_QTY);
  const maxQty = Math.max(line.qty, Math.floor(cap / step) * step);
  return {
    id: line.id,
    brand: line.offer.brand,
    article: line.offer.article,
    name: line.offer.name,
    isLocal: line.isLocal,
    qty: line.qty,
    multiplicity: step,
    maxQty,
    priceClientKop: line.priceClientKop,
    priceText: formatRub(line.priceClientKop),
    lineTotalText: formatRub(safeMul(line.priceClientKop, line.qty)),
    promiseText: promiseFor([line.etaDate], settings),
  };
}

export function summarizeCart(
  lines: readonly RepricedLine[],
  settings: CartSettings,
): CartSummaryView {
  const totals = cartTotals(lines);
  const { mixed } = splitCartLines(lines);
  const { order } = settings;
  let payment: PaymentNotice;
  if (mixed) {
    const advice = splitAdvice(lines, {
      onPickupMaxTotalKop: order.onPickupMaxTotalKop,
      noShowLimit: order.noShowLimit,
    });
    payment = { mixed: true, sentences: [MIXED_CART_TEXT], offerSplit: advice.offerSplit };
  } else {
    // No-shows are unknown before the phone is entered: 0 here, the server decides at checkout.
    const decision = choosePaymentScheme({
      allItemsLocal: lines.every((l) => l.isLocal),
      totalKop: totals.subtotalKop,
      noShowCount: 0,
      noShowLimit: order.noShowLimit,
      onPickupMaxTotalKop: order.onPickupMaxTotalKop,
      fulfillment: 'pickup',
    });
    payment = {
      mixed: false,
      sentences: [
        ...explainPaymentScheme(decision, { onPickupMaxTotalKop: order.onPickupMaxTotalKop }),
        FINAL_SCHEME_NOTE,
      ],
      offerSplit: false,
    };
  }
  return {
    lines: lines.map((line) => toLineView(line, settings)),
    subtotalKop: totals.subtotalKop,
    subtotalText: formatRub(totals.subtotalKop),
    itemsCount: totals.itemsCount,
    promiseText: promiseFor(
      lines.map((l) => l.etaDate),
      settings,
    ),
    minimums: checkOrderMinimums({
      subtotalKop: totals.subtotalKop,
      marginKop: totals.marginKop,
      minOrderTotalKop: order.minOrderTotalKop,
      minMarginKop: order.minMarginKop,
    }),
    payment,
  };
}
