/**
 * Contract file (step 0): every enum used by the database (pgEnum), the state machine,
 * workers and UI is declared here once, as a readonly tuple plus its union type.
 *
 * Rules:
 * - Values are stable identifiers stored in the database. Never rename or reorder them;
 *   appending a value requires a migration (`ALTER TYPE ... ADD VALUE`).
 * - This module is pure (no imports) so drizzle-kit, Next.js and the worker can import it
 *   through the `@detaly/domain/statuses` subpath without pulling anything else.
 * - Source of truth: docs/PLAN.md sections 2-3 and docs/phase0-implementation.md section 3.
 */

/** Narrowing helper for any enum tuple declared below. */
export function isOneOf<const T extends readonly string[]>(
  values: T,
  value: unknown,
): value is T[number] {
  return typeof value === 'string' && (values as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// Orders
// ---------------------------------------------------------------------------

/**
 * Order status (17 values, PLAN section 3).
 * - awaiting_payment: prepay scheme, payment link issued.
 * - awaiting_confirmation: pay_on_handover scheme, client must confirm.
 * - awaiting_supplier_invoice: Rossko ships only after its invoice is paid
 *   (settings `rossko.prepay_invoice = true`).
 * - out_for_delivery: courier, prepay only (phase 2, declared from day one).
 * - awaiting_handover_payment: pay_on_handover, QR shown at the pickup point.
 */
export const ORDER_STATUSES = [
  'draft',
  'awaiting_payment',
  'awaiting_confirmation',
  'confirmed',
  'ordering',
  'awaiting_supplier_invoice',
  'ordered_at_supplier',
  'needs_attention',
  'awaiting_client_approval',
  'ready',
  'out_for_delivery',
  'awaiting_handover_payment',
  'handed',
  'completed',
  'cancelled',
  'refund_pending',
  'refunded',
] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

/** Statuses with no outgoing transitions. */
export const TERMINAL_ORDER_STATUSES = ['refunded'] as const satisfies readonly OrderStatus[];

/** Per-item state (10 values). An order is `ready` when every live item is `arrived`. */
export const ORDER_ITEM_STATES = [
  'pending',
  'ordered',
  'failed',
  'replaced',
  'arrived',
  'handed',
  'return_requested',
  'returned',
  'refund_pending',
  'refunded',
] as const;
export type OrderItemState = (typeof ORDER_ITEM_STATES)[number];

/** Item states that no longer belong to the order: not bought, replaced, money returned. */
export const DROPPED_ORDER_ITEM_STATES = [
  'failed',
  'replaced',
  'refund_pending',
  'refunded',
] as const satisfies readonly OrderItemState[];

/**
 * TransitionContext.allLiveItemsArrived from the order's item states: every live item is at
 * the point (`arrived`, or already `handed`). An order without live items has nothing at the
 * point: false.
 */
export function liveItemsAllArrived(states: readonly OrderItemState[]): boolean {
  const dropped: readonly OrderItemState[] = DROPPED_ORDER_ITEM_STATES;
  const live = states.filter((state) => !dropped.includes(state));
  return live.length > 0 && live.every((state) => state === 'arrived' || state === 'handed');
}

/** prepay: 100% online prepayment (two receipts); pay_on_handover: pay at the pickup point. */
export const PAYMENT_SCHEMES = ['prepay', 'pay_on_handover'] as const;
export type PaymentScheme = (typeof PAYMENT_SCHEMES)[number];

export const FULFILLMENTS = ['pickup', 'courier'] as const;
export type Fulfillment = (typeof FULFILLMENTS)[number];

/** Who caused an order event / transition. */
export const ACTOR_TYPES = ['client', 'staff', 'system', 'webhook'] as const;
export type ActorType = (typeof ACTOR_TYPES)[number];

// ---------------------------------------------------------------------------
// Payments, receipts, refunds (YooKassa API v3 vocabulary where it applies)
// ---------------------------------------------------------------------------

export const PAYMENT_PROVIDERS = ['yookassa'] as const;
export type PaymentProviderName = (typeof PAYMENT_PROVIDERS)[number];

/** prepayment: online prepay (receipt "full_prepayment"); full: payment at handover ("full_payment"). */
export const PAYMENT_KINDS = ['prepayment', 'full'] as const;
export type PaymentKind = (typeof PAYMENT_KINDS)[number];

/** Mirrors YooKassa payment.status. We always use capture=true, so waiting_for_capture is transient. */
export const PAYMENT_STATUSES = [
  'pending',
  'waiting_for_capture',
  'succeeded',
  'canceled',
] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

/**
 * Receipt kinds (54-FZ), 6 values:
 * - prepayment: "предоплата 100%" sent with the prepay payment;
 * - full: full settlement sent with a pay_on_handover payment;
 * - offset: full settlement with prepayment offset (POST /receipts at handover);
 * - refund_prepayment / refund_full: refund receipts mirroring the original settlement sign;
 * - correction: correction receipt (only if supported by the receipt provider).
 */
export const RECEIPT_KINDS = [
  'prepayment',
  'full',
  'offset',
  'refund_prepayment',
  'refund_full',
  'correction',
] as const;
export type ReceiptKind = (typeof RECEIPT_KINDS)[number];

/** Mirrors YooKassa receipt.status. A row is inserted as `pending` before the provider call. */
export const RECEIPT_STATUSES = ['pending', 'succeeded', 'canceled'] as const;
export type ReceiptStatus = (typeof RECEIPT_STATUSES)[number];

/**
 * Refund reasons. The first six come from PLAN section 2; the last three cover PLAN section 3
 * branches that have no matching reason there:
 * - late_payment: payment.succeeded arrived for an already cancelled order;
 * - amount_mismatch: paid amount differs from orders.total and the owner refunds it;
 * - other: owner override, the reason text goes to order_events.
 */
export const REFUND_REASONS = [
  'refusal',
  'not_fit',
  'defect',
  'supplier_fail',
  'no_show',
  'delay',
  'late_payment',
  'amount_mismatch',
  'other',
] as const;
export type RefundReason = (typeof REFUND_REASONS)[number];

/** failed triggers an alert; the 10-day legal deadline keeps running. */
export const REFUND_STATUSES = ['pending', 'succeeded', 'failed'] as const;
export type RefundStatus = (typeof REFUND_STATUSES)[number];

// ---------------------------------------------------------------------------
// Supplier (Rossko)
// ---------------------------------------------------------------------------

/** The row is created as `sending` before GetCheckout (double-submit protection). */
export const SUPPLIER_ORDER_STATUSES = ['sending', 'created', 'failed'] as const;
export type SupplierOrderStatus = (typeof SUPPLIER_ORDER_STATUSES)[number];

export const SUPPLIER_RETURN_KINDS = ['return', 'claim'] as const;
export type SupplierReturnKind = (typeof SUPPLIER_RETURN_KINDS)[number];

export const SUPPLIER_RETURN_STATUSES = ['requested', 'accepted', 'rejected', 'refunded'] as const;
export type SupplierReturnStatus = (typeof SUPPLIER_RETURN_STATUSES)[number];

// ---------------------------------------------------------------------------
// Claims and VIN requests
// ---------------------------------------------------------------------------

export const CLAIM_KINDS = ['refusal', 'not_fit', 'defect', 'delay'] as const;
export type ClaimKind = (typeof CLAIM_KINDS)[number];

export const CLAIM_DECISIONS = ['refund', 'replace', 'reject'] as const;
export type ClaimDecision = (typeof CLAIM_DECISIONS)[number];

export const VIN_REQUEST_STATUSES = ['new', 'in_work', 'offered', 'converted', 'closed'] as const;
export type VinRequestStatus = (typeof VIN_REQUEST_STATUSES)[number];

/** Which resolver produced a VIN proposal (VIN_PROVIDER env). */
export const VIN_PROVIDERS = ['manual', 'laximo', 'acat', 'partsapi'] as const;
export type VinProvider = (typeof VIN_PROVIDERS)[number];

// ---------------------------------------------------------------------------
// Legal documents and consents (152-FZ)
// ---------------------------------------------------------------------------

/** Each kind lives in content/legal/<kind>/<version>.md. */
export const DOCUMENT_KINDS = [
  'offer',
  'privacy',
  'consent_pd',
  'consent_marketing',
  'return_memo',
] as const;
export type DocumentKind = (typeof DOCUMENT_KINDS)[number];

export const CONSENT_KINDS = ['pd', 'marketing'] as const;
export type ConsentKind = (typeof CONSENT_KINDS)[number];

/** Where the consent was given. */
export const CONSENT_CHANNELS = ['web', 'telegram', 'max', 'admin'] as const;
export type ConsentChannel = (typeof CONSENT_CHANNELS)[number];

// ---------------------------------------------------------------------------
// Messaging and notifications
// ---------------------------------------------------------------------------

export const MESSENGER_CHANNELS = ['telegram', 'max'] as const;
export type MessengerChannel = (typeof MESSENGER_CHANNELS)[number];

/** Channel priority for clients: max, then telegram, then sms (allowlisted templates only). */
export const NOTIFICATION_CHANNELS = ['telegram', 'max', 'sms'] as const;
export type NotificationChannel = (typeof NOTIFICATION_CHANNELS)[number];

/** skipped: no channel available (fallback_reason says why); approval timers do not start. */
export const NOTIFICATION_STATUSES = ['queued', 'sent', 'failed', 'skipped'] as const;
export type NotificationStatus = (typeof NOTIFICATION_STATUSES)[number];

// ---------------------------------------------------------------------------
// Staff, carts, bookings, photos, catalogue filters, webhooks
// ---------------------------------------------------------------------------

export const STAFF_ROLES = ['owner', 'seller'] as const;
export type StaffRole = (typeof STAFF_ROLES)[number];

/**
 * active: being edited (client cart or seller proposal with proposal_token);
 * converted: turned into an order; abandoned: expired or replaced.
 */
export const CART_STATUSES = ['active', 'converted', 'abandoned'] as const;
export type CartStatus = (typeof CART_STATUSES)[number];

/** Installation is a Service56 service paid at the service; bookings carry no price. */
export const INSTALL_BOOKING_STATUSES = [
  'requested',
  'confirmed',
  'done',
  'cancelled',
  'no_show',
] as const;
export type InstallBookingStatus = (typeof INSTALL_BOOKING_STATUSES)[number];

export const PHOTO_KINDS = ['packaging', 'handover', 'return'] as const;
export type PhotoKind = (typeof PHOTO_KINDS)[number];

/** keyword: matched against the item name; group: matched against the supplier product group. */
export const EXCLUDED_KINDS = ['keyword', 'group'] as const;
export type ExcludedKind = (typeof EXCLUDED_KINDS)[number];

export const WEBHOOK_SOURCES = ['yookassa', 'max'] as const;
export type WebhookSource = (typeof WEBHOOK_SOURCES)[number];

/** api_calls.source */
export const API_CALL_SOURCES = ['rossko', 'yookassa', 'vin', 'sms', 'telegram', 'max'] as const;
export type ApiCallSource = (typeof API_CALL_SOURCES)[number];

/** Rossko search modes (ROSSKO_MODE env): fixtures work before API keys arrive. */
export const ROSSKO_MODES = ['fixtures', 'live'] as const;
export type RosskoMode = (typeof ROSSKO_MODES)[number];

// ---------------------------------------------------------------------------
// Phase 1B: receipts, payments, refunds, client approvals, webhooks
// ---------------------------------------------------------------------------

/**
 * 54-FZ settlement method of a receipt line ("признак способа расчёта"): full_prepayment for
 * the prepay payment and its refund, full_payment for payment at handover, the offset receipt
 * and refunds after it.
 */
export const PAYMENT_MODES = ['full_prepayment', 'full_payment'] as const;
export type PaymentMode = (typeof PAYMENT_MODES)[number];

/** Subject of a receipt line. Installation is never sold, so only goods and delivery exist. */
export const PAYMENT_SUBJECTS = ['commodity', 'service'] as const;
export type PaymentSubject = (typeof PAYMENT_SUBJECTS)[number];

/** payments.confirmation_type: redirect link on /o/<token>, or QR on the seller's screen. */
export const CONFIRMATION_TYPES = ['redirect', 'qr'] as const;
export type ConfirmationType = (typeof CONFIRMATION_TYPES)[number];

/**
 * refunds.scope (decision Б11): the whole order (-> refunded), one item (partial refund, the
 * order status stays) or an orphan payment (a payment of an already refunded order, journal
 * only). A pgEnum: append only.
 */
export const REFUND_SCOPES = ['order', 'item', 'orphan'] as const;
export type RefundScope = (typeof REFUND_SCOPES)[number];

/** client_approvals.kind (pgEnum approval_kind): an alternative at the client's price or a new date. */
export const APPROVAL_KINDS = ['alternative', 'new_eta'] as const;
export type ApprovalKind = (typeof APPROVAL_KINDS)[number];

/** client_approvals.decision (pgEnum approval_decision); timeout = no answer in approval.timeout_h. */
export const APPROVAL_DECISIONS = ['approved', 'refund', 'timeout'] as const;
export type ApprovalDecision = (typeof APPROVAL_DECISIONS)[number];

/** client_approvals.scope (text + check): the whole order or one item (order_item_id set). */
export const APPROVAL_SCOPES = ['order', 'item'] as const;
export type ApprovalScope = (typeof APPROVAL_SCOPES)[number];

/**
 * seller_cards.kind (text + check): an order card with action buttons, the handover QR, or a
 * VIN request card (phase 1C; the card then belongs to a vin_request instead of an order).
 */
export const SELLER_CARD_KINDS = ['order', 'qr', 'vin'] as const;
export type SellerCardKind = (typeof SELLER_CARD_KINDS)[number];

/**
 * webhook_events.result (a text column): what applying the re-read provider object did.
 * - duplicate: the object was already applied (no new transition);
 * - stale: the event is not about the order's current payment;
 * - pending: the object is not final yet;
 * - orphan_payment: a payment of an already refunded order (refunded back automatically);
 * - amount_mismatch: the paid amount differs from orders.total_kop (needs_attention);
 * - ignored: an event type the system does not act on.
 */
export const WEBHOOK_RESULTS = [
  'processed',
  'duplicate',
  'stale',
  'pending',
  'orphan_payment',
  'amount_mismatch',
  'ignored',
  'error',
] as const;
export type WebhookResult = (typeof WEBHOOK_RESULTS)[number];

// ---------------------------------------------------------------------------
// Phase 1C: claims, installation bookings, VIN requests, messenger links
// (docs/phase-1c-implementation.md sections 0 and 3.1)
// ---------------------------------------------------------------------------

/** claims.opened_via (text + check): the order page, the admin or the seller bot. */
export const CLAIM_OPENED_VIA = ['web', 'admin', 'bot'] as const;
export type ClaimOpenedVia = (typeof CLAIM_OPENED_VIA)[number];

/** claims.decided_via (text + check): a decision is made by staff in the bot or the admin. */
export const CLAIM_DECIDED_VIA = ['bot', 'admin'] as const;
export type ClaimDecidedVia = (typeof CLAIM_DECIDED_VIA)[number];

/** install_bookings.created_via (text + check). */
export const INSTALL_CREATED_VIA = ['web', 'bot', 'admin'] as const;
export type InstallCreatedVia = (typeof INSTALL_CREATED_VIA)[number];

/**
 * Order statuses in which the client may book an installation slot (decision С6): the order is
 * alive and the part is on its way, at the point or already handed.
 */
export const INSTALL_BOOKABLE_STATUSES = [
  'confirmed',
  'ordering',
  'awaiting_supplier_invoice',
  'ordered_at_supplier',
  'ready',
  'awaiting_handover_payment',
  'handed',
] as const satisfies readonly OrderStatus[];

/** Bookings that hold a lift (requested ones too: the master has not said no yet). */
export const INSTALL_HOLDING_STATUSES = [
  'requested',
  'confirmed',
] as const satisfies readonly InstallBookingStatus[];

/** VIN requests waiting for the master's answer (the 4-hour reminder looks at them). */
export const VIN_OPEN_STATUSES = ['new', 'in_work'] as const satisfies readonly VinRequestStatus[];

/** First segment of a FileStore key: whose photo it is. */
export const FILE_KEY_SCOPES = ['vin', 'claim', 'order'] as const;
export type FileKeyScope = (typeof FILE_KEY_SCOPES)[number];

/**
 * FileStore keys (@detaly/files) and order_photos.s3_key (CHECK): `<scope>/<owner uuid>/<uuid>.jpg`
 * with lower-case uuids. Nothing else is accepted, so a key can never walk out of its folder.
 */
export const FILE_KEY_PATTERN =
  '^(vin|claim|order)/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/' +
  '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\\.jpg$';

/** link_tokens.channel (pgEnum messenger_channel): MAX links come in phase 2. */
export const LINK_TOKEN_CHANNELS = MESSENGER_CHANNELS;
export type LinkTokenChannel = MessengerChannel;
