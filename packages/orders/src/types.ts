/**
 * Types of @detaly/orders (docs/phase-1b-implementation.md section 5.1). The contract was fixed
 * by the foundation (wave 1); wave 2 only adds optional fields.
 */
import type { Env } from '@detaly/config';
import type {
  claims,
  clientApprovals,
  Database,
  Executor,
  installBookings,
  orderItems,
  orderPhotos,
  orders,
  payments,
  receipts,
  refunds,
  supplierOrders,
} from '@detaly/db';
import type {
  ActorType,
  ApprovalProposal,
  ClaimDecidedVia,
  ClaimDecision,
  ClaimKind,
  ClaimOpenedVia,
  EtaSettings,
  InstallBookingStatus,
  InstallCreatedVia,
  InstallSlot,
  IsoDate,
  Kop,
  OrderEvent,
  OrderItemState,
  OrderStatus,
  PhotoKind,
  PricingConfig,
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
export type ClaimRow = typeof claims.$inferSelect;
export type InstallBookingRow = typeof installBookings.$inferSelect;
export type OrderPhotoRow = typeof orderPhotos.$inferSelect;

/**
 * A claim as the engine sees it (OrderSnapshot.claims): ids, kind, dates and decision, never the
 * client's text, the answer or the owner's reason (they may hold PD).
 */
export interface ClaimSummary {
  id: string;
  orderItemId: string | null;
  kind: ClaimKind;
  openedAt: Date;
  deadlineAt: Date;
  decision: ClaimDecision | null;
  decidedAt: Date | null;
  returnAcceptedAt: Date | null;
  compensationAmountKop: Kop | null;
  refundId: string | null;
  closedAt: Date | null;
  /** «Замена заказана» of a replace decision (the replacement items were written). */
  replacementOrderedAt: Date | null;
  /** Photos the client attached (the keys stay in the read models). */
  photoCount: number;
}

/** An installation booking as the engine sees it (OrderSnapshot.bookings). No price anywhere. */
export interface BookingSummary {
  id: string;
  slotAt: Date;
  status: InstallBookingStatus;
  createdVia: string | null;
  confirmedAt: Date | null;
  cancelledAt: Date | null;
}

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
  /** Claims of the order, open and closed, oldest first (phase 1C; no texts). */
  claims: ClaimSummary[];
  /** Installation bookings of the order, oldest first (phase 1C). */
  bookings: BookingSummary[];
}

/** Settings the engine uses: `settings` rows over env defaults (settingsDefaultsFromEnv). */
export interface OrderSettings {
  /**
   * Base markup table, group adjustments, floor and ceiling (resolvePricingConfig): the same
   * values web prices search, cart and checkout with (docs/pricing.md).
   */
  pricing: PricingConfig;
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
  /** reviews.reminder_days: the review reminder after `completed`; 0 = off (docs/reviews.md). */
  reviewReminderDays: number;
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
  /**
   * The claim a refund decision is about (claim_refund_approved, client_refused of a delay
   * claim): create_refund takes the reason from claimKind, requested_at from claimOpenedAt and
   * writes claims.refund_id.
   */
  claimId?: string | null;
  /** claims.opened_at (ISO): the 10 days of art. 22 run from the client's request. */
  claimOpenedAt?: string | null;
  /** claim_opened: the claims row the effect open_claim inserts (never journaled: PD). */
  claim?: ClaimDraft;
};

/** What effect open_claim writes into claims (decision С7). */
export interface ClaimDraft {
  /** Pre-generated claims.id (uuid v7). */
  id: string;
  kind: ClaimKind;
  orderItemId: string | null;
  /** The client's description (≤ CLAIM_TEXT_MAX); may contain PD, never journaled. */
  clientText: string | null;
  /** FileStore keys claim/<order id>/<uuid>.jpg (≤ CLAIM_PHOTOS_MAX). */
  photos: string[];
  openedVia: ClaimOpenedVia;
  requestKey: string;
}

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

/**
 * Phase 1C buttons (docs/phase-1c-implementation.md section 5.2): claims, bookings, the packaging
 * photo. A separate union: the 1B exhaustive switches of the bot and the admin keep compiling
 * until they handle these (availableStaffActions1C lists them; performStaffAction takes both).
 */
export type StaffActionCode1C = ClaimStaffActionCode | BookingStaffActionCode | 'pphoto';

/** Every staff action code performStaffAction accepts. */
export type AnyStaffActionCode = StaffActionCode | StaffActionCode1C;

/**
 * Claim buttons; the target id is claims.id: «Принял возврат» (cret, with a photo), the decision
 * refund / replace / reject (cref, crepl, crej, with the answer text) and «Замена выдана» (cclose).
 */
export type ClaimStaffActionCode = 'cret' | 'cref' | 'crepl' | 'crej' | 'cclose';

/** Booking buttons; the target id is install_bookings.id. */
export type BookingStaffActionCode = 'bconf' | 'bdecl' | 'bdone' | 'bnoshow';

/** A button for the bot card or the admin page. */
export interface StaffActionView {
  code: StaffActionCode;
  label: string;
  /** Set for item actions (ialt, ieta, icancel, iprob, iarr). */
  itemId?: string;
  /** Set for claim actions (cret, cref, crepl, crej, cclose). */
  claimId?: string;
  /** Set for booking actions (bconf, bdecl, bdone, bnoshow). */
  bookingId?: string;
  enabled: boolean;
  /** «Ждём чек», «Сначала „Клиент пришёл“» ... */
  disabledReason?: string | null;
  /**
   * cref of the owner without «Принял возврат»: the press must ask for the override reason
   * first (StaffActionInput.reason), then for the answer text.
   */
  needsReason?: boolean;
}

/** A phase 1C button (availableStaffActions1C): a claim, a booking or the packaging photo. */
export type StaffActionView1C = Omit<StaffActionView, 'code'> & { code: StaffActionCode1C };

export type AnyStaffActionView = StaffActionView | StaffActionView1C;

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
  /** cref / crepl / crej: the answer to the client (1..2000 characters, shown on /o only). */
  text?: string;
  /** cret / pphoto: the FileStore key of the uploaded photo (order/<order id>/<uuid>.jpg). */
  photoKey?: string;
  /** pphoto: packaging (default) or handover. */
  photoKind?: 'packaging' | 'handover';
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

// ---------------------------------------------------------------------------------------------
// Phase 1C: messenger links, installation bookings, claims, photos (section 5.1)
// ---------------------------------------------------------------------------------------------

/** What /o/<token> shows next to «Статусы в Telegram» (MAX bindings come in phase 2). */
export interface MessengerStatus {
  telegram: 'none' | 'active' | 'blocked';
  max: 'none';
}

/** Why installSlotsForOrder has no slots. */
export type InstallSlotsReason =
  /** The order status does not allow a booking (INSTALL_BOOKABLE_STATUSES). */
  | 'status'
  /** The part has no pickup date yet (orders.promised_date). */
  | 'no_date'
  /** PICKUP_HOURS was not understood. */
  | 'no_hours'
  /** The order already has an active booking. */
  | 'booked'
  /** Every lift is taken within the horizon. */
  | 'full';

export interface InstallSlotsResult {
  slots: InstallSlot[];
  reason?: InstallSlotsReason;
}

export type BookInstallResult =
  | { ok: true; bookingId: string; slot: InstallSlot; duplicate: boolean }
  | { ok: false; reason: 'slot_taken' | 'not_allowed' | 'already_booked' | 'bad_slot' };

export type CancelInstallResult =
  | { ok: true; bookingId: string; orderId: string }
  | { ok: false; reason: 'not_found' | 'not_allowed' | 'too_late' | 'closed'; message: string };

export type InstallDecision = 'confirm' | 'decline' | 'done' | 'no_show';

/** A staff member acting through the bot or the admin (admin: id null, role owner). */
export interface StaffRef {
  id: string | null;
  role: StaffRole;
  via: 'bot' | 'admin';
}

export type OpenClaimResult =
  | { ok: true; claimId: string; orderId: string; deadlineAt: Date; duplicate: boolean }
  | {
      ok: false;
      reason:
        | 'not_found'
        | 'bad_input'
        | 'kind_unavailable'
        | 'already_open'
        | 'not_allowed'
        | 'guard_failed';
      /** Russian text for the form / the admin flash message. */
      message: string;
      /** claimKindsAvailable now (kind_unavailable). */
      kinds?: ClaimKind[];
    };

/** Result of the claim, booking and photo services (the shape of performStaffAction). */
export type ServiceResult = StaffActionResult & {
  /** order_photos.id written by the action (cret, pphoto). */
  photoId?: string;
};

/** A claim for the admin, /o/<token> and the bot card (loadClaimsView). */
export interface ClaimView extends ClaimSummary {
  orderId: string;
  /** Brand and article of the claimed item; null for the whole order. */
  item: { id: string; brand: string; article: string } | null;
  openedVia: ClaimOpenedVia | null;
  decidedVia: ClaimDecidedVia | null;
  /** Photos of the client (FileStore keys): the admin shows them, the bot only their number. */
  photos: string[];
  /** order_photos of the returned part (kind return). */
  returnPhotos: { id: string; key: string; createdAt: Date }[];
  /**
   * The client's text, the answer, the owner's reason and the replacement note: filled only
   * with `{ texts: true }` (admin, /o/<token>); null otherwise (bot cards, Telegram).
   */
  clientText: string | null;
  decisionText: string | null;
  overrideReason: string | null;
  replacementNote: string | null;
  /** closed_at is null. */
  open: boolean;
}

/** A booking for the admin, /o/<token> and the bot (loadBookingsView). No price. */
export interface BookingView extends BookingSummary {
  orderId: string;
  slot: InstallSlot;
  staffNote: string | null;
  createdAt: Date;
  /** requested or confirmed: it holds a lift. */
  active: boolean;
  /** The client may cancel it by themselves until this instant (slot - 2 h). */
  clientCancelUntil: Date;
}

export interface OrderPhotoView {
  id: string;
  kind: PhotoKind;
  key: string;
  claimId: string | null;
  orderItemId: string | null;
  createdAt: Date;
}

export type { InstallCreatedVia };
