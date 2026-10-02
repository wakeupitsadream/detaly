/**
 * Types of @detaly/orders (docs/phase-1b-implementation.md section 5.1). The contract was fixed
 * by the foundation (wave 1); wave 2 only adds optional fields.
 */
import type { Env } from '@detaly/config';
import type {
  clientApprovals,
  Database,
  Executor,
  orderItems,
  orders,
  payments,
  receipts,
  refunds,
  supplierOrders,
} from '@detaly/db';
import type {
  ActorType,
  ApprovalProposal,
  EtaSettings,
  IsoDate,
  Kop,
  MarkupRule,
  OrderEvent,
  OrderItemState,
  OrderStatus,
  RecheckAlternative,
  StaffRole,
  TransitionContext,
  TransitionEffect,
  TransitionRule,
} from '@detaly/domain';
import type { CreatePaymentRequest, ProviderPayment } from '@detaly/payments';

// ---------------------------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------------------------

/**
 * What the engine needs. `env` is the full parsed env (settings defaults come from it); the
 * engine reads APP_BASE_URL, YOOKASSA_VAT_CODE, YOOKASSA_TAX_SYSTEM_CODE and SMS_PROVIDER.
 */
export interface EngineDeps {
  db: Database;
  env: Env;
  /** Clock (tests); default () => new Date(). */
  now?: () => Date;
  /** Called after a commit that wrote outbox rows (web: PUBLISH OUTBOX_CHANNEL). Never throws. */
  nudge?: () => void;
}

/** A transaction or the database: functions taking `tx` never open their own transaction. */
export type Tx = Executor;

// ---------------------------------------------------------------------------------------------
// Rows and snapshot
// ---------------------------------------------------------------------------------------------

export type OrderRow = typeof orders.$inferSelect;
export type OrderItemRow = typeof orderItems.$inferSelect;
export type PaymentRow = typeof payments.$inferSelect;
export type ReceiptRow = typeof receipts.$inferSelect;
export type RefundRow = typeof refunds.$inferSelect;
export type SupplierOrderRow = typeof supplierOrders.$inferSelect;
export type ClientApprovalRow = typeof clientApprovals.$inferSelect;

/** A supplier order attempt with the order items it covers (supplier_order_items). */
export interface SupplierOrderView extends SupplierOrderRow {
  itemIds: string[];
}

/**
 * Everything a transition decision needs, loaded under the order row lock. The client phone is
 * never loaded here (PD minimisation); notify jobs read it themselves.
 */
export interface OrderSnapshot {
  order: OrderRow;
  items: OrderItemRow[];
  /** Oldest first; the last one is the order's current payment. */
  payments: PaymentRow[];
  receipts: ReceiptRow[];
  refunds: RefundRow[];
  supplierOrders: SupplierOrderView[];
  /** The undecided client_approvals row, if any. */
  openApproval: ClientApprovalRow | null;
  /** users.no_show_count of the client. */
  noShowCount: number;
}

/** Settings the engine uses: `settings` rows over env defaults (settingsDefaultsFromEnv). */
export interface OrderSettings {
  markupRules: MarkupRule[];
  eta: EtaSettings;
  /** pricing.drift_tolerance_pct in basis points. */
  driftToleranceBp: number;
  /** pricing.margin_floor_pct in basis points. */
  marginFloorBp: number;
  minOrderTotalKop: Kop;
  minMarginKop: Kop;
  onPickupMaxTotalKop: Kop;
  onPickupConfirmTtlH: number;
  paymentTtlMin: number;
  pickupWindowPrepaidDays: number;
  pickupWindowCodDays: number;
  supplierReturnDays: number;
  handedCompleteDays: number;
  handoverQrTtlMin: number;
  noShowLimit: number;
  reminderDays: number[];
  courierFeeKop: Kop;
  /** approval.timeout_h */
  approvalTimeoutH: number;
}

// ---------------------------------------------------------------------------------------------
// Transitions
// ---------------------------------------------------------------------------------------------

/** Who triggers a transition. Admin (Basic auth) acts as the owner with id 'admin' (Б19). */
export interface ActorRef {
  type: ActorType;
  /** staff id, user id, 'admin', or an external identifier ('yookassa'). */
  id: string | null;
  staffRole?: StaffRole | null;
}

/** Why an order entered needs_attention (orders.attention_reason). */
export type AttentionReason =
  | 'price_drift'
  | 'unavailable'
  | 'item_errors'
  | 'checkout_disabled'
  | 'unknown_after_timeout'
  | 'checkout_failed'
  | 'amount_mismatch'
  | 'unexpected_payment'
  | `item_problem:${ItemProblem}`;

/** «Проблема с позицией» reasons (bot menu pdecl / pwrong / pdmg / pdelay). */
export type ItemProblem = 'declined' | 'wrong' | 'damaged' | 'delay';

/**
 * Facts known to the caller that the snapshot cannot tell (recheck results, the provider
 * payment, the approval scope). They override what buildTransitionContext derives.
 */
export type TransitionFacts = Partial<Omit<TransitionContext, 'actor' | 'staffRole'>> & {
  /** needs_attention reason written to orders.attention_reason. */
  reason?: AttentionReason | null;
  /** Item ids covered by a created supplier order (supplier_checkout_succeeded). */
  coveredItemIds?: string[];
  /** GetCheckout itemErrors by order item id, as received. */
  itemErrors?: { orderItemId: string; error: unknown }[];
  /** payments.id the event is about (payment events). */
  paymentId?: string | null;
  /** refunds.id the event is about (refund events). */
  refundId?: string | null;
  /** alternative_proposed / new_eta_proposed: what the client is asked (client_approvals.proposal). */
  proposal?: ApprovalProposal;
  /** item_problem: the seller's reason (attention_reason `item_problem:<problem>`). */
  problem?: ItemProblem;
};

/** How one event changes the order items (section 5.3). */
export type ItemChange =
  | {
      kind: 'state';
      itemId: string;
      to: OrderItemState;
      /** item_arrived (default: the transition time). */
      arrivedAt?: Date;
      /** GetCheckout itemErrors entry (the item stays pending); null clears it. */
      supplierItemError?: unknown;
    }
  | {
      /** Old item -> replaced, a copy or the approved alternative -> pending. */
      kind: 'replace';
      itemId: string;
      replacement: Omit<typeof orderItems.$inferInsert, 'id' | 'orderId'>;
    }
  | { kind: 'eta'; itemId: string; etaDate: IsoDate }
  | { kind: 'refunded'; itemId: string; amountKop: Kop };

export interface ApplyInput {
  orderId: string;
  event: OrderEvent;
  actor: ActorRef;
  /** The item the event is about (item_arrived, item_cancelled, item_problem, ...). */
  itemId?: string | null;
  facts?: TransitionFacts;
  /** Extra journal payload (no PD). */
  payload?: Record<string, unknown>;
  /** Run inside this transaction instead of opening one (and do not nudge). */
  tx?: Tx;
}

export type ApplyResult =
  | {
      ok: true;
      orderEventId: string;
      from: OrderStatus;
      to: OrderStatus;
      rule: TransitionRule;
      effects: readonly TransitionEffect[];
    }
  | {
      ok: false;
      reason: 'no_rule' | 'guard_failed' | 'not_found';
      failed: string[];
      /** Current status (null when the order does not exist). */
      status: OrderStatus | null;
    };

/** A resolved decision ready to be written (persistTransition). */
export interface TransitionDecision {
  rule: TransitionRule;
  ctx: TransitionContext;
  changes: ItemChange[];
}

export type AppliedTransition = Extract<ApplyResult, { ok: true }>;

// ---------------------------------------------------------------------------------------------
// Staff and client actions
// ---------------------------------------------------------------------------------------------

/** Seller bot callback codes (section 13.2) and admin-only actions. */
export type StaffActionCode =
  | 'recheck'
  | 'refused'
  | 'cancel'
  | 'anyway'
  | 'ialt'
  | 'ieta'
  | 'icancel'
  | 'iprob'
  | 'iarr'
  | 'invpaid'
  | 'came'
  | 'rcpt'
  | 'qr'
  | 'handed'
  | 'noshow'
  // admin only
  | 'manual_supplier_order'
  | 'supplier_return_accept'
  | 'supplier_return_reject'
  | 'stock_item'
  | 'refund_payment'
  | 'retry_refund';

/** A button for the bot card or the admin page. */
export interface StaffActionView {
  code: StaffActionCode;
  label: string;
  /** Set for item actions (ialt, ieta, icancel, iprob, iarr). */
  itemId?: string;
  enabled: boolean;
  /** «Ждём чек», «Сначала „Клиент пришёл“» ... */
  disabledReason?: string | null;
}

export interface StaffActionInput {
  /** ialt: the chosen alternative (from recheck_result). */
  alternative?: RecheckAlternative;
  /** ialt / ieta: a ready proposal (admin may build it by hand). */
  proposal?: ApprovalProposal;
  /** ieta: the new date. */
  etaDate?: IsoDate;
  /** iprob */
  problem?: ItemProblem;
  /** invpaid: number and date of the payment order. */
  paymentRef?: string;
  /** manual_supplier_order: Rossko order numbers. */
  rosskoOrderIds?: string[];
  /** supplier_return_accept / reject, stock_item. */
  supplierReturnId?: string;
  amountKop?: Kop;
  /** refund_payment (owner, required), overrides. */
  reason?: string;
  /** refund_payment: payments.id. */
  paymentId?: string;
  /** retry_refund: one failed refunds.id (default: every refund that can be retried). */
  refundId?: string;
  /** Free text without PD. */
  note?: string;
}

export interface StaffActionResult {
  ok: boolean;
  /** Short Russian text for answerCallbackQuery / the admin flash message. */
  message: string;
  orderId: string;
  /** Menu to show instead of the main keyboard (ialt, ieta, iprob). */
  menu?: StaffActionView[];
}

/** Client actions on /o/<token>; the web checks the token and the 4 phone digits (Б24). */
export type ClientAction =
  'confirm' | 'approve' | 'refund_request' | 'refuse' | 'prepay_now' | 'item_cancel';

// ---------------------------------------------------------------------------------------------
// Payments, refunds, receipts
// ---------------------------------------------------------------------------------------------

export type PreparePaymentResult =
  /** A live pending payment with its link: redirect to it. */
  | { kind: 'reuse'; confirmationUrl: string }
  /** Call createPayment with this request (same Idempotence-Key on retry), then recordPaymentCreated. */
  | { kind: 'create'; paymentRowId: string; request: CreatePaymentRequest }
  | { kind: 'unavailable'; reason: string };

export type ProviderObjectSource = 'webhook' | 'reconciliation' | 'housekeeping' | 'web';

/** A final provider error of a receipt attempt (no PD). */
export interface ReceiptAttemptError {
  error: { code: string | null; message: string; final: boolean };
}

/**
 * ProviderPayment as the engine reads it. The wave 2 fields (section 6.1) are read defensively:
 * absent means "not reported" (RUB, no paid_at, no reason), and the currency is widened to a
 * string so that a non-RUB object (rejected by the YooKassa parser) still never matches a total.
 */
export type ProviderPaymentLike = Omit<
  ProviderPayment,
  | 'currency'
  | 'paidAt'
  | 'cancellationReason'
  | 'cancellationParty'
  | 'receiptRegistration'
  | 'refundedAmountKop'
> & {
  currency?: string | null;
  paidAt?: string | null;
  cancellationReason?: string | null;
  cancellationParty?: string | null;
  receiptRegistration?: ProviderPayment['receiptRegistration'];
  refundedAmountKop?: ProviderPayment['refundedAmountKop'];
};
