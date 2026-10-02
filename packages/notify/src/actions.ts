/**
 * Short action codes used in buttons. Telegram callback_data is limited to 64 bytes and holds
 * `a:<action>:<orderId>:<nonce>`, so codes stay short; each maps to an order event.
 */
import type { OrderEvent } from '@detaly/domain';

export const CALLBACK_ACTIONS = {
  // client
  confirm: 'client_confirmed',
  approve: 'client_approved',
  refund: 'client_refund_requested',
  // staff
  recheck: 'supplier_order_requested',
  cancel: 'order_cancelled',
  refused: 'client_refused',
  alt: 'alternative_proposed',
  neweta: 'new_eta_proposed',
  anyway: 'order_anyway',
  invpaid: 'supplier_invoice_paid',
  came: 'client_arrived',
  qr: 'handover_payment_requested',
  handed: 'handed_over',
} as const satisfies Record<string, OrderEvent>;

export type CallbackAction = keyof typeof CALLBACK_ACTIONS;

export function isCallbackAction(value: string): value is CallbackAction {
  return Object.hasOwn(CALLBACK_ACTIONS, value);
}

export function eventForAction(action: string): OrderEvent | null {
  return isCallbackAction(action) ? CALLBACK_ACTIONS[action] : null;
}
