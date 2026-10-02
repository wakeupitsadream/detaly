/**
 * Guard conditions of the order state machine. A guard is a named predicate over the
 * transition context. Missing context fields make "positive" guards fail, so a caller that
 * forgets to pass data gets `guard_failed` instead of a wrong transition.
 */
import type {
  ActorType,
  ClaimKind,
  Fulfillment,
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
  /** Every live (not failed/replaced/refunded) item is `arrived`. */
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
   * A supplier order (GetCheckout succeeded) already covers the live items. False when the
   * problem was found by the recheck before ordering: going back to work then means GetCheckout.
   */
  supplierOrderCreated?: boolean;
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

export const paymentSucceeded = guard(
  'payment_succeeded',
  (c) => c.providerPaymentStatus === 'succeeded',
);

export const allLiveItemsArrived = guard(
  'all_items_arrived',
  (c) => c.allLiveItemsArrived === true,
);

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

export const supplierOrderCreated = guard(
  'supplier_order_created',
  (c) => c.supplierOrderCreated === true,
);
export const supplierOrderMissing = guard(
  'supplier_order_missing',
  (c) => c.supplierOrderCreated === false,
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
