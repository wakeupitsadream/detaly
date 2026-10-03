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
  handoverPaymentHeldOf,
  handoverPaymentsHeld,
  heldPayments,
  isLiveState,
  itemsAfterChanges,
  moneyHeldOf,
  paymentHeldOf,
  paymentRestKop,
  planItemChanges,
  refundablePayment,
  settlementReceiptSucceededOf,
} from './context';
export { applyTransition, persistTransition } from './engine';
export { canReachClient, enqueueNotify, enqueueOutbox, recordJournalEvent } from './journal';
export {
  createRefund,
  createRefundTask,
  EngineError,
  openRefundTasks,
  paymentsEnabled,
  planRefund,
  REFUND_DEADLINE_DAYS,
  REFUND_TASK_ERROR,
  retryableRefunds,
} from './rows';
export {
  applyPaymentObject,
  applyReceiptObject,
  applyRefundObject,
  preparePayment,
  recordPaymentCreated,
  recordPaymentRejected,
  REJECTED_REASON_PREFIX,
  SUPERSEDED_REASON,
} from './payments';
export {
  availableStaffActions,
  availableStaffActions1C,
  ETA_MENU_DAYS,
  failureMessage,
  loadStaffActions,
  loadStaffActions1C,
  ORDER_STATUS_LABELS,
  performClientAction,
  performStaffAction,
} from './actions';
// phase 1C (docs/phase-1c-implementation.md section 5.1)
export {
  bindMessenger,
  consumeLinkToken,
  createLinkToken,
  findBindingUser,
  isLinkToken,
  messengerStatus,
  setMessengerBlocked,
} from './links';
export {
  bookingSlot,
  bookInstall,
  cancelInstall,
  decideInstall,
  INSTALL_OPTIONS,
  installSlotsForOrder,
  loadBookingsView,
  loadInstallLoad,
  snapshotFromBookings,
} from './install';
export {
  acceptClaimReturn,
  closeClaim,
  decideClaim,
  isOrderFileKey,
  loadClaimsView,
  openClaim,
  recordClaimCompensation,
  REPLACEMENT_TASK_NOTE,
} from './claims';
export { addOrderPhoto, loadOrderPhotos } from './photos';
