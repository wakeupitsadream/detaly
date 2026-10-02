/**
 * Guard conditions of the order state machine. A guard is a named predicate over the
 * transition context. Missing context fields make "positive" guards fail, so a caller that
 * forgets to pass data gets `guard_failed` instead of a wrong transition.
 */
import type {
  ActorType,
  ClaimKind,
  Fulfillment,
  PaymentKind,
  PaymentScheme,
  PaymentStatus,
  StaffRole,
} from '../statuses';
import type { BasisPoints, Kop } from '../types';

/** Everything guards may look at. The worker/web fill it from the order row and settings. */
export interface TransitionContext {
  /** Who triggers the event; must be listed in the rule's `actors`. */
  actor: ActorType;
  staffRole?: StaffRole | null;
  scheme?: PaymentScheme | null;
  fulfillment?: Fulfillment | null;

  // --- checkout (draft) ---
  /** A consent kind=pd exists for the current privacy/consent version. */
  hasPdConsent?: boolean;
  /** Every item comes from an Orenburg (local) stock. */
  allItemsLocal?: boolean;
  /** orders.total_kop (also used to check paid amounts). */
  totalKop?: Kop;
  /** settings pricing.min_order_total_kop (0 = no minimum). */
  minOrderTotalKop?: Kop;
  /** Order margin: sum of (priceClient - priceSupplier) x quantity over the items (orderMarginKop). */
  orderMarginKop?: Kop;
  /** settings pricing.min_margin_kop (MIN_MARGIN_RUB; 0 = no minimum, must still be passed). */
  minMarginKop?: Kop;
  /** settings order.on_pickup_max_total_kop (ON_PICKUP_MAX_TOTAL). */
  onPickupMaxTotalKop?: Kop;
  /** users.no_show_count of the client. */
  noShowCount?: number;
  /** settings no_show.limit (NO_SHOW_LIMIT). */
  noShowLimit?: number;

  // --- payments ---
  /** Amount of the payment confirmed by GET /payments/{id}. */
  paidAmountKop?: Kop;
  /** Status confirmed by GET /payments/{id}; null when no payment object exists at all. */
  providerPaymentStatus?: PaymentStatus | null;
  /**
   * The payment the event is about is the latest payment created for the order. A late
   * cancel/expiry of an earlier payment (old QR, replaced link) must not touch the order:
   * cancel and expiry rules require it, and the worker marks such webhooks `stale`.
   */
  eventPaymentIsCurrent?: boolean;
  /**
   * payments.kind of the payment the event is about: `full` is a handover (QR) payment,
   * `prepayment` an online prepay link. Tells a late payment of an expired QR (decision Б9)
   * from a duplicate prepayment.
   */
  eventPaymentKind?: PaymentKind | null;
  /**
   * Every live (not failed/replaced/refunded) item is `arrived`. Pass `false` explicitly for
   * "not yet": the negative branch never runs on a missing flag. For a partial cancellation it
   * is computed over the items left after the cancellation.
   */
  allLiveItemsArrived?: boolean;
  /**
   * A succeeded payment of this order exists and is not fully refunded. Prepay orders past
   * awaiting_payment always hold money; a pay_on_handover order holds money only after the
   * handover QR payment succeeded (or a mismatched payment sent it to needs_attention). For
   * pay_on_handover the caller must pass it explicitly: refusal/cancel branches fail closed.
   */
  paymentHeld?: boolean;

  // --- supplier ---
  /** Supplier price growth found by the recheck (driftBp of the order). */
  priceDriftBp?: BasisPoints;
  /** settings pricing.drift_tolerance_pct in bp. */
  driftToleranceBp?: BasisPoints;
  /** Recheck found enough stock for every item. */
  allAvailable?: boolean;
  /** Number of GetCheckout itemErrors. */
  supplierItemErrors?: number;
  /** settings rossko.prepay_invoice. */
  prepayInvoice?: boolean;
  /**
   * The Rossko invoice of the current supplier order is marked paid ("Счёт оплачен" in
   * order_events). Only read when prepayInvoice is true; a missing flag means "not paid".
   */
  supplierInvoicePaid?: boolean;
  /**
   * Live items that no successful supplier order covers yet (no supplier_order_items row of a
   * created supplier order), counted after the decision being applied: an approved alternative
   * is a new pending item, items failed in GetCheckout itemErrors stay pending, a cancelled item
   * is not counted. > 0 when going back to work means GetCheckout for these items.
   */
  pendingSupplierItems?: number;
  /** Order margin after the change (marginBp of totals). */
  marginBp?: BasisPoints;
  /** settings pricing.margin_floor_pct in bp. */
  marginFloorBp?: BasisPoints;

  // --- approvals and partial operations ---
  /** The client notification was delivered (not `skipped`), so an approval timer may run. */
  clientReachable?: boolean;
  /** Whole order or a single item. */
  scope?: 'order' | 'item';
  /** Live items left after cancelling the item in question. */
  liveItemsAfter?: number;

  // --- handover ---
  /** "Клиент пришёл" was pressed for this order. */
  clientArrived?: boolean;
  /** The settlement receipt (offset for prepay, full for pay_on_handover) is succeeded. */
  settlementReceiptSucceeded?: boolean;
  /**
   * The storage window of a ready order has passed (orders.expires_at <= now: prepay
   * pickup.window_prepaid_days, pay_on_handover pickup.window_cod_days). «Клиент не пришёл»
   * is pressed by staff only after it (decision Б10); housekeeping passes true.
   */
  pickupWindowElapsed?: boolean;

  // --- claims and refunds ---
  openClaims?: number;
  claimKind?: ClaimKind | null;
  /** claims.return_accepted_at is set ("Принял возврат" with a return photo). */
  returnAccepted?: boolean;
  /** Owner override reason written to order_events (only counted for staffRole owner). */
  ownerOverrideReason?: string | null;
  /** refund.succeeded confirmed by GET /refunds/{id}. */
  refundConfirmed?: boolean;
}

export interface Guard {
  readonly name: string;
  readonly test: (ctx: TransitionContext) => boolean;
  /** Set for conjunctions built by `all`, so failures can be reported precisely. */
  readonly parts?: readonly Guard[];
}

export function guard(name: string, test: (ctx: TransitionContext) => boolean): Guard {
  return { name, test };
}

/** All guards must pass; failing names are reported by `failedGuards`. */
export function all(...guards: Guard[]): Guard {
  return {
    name: guards.map((g) => g.name).join(' & '),
    test: (ctx) => guards.every((g) => g.test(ctx)),
    parts: guards,
  };
}

/** Names of the leaf guards that fail for `ctx` (empty when the guard passes). */
export function failedGuards(g: Guard, ctx: TransitionContext): string[] {
  if (g.test(ctx)) return [];
  if (g.parts === undefined) return [g.name];
  return g.parts.flatMap((part) => failedGuards(part, ctx));
}

export function not(inner: Guard): Guard {
  return { name: `!${inner.name}`, test: (ctx) => !inner.test(ctx) };
}

const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v);

export const prepay = guard('prepay', (c) => c.scheme === 'prepay');
export const payOnHandover = guard('pay_on_handover', (c) => c.scheme === 'pay_on_handover');
export const schemeKnown = guard(
  'scheme_known',
  (c) => c.scheme === 'prepay' || c.scheme === 'pay_on_handover',
);
export const courier = guard('courier', (c) => c.fulfillment === 'courier');
export const isOwner = guard('owner', (c) => c.actor === 'staff' && c.staffRole === 'owner');

export const hasPdConsent = guard('pd_consent', (c) => c.hasPdConsent === true);

export const minTotalReached = guard(
  'min_order_total',
  (c) => isCount(c.totalKop) && c.totalKop > 0 && c.totalKop >= (c.minOrderTotalKop ?? 0),
);

/** PLAN section 4: checkout is refused below MIN_MARGIN_RUB ("добавьте позицию"). */
export const minMarginReached = guard(
  'min_order_margin',
  (c) => isCount(c.orderMarginKop) && isCount(c.minMarginKop) && c.orderMarginKop >= c.minMarginKop,
);

/**
 * PLAN round 4: pay on handover only when every item is local, total <= ON_PICKUP_MAX_TOTAL,
 * no_show_count < NO_SHOW_LIMIT, and the order is picked up (courier is prepay only).
 */
export const onPickupEligible = guard(
  'on_pickup_eligible',
  (c) =>
    c.allItemsLocal === true &&
    isCount(c.totalKop) &&
    isCount(c.onPickupMaxTotalKop) &&
    c.totalKop <= c.onPickupMaxTotalKop &&
    isCount(c.noShowCount) &&
    isCount(c.noShowLimit) &&
    c.noShowCount < c.noShowLimit &&
    c.fulfillment !== 'courier',
);

/**
 * Money was taken from the client: prepay orders, or pay_on_handover with a succeeded payment.
 * Decides between refund_pending (refund) and cancelled (nothing to return).
 */
export const moneyHeld = guard(
  'money_held',
  (c) => c.scheme === 'prepay' || (c.scheme === 'pay_on_handover' && c.paymentHeld === true),
);

/** pay_on_handover with an explicit "no payment taken"; a missing flag never cancels. */
export const noMoneyHeld = guard(
  'no_money_held',
  (c) => c.scheme === 'pay_on_handover' && c.paymentHeld === false,
);

/** The order holds a succeeded payment (stale cancel/expiry of another payment is ignored). */
export const paymentHeldFlag = guard('payment_held', (c) => c.paymentHeld === true);

/**
 * Whether money was taken is known: prepay, or pay_on_handover with an explicit paymentHeld.
 * Rules whose refund depends on it (item cancellations) fail closed without it.
 */
export const paymentHeldKnown = guard(
  'payment_held_known',
  (c) =>
    c.scheme === 'prepay' || (c.scheme === 'pay_on_handover' && typeof c.paymentHeld === 'boolean'),
);

/** The event's payment is the latest payment of the order (see eventPaymentIsCurrent). */
export const eventPaymentIsCurrent = guard(
  'event_payment_is_current',
  (c) => c.eventPaymentIsCurrent === true,
);

export const amountMatches = guard(
  'amount_matches_total',
  (c) => isCount(c.paidAmountKop) && isCount(c.totalKop) && c.paidAmountKop === c.totalKop,
);

export const amountMismatch = guard(
  'amount_mismatch',
  (c) => isCount(c.paidAmountKop) && isCount(c.totalKop) && c.paidAmountKop !== c.totalKop,
);

/** Cancel/expire only after the provider confirmed the payment is not (and will not be) paid. */
export const paymentConfirmedUnpaid = guard(
  'payment_confirmed_unpaid',
  (c) => c.providerPaymentStatus === 'canceled' || c.providerPaymentStatus === null,
);

/**
 * Decision Д3 (phase 1A): the client may cancel an unpaid order while its latest payment is
 * absent (null), pending or canceled. A missing field (undefined) and succeeded or
 * waiting_for_capture payments fail.
 */
export const noPaymentSucceeded = guard(
  'no_payment_succeeded',
  (c) =>
    c.providerPaymentStatus === null ||
    c.providerPaymentStatus === 'pending' ||
    c.providerPaymentStatus === 'canceled',
);

export const paymentSucceeded = guard(
  'payment_succeeded',
  (c) => c.providerPaymentStatus === 'succeeded',
);

export const allLiveItemsArrived = guard(
  'all_items_arrived',
  (c) => c.allLiveItemsArrived === true,
);

/** Explicit "some live item has not arrived"; a missing flag fails (not `!allLiveItemsArrived`). */
export const itemsNotArrived = guard('items_not_arrived', (c) => c.allLiveItemsArrived === false);

export const recheckPassed = guard(
  'recheck_passed',
  (c) =>
    c.allAvailable === true &&
    isCount(c.priceDriftBp) &&
    isCount(c.driftToleranceBp) &&
    c.priceDriftBp <= c.driftToleranceBp,
);

export const noItemErrors = guard('no_item_errors', (c) => c.supplierItemErrors === 0);
export const hasItemErrors = guard(
  'has_item_errors',
  (c) => isCount(c.supplierItemErrors) && c.supplierItemErrors > 0,
);
export const prepayInvoice = guard('prepay_invoice', (c) => c.prepayInvoice === true);
/** Explicitly no prepay invoice (a missing setting never skips the invoice step). */
export const noPrepayInvoice = guard('no_prepay_invoice', (c) => c.prepayInvoice === false);

/** Every live item is covered by a created supplier order: nothing to (re)order. */
export const supplierItemsCovered = guard(
  'supplier_items_covered',
  (c) => c.pendingSupplierItems === 0,
);
/** Some live items still need GetCheckout (recheck problem, itemErrors, approved alternative). */
export const supplierItemsPending = guard(
  'supplier_items_pending',
  (c) => isCount(c.pendingSupplierItems) && c.pendingSupplierItems > 0,
);

/** prepay_invoice is on and the current Rossko invoice is not marked paid yet. */
export const supplierInvoiceDue = guard(
  'supplier_invoice_due',
  (c) => c.prepayInvoice === true && c.supplierInvoicePaid !== true,
);
/** The supplier ships without waiting for us: no prepay invoice, or it is already paid. */
export const supplierInvoiceSettled = guard(
  'supplier_invoice_settled',
  (c) => c.prepayInvoice === false || (c.prepayInvoice === true && c.supplierInvoicePaid === true),
);

export const marginAboveFloor = guard(
  'margin_floor',
  (c) => isCount(c.marginBp) && isCount(c.marginFloorBp) && c.marginBp >= c.marginFloorBp,
);

export const clientReachable = guard('client_reachable', (c) => c.clientReachable === true);
export const scopeOrder = guard('scope_order', (c) => c.scope === 'order');
export const scopeItem = guard('scope_item', (c) => c.scope === 'item');
export const liveItemsRemain = guard(
  'live_items_remain',
  (c) => isCount(c.liveItemsAfter) && c.liveItemsAfter > 0,
);

export const clientArrived = guard('client_arrived', (c) => c.clientArrived === true);
export const settlementReceiptSucceeded = guard(
  'settlement_receipt_succeeded',
  (c) => c.settlementReceiptSucceeded === true,
);

/** Decision Б10: a no-show is recorded only after the storage window has passed. */
export const pickupWindowElapsed = guard(
  'pickup_window_elapsed',
  (c) => c.pickupWindowElapsed === true,
);

/** The event's payment is a handover (QR) payment: payments.kind = 'full'. */
export const eventPaymentIsHandover = guard(
  'event_payment_is_handover',
  (c) => c.eventPaymentKind === 'full',
);

/**
 * Decision Б9: a pay_on_handover order is back in `ready` after the QR expired, and the client
 * pays that old QR anyway with the right amount. It is the payment the seller was waiting for,
 * not an unexpected one.
 */
export const lateHandoverPayment = all(payOnHandover, eventPaymentIsHandover, amountMatches);

export const noOpenClaims = guard('no_open_claims', (c) => c.openClaims === 0);

/**
 * PLAN section 2 invariant: a claim refund (except kind=delay) needs the returned part
 * accepted, or an owner override with a written reason.
 */
export const claimRefundAllowed = guard(
  'claim_refund_allowed',
  (c) =>
    c.claimKind === 'delay' ||
    c.returnAccepted === true ||
    (c.actor === 'staff' &&
      c.staffRole === 'owner' &&
      typeof c.ownerOverrideReason === 'string' &&
      c.ownerOverrideReason.trim() !== ''),
);

export const refundConfirmed = guard('refund_confirmed', (c) => c.refundConfirmed === true);
