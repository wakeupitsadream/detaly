/**
 * Staff actions (seller bot table 13.2 and admin-only actions) and client actions on /o/<token>.
 * Each action becomes an order event with facts (applyTransition) or, for actions that do not
 * change the status, rows written under the order row lock.
 */
import {
  and,
  claims,
  desc,
  eq,
  inArray,
  installBookings,
  orderEvents,
  orderItems,
  orders,
  stockItems,
  supplierOrderItems,
  supplierOrders,
  supplierReturns,
} from '@detaly/db';
import {
  addDays,
  type ApprovalProposal,
  CLAIM_KIND_LABELS,
  isIsoDate,
  localDate,
  REFUSABLE_STATUSES,
  resolveTransition,
  type OrderEvent,
  type OrderStatus,
  type RecheckAlternative,
  type RecheckItemResult,
  type StaffRole,
  type TransitionResult,
} from '@detaly/domain';
import {
  buildTransitionContext,
  handoverPaymentHeldOf,
  handoverPaymentsHeld,
  itemsAfterChanges,
  liveMarginBp,
  moneyHeldOf,
  planItemChanges,
  refundablePayment,
  settlementReceiptSucceededOf,
} from './context';
import { acceptClaimReturn, closeClaim, decideClaim, REPLACEMENT_NOT_ORDERED } from './claims';
import {
  markSupplierReturnRefunded,
  rejectSupplierReturn,
  shipSupplierReturn,
  supplierReturnOrderId,
} from './supplier-returns';
import { applyTransition, applyTransitionInTx, clock, nudge } from './engine';
import { bookingSlot, decideInstall } from './install';
import { addOrderPhoto } from './photos';
import { enqueueOutbox, recordJournalEvent } from './journal';
import {
  createRefund,
  EngineError,
  failedOrphanOf,
  paymentsEnabled,
  refundTargetOf,
  retryableRefunds,
} from './rows';
import { loadOrderSettings } from './settings';
import { isUuid, loadOrderSnapshot } from './snapshot';
import type {
  ActorRef,
  AnyStaffActionCode,
  ApplyResult,
  BookingStaffActionCode,
  ClaimStaffActionCode,
  ClaimSummary,
  ClientAction,
  InstallDecision,
  EngineDeps,
  ItemProblem,
  OrderSettings,
  OrderSnapshot,
  StaffActionInput,
  StaffActionResult,
  StaffActionView,
  StaffActionView1C,
  StaffRef,
  TransitionFacts,
  Tx,
} from './types';

/** Russian status names for staff messages. */
export const ORDER_STATUS_LABELS: Record<OrderStatus, string> = {
  draft: 'черновик',
  awaiting_payment: 'ждёт оплаты',
  awaiting_confirmation: 'ждёт подтверждения',
  confirmed: 'подтверждён',
  ordering: 'заказываем у Rossko',
  awaiting_supplier_invoice: 'ждёт оплаты счёта Rossko',
  ordered_at_supplier: 'заказан у Rossko',
  needs_attention: 'требует внимания',
  awaiting_client_approval: 'ждёт решения клиента',
  ready: 'готов к выдаче',
  out_for_delivery: 'у курьера',
  awaiting_handover_payment: 'ждёт оплаты на точке',
  handed: 'выдан',
  completed: 'завершён',
  cancelled: 'отменён',
  refund_pending: 'возврат денег',
  refunded: 'деньги возвращены',
};

/** Guard names -> what the seller sees. */
const GUARD_MESSAGES: Record<string, string> = {
  settlement_receipt_succeeded: 'Ждём чек',
  client_arrived: 'Сначала «Клиент пришёл»',
  client_reachable: 'Клиенту не доставить сообщение — позвоните ему',
  margin_floor: 'Маржа ниже порога',
  pickup_window_elapsed: 'Срок хранения ещё не истёк',
  live_items_remain: 'Это последняя позиция — отмените заказ целиком',
  owner: 'Только владелец',
  payment_succeeded: 'Ждём оплату',
  handover_payment_held: 'Ждём оплату',
  item: 'Позиция не найдена',
  item_state: 'Позиция в другом состоянии',
  proposal: 'Предложение не подходит: аналог — только по цене клиента, срок — не в прошлом',
  approval: 'Нет открытого вопроса клиенту',
  payments_disabled: 'Оплата не настроена (ЮKassa)',
  no_refundable_payment: 'Нет платежа для возврата',
  prepay_funded: 'Платёж клиента возвращён — заказывать не на что',
  no_prepayment: 'Нет предоплаты для чека зачёта',
  offset_exceeds_prepayment: 'Чек зачёта больше остатка предоплаты — проверьте возвраты в админке',
  no_phone: 'У клиента нет телефона для чека',
  refund_plan: 'Сумма возврата превышает платёж',
  receipt_lines: 'Чек не собирается: проверьте позиции',
  receipt_codes_missing: 'Не заданы коды НДС и системы налогообложения',
  receipt_total_mismatch: 'Сумма позиций не равна сумме заказа',
  claim_refund_allowed: 'Сначала «Принял возврат»',
  claim_refundable_kind: 'По просрочке после получения — компенсация, не возврат',
  money_held: 'Нет оплаты, которую можно вернуть',
};

/** Seller-facing text of a failed transition. */
export function failureMessage(result: Extract<ApplyResult, { ok: false }>): string {
  if (result.reason === 'not_found') return 'Заказ не найден';
  if (result.reason === 'no_rule') {
    return result.status
      ? `Действие недоступно: заказ ${ORDER_STATUS_LABELS[result.status]}`
      : 'Действие недоступно';
  }
  for (const name of result.failed) {
    const message = GUARD_MESSAGES[name];
    if (message) return message;
  }
  return 'Действие сейчас недоступно';
}

const SUCCESS_MESSAGES: Record<AnyStaffActionCode, string> = {
  recheck: 'Проверяем цены и наличие у Rossko…',
  refused: 'Заказ отменён',
  cancel: 'Заказ отменён',
  anyway: 'Продолжаем заказ',
  ialt: 'Аналог предложен клиенту',
  ieta: 'Новый срок предложен клиенту',
  icancel: 'Позиция отменена',
  iprob: 'Проблема с позицией отмечена',
  iarr: 'Отмечено: приехало',
  invpaid: 'Счёт Rossko отмечен оплаченным',
  came: 'Отмечено: клиент пришёл',
  rcpt: 'Чек отправлен повторно',
  qr: 'QR на оплату создаётся',
  handed: 'Выдано',
  noshow: 'Отмечено: клиент не пришёл',
  manual_supplier_order: 'Заказ в ЛК Rossko записан',
  supplier_return_accept: 'Возврат Rossko принят',
  supplier_return_reject: 'Возврат не принят: деталь на складе',
  stock_item: 'Деталь записана на склад',
  refund_payment: 'Возврат платежа создан',
  retry_refund: 'Возврат отправлен повторно',
  cret: 'Возврат принят',
  cref: 'Возврат денег по претензии создан',
  crepl: 'Решение: замена',
  crej: 'Отказ по претензии записан',
  cclose: 'Замена выдана, претензия закрыта',
  bconf: 'Запись подтверждена',
  bdecl: 'Запись отклонена',
  bdone: 'Установка отмечена выполненной',
  bnoshow: 'Отмечено: клиент не приехал на установку',
  pphoto: 'Фото сохранено',
  srship: 'Отмечено: сдано водителю',
  srrej: 'Отмечено: не берут, деталь на складе',
};

const CLAIM_ACTIONS: ReadonlySet<AnyStaffActionCode> = new Set<ClaimStaffActionCode>([
  'cret',
  'cref',
  'crepl',
  'crej',
  'cclose',
]);

const BOOKING_DECISIONS: Readonly<Record<BookingStaffActionCode, InstallDecision>> = {
  bconf: 'confirm',
  bdecl: 'decline',
  bdone: 'done',
  bnoshow: 'no_show',
};

function isBookingAction(code: AnyStaffActionCode): code is BookingStaffActionCode {
  return code in BOOKING_DECISIONS;
}

/** Step 7: buttons whose target id is supplier_returns.id. */
const SUPPLIER_RETURN_ACTIONS: ReadonlySet<AnyStaffActionCode> = new Set<AnyStaffActionCode>([
  'srship',
  'srrej',
]);

/** Statuses after the handover: the part is with the client. */
const AFTER_HANDOVER: readonly OrderStatus[] = ['handed', 'completed'];
/** «Фото упаковки» (decision С17): while the part is on its way or at the point. */
const PACKAGING_PHOTO_STATUSES: readonly OrderStatus[] = ['ordered_at_supplier', 'ready'];

/** Actions only the owner (or the admin acting as the owner) may take. */
const OWNER_ONLY: ReadonlySet<AnyStaffActionCode> = new Set<AnyStaffActionCode>([
  'invpaid',
  'manual_supplier_order',
  'supplier_return_accept',
  'supplier_return_reject',
  'stock_item',
  'refund_payment',
  'retry_refund',
]);

/** Actions whose target is an order item. */
const ITEM_ACTIONS: ReadonlySet<AnyStaffActionCode> = new Set<AnyStaffActionCode>([
  'ialt',
  'ieta',
  'icancel',
  'iprob',
  'iarr',
]);

const REFUSABLE: readonly OrderStatus[] = REFUSABLE_STATUSES;

/** ieta menu: days added to today (bot codes eta2 / eta5 / eta7 / eta14). */
export const ETA_MENU_DAYS = [2, 5, 7, 14] as const;

const PROBLEM_LABELS: Record<ItemProblem, string> = {
  declined: 'Отказ поставщика',
  wrong: 'Приехало не то',
  damaged: 'Повреждено при приёмке',
  delay: 'Сдвиг срока',
};

function itemTitle(item: { brand: string; article: string }): string {
  return `${item.brand} ${item.article}`;
}

// ---------------------------------------------------------------------------------------------
// availableStaffActions
// ---------------------------------------------------------------------------------------------

/** Buttons for a staff member right now (bot card, admin page). */
export function availableStaffActions(
  snapshot: OrderSnapshot,
  role: StaffRole,
  settings: OrderSettings,
  now: Date,
): StaffActionView[] {
  const { order } = snapshot;
  const status = order.status;
  const check = staffCheck(snapshot, role, settings, now);
  const views: StaffActionView[] = [];
  const add = (view: StaffActionView) => views.push({ disabledReason: null, ...view });
  const moneyHeld = moneyHeldOf(snapshot);
  const clientArrived = order.clientArrivedAt !== null;

  if (status === 'confirmed') {
    add({ code: 'recheck', label: 'Проверить и заказать', enabled: true });
  } else if (status === 'needs_attention') {
    const anyway = check('order_anyway');
    if (anyway.ok) add({ code: 'anyway', label: 'Заказать всё равно', enabled: true });
    else if (anyway.failed.includes('margin_floor')) {
      add({
        code: 'anyway',
        label: 'Заказать всё равно',
        enabled: false,
        disabledReason: GUARD_MESSAGES.margin_floor,
      });
    }
    for (const item of snapshot.items) {
      if (item.state !== 'pending' && item.state !== 'ordered') continue;
      const title = itemTitle(item);
      add({ code: 'ialt', label: `Аналог: ${title}`, itemId: item.id, enabled: true });
      add({ code: 'ieta', label: `Новый срок: ${title}`, itemId: item.id, enabled: true });
      if (check('item_cancelled', item.id).ok) {
        add({ code: 'icancel', label: `Отменить: ${title}`, itemId: item.id, enabled: true });
      }
    }
    if (check('order_cancelled').ok) {
      add({
        code: 'cancel',
        label: moneyHeld ? 'Отменить заказ и вернуть деньги' : 'Отменить заказ',
        enabled: true,
      });
    }
  } else if (status === 'ordered_at_supplier') {
    for (const item of snapshot.items) {
      if (item.state !== 'ordered' && item.state !== 'pending') continue;
      const title = itemTitle(item);
      if (item.state === 'ordered' && check('item_arrived', item.id).ok) {
        add({ code: 'iarr', label: `Приехало: ${title}`, itemId: item.id, enabled: true });
      }
      if (item.state === 'ordered') {
        add({ code: 'iprob', label: `Проблема: ${title}`, itemId: item.id, enabled: true });
      }
      if (check('item_cancelled', item.id).ok) {
        add({ code: 'icancel', label: `Отменить: ${title}`, itemId: item.id, enabled: true });
      }
    }
  } else if (status === 'awaiting_supplier_invoice') {
    if (role === 'owner') add({ code: 'invpaid', label: 'Счёт оплачен', enabled: true });
  } else if (status === 'ready') {
    const prepay = order.paymentScheme === 'prepay';
    if (!clientArrived) add({ code: 'came', label: 'Клиент пришёл', enabled: true });
    if (prepay && clientArrived && !settlementReceiptSucceededOf(snapshot)) {
      add({ code: 'rcpt', label: 'Повторить чек', enabled: true });
    }
    if (!prepay && clientArrived) {
      const qr = check('handover_payment_requested');
      add({ code: 'qr', label: 'Выставить оплату', enabled: qr.ok });
    }
    if (prepay) {
      const handed = check('handed_over');
      add({
        code: 'handed',
        label: 'Выдал',
        enabled: handed.ok,
        disabledReason: handed.ok
          ? null
          : clientArrived
            ? GUARD_MESSAGES.settlement_receipt_succeeded
            : GUARD_MESSAGES.client_arrived,
      });
    } else {
      add({
        code: 'handed',
        label: 'Выдал',
        enabled: false,
        disabledReason: clientArrived
          ? 'Сначала «Выставить оплату»'
          : GUARD_MESSAGES.client_arrived,
      });
    }
    if (check('storage_expired').ok) {
      add({ code: 'noshow', label: 'Клиент не пришёл', enabled: true });
    }
  } else if (status === 'awaiting_handover_payment') {
    const handed = check('handed_over');
    // Any held QR of the total counts, not only the latest payment (two QR on the screen).
    const paid = handoverPaymentHeldOf(snapshot);
    if (paid && !settlementReceiptSucceededOf(snapshot) && pendingHandoverReceipt(snapshot)) {
      add({ code: 'rcpt', label: 'Повторить чек', enabled: true });
    }
    add({
      code: 'handed',
      label: 'Выдал',
      enabled: handed.ok,
      disabledReason: handed.ok
        ? null
        : paid
          ? GUARD_MESSAGES.settlement_receipt_succeeded
          : GUARD_MESSAGES.payment_succeeded,
    });
  }

  if (REFUSABLE.includes(status) && check('client_refused').ok) {
    add({
      code: 'refused',
      label: moneyHeld ? 'Отказ клиента: вернуть деньги' : 'Отказ клиента: отменить заказ',
      enabled: true,
    });
  }
  // A refund the provider rejected or canceled: the 10 days of ст. 22 keep running, so the
  // owner can send it again from any status (the order and items follow its outcome).
  if (role === 'owner' && retryableRefunds(snapshot).length > 0) {
    add({ code: 'retry_refund', label: 'Повторить возврат', enabled: true });
  }

  return views;
}

/** Resolves an event for a staff member on the snapshot (no writes): what the buttons offer. */
function staffCheck(
  snapshot: OrderSnapshot,
  role: StaffRole,
  settings: OrderSettings,
  now: Date,
): Check {
  const actor: ActorRef = { type: 'staff', id: null, staffRole: role };
  return (event, itemId = null, facts = {}) => {
    const all: TransitionFacts = { ...facts, ...(itemId ? { scope: 'item' as const } : {}) };
    const changes = planItemChanges(event, snapshot, { ...all, itemId });
    const ctx = buildTransitionContext(snapshot, actor, all, settings, now, changes);
    return resolveTransition(snapshot.order.status, event, ctx);
  };
}

/**
 * Phase 1C buttons (section 5.2) for the bot card and the admin page, after those of
 * availableStaffActions: per open claim «Принял возврат» (cret), «Вернуть деньги» (cref, disabled
 * for a seller until the return is accepted, enabled with needsReason for the owner; none for a
 * delay after the handover — compensation, art. 23.1), «Замена» (crepl), «Отказать» (crej),
 * «Замена выдана» (cclose, after «Замена заказана» in the admin); per active booking bconf /
 * bdecl / bdone / bnoshow; «Фото упаковки» (pphoto) while the part is on its way or at the point.
 */
export function availableStaffActions1C(
  snapshot: OrderSnapshot,
  role: StaffRole,
  settings: OrderSettings,
  now: Date,
): StaffActionView1C[] {
  const status = snapshot.order.status;
  const check = staffCheck(snapshot, role, settings, now);
  const views: StaffActionView1C[] = [];
  const add = (view: StaffActionView1C) => views.push({ disabledReason: null, ...view });
  const openClaims = snapshot.claims.filter((claim) => claim.closedAt === null);
  for (const claim of openClaims) {
    const about = openClaims.length > 1 ? ` · ${claimTitle(snapshot, claim)}` : '';
    const target = { claimId: claim.id };
    if (claim.decision === 'replace') {
      // The replacement purchase is recorded first («Замена заказана», admin).
      const ordered = claim.replacementOrderedAt !== null;
      add({
        code: 'cclose',
        label: `Замена выдана${about}`,
        ...target,
        enabled: ordered,
        disabledReason: ordered ? null : REPLACEMENT_NOT_ORDERED,
      });
      continue;
    }
    if (claim.decision !== null) continue;
    const afterHandover = AFTER_HANDOVER.includes(status);
    const returnAccepted = claim.returnAcceptedAt !== null;
    if (afterHandover && claim.kind !== 'delay' && !returnAccepted) {
      add({ code: 'cret', label: `Принял возврат${about}`, ...target, enabled: true });
    }
    const refund = claimRefundCheck(snapshot, claim, check)?.(role) ?? null;
    if (refund !== null) {
      const reasonNote = refund.needsReason ? ' (нужна причина)' : '';
      add({ code: 'cref', label: `Вернуть деньги${reasonNote}${about}`, ...target, ...refund });
    }
    if (afterHandover && claim.kind !== 'delay') {
      add({ code: 'crepl', label: `Замена${about}`, ...target, enabled: true });
    }
    add({ code: 'crej', label: `Отказать по претензии${about}`, ...target, enabled: true });
  }
  for (const booking of snapshot.bookings) {
    const target = { bookingId: booking.id };
    const slot = bookingSlot(booking.slotAt);
    const when = `${slot.dayText} ${slot.timeText}`;
    if (booking.status === 'requested') {
      add({ code: 'bconf', label: `Подтвердить запись ${when}`, ...target, enabled: true });
      add({ code: 'bdecl', label: `Отклонить запись ${when}`, ...target, enabled: true });
    } else if (booking.status === 'confirmed') {
      const started = now.getTime() >= booking.slotAt.getTime();
      const notYet = started ? null : 'Время записи ещё не наступило';
      add({
        code: 'bdone',
        label: `Установка выполнена ${when}`,
        ...target,
        enabled: started,
        disabledReason: notYet,
      });
      add({
        code: 'bnoshow',
        label: `Не приехал на установку ${when}`,
        ...target,
        enabled: started,
        disabledReason: notYet,
      });
      add({ code: 'bdecl', label: `Отменить запись ${when}`, ...target, enabled: true });
    }
  }
  if (PACKAGING_PHOTO_STATUSES.includes(status)) {
    add({ code: 'pphoto', label: 'Фото упаковки', enabled: true });
  }
  return views;
}

function claimTitle(snapshot: OrderSnapshot, claim: ClaimSummary): string {
  const kind = CLAIM_KIND_LABELS[claim.kind];
  const item = snapshot.items.find((i) => i.id === claim.orderItemId);
  return item ? `${kind}: ${itemTitle(item)}` : kind;
}

type Check = (
  event: OrderEvent,
  itemId?: string | null,
  facts?: TransitionFacts,
) => TransitionResult;

/**
 * «Вернуть деньги» of an undecided claim: the refund rule of its status with the claim facts.
 * Without «Принял возврат» (not a delay) a seller sees it disabled; the owner sees it enabled with
 * «нужна причина» (the override reason, PLAN section 2). null: no refund in this status.
 */
function claimRefundCheck(
  snapshot: OrderSnapshot,
  claim: ClaimSummary,
  check: Check,
):
  | ((role: StaffRole) => Pick<StaffActionView1C, 'enabled' | 'disabledReason' | 'needsReason'>)
  | null {
  const status = snapshot.order.status;
  const facts: TransitionFacts = {
    claimKind: claim.kind,
    returnAccepted: claim.returnAcceptedAt !== null,
  };
  let event: OrderEvent;
  let itemId: string | null = null;
  if (AFTER_HANDOVER.includes(status)) {
    // A delay after the handover is compensated (art. 23.1), never refunded: no button.
    if (claim.kind === 'delay') return null;
    event = 'claim_refund_approved';
    itemId = claim.orderItemId;
    facts.scope = itemId === null ? 'order' : 'item';
  } else if (claim.kind === 'delay' && claim.orderItemId === null && REFUSABLE.includes(status)) {
    event = 'client_refused';
    facts.scope = 'order';
  } else {
    return null;
  }
  const plain = check(event, itemId, facts);
  const overridden = check(event, itemId, { ...facts, ownerOverrideReason: 'override' });
  return (role) => {
    if (plain.ok) return { enabled: true };
    if (plain.failed.includes('claim_refund_allowed')) {
      if (role === 'owner' && overridden.ok) {
        return { enabled: true, needsReason: true };
      }
      return { enabled: false, disabledReason: GUARD_MESSAGES.claim_refund_allowed ?? null };
    }
    const reason = plain.failed.map((name) => GUARD_MESSAGES[name]).find(Boolean);
    return { enabled: false, disabledReason: reason ?? 'Возврат сейчас недоступен' };
  };
}

/** The pending `full` receipt of a held handover payment («Повторить чек» at the point). */
function pendingHandoverReceipt(snapshot: OrderSnapshot) {
  const held = new Set(handoverPaymentsHeld(snapshot).map((payment) => payment.id));
  return (
    snapshot.receipts
      .filter(
        (r) =>
          r.kind === 'full' &&
          r.status === 'pending' &&
          r.paymentId !== null &&
          held.has(r.paymentId),
      )
      .at(-1) ?? null
  );
}

// ---------------------------------------------------------------------------------------------
// performStaffAction
// ---------------------------------------------------------------------------------------------

async function resolveTarget(
  deps: EngineDeps,
  action: AnyStaffActionCode,
  targetId: string,
): Promise<{ orderId: string; itemId: string | null } | null> {
  if (!isUuid(targetId)) return null;
  if (CLAIM_ACTIONS.has(action)) {
    const [claim] = await deps.db
      .select({ orderId: claims.orderId })
      .from(claims)
      .where(eq(claims.id, targetId));
    return claim ? { orderId: claim.orderId, itemId: null } : null;
  }
  if (isBookingAction(action)) {
    const [booking] = await deps.db
      .select({ orderId: installBookings.orderId })
      .from(installBookings)
      .where(eq(installBookings.id, targetId));
    return booking ? { orderId: booking.orderId, itemId: null } : null;
  }
  if (SUPPLIER_RETURN_ACTIONS.has(action)) {
    const orderId = await supplierReturnOrderId(deps.db, targetId);
    return orderId === null ? null : { orderId, itemId: null };
  }
  if (!ITEM_ACTIONS.has(action)) {
    const [order] = await deps.db
      .select({ id: orders.id })
      .from(orders)
      .where(eq(orders.id, targetId));
    if (order) return { orderId: order.id, itemId: null };
  }
  const [item] = await deps.db
    .select({ id: orderItems.id, orderId: orderItems.orderId })
    .from(orderItems)
    .where(eq(orderItems.id, targetId));
  return item ? { orderId: item.orderId, itemId: item.id } : null;
}

/** The latest recheck_result payload items (fresh prices, alternatives), if any. */
async function latestRecheck(deps: EngineDeps, orderId: string): Promise<RecheckItemResult[]> {
  const [row] = await deps.db
    .select({ payload: orderEvents.payload })
    .from(orderEvents)
    .where(and(eq(orderEvents.orderId, orderId), eq(orderEvents.type, 'recheck_result')))
    .orderBy(desc(orderEvents.createdAt), desc(orderEvents.id))
    .limit(1);
  const items = (row?.payload as { items?: unknown } | undefined)?.items;
  return Array.isArray(items) ? (items as RecheckItemResult[]) : [];
}

function alternativeProposal(alternative: RecheckAlternative): ApprovalProposal {
  const { available: _available, ...rest } = alternative;
  return { kind: 'alternative', ...rest };
}

interface LockedRun {
  tx: Tx;
  snapshot: OrderSnapshot;
  at: Date;
}

/** Runs a non-transition action under the order row lock; nudges after commit. */
async function withLockedOrder(
  deps: EngineDeps,
  orderId: string,
  run: (locked: LockedRun) => Promise<StaffActionResult>,
): Promise<StaffActionResult> {
  try {
    const result = await deps.db.transaction(async (tx) => {
      const snapshot = await loadOrderSnapshot(tx, orderId, { lock: true });
      if (snapshot === null) return { ok: false, message: 'Заказ не найден', orderId };
      const result = await run({ tx, snapshot, at: clock(deps) });
      // A refusal must not commit partial writes.
      if (!result.ok) throw new ActionRefused(result);
      return result;
    });
    if (result.ok) nudge(deps);
    return result;
  } catch (error) {
    if (error instanceof ActionRefused) return error.result;
    if (error instanceof EngineError) {
      return { ok: false, message: GUARD_MESSAGES[error.code] ?? 'Действие не выполнено', orderId };
    }
    throw error;
  }
}

class ActionRefused extends Error {
  constructor(readonly result: StaffActionResult) {
    super(result.message);
  }
}

/** Translates an action code into an event and facts (or a non-transition action) and applies it. */
export async function performStaffAction(
  deps: EngineDeps,
  args: {
    staff: { id: string | null; role: StaffRole; via: 'bot' | 'admin' };
    /** 1B codes and the phase 1C ones (StaffActionCode1C). */
    action: AnyStaffActionCode;
    /** Order id or item id depending on the action (table 13.2). */
    targetId: string;
    input?: StaffActionInput;
  },
): Promise<StaffActionResult> {
  const { staff, action } = args;
  const input = args.input ?? {};
  const target = await resolveTarget(deps, action, args.targetId);
  if (target === null) return { ok: false, message: 'Заказ не найден', orderId: args.targetId };
  const { orderId, itemId } = target;
  if (OWNER_ONLY.has(action) && staff.role !== 'owner') {
    return { ok: false, message: GUARD_MESSAGES.owner as string, orderId };
  }
  const actor: ActorRef = {
    type: 'staff',
    id: staff.id ?? (staff.via === 'admin' ? 'admin' : null),
    staffRole: staff.role,
  };
  const done = (message = SUCCESS_MESSAGES[action]): StaffActionResult => ({
    ok: true,
    message,
    orderId,
  });
  const refuse = (message: string, menu?: StaffActionView[]): StaffActionResult => ({
    ok: false,
    message,
    orderId,
    ...(menu ? { menu } : {}),
  });
  const apply = async (
    event: OrderEvent,
    options: {
      itemId?: string | null;
      facts?: TransitionFacts;
      payload?: Record<string, unknown>;
    } = {},
  ): Promise<StaffActionResult> => {
    const result = await applyTransition(deps, {
      orderId,
      event,
      actor,
      itemId: options.itemId ?? null,
      facts: options.facts,
      payload: { via: staff.via, ...options.payload },
    });
    return result.ok ? done() : refuse(failureMessage(result));
  };

  switch (action) {
    case 'recheck':
      return withLockedOrder(deps, orderId, async ({ tx, snapshot, at }) => {
        if (snapshot.order.status !== 'confirmed') {
          return refuse(`Проверка недоступна: заказ ${ORDER_STATUS_LABELS[snapshot.order.status]}`);
        }
        const { orderEventId } = await recordJournalEvent(tx, {
          orderId,
          type: 'recheck_requested',
          actor,
          payload: { via: staff.via },
          at,
        });
        await enqueueOutbox(tx, {
          queue: 'rossko',
          name: 'recheck',
          key: `recheck:${orderEventId}`,
          data: { orderId, eventId: orderEventId, staffId: staff.id },
        });
        return done();
      });
    case 'refused':
      return apply('client_refused');
    case 'cancel':
      return apply('order_cancelled');
    case 'anyway': {
      // Margin at the fresh supplier prices of the last recheck, when there was one.
      const fresh = new Map(
        (await latestRecheck(deps, orderId)).map((r) => [r.orderItemId, r.freshPriceSupplierKop]),
      );
      const snapshot = await loadOrderSnapshot(deps.db, orderId, { lock: false });
      const margin = snapshot
        ? liveMarginBp(
            itemsAfterChanges(snapshot.items, []),
            (item) => fresh.get(item.id) ?? item.priceSupplierAtOrderKop,
          )
        : null;
      return apply('order_anyway', { facts: margin === null ? {} : { marginBp: margin } });
    }
    case 'ialt': {
      const proposal =
        input.proposal ?? (input.alternative ? alternativeProposal(input.alternative) : null);
      if (proposal === null || proposal.kind !== 'alternative') {
        const result = (await latestRecheck(deps, orderId)).find((r) => r.orderItemId === itemId);
        const menu = (result?.alternatives ?? []).map((alt): StaffActionView => ({
          code: 'ialt',
          label: `${alt.offer.brand} ${alt.offer.article}${alt.etaDate ? ` — к ${alt.etaDate}` : ''}`,
          itemId: itemId ?? undefined,
          enabled: true,
        }));
        return menu.length > 0
          ? refuse('Выберите аналог', menu)
          : refuse('Аналогов нет: проверьте цены ещё раз или отмените позицию');
      }
      return apply('alternative_proposed', {
        itemId,
        facts: { proposal, scope: 'item' },
        payload: { offerKey: proposal.offerKey },
      });
    }
    case 'ieta': {
      const proposal: ApprovalProposal | null =
        input.proposal ??
        (input.etaDate
          ? { kind: 'new_eta', etaDate: input.etaDate, note: input.note ?? null }
          : null);
      if (proposal === null || proposal.kind !== 'new_eta') {
        const today = localDate(clock(deps));
        return refuse(
          'Выберите новый срок',
          ETA_MENU_DAYS.map((days) => ({
            code: 'ieta',
            label: `+${days} дн. (${addDays(today, days)})`,
            itemId: itemId ?? undefined,
            enabled: true,
          })),
        );
      }
      if (!isIsoDate(proposal.etaDate)) return refuse('Неверная дата');
      return apply('new_eta_proposed', {
        itemId,
        facts: { proposal, scope: 'item' },
        payload: { etaDate: proposal.etaDate },
      });
    }
    case 'icancel':
      return apply('item_cancelled', { itemId, facts: { scope: 'item' } });
    case 'iprob': {
      const problem = input.problem;
      if (problem === undefined) {
        return refuse(
          'Что случилось?',
          (Object.keys(PROBLEM_LABELS) as ItemProblem[]).map((p) => ({
            code: 'iprob',
            label: PROBLEM_LABELS[p],
            itemId: itemId ?? undefined,
            enabled: true,
          })),
        );
      }
      if (problem === 'damaged') {
        return apply('item_damaged_on_receipt', { itemId, payload: { problem } });
      }
      return apply('item_problem', {
        itemId,
        facts: { problem, reason: `item_problem:${problem}` },
        payload: { problem },
      });
    }
    case 'iarr':
      return apply('item_arrived', { itemId });
    case 'invpaid': {
      const paymentRef = input.paymentRef?.trim() ?? '';
      if (paymentRef === '' || paymentRef.length > 200) {
        return refuse('Укажите номер и дату платёжного поручения');
      }
      return apply('supplier_invoice_paid', { payload: { paymentRef } });
    }
    case 'came':
      return apply('client_arrived');
    case 'rcpt': {
      const [row] = await deps.db
        .select({ status: orders.status })
        .from(orders)
        .where(eq(orders.id, orderId));
      if (row?.status === 'awaiting_handover_payment') {
        return retryHandoverReceipt(deps, orderId, actor, staff.via, done, refuse);
      }
      return apply('offset_receipt_requested');
    }
    case 'qr':
      if (!paymentsEnabled(deps.env)) return refuse(GUARD_MESSAGES.payments_disabled as string);
      return apply('handover_payment_requested');
    case 'handed':
      return apply('handed_over');
    case 'noshow':
      return apply('storage_expired');
    case 'manual_supplier_order':
      return manualSupplierOrder(deps, orderId, actor, input, done, refuse);
    case 'supplier_return_accept':
    case 'supplier_return_reject':
      return supplierReturnDecision(deps, orderId, staff, action, input, done, refuse);
    case 'stock_item':
      return stockItem(deps, orderId, itemId, actor, input, done, refuse);
    case 'refund_payment':
      return refundPayment(deps, orderId, actor, input, done, refuse);
    case 'retry_refund':
      return retryRefund(deps, orderId, actor, input, done, refuse);
    // --- phase 1C: the target id is the claim, the booking or the order ---------------------
    case 'cret':
      if (!input.photoKey) return refuse('Пришлите фото возвращённой детали');
      return acceptClaimReturn(deps, { claimId: args.targetId, photoKey: input.photoKey, staff });
    case 'cref':
    case 'crepl':
    case 'crej':
      return decideClaim(deps, {
        claimId: args.targetId,
        decision: action === 'cref' ? 'refund' : action === 'crepl' ? 'replace' : 'reject',
        text: input.text ?? '',
        staff,
        overrideReason: action === 'cref' ? (input.reason ?? null) : null,
      });
    case 'cclose':
      return closeClaim(deps, { claimId: args.targetId, staff, note: input.note ?? null });
    case 'bconf':
    case 'bdecl':
    case 'bdone':
    case 'bnoshow':
      return decideInstall(deps, {
        bookingId: args.targetId,
        decision: BOOKING_DECISIONS[action],
        note: input.note ?? null,
        staff,
      });
    case 'pphoto':
      if (!input.photoKey) return refuse('Пришлите фото упаковки');
      return addOrderPhoto(deps, {
        orderId,
        kind: input.photoKind ?? 'packaging',
        fileKey: input.photoKey,
        staff,
      });
    // --- step 7: the target id is the supplier return (any staff member) ---------------------
    case 'srship':
      return shipSupplierReturn(deps, { supplierReturnId: args.targetId, staff });
    case 'srrej':
      return rejectSupplierReturn(deps, {
        supplierReturnId: args.targetId,
        staff,
        note: input.note ?? null,
      });
  }
}

/**
 * «Повторить чек» of a paid QR (pay_on_handover): the receipt went inside the payment, so it
 * cannot be sent again; receipts/payment-receipt opens a new polling window for it (the first
 * one ended with an alert) and «Выдал» unlocks as soon as the provider registers it.
 */
async function retryHandoverReceipt(
  deps: EngineDeps,
  orderId: string,
  actor: ActorRef,
  via: 'bot' | 'admin',
  done: Done,
  refuse: Refuse,
): Promise<StaffActionResult> {
  return withLockedOrder(deps, orderId, async ({ tx, snapshot, at }) => {
    if (snapshot.order.status !== 'awaiting_handover_payment') {
      return refuse(`Недоступно: заказ ${ORDER_STATUS_LABELS[snapshot.order.status]}`);
    }
    if (!handoverPaymentHeldOf(snapshot)) return refuse(GUARD_MESSAGES.payment_succeeded as string);
    if (settlementReceiptSucceededOf(snapshot)) return refuse('Чек уже пробит — нажмите «Выдал»');
    const receipt = pendingHandoverReceipt(snapshot);
    if (receipt === null) {
      return refuse('ЮKassa отклонила чек оплаты — пробейте чек в ЛК ЮKassa и напишите владельцу');
    }
    const { orderEventId } = await recordJournalEvent(tx, {
      orderId,
      type: 'receipt_retry_requested',
      actor,
      payload: { receiptId: receipt.id, kind: receipt.kind, via },
      at,
    });
    await enqueueOutbox(tx, {
      queue: 'receipts',
      name: 'payment-receipt',
      key: `payment-receipt:${receipt.id}:retry:${orderEventId}`,
      data: { receiptId: receipt.id, orderId, restart: true },
    });
    return done('Проверяем чек ещё раз');
  });
}

/**
 * «Повторить возврат» (owner): a refund of the order or of one item that the provider rejected
 * (4xx on POST /refunds) or canceled is created again with the same scope, items, payment and
 * reason, and a new Idempotence-Key (safe: the old one created nothing or was canceled). The
 * new row keeps the old deadline_at (10 days of ст. 22 from the first request) and points to
 * it (retry_of); its success moves the order and the items as the first one would have.
 */
async function retryRefund(
  deps: EngineDeps,
  orderId: string,
  actor: ActorRef,
  input: StaffActionInput,
  done: Done,
  refuse: Refuse,
): Promise<StaffActionResult> {
  return withLockedOrder(deps, orderId, async ({ tx, snapshot, at }) => {
    const wanted = input.refundId;
    const targets = retryableRefunds(snapshot)
      .filter((refund) => wanted === undefined || refund.id === wanted)
      // Item refunds first: a whole-order refund then plans what they do not cover.
      .sort((a, b) => Number(a.scope !== 'item') - Number(b.scope !== 'item'));
    if (targets.length === 0) return refuse('Нет возврата, который можно повторить');
    let current = snapshot;
    let created = 0;
    for (const failed of targets) {
      if (created > 0) {
        current = (await loadOrderSnapshot(tx, orderId, { lock: false })) as OrderSnapshot;
        if (!retryableRefunds(current).some((refund) => refund.id === failed.id)) continue;
      }
      try {
        await tx.transaction((sp) =>
          createRefund(sp, current, {
            ...refundTargetOf(failed),
            reason: failed.reason,
            requestedAt: at,
            actor,
            env: deps.env,
            retryOf: failed,
            ...(input.note ? { note: input.note.slice(0, 500) } : {}),
          }),
        );
      } catch (error) {
        if (error instanceof EngineError) throw error;
        if (error instanceof Error && error.name === 'ReceiptLinesError') {
          return refuse('Чек возврата не собирается: оформите возврат в ЛК ЮKassa');
        }
        if (error instanceof Error && error.name === 'RefundPlanError') {
          return refuse('Сумма возврата превышает платёж');
        }
        throw error;
      }
      created += 1;
    }
    return created > 0 ? done() : refuse('Нет возврата, который можно повторить');
  });
}

type Done = (message?: string) => StaffActionResult;
type Refuse = (message: string, menu?: StaffActionView[]) => StaffActionResult;

/**
 * «Заказано вручную в ЛК Rossko» (decision Б14): a `created` supplier order with the given
 * Rossko numbers covering the live pending items (they become `ordered`); a `sending` attempt
 * left by a timeout is closed as failed. The seller then presses «Заказать всё равно».
 */
async function manualSupplierOrder(
  deps: EngineDeps,
  orderId: string,
  actor: ActorRef,
  input: StaffActionInput,
  done: Done,
  refuse: Refuse,
): Promise<StaffActionResult> {
  const ids = (input.rosskoOrderIds ?? []).map((id) => id.trim()).filter((id) => id !== '');
  if (ids.length === 0 || ids.some((id) => id.length > 64)) {
    return refuse('Укажите номера заказов Rossko');
  }
  return withLockedOrder(deps, orderId, async ({ tx, snapshot, at }) => {
    if (snapshot.order.status !== 'needs_attention') {
      return refuse(`Недоступно: заказ ${ORDER_STATUS_LABELS[snapshot.order.status]}`);
    }
    const pending = snapshot.items.filter((i) => i.state === 'pending');
    if (pending.length === 0) return refuse('Нет позиций, ожидающих заказа');
    await tx
      .update(supplierOrders)
      .set({ status: 'failed', error: 'superseded_by_manual', updatedAt: at })
      .where(and(eq(supplierOrders.orderId, orderId), eq(supplierOrders.status, 'sending')));
    const attemptNo = Math.max(0, ...snapshot.supplierOrders.map((s) => s.attemptNo)) + 1;
    const [created] = await tx
      .insert(supplierOrders)
      .values({ orderId, attemptNo, status: 'created', rosskoOrderIds: ids })
      .returning({ id: supplierOrders.id });
    const supplierOrderId = created?.id as string;
    await tx
      .insert(supplierOrderItems)
      .values(pending.map((item) => ({ supplierOrderId, orderItemId: item.id })));
    await tx
      .update(orderItems)
      .set({ state: 'ordered', supplierItemError: null, updatedAt: at })
      .where(
        inArray(
          orderItems.id,
          pending.map((i) => i.id),
        ),
      );
    await recordJournalEvent(tx, {
      orderId,
      type: 'supplier_order_manual',
      actor,
      payload: { supplierOrderId, rosskoOrderIds: ids, itemIds: pending.map((i) => i.id) },
      at,
    });
    return done('Заказ в ЛК Rossko записан. Нажмите «Заказать всё равно», чтобы продолжить');
  });
}

async function supplierReturnOf(tx: Tx, orderId: string, supplierReturnId: string | undefined) {
  if (!isUuid(supplierReturnId)) return null;
  const [row] = await tx
    .select({ ret: supplierReturns, item: orderItems })
    .from(supplierReturns)
    .innerJoin(orderItems, eq(orderItems.id, supplierReturns.orderItemId))
    .where(and(eq(supplierReturns.id, supplierReturnId), eq(orderItems.orderId, orderId)));
  return row ?? null;
}

/**
 * «Rossko принял / не принял возврат» (admin, owner): accepted while the part waits or after
 * «Сдал водителю» (step 7); not accepted -> the part goes to stock_items through the same function
 * as the bot's «Не берут» (supplier-returns.ts), with this action's own reason code. Accepted with
 * the amount received (the card's «Получено, ₽») is the money back: «Деньги вернулись» of step 7
 * (refunded with refunded_at), so it shows in the month's «не доход» and stops the 10-day alert.
 */
async function supplierReturnDecision(
  deps: EngineDeps,
  orderId: string,
  staff: StaffRef,
  action: 'supplier_return_accept' | 'supplier_return_reject',
  input: StaffActionInput,
  done: Done,
  refuse: Refuse,
): Promise<StaffActionResult> {
  const withAmount =
    action === 'supplier_return_accept' &&
    input.amountKop !== undefined &&
    input.amountKop !== null &&
    input.amountKop > 0;
  if (action === 'supplier_return_reject' || withAmount) {
    const [found] = isUuid(input.supplierReturnId)
      ? await deps.db
          .select({ id: supplierReturns.id, status: supplierReturns.status })
          .from(supplierReturns)
          .innerJoin(orderItems, eq(orderItems.id, supplierReturns.orderItemId))
          .where(
            and(eq(supplierReturns.id, input.supplierReturnId), eq(orderItems.orderId, orderId)),
          )
      : [];
    if (!found) return refuse('Возврат поставщику не найден');
    if (withAmount) {
      if (found.status === 'rejected' || found.status === 'refunded') {
        return refuse('Решение по возврату уже записано');
      }
      return markSupplierReturnRefunded(deps, {
        supplierReturnId: found.id,
        amountKop: input.amountKop as number,
        staff,
      });
    }
    return rejectSupplierReturn(deps, {
      supplierReturnId: found.id,
      staff,
      reason: input.reason?.trim() || 'rossko_rejected_return',
      note: input.note ?? null,
      strict: true,
      message: SUCCESS_MESSAGES.supplier_return_reject,
    });
  }
  return withLockedOrder(deps, orderId, async ({ tx, at }) => {
    const found = await supplierReturnOf(tx, orderId, input.supplierReturnId);
    if (found === null) return refuse('Возврат поставщику не найден');
    if (found.ret.status !== 'requested' && found.ret.status !== 'shipped') {
      return refuse('Решение по возврату уже записано');
    }
    await tx
      .update(supplierReturns)
      .set({
        status: 'accepted',
        amountReceivedKop: input.amountKop ?? null,
        ...(input.note ? { note: input.note } : {}),
        updatedAt: at,
      })
      .where(eq(supplierReturns.id, found.ret.id));
    return done();
  });
}

/** A part kept by us (stock_items, minimal in 1B; «Продать со склада» is phase 2). */
async function stockItem(
  deps: EngineDeps,
  orderId: string,
  itemId: string | null,
  actor: ActorRef,
  input: StaffActionInput,
  done: Done,
  refuse: Refuse,
): Promise<StaffActionResult> {
  return withLockedOrder(deps, orderId, async ({ tx, snapshot, at }) => {
    let item = itemId ? snapshot.items.find((i) => i.id === itemId) : undefined;
    if (item === undefined && input.supplierReturnId) {
      const found = await supplierReturnOf(tx, orderId, input.supplierReturnId);
      item = found ? snapshot.items.find((i) => i.id === found.item.id) : undefined;
    }
    if (item === undefined) return refuse('Позиция не найдена');
    const costKop = input.amountKop ?? item.priceSupplierAtOrderKop * item.qty;
    if (!Number.isSafeInteger(costKop) || costKop < 0) return refuse('Неверная стоимость');
    const [stock] = await tx
      .insert(stockItems)
      .values({ orderItemId: item.id, costKop, reason: input.reason?.trim() || 'not_returned' })
      .returning({ id: stockItems.id });
    await recordJournalEvent(tx, {
      orderId,
      type: 'stock_item_created',
      actor,
      payload: { stockItemId: stock?.id, itemId: item.id },
      at,
    });
    return done();
  });
}

/**
 * «Вернуть платёж» (owner): the whole payment back with the lines of the receipt that took the
 * money (scope orphan: the order status does not change), the owner's reason in the journal.
 * Not for a payment whose order or item refund failed (that one is retried, so the order moves),
 * and after handover the order's own payment goes back as a whole-order refund instead.
 */
async function refundPayment(
  deps: EngineDeps,
  orderId: string,
  actor: ActorRef,
  input: StaffActionInput,
  done: Done,
  refuse: Refuse,
): Promise<StaffActionResult> {
  const reason = input.reason?.trim() ?? '';
  if (reason === '') return refuse('Укажите причину возврата');
  if (!isUuid(input.paymentId)) return refuse('Платёж не найден');
  const paymentId = input.paymentId;
  return withLockedOrder(deps, orderId, async ({ tx, snapshot, at }) => {
    const payment = snapshot.payments.find((p) => p.id === paymentId);
    if (payment === undefined || payment.status !== 'succeeded') {
      return refuse('Платёж не найден или не оплачен');
    }
    if (retryableRefunds(snapshot).some((refund) => refund.paymentId === paymentId)) {
      // An orphan refund would leave the order and its items waiting for the failed one.
      return refuse(
        'По этому платежу есть возврат, который не прошёл: нажмите «Повторить возврат», чтобы заказ и позиции пошли за деньгами',
      );
    }
    const status = snapshot.order.status;
    if (
      (status === 'handed' || status === 'completed') &&
      refundablePayment(snapshot)?.id === paymentId
    ) {
      // The order's own money after handover: a refusal within the 7 days of ст. 26.1 and
      // the like go back as the whole order (planOrderRefund, refund_full mirroring the
      // offset / handover receipt), and the order follows: refund_pending -> refunded.
      const result = await applyTransitionInTx(
        tx,
        deps,
        {
          orderId,
          event: 'claim_refund_approved',
          actor,
          facts: { scope: 'order', ownerOverrideReason: reason.slice(0, 500) },
          payload: { via: 'refund_payment', note: reason.slice(0, 500) },
        },
        { snapshot },
      );
      return result.ok ? done('Возврат всего заказа создан') : refuse(failureMessage(result));
    }
    try {
      await tx.transaction((sp) =>
        createRefund(sp, snapshot, {
          scope: 'orphan',
          paymentId,
          reason:
            snapshot.order.attentionReason === 'amount_mismatch' ? 'amount_mismatch' : 'other',
          requestedAt: at,
          actor,
          env: deps.env,
          note: reason.slice(0, 500),
          // A failed orphan refund or a refund task of this payment keeps its deadline.
          retryOf: failedOrphanOf(snapshot, paymentId),
        }),
      );
    } catch (error) {
      if (error instanceof EngineError) throw error;
      if (error instanceof Error && error.name === 'RefundPlanError') {
        return refuse('Платёж уже возвращён полностью или частично');
      }
      if (error instanceof Error && error.name === 'ReceiptLinesError') {
        return refuse('Чек возврата не собирается: оформите возврат в ЛК ЮKassa');
      }
      throw error;
    }
    return done();
  });
}

// ---------------------------------------------------------------------------------------------
// performClientAction
// ---------------------------------------------------------------------------------------------

/** Client actions on /o/<token>; the web checks the token and the 4 phone digits (Б24). */
export async function performClientAction(
  deps: EngineDeps,
  input: { orderId: string; userId: string; action: ClientAction; itemId?: string | null },
): Promise<ApplyResult> {
  if (!isUuid(input.orderId)) return { ok: false, reason: 'not_found', failed: [], status: null };
  const [order] = await deps.db
    .select({ userId: orders.userId, status: orders.status })
    .from(orders)
    .where(eq(orders.id, input.orderId));
  if (!order || order.userId !== input.userId) {
    return { ok: false, reason: 'not_found', failed: [], status: null };
  }
  const actor: ActorRef = { type: 'client', id: input.userId };
  const base = { orderId: input.orderId, actor };
  switch (input.action) {
    case 'confirm':
      return applyTransition(deps, { ...base, event: 'client_confirmed' });
    case 'approve':
      return applyTransition(deps, { ...base, event: 'client_approved' });
    case 'refund_request':
      return applyTransition(deps, { ...base, event: 'client_refund_requested' });
    case 'refuse':
      // Before payment / confirmation a refusal is the phase 1A cancellation.
      return applyTransition(deps, {
        ...base,
        event:
          order.status === 'awaiting_payment' || order.status === 'awaiting_confirmation'
            ? 'client_cancelled'
            : 'client_refused',
      });
    case 'prepay_now':
      return applyTransition(deps, { ...base, event: 'switch_to_prepay' });
    case 'item_cancel':
      if (!isUuid(input.itemId)) {
        return { ok: false, reason: 'guard_failed', failed: ['item'], status: order.status };
      }
      return applyTransition(deps, {
        ...base,
        event: 'item_cancelled',
        itemId: input.itemId,
        facts: { scope: 'item' },
      });
  }
}

/** Loads what availableStaffActions needs (no lock): for the bot card and the admin page. */
export async function loadStaffActions(
  deps: EngineDeps,
  orderId: string,
  role: StaffRole,
): Promise<StaffActionView[] | null> {
  const snapshot = await loadOrderSnapshot(deps.db, orderId, { lock: false });
  if (snapshot === null) return null;
  const settings = await loadOrderSettings(deps.db, deps.env);
  return availableStaffActions(snapshot, role, settings, clock(deps));
}

/** loadStaffActions for the phase 1C buttons (availableStaffActions1C), no lock. */
export async function loadStaffActions1C(
  deps: EngineDeps,
  orderId: string,
  role: StaffRole,
): Promise<StaffActionView1C[] | null> {
  const snapshot = await loadOrderSnapshot(deps.db, orderId, { lock: false });
  if (snapshot === null) return null;
  const settings = await loadOrderSettings(deps.db, deps.env);
  return availableStaffActions1C(snapshot, role, settings, clock(deps));
}
