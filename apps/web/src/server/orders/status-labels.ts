/**
 * Order statuses in words a client understands (docs/phase-1a-implementation.md 7.1). Every
 * one of the 17 statuses has a label: 1A reaches only awaiting_payment, awaiting_confirmation
 * and cancelled, the rest are ready for 1B/1C.
 */
import {
  CLIENT_ORDER_STATUS_LABELS,
  isOneOf,
  ORDER_STATUSES,
  type OrderStatus,
} from '@detaly/domain';

/** The client wording lives in @detaly/domain, shared with the client bot. */
export const ORDER_STATUS_LABELS: Readonly<Record<OrderStatus, string>> =
  CLIENT_ORDER_STATUS_LABELS;

/** Colour of the status badge. */
export type StatusTone = 'wait' | 'progress' | 'success' | 'stopped';

const TONES: Readonly<Record<OrderStatus, StatusTone>> = {
  draft: 'wait',
  awaiting_payment: 'wait',
  awaiting_confirmation: 'wait',
  confirmed: 'progress',
  ordering: 'progress',
  awaiting_supplier_invoice: 'progress',
  ordered_at_supplier: 'progress',
  needs_attention: 'wait',
  awaiting_client_approval: 'wait',
  ready: 'success',
  out_for_delivery: 'progress',
  awaiting_handover_payment: 'wait',
  handed: 'success',
  completed: 'success',
  cancelled: 'stopped',
  refund_pending: 'stopped',
  refunded: 'stopped',
};

/** Label of a status; an unexpected value (e.g. a newer enum value) is shown as is. */
export function orderStatusLabel(status: string): string {
  return isOneOf(ORDER_STATUSES, status) ? ORDER_STATUS_LABELS[status] : status;
}

export function orderStatusTone(status: OrderStatus): StatusTone {
  return TONES[status];
}

/** Statuses at which the pickup code is shown (decision Д13: from `ready` on, at the counter). */
export const PICKUP_CODE_STATUSES = [
  'ready',
  'awaiting_handover_payment',
] as const satisfies readonly OrderStatus[];

/** The order is over for the client: no promise date, no messenger buttons. */
export const CLOSED_STATUSES = [
  'handed',
  'completed',
  'cancelled',
  'refund_pending',
  'refunded',
] as const satisfies readonly OrderStatus[];
