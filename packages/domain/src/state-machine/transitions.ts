/**
 * Declarative order transition table (docs/PLAN.md section 3).
 *
 * Reading a rule: in any status of `from`, `event` triggered by one of `actors` moves the order
 * to `to` when `guard` passes. Several rules may share (status, event); their guards are
 * mutually exclusive (checked by tests), so the first passing rule is the only passing rule.
 *
 * Decisions beyond the literal PLAN table (see docs/phase0-implementation.md section 4):
 * - client refusal before handover, storage expiry and staff/approval cancellations go to
 *   `cancelled` for pay_on_handover (no money taken yet) and to `refund_pending` for prepay;
 * - a ready pay_on_handover order switched to prepay returns to `ready` (not `confirmed`)
 *   after payment, and back to `ready` (pay_on_handover) when that payment is canceled;
 * - self-transitions (to === from) record events that do not change the order status:
 *   partial arrival, damage on receipt, ETA change, "Клиент пришёл", offset receipt retries,
 *   handover payment success before "Выдал", claim opening, refund failure;
 * - "refund or cancel" splits follow the money, not only the scheme: a pay_on_handover order
 *   whose handover payment already succeeded is refunded like a prepay one (`moneyHeld`);
 * - going back to work from needs_attention / awaiting_client_approval ("Заказать всё равно",
 *   "Согласен", cancelling one item) lands in `ordering` with GetCheckout whenever some live item
 *   is not covered by a created supplier order (recheck problem, itemErrors, an approved
 *   alternative), in `awaiting_supplier_invoice` when everything is ordered but the Rossko
 *   invoice is still unpaid (rossko.prepay_invoice), else in `ordered_at_supplier`;
 * - payment cancel/expiry only applies to the order's current payment (eventPaymentIsCurrent);
 *   a payment that succeeds while the order does not wait for one is never dropped: it sends
 *   the order to needs_attention (before handover) or alerts the owner (after it);
 * - the client may cancel an order on /o/<token> before paying (awaiting_payment, while no
 *   payment succeeded) or before confirming (awaiting_confirmation): `client_cancelled`, no
 *   notification (phase 1A, docs/phase-1a-implementation.md decision Д3). An awaiting_payment
 *   order whose live items all arrived came from `ready` through «Оплатить заранее»: its
 *   cancellation is a refusal before handover and creates the seller's supplier-return task;
 * - the client (or staff) may cancel one delayed item in ordered_at_supplier ("Жду до" /
 *   "Отменить позицию", order.eta_changed): partial refund, the order stays with the others.
 *
 * Phase 1B additions (docs/phase-1b-implementation.md section 3.4):
 * - «Клиент не пришёл» is `storage_expired` pressed by staff, allowed only after the storage
 *   window (pickupWindowElapsed, decision Б10); housekeeping sends the same event;
 * - the handover QR TTL returns the order to `ready` without a confirmed cancel (YooKassa cannot
 *   cancel a pending payment); a later payment of that QR with the right amount brings the order
 *   back to `awaiting_handover_payment` instead of the owner's "unexpected payment" (Б9);
 * - partial (one item) refunds complete or fail through `partial_refund_succeeded` /
 *   `partial_refund_failed`, self-transitions; `refund_succeeded` is only for the whole order;
 * - «Выдал» after a handover payment needs a held QR payment of the total and its own `full`
 *   receipt (handoverPaymentHeld), not the latest payment's status: two QR may be on the screen;
 * - a payment arriving in refund_pending or refunded has no rule: the engine returns it as an
 *   orphan refund. After handover (handed, completed) the owner decides, with a refund task.
 */
import type { ActorType, OrderStatus, PaymentScheme, ReceiptKind } from '../statuses';
import {
  all,
  allLiveItemsArrived,
  amountMatches,
  amountMismatch,
  claimRefundAllowed,
  clientArrived,
  clientReachable,
  courier,
  type Guard,
  hasItemErrors,
  eventPaymentIsCurrent,
  handoverPaymentHeld,
  hasPdConsent,
  isOwner,
  itemsNotArrived,
  lateHandoverPayment,
  liveItemsRemain,
  marginAboveFloor,
  minMarginReached,
  minTotalReached,
  moneyHeld,
  noMoneyHeld,
  noItemErrors,
  noOpenClaims,
  noPaymentSucceeded,
  noPrepayInvoice,
  not,
  onPickupEligible,
  payOnHandover,
  paymentConfirmedUnpaid,
  paymentHeldFlag,
  paymentHeldKnown,
  prepayFunded,
  paymentSucceeded,
  pickupWindowElapsed,
  prepay,
  prepayInvoice,
  recheckPassed,
  refundConfirmed,
  scopeItem,
  schemeKnown,
  scopeOrder,
  settlementReceiptSucceeded,
  supplierInvoiceDue,
  supplierInvoiceSettled,
  supplierItemsCovered,
  supplierItemsPending,
  type TransitionContext,
} from './guards';

/** Order events (column order_events.type is text; these are its values for transitions). */
export const ORDER_EVENTS = [
  // checkout
  'checkout',
  'checkout_stale',
  // payments (webhook or reconciliation, always confirmed by GET /payments)
  'payment_succeeded',
  'payment_canceled',
  'payment_ttl_expired',
  // pay_on_handover confirmation
  'client_confirmed',
  'confirmation_timeout',
  // client cancellation before payment / confirmation (phase 1A, decision Д3)
  'client_cancelled',
  // supplier
  'supplier_order_requested',
  'supplier_checkout_succeeded',
  'supplier_checkout_failed',
  'supplier_invoice_paid',
  'item_problem',
  'order_anyway',
  'alternative_proposed',
  'new_eta_proposed',
  // client decision
  'client_approved',
  'client_refund_requested',
  'approval_timeout',
  // cancellations by staff
  'item_cancelled',
  'order_cancelled',
  // arrival
  'item_arrived',
  'item_damaged_on_receipt',
  'eta_changed',
  // handover
  'client_arrived',
  'offset_receipt_requested',
  'handover_payment_requested',
  'handed_over',
  'switch_to_prepay',
  'courier_dispatched',
  'delivery_failed',
  'storage_expired',
  // after handover
  'completion_timeout',
  'claim_opened',
  'claim_refund_approved',
  // refusal and refunds
  'client_refused',
  'refund_succeeded',
  'refund_failed',
  // partial refunds (phase 1B, decision Б11): the order status does not change
  'partial_refund_succeeded',
  'partial_refund_failed',
] as const;
export type OrderEvent = (typeof ORDER_EVENTS)[number];

/**
 * Notification templates referenced by transitions. Implemented by @detaly/notify
 * (templates/order.ts must cover every id). Client templates carry only the order number,
 * status, brand and article (PD minimisation).
 */
export const ORDER_NOTIFY_TEMPLATES = [
  // client
  'confirm_request',
  'payment_link',
  'paid',
  'payment_expired',
  'late_payment_refund',
  'confirmation_expired',
  'ordered',
  'decision_needed',
  'refund_started',
  'order_cancelled',
  'item_cancelled',
  'arrived',
  'partial_arrival',
  'new_eta',
  'eta_changed',
  'handed',
  'courier_on_way',
  'delivery_failed',
  'storage_expired',
  'how_is_it',
  'claim_received',
  'money_sent',
  // staff (sellers chat or owner)
  'staff_new_order',
  'staff_amount_mismatch',
  'staff_unexpected_payment',
  'staff_supplier_invoice_due',
  'staff_problem',
  'staff_client_approved',
  'staff_delay_hint',
  'staff_delivery_failed',
  'staff_supplier_return_task',
  'staff_cancel_at_supplier_task',
  'staff_claim_deadline',
  'staff_refund_failed',
  // staff, phase 1B (sent by the engine and workers outside TRANSITIONS)
  'staff_orphan_payment',
  'staff_receipt_failed',
  'staff_approval_unreachable',
  'staff_refund_deadline',
  'staff_payment_rejected',
  'staff_refund_receipt_failed',
] as const;
export type OrderNotifyTemplate = (typeof ORDER_NOTIFY_TEMPLATES)[number];

export type NotifyAudience = 'client' | 'sellers' | 'owner';

export interface NotifySpec {
  audience: NotifyAudience;
  template: OrderNotifyTemplate;
}

/** Side effects the worker performs in the same transaction / via queues. */
export const TRANSITION_EFFECTS = [
  'set_scheme_prepay',
  'set_scheme_pay_on_handover',
  'create_payment',
  'create_handover_payment',
  'create_refund',
  'start_approval_timer',
  'start_pickup_window',
  'start_completion_timer',
  'mark_client_arrived',
  'no_show_increment',
  'supplier_checkout',
  'supplier_claim_and_reorder',
  'supplier_return_task',
  'cancel_at_supplier_task',
  'open_claim',
] as const;
export type TransitionEffect = (typeof TRANSITION_EFFECTS)[number];

export type ReceiptSpec = ReceiptKind | ((ctx: TransitionContext) => ReceiptKind | null);
export type EffectsSpec =
  readonly TransitionEffect[] | ((ctx: TransitionContext) => readonly TransitionEffect[]);

export interface TransitionRule {
  readonly from: readonly OrderStatus[];
  readonly event: OrderEvent;
  readonly to: OrderStatus;
  readonly actors: readonly ActorType[];
  readonly guard?: Guard;
  /** Receipt issued by this transition (in the payment, POST /receipts or the refund). */
  readonly receipt?: ReceiptSpec;
  readonly notify: readonly NotifySpec[];
  readonly effects?: EffectsSpec;
  /** Short description for docs, admin and logs (Russian, matches PLAN wording). */
  readonly label: string;
}

/** Statuses between confirmation and handover where the client may refuse (ст. 26.1 ЗоЗПП). */
export const REFUSABLE_STATUSES = [
  'confirmed',
  'ordering',
  'awaiting_supplier_invoice',
  'ordered_at_supplier',
  'needs_attention',
  'awaiting_client_approval',
  'ready',
  'out_for_delivery',
  'awaiting_handover_payment',
] as const satisfies readonly OrderStatus[];

const client = (template: OrderNotifyTemplate): NotifySpec => ({ audience: 'client', template });
const sellers = (template: OrderNotifyTemplate): NotifySpec => ({ audience: 'sellers', template });
const owner = (template: OrderNotifyTemplate): NotifySpec => ({ audience: 'owner', template });

/** Refund receipt mirrors the settlement sign of the receipt that took the money. */
const refundReceipt = (ctx: TransitionContext): ReceiptKind | null => {
  const scheme: PaymentScheme | null | undefined = ctx.scheme;
  if (scheme === 'prepay') {
    if (ctx.paymentHeld === false) return null;
    return ctx.settlementReceiptSucceeded === true ? 'refund_full' : 'refund_prepayment';
  }
  // pay_on_handover money is taken with a full_payment receipt (handover QR payment).
  if (scheme === 'pay_on_handover' && ctx.paymentHeld === true) return 'refund_full';
  return null;
};

/** Money is refunded only when it was taken (prepay, or a succeeded handover payment). */
const refundEffects =
  (extra: readonly TransitionEffect[]) =>
  (ctx: TransitionContext): readonly TransitionEffect[] =>
    moneyHeld.test(ctx) ? ['create_refund', ...extra] : extra;

const resolveEffects = (effects: EffectsSpec | undefined, ctx: TransitionContext) =>
  effects === undefined ? [] : typeof effects === 'function' ? effects(ctx) : effects;

/**
 * A rule that resumes supplier work (PLAN: "позиция replaced → новая").
 * - some live items are not covered by a created supplier order (pendingSupplierItems > 0:
 *   the recheck failed before GetCheckout, GetCheckout returned itemErrors, the client approved
 *   an alternative) -> `ordering`, GetCheckout for these items (a new attempt);
 * - everything is ordered, but rossko.prepay_invoice is on and the invoice is not paid ->
 *   `awaiting_supplier_invoice` with the owner reminder (Rossko does not ship before payment);
 * - everything is ordered and nothing blocks shipping -> `ordered_at_supplier`.
 */
function resumeWork(rule: Omit<TransitionRule, 'to'>): TransitionRule[] {
  const withGuard = (...extra: Guard[]): Guard =>
    rule.guard === undefined ? all(...extra) : all(rule.guard, ...extra);
  return [
    {
      ...rule,
      to: 'ordered_at_supplier',
      guard: withGuard(supplierItemsCovered, supplierInvoiceSettled),
    },
    {
      ...rule,
      label: `${rule.label} (ждём оплаты счёта Rossko)`,
      to: 'awaiting_supplier_invoice',
      guard: withGuard(supplierItemsCovered, supplierInvoiceDue),
      notify: [...rule.notify, owner('staff_supplier_invoice_due')],
    },
    {
      ...rule,
      label: `${rule.label} (дозаказ у Rossko)`,
      to: 'ordering',
      guard: withGuard(supplierItemsPending),
      effects: (ctx) => [...resolveEffects(rule.effects, ctx), 'supplier_checkout'],
    },
  ];
}

/**
 * Statuses before handover where a payment is not expected (a duplicate or stale link paid).
 * `ready` has its own rule: there an old handover QR may still be paid (decision Б9).
 */
const UNEXPECTED_PAYMENT_STATUSES = [
  'confirmed',
  'ordering',
  'awaiting_supplier_invoice',
  'ordered_at_supplier',
  'needs_attention',
  'awaiting_client_approval',
  'out_for_delivery',
] as const satisfies readonly OrderStatus[];

/** Statuses where a partial (one item) refund may complete or fail (decision Б11). */
export const PARTIAL_REFUND_STATUSES = [
  'confirmed',
  'ordering',
  'awaiting_supplier_invoice',
  'ordered_at_supplier',
  'needs_attention',
  'awaiting_client_approval',
  'ready',
  'awaiting_handover_payment',
  'out_for_delivery',
  'handed',
  'completed',
  'refund_pending',
] as const satisfies readonly OrderStatus[];

/** A late payment can be a prepayment link or a handover QR payment. */
const lateRefundReceipt = (ctx: TransitionContext): ReceiptKind | null =>
  ctx.scheme === 'pay_on_handover' ? 'refund_full' : 'refund_prepayment';

const PAYMENT_ACTORS = ['webhook', 'system'] as const satisfies readonly ActorType[];

export const TRANSITIONS: readonly TransitionRule[] = [
  // --- draft -------------------------------------------------------------------------------
  {
    label: 'Оформление: оплата при получении',
    from: ['draft'],
    event: 'checkout',
    to: 'awaiting_confirmation',
    actors: ['client'],
    guard: all(hasPdConsent, minTotalReached, minMarginReached, onPickupEligible),
    notify: [client('confirm_request')],
    effects: ['set_scheme_pay_on_handover'],
  },
  {
    label: 'Оформление: предоплата',
    from: ['draft'],
    event: 'checkout',
    to: 'awaiting_payment',
    actors: ['client'],
    guard: all(hasPdConsent, minTotalReached, minMarginReached, not(onPickupEligible)),
    notify: [client('payment_link')],
    effects: ['set_scheme_prepay', 'create_payment'],
  },
  {
    label: 'Сумма или состав устарели (409, DiffBanner)',
    from: ['draft'],
    event: 'checkout_stale',
    to: 'draft',
    actors: ['system'],
    notify: [],
  },

  // --- awaiting_payment --------------------------------------------------------------------
  {
    label: 'Оплачено',
    from: ['awaiting_payment'],
    event: 'payment_succeeded',
    to: 'confirmed',
    actors: PAYMENT_ACTORS,
    guard: all(amountMatches, itemsNotArrived),
    receipt: 'prepayment',
    notify: [client('paid'), sellers('staff_new_order')],
  },
  {
    label: 'Оплачено заранее (заказ уже приехал)',
    from: ['awaiting_payment'],
    event: 'payment_succeeded',
    to: 'ready',
    actors: PAYMENT_ACTORS,
    guard: all(amountMatches, allLiveItemsArrived),
    receipt: 'prepayment',
    notify: [client('paid')],
  },
  {
    label: 'Сумма платежа не равна сумме заказа',
    from: ['awaiting_payment'],
    event: 'payment_succeeded',
    to: 'needs_attention',
    actors: PAYMENT_ACTORS,
    guard: amountMismatch,
    notify: [owner('staff_amount_mismatch')],
  },
  {
    label: 'Платёж отменён',
    from: ['awaiting_payment'],
    event: 'payment_canceled',
    to: 'cancelled',
    actors: PAYMENT_ACTORS,
    guard: all(eventPaymentIsCurrent, paymentConfirmedUnpaid, itemsNotArrived),
    notify: [client('payment_expired')],
  },
  {
    label: 'Платёж отменён: заказ возвращается к оплате при получении',
    from: ['awaiting_payment'],
    event: 'payment_canceled',
    to: 'ready',
    actors: PAYMENT_ACTORS,
    guard: all(eventPaymentIsCurrent, paymentConfirmedUnpaid, allLiveItemsArrived),
    notify: [],
    effects: ['set_scheme_pay_on_handover'],
  },
  {
    label: 'Срок оплаты истёк',
    from: ['awaiting_payment'],
    event: 'payment_ttl_expired',
    to: 'cancelled',
    actors: ['system'],
    guard: all(eventPaymentIsCurrent, paymentConfirmedUnpaid, itemsNotArrived),
    notify: [client('payment_expired')],
  },
  {
    label: 'Срок оплаты истёк: заказ возвращается к оплате при получении',
    from: ['awaiting_payment'],
    event: 'payment_ttl_expired',
    to: 'ready',
    actors: ['system'],
    guard: all(eventPaymentIsCurrent, paymentConfirmedUnpaid, allLiveItemsArrived),
    notify: [],
    effects: ['set_scheme_pay_on_handover'],
  },

  {
    label: 'Клиент отменил заказ до оплаты',
    from: ['awaiting_payment'],
    event: 'client_cancelled',
    to: 'cancelled',
    actors: ['client'],
    guard: all(noPaymentSucceeded, itemsNotArrived),
    notify: [],
  },
  {
    // «Оплатить заранее» on a ready order: the parts are bought and wait at the point, so this
    // is a refusal before handover (PLAN section 3), not a silent cancel before payment.
    label: 'Клиент отменил заказ до оплаты (заказ уже приехал)',
    from: ['awaiting_payment'],
    event: 'client_cancelled',
    to: 'cancelled',
    actors: ['client'],
    guard: all(noPaymentSucceeded, allLiveItemsArrived),
    notify: [client('order_cancelled'), sellers('staff_cancel_at_supplier_task')],
    effects: ['cancel_at_supplier_task'],
  },

  // --- cancelled ---------------------------------------------------------------------------
  {
    label: 'Поздняя оплата отменённого заказа',
    from: ['cancelled'],
    event: 'payment_succeeded',
    to: 'refund_pending',
    actors: PAYMENT_ACTORS,
    receipt: lateRefundReceipt,
    notify: [client('late_payment_refund')],
    effects: ['create_refund'],
  },

  // --- awaiting_confirmation ---------------------------------------------------------------
  {
    label: 'Клиент подтвердил заказ',
    from: ['awaiting_confirmation'],
    event: 'client_confirmed',
    to: 'confirmed',
    actors: ['client'],
    notify: [sellers('staff_new_order')],
  },
  {
    label: 'Нет подтверждения 24 ч',
    from: ['awaiting_confirmation'],
    event: 'confirmation_timeout',
    to: 'cancelled',
    actors: ['system'],
    notify: [client('confirmation_expired')],
  },
  {
    label: 'Клиент отменил заказ до подтверждения',
    from: ['awaiting_confirmation'],
    event: 'client_cancelled',
    to: 'cancelled',
    actors: ['client'],
    notify: [],
  },

  // --- confirmed / ordering / supplier invoice ---------------------------------------------
  {
    label: 'Проверить и заказать: перепроверка пройдена',
    from: ['confirmed'],
    event: 'supplier_order_requested',
    to: 'ordering',
    actors: ['staff', 'system'],
    guard: recheckPassed,
    notify: [],
    effects: ['supplier_checkout'],
  },
  {
    label: 'Перепроверка: рост цены выше допуска или нет наличия',
    from: ['confirmed'],
    event: 'supplier_order_requested',
    to: 'needs_attention',
    actors: ['staff', 'system'],
    guard: not(recheckPassed),
    notify: [sellers('staff_problem')],
  },
  {
    label: 'Заказ у Rossko создан',
    from: ['ordering'],
    event: 'supplier_checkout_succeeded',
    to: 'ordered_at_supplier',
    actors: ['system'],
    guard: all(noItemErrors, noPrepayInvoice),
    notify: [client('ordered')],
  },
  {
    label: 'Заказ у Rossko создан, нужна оплата счёта',
    from: ['ordering'],
    event: 'supplier_checkout_succeeded',
    to: 'awaiting_supplier_invoice',
    actors: ['system'],
    guard: all(noItemErrors, prepayInvoice),
    notify: [owner('staff_supplier_invoice_due')],
  },
  {
    label: 'GetCheckout вернул itemErrors',
    from: ['ordering'],
    event: 'supplier_checkout_succeeded',
    to: 'needs_attention',
    actors: ['system'],
    guard: hasItemErrors,
    notify: [sellers('staff_problem')],
  },
  {
    label: 'GetCheckout не прошёл',
    from: ['ordering'],
    event: 'supplier_checkout_failed',
    to: 'needs_attention',
    actors: ['system'],
    notify: [sellers('staff_problem')],
  },
  {
    label: 'Счёт Rossko оплачен',
    from: ['awaiting_supplier_invoice'],
    event: 'supplier_invoice_paid',
    to: 'ordered_at_supplier',
    actors: ['staff'],
    guard: isOwner,
    notify: [client('ordered')],
  },

  // --- ordered_at_supplier -----------------------------------------------------------------
  {
    label: 'Проблема с позицией',
    from: ['ordered_at_supplier'],
    event: 'item_problem',
    to: 'needs_attention',
    actors: ['staff', 'system'],
    notify: [sellers('staff_problem')],
  },
  {
    label: 'Приехало всё',
    from: ['ordered_at_supplier'],
    event: 'item_arrived',
    to: 'ready',
    actors: ['staff'],
    guard: allLiveItemsArrived,
    notify: [client('arrived')],
    effects: ['start_pickup_window'],
  },
  {
    label: 'Приехала часть позиций',
    from: ['ordered_at_supplier'],
    event: 'item_arrived',
    to: 'ordered_at_supplier',
    actors: ['staff'],
    guard: itemsNotArrived,
    notify: [client('partial_arrival')],
  },
  {
    label: 'Повреждено при приёмке: рекламация и повторный заказ',
    from: ['ordered_at_supplier'],
    event: 'item_damaged_on_receipt',
    to: 'ordered_at_supplier',
    actors: ['staff'],
    notify: [client('new_eta')],
    effects: ['supplier_claim_and_reorder'],
  },
  // The reorder of a damaged item is a GetCheckout while the order stays ordered_at_supplier
  // (PLAN 3.4 «повторный заказ позиции»); its result is applied here like from `ordering`.
  // VERIFY (R7): with rossko.prepay_invoice the replacement invoice is paid in the Rossko account
  // (the order does not go back to awaiting_supplier_invoice for one item).
  {
    label: 'Повторный заказ позиции у Rossko создан',
    from: ['ordered_at_supplier'],
    event: 'supplier_checkout_succeeded',
    to: 'ordered_at_supplier',
    actors: ['system'],
    guard: noItemErrors,
    notify: [],
  },
  {
    label: 'Повторный заказ позиции: GetCheckout вернул itemErrors',
    from: ['ordered_at_supplier'],
    event: 'supplier_checkout_succeeded',
    to: 'needs_attention',
    actors: ['system'],
    guard: hasItemErrors,
    notify: [sellers('staff_problem')],
  },
  {
    label: 'Повторный заказ позиции: GetCheckout не прошёл',
    from: ['ordered_at_supplier'],
    event: 'supplier_checkout_failed',
    to: 'needs_attention',
    actors: ['system'],
    notify: [sellers('staff_problem')],
  },
  {
    label: 'Сдвиг срока',
    from: ['ordered_at_supplier'],
    event: 'eta_changed',
    to: 'ordered_at_supplier',
    actors: ['system', 'staff'],
    notify: [client('eta_changed'), sellers('staff_delay_hint')],
  },
  {
    label: 'Отменить задержанную позицию (частичный возврат)',
    from: ['ordered_at_supplier'],
    event: 'item_cancelled',
    to: 'ordered_at_supplier',
    actors: ['client', 'staff'],
    guard: all(scopeItem, liveItemsRemain, paymentHeldKnown, itemsNotArrived),
    receipt: refundReceipt,
    notify: [client('item_cancelled'), sellers('staff_cancel_at_supplier_task')],
    effects: refundEffects(['cancel_at_supplier_task']),
  },
  {
    label: 'Отменить задержанную позицию: остальное уже приехало',
    from: ['ordered_at_supplier'],
    event: 'item_cancelled',
    to: 'ready',
    actors: ['client', 'staff'],
    guard: all(scopeItem, liveItemsRemain, paymentHeldKnown, allLiveItemsArrived),
    receipt: refundReceipt,
    notify: [client('item_cancelled'), client('arrived'), sellers('staff_cancel_at_supplier_task')],
    effects: refundEffects(['cancel_at_supplier_task', 'start_pickup_window']),
  },

  // --- needs_attention ---------------------------------------------------------------------
  ...resumeWork({
    label: 'Заказать всё равно',
    from: ['needs_attention'],
    event: 'order_anyway',
    actors: ['staff'],
    guard: all(marginAboveFloor, prepayFunded),
    notify: [],
  }),
  {
    label: 'Аналог по цене клиента',
    from: ['needs_attention'],
    event: 'alternative_proposed',
    to: 'awaiting_client_approval',
    actors: ['staff'],
    guard: clientReachable,
    notify: [client('decision_needed')],
    effects: ['start_approval_timer'],
  },
  {
    label: 'Новый срок',
    from: ['needs_attention'],
    event: 'new_eta_proposed',
    to: 'awaiting_client_approval',
    actors: ['staff'],
    guard: clientReachable,
    notify: [client('decision_needed')],
    effects: ['start_approval_timer'],
  },
  ...resumeWork({
    label: 'Отменить позицию',
    from: ['needs_attention'],
    event: 'item_cancelled',
    actors: ['staff'],
    guard: all(liveItemsRemain, paymentHeldKnown),
    receipt: refundReceipt,
    notify: [client('item_cancelled')],
    effects: refundEffects([]),
  }),
  {
    label: 'Отменить заказ и вернуть деньги',
    from: ['needs_attention'],
    event: 'order_cancelled',
    to: 'refund_pending',
    actors: ['staff'],
    guard: moneyHeld,
    receipt: refundReceipt,
    notify: [client('refund_started')],
    effects: ['create_refund', 'cancel_at_supplier_task'],
  },
  {
    label: 'Отменить заказ (оплаты ещё не было)',
    from: ['needs_attention'],
    event: 'order_cancelled',
    to: 'cancelled',
    actors: ['staff'],
    guard: noMoneyHeld,
    notify: [client('order_cancelled')],
    effects: ['cancel_at_supplier_task'],
  },

  // --- awaiting_client_approval ------------------------------------------------------------
  ...resumeWork({
    label: 'Клиент согласен',
    from: ['awaiting_client_approval'],
    event: 'client_approved',
    actors: ['client'],
    notify: [sellers('staff_client_approved')],
  }),
  ...(['client_refund_requested', 'approval_timeout'] as const).flatMap(
    (event): TransitionRule[] => {
      const actors: readonly ActorType[] = event === 'approval_timeout' ? ['system'] : ['client'];
      const how = event === 'approval_timeout' ? 'нет ответа 24 ч' : 'клиент: вернуть деньги';
      return [
        {
          label: `Решение клиента (${how}): весь заказ, предоплата`,
          from: ['awaiting_client_approval'],
          event,
          to: 'refund_pending',
          actors,
          guard: all(scopeOrder, moneyHeld),
          receipt: refundReceipt,
          notify: [client('refund_started')],
          effects: ['create_refund', 'cancel_at_supplier_task'],
        },
        {
          label: `Решение клиента (${how}): весь заказ, оплата при получении`,
          from: ['awaiting_client_approval'],
          event,
          to: 'cancelled',
          actors,
          guard: all(scopeOrder, noMoneyHeld),
          notify: [client('order_cancelled')],
          effects: ['cancel_at_supplier_task'],
        },
        ...resumeWork({
          label: `Решение клиента (${how}): одна позиция`,
          from: ['awaiting_client_approval'],
          event,
          actors,
          guard: all(scopeItem, liveItemsRemain, paymentHeldKnown),
          receipt: refundReceipt,
          notify: [client('item_cancelled')],
          effects: refundEffects([]),
        }),
      ];
    },
  ),

  // --- ready and handover ------------------------------------------------------------------
  {
    label: 'Клиент пришёл',
    from: ['ready'],
    event: 'client_arrived',
    to: 'ready',
    actors: ['staff'],
    guard: schemeKnown,
    receipt: (ctx) => (ctx.scheme === 'prepay' ? 'offset' : null),
    notify: [],
    effects: ['mark_client_arrived'],
  },
  {
    label: 'Чек зачёта аванса (повтор)',
    from: ['ready'],
    event: 'offset_receipt_requested',
    to: 'ready',
    actors: ['staff', 'system'],
    guard: all(prepay, clientArrived),
    receipt: 'offset',
    notify: [],
  },
  {
    label: 'Выставить оплату (QR на экране продавца)',
    from: ['ready'],
    event: 'handover_payment_requested',
    to: 'awaiting_handover_payment',
    actors: ['staff'],
    guard: all(payOnHandover, clientArrived),
    receipt: 'full',
    notify: [],
    effects: ['create_handover_payment'],
  },
  {
    label: 'Выдал (предоплата, чек зачёта пробит)',
    from: ['ready'],
    event: 'handed_over',
    to: 'handed',
    actors: ['staff'],
    guard: all(prepay, settlementReceiptSucceeded),
    notify: [client('handed')],
    effects: ['start_completion_timer'],
  },
  {
    label: 'Оплатить заранее',
    from: ['ready'],
    event: 'switch_to_prepay',
    to: 'awaiting_payment',
    actors: ['client', 'staff'],
    guard: payOnHandover,
    notify: [client('payment_link')],
    effects: ['set_scheme_prepay', 'create_payment'],
  },
  {
    label: 'Передал курьеру',
    from: ['ready'],
    event: 'courier_dispatched',
    to: 'out_for_delivery',
    actors: ['staff'],
    guard: all(prepay, courier),
    notify: [client('courier_on_way')],
  },
  // housekeeping, or «Клиент не пришёл» from staff, only after the window (decision Б10)
  {
    label: 'Хранение истекло: возврат денег',
    from: ['ready'],
    event: 'storage_expired',
    to: 'refund_pending',
    actors: ['system', 'staff'],
    guard: all(pickupWindowElapsed, moneyHeld),
    receipt: refundReceipt,
    notify: [client('storage_expired'), sellers('staff_supplier_return_task')],
    effects: ['create_refund', 'no_show_increment', 'supplier_return_task'],
  },
  {
    label: 'Хранение истекло: отмена (оплаты не было)',
    from: ['ready'],
    event: 'storage_expired',
    to: 'cancelled',
    actors: ['system', 'staff'],
    guard: all(pickupWindowElapsed, noMoneyHeld),
    notify: [client('storage_expired'), sellers('staff_supplier_return_task')],
    effects: ['no_show_increment', 'supplier_return_task'],
  },

  // --- awaiting_handover_payment -----------------------------------------------------------
  {
    label: 'Оплата на точке прошла',
    from: ['awaiting_handover_payment'],
    event: 'payment_succeeded',
    to: 'awaiting_handover_payment',
    actors: PAYMENT_ACTORS,
    guard: amountMatches,
    notify: [],
  },
  {
    label: 'Оплата на точке: сумма не равна сумме заказа',
    from: ['awaiting_handover_payment'],
    event: 'payment_succeeded',
    to: 'needs_attention',
    actors: PAYMENT_ACTORS,
    guard: amountMismatch,
    notify: [owner('staff_amount_mismatch')],
  },
  {
    // Any held QR payment of the total pays for the order, not only the latest one: an old QR
    // paid after a newer one was shown (two QR on the screen) must not block the handover.
    label: 'Выдал (оплата на точке и чек прошли)',
    from: ['awaiting_handover_payment'],
    event: 'handed_over',
    to: 'handed',
    actors: ['staff'],
    guard: all(handoverPaymentHeld, settlementReceiptSucceeded),
    notify: [client('handed')],
    effects: ['start_completion_timer'],
  },
  {
    label: 'Оплата на точке отменена',
    from: ['awaiting_handover_payment'],
    event: 'payment_canceled',
    to: 'ready',
    actors: PAYMENT_ACTORS,
    // A stale cancel of an earlier QR must not undo a newer QR or a succeeded payment.
    guard: all(eventPaymentIsCurrent, paymentConfirmedUnpaid, not(paymentHeldFlag)),
    notify: [],
  },
  {
    // Decision Б9: YooKassa gives no way to cancel a pending payment, so the QR TTL does not
    // wait for a confirmed cancel. If the old QR is paid later, `ready + payment_succeeded`
    // (late handover payment) brings the order back here with the money. The provider status
    // must still be known and not taken (null, pending or canceled): a missing status or a
    // waiting_for_capture payment fails closed instead of dropping a paid QR.
    label: 'QR истёк',
    from: ['awaiting_handover_payment'],
    event: 'payment_ttl_expired',
    to: 'ready',
    actors: ['system'],
    guard: all(eventPaymentIsCurrent, noPaymentSucceeded, not(paymentHeldFlag)),
    notify: [],
  },

  // --- a payment succeeded while the order does not wait for one ---------------------------
  {
    label: 'Оплата по истёкшему QR прошла',
    from: ['ready'],
    event: 'payment_succeeded',
    to: 'awaiting_handover_payment',
    actors: PAYMENT_ACTORS,
    guard: all(paymentSucceeded, lateHandoverPayment),
    notify: [],
  },
  {
    label: 'Неожиданный платёж (дубль или устаревшая ссылка): владельцу',
    from: ['ready'],
    event: 'payment_succeeded',
    to: 'needs_attention',
    actors: PAYMENT_ACTORS,
    guard: all(paymentSucceeded, not(lateHandoverPayment)),
    notify: [owner('staff_unexpected_payment')],
  },
  {
    label: 'Неожиданный платёж (дубль или устаревшая ссылка): владельцу',
    from: UNEXPECTED_PAYMENT_STATUSES,
    event: 'payment_succeeded',
    to: 'needs_attention',
    actors: PAYMENT_ACTORS,
    guard: paymentSucceeded,
    notify: [owner('staff_unexpected_payment')],
  },
  // After handover the status must not move: the owner decides (the engine records a refund
  // task with the 10-day deadline). In refund_pending / refunded the engine returns such a
  // payment itself (scope orphan) without a transition.
  ...(['handed', 'completed'] as const).map((status): TransitionRule => ({
    label: 'Неожиданный платёж после выдачи: владельцу',
    from: [status],
    event: 'payment_succeeded',
    to: status,
    actors: PAYMENT_ACTORS,
    guard: paymentSucceeded,
    notify: [owner('staff_unexpected_payment')],
  })),

  // --- out_for_delivery --------------------------------------------------------------------
  {
    label: 'Клиент получил: чек зачёта',
    from: ['out_for_delivery'],
    event: 'offset_receipt_requested',
    to: 'out_for_delivery',
    actors: ['staff', 'system'],
    guard: prepay,
    receipt: 'offset',
    notify: [],
  },
  {
    label: 'Выдал курьером (чек зачёта пробит)',
    from: ['out_for_delivery'],
    event: 'handed_over',
    to: 'handed',
    actors: ['staff'],
    guard: all(prepay, settlementReceiptSucceeded),
    notify: [client('handed')],
    effects: ['start_completion_timer'],
  },
  {
    label: 'Клиент не принял',
    from: ['out_for_delivery'],
    event: 'delivery_failed',
    to: 'ready',
    actors: ['staff'],
    notify: [client('delivery_failed'), sellers('staff_delivery_failed')],
  },

  // --- handed / completed ------------------------------------------------------------------
  {
    label: '7 дней без обращений',
    from: ['handed'],
    event: 'completion_timeout',
    to: 'completed',
    actors: ['system'],
    guard: noOpenClaims,
    notify: [client('how_is_it')],
  },
  ...(['handed', 'completed'] as const).flatMap((status): TransitionRule[] => [
    {
      label: 'Претензия',
      from: [status],
      event: 'claim_opened',
      to: status,
      actors: ['client', 'staff'],
      notify: [client('claim_received'), owner('staff_claim_deadline')],
      effects: ['open_claim'],
    },
    {
      label: 'Претензия: возврат по одной позиции',
      from: [status],
      event: 'claim_refund_approved',
      to: status,
      actors: ['staff'],
      guard: all(scopeItem, claimRefundAllowed),
      receipt: 'refund_full',
      notify: [client('item_cancelled')],
      effects: ['create_refund'],
    },
  ]),
  {
    label: 'Претензия: возврат всего заказа',
    from: ['handed', 'completed'],
    event: 'claim_refund_approved',
    to: 'refund_pending',
    actors: ['staff'],
    guard: all(scopeOrder, claimRefundAllowed),
    receipt: 'refund_full',
    notify: [client('refund_started')],
    effects: ['create_refund'],
  },

  // --- client refusal before handover (ст. 26.1) -------------------------------------------
  {
    label: 'Отказ клиента до передачи: возврат денег',
    from: REFUSABLE_STATUSES,
    event: 'client_refused',
    to: 'refund_pending',
    actors: ['client', 'staff'],
    guard: moneyHeld,
    receipt: refundReceipt,
    notify: [client('refund_started'), sellers('staff_cancel_at_supplier_task')],
    effects: ['create_refund', 'cancel_at_supplier_task'],
  },
  {
    label: 'Отказ клиента до передачи: отмена (оплаты не было)',
    from: REFUSABLE_STATUSES,
    event: 'client_refused',
    to: 'cancelled',
    actors: ['client', 'staff'],
    guard: noMoneyHeld,
    notify: [client('order_cancelled'), sellers('staff_cancel_at_supplier_task')],
    effects: ['cancel_at_supplier_task'],
  },

  // --- refund_pending ----------------------------------------------------------------------
  {
    label: 'Деньги отправлены',
    from: ['refund_pending'],
    event: 'refund_succeeded',
    to: 'refunded',
    actors: PAYMENT_ACTORS,
    guard: refundConfirmed,
    notify: [client('money_sent')],
  },
  {
    label: 'Возврат не прошёл: алерт, срок 10 дней идёт',
    from: ['refund_pending'],
    event: 'refund_failed',
    to: 'refund_pending',
    actors: PAYMENT_ACTORS,
    notify: [owner('staff_refund_failed')],
  },

  // --- partial refunds (one item; decision Б11): the order status does not change ----------
  ...PARTIAL_REFUND_STATUSES.flatMap((status): TransitionRule[] => [
    {
      label: 'Деньги за позицию отправлены',
      from: [status],
      event: 'partial_refund_succeeded',
      to: status,
      actors: PAYMENT_ACTORS,
      guard: refundConfirmed,
      notify: [client('money_sent')],
    },
    {
      label: 'Возврат за позицию не прошёл: алерт, срок 10 дней идёт',
      from: [status],
      event: 'partial_refund_failed',
      to: status,
      actors: PAYMENT_ACTORS,
      notify: [owner('staff_refund_failed')],
    },
  ]),
];

/** Resolves a rule's side effects for a concrete context. */
export function effectsFor(
  rule: TransitionRule,
  ctx: TransitionContext,
): readonly TransitionEffect[] {
  if (rule.effects === undefined) return [];
  return typeof rule.effects === 'function' ? rule.effects(ctx) : rule.effects;
}

/** Resolves a rule's receipt for a concrete context. */
export function receiptFor(rule: TransitionRule, ctx: TransitionContext): ReceiptKind | null {
  if (rule.receipt === undefined) return null;
  return typeof rule.receipt === 'function' ? rule.receipt(ctx) : rule.receipt;
}
