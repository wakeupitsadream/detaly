/**
 * @detaly/orders: the order engine (docs/phase-1b-implementation.md section 5). The only place
 * where orders.status changes: every transition goes through applyTransition / persistTransition
 * inside a transaction holding `select ... for update` on the order row, and writes its effects
 * (outbox rows, receipts, refunds, supplier orders) in the same transaction.
 *
 * No network: payment, receipt and supplier calls are made by the worker and web with the rows
 * this package prepares.
 *
 * Phase 1B wave 1 (foundation) ships the contract only: types and signatures of section 5.1.
 * Every function throws NOT_IMPLEMENTED until the `engine` package of wave 2 fills it in.
 */
import type { Env, OutboxQueue } from '@detaly/config';
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
  JournalEvent,
  Kop,
  MarkupRule,
  OrderEvent,
  OrderItemState,
  OrderNotifyTemplate,
  OrderStatus,
  PaymentKind,
  ReceiptStatus,
  RecheckAlternative,
  RefundReason,
  RefundScope,
  StaffRole,
  TransitionContext,
  TransitionEffect,
  TransitionRule,
  WebhookResult,
} from '@detaly/domain';
import type {
  CreatePaymentRequest,
  ProviderPayment,
  ProviderReceipt,
  ProviderRefund,
} from '@detaly/payments';

export const NOT_IMPLEMENTED = 'not implemented: phase 1B wave 2';

function notImplemented(): never {
  throw new Error(NOT_IMPLEMENTED);
}

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
};

/** How one event changes the order items (section 5.3). */
export type ItemChange =
  | {
      kind: 'state';
      itemId: string;
      to: OrderItemState;
      /** item_arrived */
      arrivedAt?: Date;
      /** GetCheckout itemErrors entry (the item stays pending). */
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

/** `settings` + env defaults; malformed values are ignored, as in web. */
export async function loadOrderSettings(_db: Executor, _env: Env): Promise<OrderSettings> {
  notImplemented();
}

/** Loads the order (`for update` with lock) and everything the decision needs. */
export async function loadOrderSnapshot(
  _tx: Tx,
  _orderId: string,
  _options: { lock: boolean },
): Promise<OrderSnapshot | null> {
  notImplemented();
}

/** Pure. Derives TransitionContext from the snapshot after `changes`; `facts` override. */
export function buildTransitionContext(
  _snapshot: OrderSnapshot,
  _actor: ActorRef,
  _facts: TransitionFacts,
  _settings: OrderSettings,
  _now: Date,
  _changes?: readonly ItemChange[],
): TransitionContext {
  notImplemented();
}

/** Pure. Item changes of an event (section 5.3). */
export function planItemChanges(
  _event: OrderEvent,
  _snapshot: OrderSnapshot,
  _facts: TransitionFacts & { itemId?: string | null },
): ItemChange[] {
  notImplemented();
}

/** Locks the order, resolves the transition and persists it with its effects; nudges after commit. */
export async function applyTransition(_deps: EngineDeps, _input: ApplyInput): Promise<ApplyResult> {
  notImplemented();
}

/**
 * The persisting half of applyTransition for callers that already hold the transaction and
 * the snapshot (checkout inserts the order and then persists `checkout`).
 */
export async function persistTransition(
  _tx: Tx,
  _snapshot: OrderSnapshot,
  _decision: TransitionDecision,
  _input: Omit<ApplyInput, 'tx'> & { deps: EngineDeps },
): Promise<AppliedTransition> {
  notImplemented();
}

/** A journal event (JOURNAL_EVENTS) without a status change; the caller holds the lock. */
export async function recordJournalEvent(
  _tx: Tx,
  _input: {
    orderId: string;
    type: JournalEvent;
    actor: ActorRef;
    payload?: Record<string, unknown>;
  },
): Promise<{ orderEventId: string }> {
  notImplemented();
}

/** `insert ... on conflict (job_id) do nothing returning`; false when the key was queued already. */
export async function enqueueOutbox(
  _tx: Tx,
  _input: {
    queue: OutboxQueue;
    name: string;
    /** Logical job key in PLAN format (outbox.job_id). */
    key: string;
    data?: Record<string, unknown>;
    availableAt?: Date;
  },
): Promise<boolean> {
  notImplemented();
}

/**
 * clientReachable (decision Б16): an unblocked messenger binding, or a phone with an enabled
 * SMS provider and the template in the SMS allowlist.
 */
export async function canReachClient(
  _tx: Tx,
  _orderId: string,
  _options: { smsEnabled: boolean; template: OrderNotifyTemplate },
): Promise<boolean> {
  notImplemented();
}

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
  | 'refund_payment';

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

/** Buttons for a staff member right now (bot card, admin page). */
export function availableStaffActions(
  _snapshot: OrderSnapshot,
  _role: StaffRole,
  _settings: OrderSettings,
  _now: Date,
): StaffActionView[] {
  notImplemented();
}

/** Translates an action code into an event and facts (or a non-transition action) and applies it. */
export async function performStaffAction(
  _deps: EngineDeps,
  _input: {
    staff: { id: string | null; role: StaffRole; via: 'bot' | 'admin' };
    action: StaffActionCode;
    /** Order id or item id depending on the action (table 13.2). */
    targetId: string;
    input?: StaffActionInput;
  },
): Promise<StaffActionResult> {
  notImplemented();
}

/** Client actions on /o/<token>; the web checks the token and the 4 phone digits (Б24). */
export type ClientAction =
  'confirm' | 'approve' | 'refund_request' | 'refuse' | 'prepay_now' | 'item_cancel';

export async function performClientAction(
  _deps: EngineDeps,
  _input: { orderId: string; userId: string; action: ClientAction; itemId?: string | null },
): Promise<ApplyResult> {
  notImplemented();
}

// ---------------------------------------------------------------------------------------------
// Payments, refunds, receipts
// ---------------------------------------------------------------------------------------------

export type PreparePaymentResult =
  /** A live pending payment with its link: redirect to it. */
  | { kind: 'reuse'; confirmationUrl: string }
  /** Call createPayment with this request (same Idempotence-Key on retry), then recordPaymentCreated. */
  | { kind: 'create'; paymentRowId: string; request: CreatePaymentRequest }
  | { kind: 'unavailable'; reason: string };

/**
 * Under the lock: awaiting_payment (prepayment) or awaiting_handover_payment (full); reuses a
 * live pending payment, repeats a pending one without provider id, or writes new payments and
 * receipts rows (decisions Б5–Б7).
 */
export async function preparePayment(
  _deps: EngineDeps,
  _input: {
    orderId: string;
    kind: PaymentKind;
    confirmation: 'redirect' | 'qr';
    returnUrl: string;
    tx?: Tx;
  },
): Promise<PreparePaymentResult> {
  notImplemented();
}

/** Stores the provider answer of POST /payments; journal `payment_created`. */
export async function recordPaymentCreated(
  _deps: EngineDeps,
  _paymentRowId: string,
  _providerPayment: ProviderPayment,
): Promise<void> {
  notImplemented();
}

export type ProviderObjectSource = 'webhook' | 'reconciliation' | 'housekeeping' | 'web';

/** Applies a payment object re-read from the provider (never a webhook body). */
export async function applyPaymentObject(
  _deps: EngineDeps,
  _providerPayment: ProviderPayment,
  _options: { source: ProviderObjectSource; webhookEventId?: string | null },
): Promise<{ result: WebhookResult; transition?: ApplyResult }> {
  notImplemented();
}

/** Applies a refund object re-read from the provider. */
export async function applyRefundObject(
  _deps: EngineDeps,
  _providerRefund: ProviderRefund,
  _options: { source: ProviderObjectSource; webhookEventId?: string | null },
): Promise<{ result: WebhookResult; transition?: ApplyResult }> {
  notImplemented();
}

/** A final provider error of a receipt attempt (no PD). */
export interface ReceiptAttemptError {
  error: { code: string | null; message: string; final: boolean };
}

/** Receipt status from the provider; succeeded -> journal receipt_succeeded, final error -> receipt_failed. */
export async function applyReceiptObject(
  _deps: EngineDeps,
  _receiptRowId: string,
  _result: ProviderReceipt | ReceiptAttemptError,
): Promise<{ status: ReceiptStatus; changed: boolean }> {
  notImplemented();
}

/**
 * refunds row (deadline_at = requested_at + 10 days, request) and its refund receipt, checked
 * with assertRefundWithinPayment; outbox payments/refund-create. The caller holds the lock.
 */
export async function createRefund(
  _tx: Tx,
  _snapshot: OrderSnapshot,
  _input: {
    scope: RefundScope;
    paymentId: string;
    reason: RefundReason;
    itemIds?: string[];
    requestedAt: Date;
  },
): Promise<{ refundId: string; receiptId: string; amountKop: Kop }> {
  notImplemented();
}
