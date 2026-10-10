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
  DELAY_WHOLE_ORDER_ONLY,
  isOrderFileKey,
  loadClaimsView,
  openClaim,
  orderClaimReplacement,
  recordClaimCompensation,
  REPLACEMENT_NOT_ORDERED,
  REPLACEMENT_TASK_NOTE,
  supplierReturnTaskNote,
} from './claims';
export { addOrderPhoto, loadOrderPhotos } from './photos';
// step 6 (docs/garage.md): «Моя машина», the client's cars
export {
  deleteUserVehicle,
  GARAGE_ORDERS_PER_VEHICLE,
  GARAGE_VEHICLES_SHOWN,
  loadGarage,
  loadOrderVehicle,
  loadUserVehicle,
  loadUserVehicles,
  recordHandoverMileage,
  saveUserVehicle,
  type GarageOrderView,
  type GarageVehicleView,
  type HandoverMileageResult,
  type SavedVehicle,
  type VehicleRow,
} from './vehicles';
// step 7 (docs/month-close.md): supplier returns to the end, the stock, the month close
export {
  listStockItems,
  listSupplierReturns,
  loadOrderSupplierReturns,
  loadSupplierReturnActions,
  markSupplierReturnRefunded,
  rejectSupplierReturn,
  shipSupplierReturn,
  sortSupplierReturns,
  STOCK_REASON_NOT_ACCEPTED,
  stockReasonLabel,
  SUPPLIER_REFUND_MAX_KOP,
  SUPPLIER_RETURN_KIND_LABELS,
  SUPPLIER_RETURN_STATUS_LABELS,
  supplierReturnActions,
  supplierReturnTitle,
  supplierReturnUrgency,
  writeOffStockItem,
  type StockItemView,
  type SupplierReturnUrgency,
  type SupplierReturnView,
} from './supplier-returns';
export {
  loadFinanceSettings,
  loadLatestReconciliation,
  loadMonthReport,
  parseReconciliationResult,
  providerErrorText,
  reconciliationDifferenceCount,
  runMonthReconciliation,
  type FinanceSettings,
  type MoneyGroup,
  type MonthAct,
  type MonthReport,
  type MonthRevenue,
  type ReconciliationResult,
  type ReconciliationSnapshot,
} from './finance';
