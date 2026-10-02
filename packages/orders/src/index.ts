/**
 * @detaly/orders: the order engine (docs/phase-1b-implementation.md section 5). The only place
 * where orders.status changes: every transition goes through applyTransition / persistTransition
 * inside a transaction holding `select ... for update` on the order row, and writes its effects
 * (outbox rows, receipts, refunds, supplier orders) in the same transaction.
 *
 * No network: payment, receipt and supplier calls are made by the worker and web with the rows
 * this package prepares.
 */
export type * from './types';
export { loadOrderSettings, resolveOrderSettings } from './settings';
export { isUuid, loadClientPhone, loadOrderSnapshot } from './snapshot';
export {
  buildTransitionContext,
  heldPayments,
  isLiveState,
  itemsAfterChanges,
  moneyHeldOf,
  paymentHeldOf,
  planItemChanges,
  refundablePayment,
  settlementReceiptSucceededOf,
} from './context';
export { applyTransition, persistTransition } from './engine';
export { canReachClient, enqueueOutbox, recordJournalEvent } from './journal';
export {
  createRefund,
  EngineError,
  paymentsEnabled,
  planRefund,
  REFUND_DEADLINE_DAYS,
} from './rows';
export {
  applyPaymentObject,
  applyReceiptObject,
  applyRefundObject,
  preparePayment,
  recordPaymentCreated,
} from './payments';
export {
  availableStaffActions,
  ETA_MENU_DAYS,
  failureMessage,
  loadStaffActions,
  ORDER_STATUS_LABELS,
  performClientAction,
  performStaffAction,
} from './actions';
