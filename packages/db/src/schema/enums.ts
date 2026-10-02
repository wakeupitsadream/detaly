// pgEnum types built from the contract tuples in @detaly/domain/statuses.
// Never reorder values there: appending a value requires a migration (ALTER TYPE ... ADD VALUE).
import { pgEnum } from 'drizzle-orm/pg-core';
import {
  ACTOR_TYPES,
  API_CALL_SOURCES,
  APPROVAL_DECISIONS,
  APPROVAL_KINDS,
  CART_STATUSES,
  CLAIM_DECISIONS,
  CLAIM_KINDS,
  CONSENT_CHANNELS,
  CONSENT_KINDS,
  DOCUMENT_KINDS,
  EXCLUDED_KINDS,
  FULFILLMENTS,
  INSTALL_BOOKING_STATUSES,
  MESSENGER_CHANNELS,
  NOTIFICATION_CHANNELS,
  NOTIFICATION_STATUSES,
  ORDER_ITEM_STATES,
  ORDER_STATUSES,
  PAYMENT_KINDS,
  PAYMENT_PROVIDERS,
  PAYMENT_SCHEMES,
  PAYMENT_STATUSES,
  PHOTO_KINDS,
  RECEIPT_KINDS,
  RECEIPT_STATUSES,
  REFUND_REASONS,
  REFUND_SCOPES,
  REFUND_STATUSES,
  STAFF_ROLES,
  SUPPLIER_ORDER_STATUSES,
  SUPPLIER_RETURN_KINDS,
  SUPPLIER_RETURN_STATUSES,
  VIN_PROVIDERS,
  VIN_REQUEST_STATUSES,
  WEBHOOK_SOURCES,
} from '@detaly/domain/statuses';

// Orders
export const orderStatus = pgEnum('order_status', ORDER_STATUSES);
export const orderItemState = pgEnum('order_item_state', ORDER_ITEM_STATES);
export const paymentScheme = pgEnum('payment_scheme', PAYMENT_SCHEMES);
export const fulfillment = pgEnum('fulfillment', FULFILLMENTS);
export const actorType = pgEnum('actor_type', ACTOR_TYPES);

// Money
export const paymentProvider = pgEnum('payment_provider', PAYMENT_PROVIDERS);
export const paymentKind = pgEnum('payment_kind', PAYMENT_KINDS);
export const paymentStatus = pgEnum('payment_status', PAYMENT_STATUSES);
export const receiptKind = pgEnum('receipt_kind', RECEIPT_KINDS);
export const receiptStatus = pgEnum('receipt_status', RECEIPT_STATUSES);
export const refundReason = pgEnum('refund_reason', REFUND_REASONS);
export const refundStatus = pgEnum('refund_status', REFUND_STATUSES);
/** Phase 1B (decision Б11): whole order, one item, or an orphan payment. */
export const refundScope = pgEnum('refund_scope', REFUND_SCOPES);

// Supplier
export const supplierOrderStatus = pgEnum('supplier_order_status', SUPPLIER_ORDER_STATUSES);
export const supplierReturnKind = pgEnum('supplier_return_kind', SUPPLIER_RETURN_KINDS);
export const supplierReturnStatus = pgEnum('supplier_return_status', SUPPLIER_RETURN_STATUSES);

// Claims and VIN
export const claimKind = pgEnum('claim_kind', CLAIM_KINDS);
export const claimDecision = pgEnum('claim_decision', CLAIM_DECISIONS);
export const vinRequestStatus = pgEnum('vin_request_status', VIN_REQUEST_STATUSES);
export const vinProvider = pgEnum('vin_provider', VIN_PROVIDERS);

// Client approvals (phase 1B, decision Б16)
export const approvalKind = pgEnum('approval_kind', APPROVAL_KINDS);
export const approvalDecision = pgEnum('approval_decision', APPROVAL_DECISIONS);

// Legal
export const documentKind = pgEnum('document_kind', DOCUMENT_KINDS);
export const consentKind = pgEnum('consent_kind', CONSENT_KINDS);
export const consentChannel = pgEnum('consent_channel', CONSENT_CHANNELS);

// Messaging
export const messengerChannel = pgEnum('messenger_channel', MESSENGER_CHANNELS);
export const notificationChannel = pgEnum('notification_channel', NOTIFICATION_CHANNELS);
export const notificationStatus = pgEnum('notification_status', NOTIFICATION_STATUSES);

// Misc
export const staffRole = pgEnum('staff_role', STAFF_ROLES);
export const cartStatus = pgEnum('cart_status', CART_STATUSES);
export const installBookingStatus = pgEnum('install_booking_status', INSTALL_BOOKING_STATUSES);
export const photoKind = pgEnum('photo_kind', PHOTO_KINDS);
export const excludedKind = pgEnum('excluded_kind', EXCLUDED_KINDS);
export const webhookSource = pgEnum('webhook_source', WEBHOOK_SOURCES);
export const apiCallSource = pgEnum('api_call_source', API_CALL_SOURCES);
