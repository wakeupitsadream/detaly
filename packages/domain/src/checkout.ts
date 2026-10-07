/**
 * Checkout decisions shown to the client before the order exists (phase 1A,
 * docs/phase-1a-implementation.md section 3.3). The payment scheme comes from the state
 * machine guard `onPickupEligible` (one source of truth); this module only adds the reasons
 * and the Russian wording.
 */
import { cartTotals, splitCartLines } from './cart';
import { formatRub } from './money';
import { onPickupEligible } from './state-machine/guards';
import type {
  CartLine,
  Kop,
  PaymentSchemeDecision,
  PaymentSchemeInput,
  PrepayReason,
} from './types';

/** pay_on_handover when onPickupEligible passes, else prepay with every reason that applies. */
export function choosePaymentScheme(input: PaymentSchemeInput): PaymentSchemeDecision {
  const eligible = onPickupEligible.test({
    actor: 'client',
    allItemsLocal: input.allItemsLocal,
    totalKop: input.totalKop,
    onPickupMaxTotalKop: input.onPickupMaxTotalKop,
    noShowCount: input.noShowCount,
    noShowLimit: input.noShowLimit,
    fulfillment: input.fulfillment,
  });
  if (eligible) return { scheme: 'pay_on_handover', reasons: [] };
  const reasons: PrepayReason[] = [];
  if (!input.allItemsLocal) reasons.push('to_order');
  if (input.totalKop > input.onPickupMaxTotalKop) reasons.push('over_limit');
  if (input.noShowCount >= input.noShowLimit) reasons.push('no_show');
  if (input.fulfillment === 'courier') reasons.push('courier');
  return { scheme: 'prepay', reasons };
}

/**
 * Sentences explaining the scheme. The no-show reason is neutral on purpose (decision Д15):
 * the page must not reveal another person's history behind a phone number.
 */
export function explainPaymentScheme(
  decision: PaymentSchemeDecision,
  { onPickupMaxTotalKop }: { onPickupMaxTotalKop: Kop },
): string[] {
  const limit = formatRub(onPickupMaxTotalKop);
  if (decision.scheme === 'pay_on_handover') {
    return [
      `Оплата при получении: все детали есть на складе в Оренбурге, а сумма не больше ${limit}. ` +
        'Оплата в пункте выдачи — с вашего телефона по QR-коду (СБП или карта). Наличные не принимаем.',
    ];
  }
  const sentences: string[] = [];
  for (const reason of decision.reasons) {
    switch (reason) {
      case 'to_order':
        sentences.push(
          'В заказе есть детали под заказ: мы выкупаем их у поставщика, поэтому нужна предоплата 100%.',
        );
        break;
      case 'over_limit':
        sentences.push(`Сумма заказа больше ${limit} — для таких заказов нужна предоплата.`);
        break;
      case 'no_show':
        sentences.push('Для этого номера доступна только предоплата.');
        break;
      case 'courier':
        sentences.push('Доставка курьером — только по предоплате.');
        break;
    }
  }
  if (sentences.length === 0) sentences.push('Для этого заказа нужна предоплата 100%.');
  return sentences;
}

export interface SplitAdviceContext {
  onPickupMaxTotalKop: Kop;
  noShowLimit: number;
  /** settings pricing.min_order_total_kop: each part must reach it on its own. */
  minOrderTotalKop: Kop;
  /** settings pricing.min_margin_kop: each part must reach it on its own. */
  minMarginKop: Kop;
}

/**
 * Offer "Разделить на два заказа" only for a mixed cart whose local part alone qualifies for
 * payment on handover and whose two parts each pass the order minimums (otherwise the split
 * ends with a part that cannot be checked out). No-shows are unknown before the phone is
 * entered (counted as 0); the server decides finally at checkout.
 */
export function splitAdvice(
  lines: readonly Pick<CartLine, 'isLocal' | 'qty' | 'priceClientKop' | 'priceSupplierKop'>[],
  ctx: SplitAdviceContext,
): { offerSplit: boolean; localTotalKop: Kop } {
  const { local, toOrder, mixed } = splitCartLines(lines);
  const localTotals = cartTotals(local);
  const localTotalKop = localTotals.subtotalKop;
  if (!mixed) return { offerSplit: false, localTotalKop };
  const decision = choosePaymentScheme({
    allItemsLocal: true,
    totalKop: localTotalKop,
    noShowCount: 0,
    noShowLimit: ctx.noShowLimit,
    onPickupMaxTotalKop: ctx.onPickupMaxTotalKop,
    fulfillment: 'pickup',
  });
  if (decision.scheme !== 'pay_on_handover') return { offerSplit: false, localTotalKop };
  const partOk = (totals: { subtotalKop: Kop; marginKop: number }) =>
    checkOrderMinimums({
      subtotalKop: totals.subtotalKop,
      marginKop: totals.marginKop,
      minOrderTotalKop: ctx.minOrderTotalKop,
      minMarginKop: ctx.minMarginKop,
    }).ok;
  return { offerSplit: partOk(localTotals) && partOk(cartTotals(toOrder)), localTotalKop };
}

/**
 * Largest order total accepted online: 500 000 ₽. Below the int4 range of the *_kop columns
 * (21 474 836,47 ₽) with a wide margin, and a prepay order is one YooKassa payment.
 * VERIFY: the per-payment maximum of the YooKassa shop (docs/external.md).
 */
export const MAX_ORDER_TOTAL_KOP: Kop = 50_000_000;

export interface OrderMinimumsInput {
  subtotalKop: Kop;
  /** Sum of (client - supplier) x qty; may be negative. */
  marginKop: number;
  /** settings pricing.min_order_total_kop; 0 = no minimum. */
  minOrderTotalKop: Kop;
  /** settings pricing.min_margin_kop; 0 = no minimum (a negative margin still fails). */
  minMarginKop: Kop;
  /** Upper bound of the order total; MAX_ORDER_TOTAL_KOP by default. */
  maxOrderTotalKop?: Kop;
}

export type OrderMinimumsResult =
  | { ok: true }
  | {
      ok: false;
      code: 'min_total' | 'min_margin' | 'max_total';
      message: string;
      missingKop: Kop | null;
    };

/**
 * Same thresholds as the guards minTotalReached and minMarginReached, with client wording,
 * plus the upper bound MAX_ORDER_TOTAL_KOP (int4 columns, one payment).
 * The margin is never disclosed: its message only asks for another item.
 */
export function checkOrderMinimums(input: OrderMinimumsInput): OrderMinimumsResult {
  const { subtotalKop, marginKop, minOrderTotalKop, minMarginKop } = input;
  const maxOrderTotalKop = input.maxOrderTotalKop ?? MAX_ORDER_TOTAL_KOP;
  if (!(subtotalKop > 0)) {
    return {
      ok: false,
      code: 'min_total',
      message: 'Добавьте детали в заказ',
      missingKop: minOrderTotalKop > 0 ? minOrderTotalKop : null,
    };
  }
  if (!(subtotalKop <= maxOrderTotalKop)) {
    return {
      ok: false,
      code: 'max_total',
      message: `Заказ больше ${formatRub(maxOrderTotalKop)} на сайте не оформить — уменьшите количество или позвоните нам`,
      missingKop: null,
    };
  }
  if (subtotalKop < minOrderTotalKop) {
    const missingKop = minOrderTotalKop - subtotalKop;
    return {
      ok: false,
      code: 'min_total',
      message: `Минимальная сумма заказа ${formatRub(minOrderTotalKop)} — добавьте позиции ещё на ${formatRub(missingKop)}`,
      missingKop,
    };
  }
  if (!(marginKop >= minMarginKop)) {
    return {
      ok: false,
      code: 'min_margin',
      message: 'Заказ слишком маленький для оформления на сайте — добавьте ещё позицию',
      missingKop: null,
    };
  }
  return { ok: true };
}
