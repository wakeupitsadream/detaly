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
        'Оплатить можно картой или по QR в пункте выдачи, наличные не принимаем.',
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
}

/**
 * Offer "Разделить на два заказа" only for a mixed cart whose local part alone qualifies for
 * payment on handover. No-shows are unknown before the phone is entered (counted as 0); the
 * server decides finally at checkout.
 */
export function splitAdvice(
  lines: readonly Pick<CartLine, 'isLocal' | 'qty' | 'priceClientKop' | 'priceSupplierKop'>[],
  ctx: SplitAdviceContext,
): { offerSplit: boolean; localTotalKop: Kop } {
  const { local, mixed } = splitCartLines(lines);
  const localTotalKop = cartTotals(local).subtotalKop;
  if (!mixed) return { offerSplit: false, localTotalKop };
  const decision = choosePaymentScheme({
    allItemsLocal: true,
    totalKop: localTotalKop,
    noShowCount: 0,
    noShowLimit: ctx.noShowLimit,
    onPickupMaxTotalKop: ctx.onPickupMaxTotalKop,
    fulfillment: 'pickup',
  });
  return { offerSplit: decision.scheme === 'pay_on_handover', localTotalKop };
}

export interface OrderMinimumsInput {
  subtotalKop: Kop;
  /** Sum of (client - supplier) x qty; may be negative. */
  marginKop: number;
  /** settings pricing.min_order_total_kop; 0 = no minimum. */
  minOrderTotalKop: Kop;
  /** settings pricing.min_margin_kop; 0 = no minimum (a negative margin still fails). */
  minMarginKop: Kop;
}

export type OrderMinimumsResult =
  | { ok: true }
  | { ok: false; code: 'min_total' | 'min_margin'; message: string; missingKop: Kop | null };

/**
 * Same thresholds as the guards minTotalReached and minMarginReached, with client wording.
 * The margin is never disclosed: its message only asks for another item.
 */
export function checkOrderMinimums(input: OrderMinimumsInput): OrderMinimumsResult {
  const { subtotalKop, marginKop, minOrderTotalKop, minMarginKop } = input;
  if (!(subtotalKop > 0)) {
    return {
      ok: false,
      code: 'min_total',
      message: 'Добавьте детали в заказ',
      missingKop: minOrderTotalKop > 0 ? minOrderTotalKop : null,
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
