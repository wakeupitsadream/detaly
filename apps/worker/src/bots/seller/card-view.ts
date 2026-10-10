// Pure rendering of seller cards (decision Б17, docs/phase-1b-implementation.md section 13.1):
// the text is drawn from the database state (number, scheme, sum, date, items with their states,
// the masked client phone, the needs_attention reason), the buttons from availableStaffActions.
// No full phone, no address, no order token: the sellers chat lives in Telegram (PD minimisation).
//
// Phase 1C (docs/phase-1c-implementation.md section 9 item 1): the open claims (kind, item,
// deadline, «возврат принят», the number of the client's photos — the photos themselves only in
// the admin, decision С2) and the active installation booking (slot, status), their buttons from
// availableStaffActions1C with the claim or booking id, «Фото упаковки» and its hint. Never the
// client's claim text: it may hold PD.
//
// Step 7 (docs/month-close.md): the task of each part going back to Rossko — the part, the
// deadline (orders.supplier_return_deadline_at), and «Сдал водителю» / «Не берут» while it waits
// at the point (supplierReturnActions, the id is the supplier return).
//
// Step 8 (docs/rossko-automation.md): the shadow auto-order of the latest «Проверить и заказать»
// as one line «Автозаказ бы: ДА» / «Автозаказ бы: НЕТ — <причины>» while the order is on its way
// from the supplier; the deadline alerts and «Отгружено Rossko» have their own headlines.
import {
  addDays,
  autoOrderLine,
  DEADLINE_ALERT_HEADLINES,
  CLAIM_DECISION_LABELS,
  CLAIM_KIND_LABELS,
  fitGuaranteeClaimLabel,
  formatRub,
  localDate,
  type AutoOrderReason,
  type ClaimDecision,
  type ClaimKind,
  type InstallBookingStatus,
  type IsoDate,
  type OrderItemState,
  type OrderNotifyTemplate,
  type OrderStatus,
  type PaymentScheme,
  type RecheckAlternative,
  type SupplierReturnKind,
  type SupplierReturnStatus,
} from '@detaly/domain';
import {
  buildCallbackData,
  callbackCodeForStaffAction,
  deadline,
  isOwnerOnlyAction,
  formatReplyBy,
  maskPhone,
  MENU_ACTIONS,
  promise,
  type MenuAction,
} from '@detaly/notify';
import {
  ETA_MENU_DAYS,
  ORDER_STATUS_LABELS,
  type StaffActionView,
  type StaffActionView1C,
  type SupplierReturnActionView,
} from '@detaly/orders';

export type InlineButton = { text: string; callback_data: string } | { text: string; url: string };
export type InlineKeyboard = InlineButton[][];

export const SCHEME_LABELS: Record<PaymentScheme, string> = {
  prepay: 'предоплата',
  pay_on_handover: 'оплата при получении',
};

export const ITEM_STATE_LABELS: Record<OrderItemState, string> = {
  pending: 'ждёт заказа',
  ordered: 'заказана',
  failed: 'не куплена',
  replaced: 'заменена',
  arrived: 'приехала',
  handed: 'выдана',
  return_requested: 'возврат поставщику',
  returned: 'возвращена поставщику',
  refund_pending: 'возврат денег',
  refunded: 'деньги возвращены',
};

/** orders.attention_reason (AttentionReason of @detaly/orders) in Russian. */
const ATTENTION_LABELS: Record<string, string> = {
  price_drift: 'цена у Rossko выросла больше допуска',
  unavailable: 'у Rossko нет нужного количества',
  item_errors: 'Rossko не принял часть позиций',
  checkout_disabled: 'автозаказ выключен — закажите в ЛК Rossko и отметьте в админке',
  unknown_after_timeout: 'Rossko не ответил — проверьте ЛК Rossko: заказ мог создаться',
  checkout_failed: 'заказ у Rossko не прошёл',
  amount_mismatch: 'сумма платежа не совпала с суммой заказа',
  unexpected_payment: 'неожиданный платёж',
  'item_problem:declined': 'поставщик отказал по позиции',
  'item_problem:wrong': 'пришла не та деталь',
  'item_problem:damaged': 'деталь повреждена',
  'item_problem:delay': 'поставщик сдвинул срок',
};

export function attentionLabel(reason: string | null | undefined): string | null {
  if (!reason) return null;
  return ATTENTION_LABELS[reason] ?? 'нужна проверка в админке';
}

/** First line of a card posted for a staff template (later redraws show «Заказ …»). */
const HEADLINES: Partial<Record<OrderNotifyTemplate, string>> = {
  staff_new_order: 'Новый заказ',
  staff_problem: 'Проблема по заказу',
  staff_client_approved: 'Клиент согласен',
  staff_delay_hint: 'Срок сдвинулся',
  staff_delivery_failed: 'Курьер не передал заказ',
  staff_supplier_return_task: 'Не выкуплен — вернуть Rossko',
  staff_cancel_at_supplier_task:
    'Отказ клиента — отменить у Rossko через ЛК или менеджера до отгрузки, иначе возврат поставщику',
  staff_receipt_failed: 'Чек не прошёл — выдача заблокирована до чека',
  staff_approval_unreachable: 'Клиент не получил уведомление — позвоните клиенту',
  staff_amount_mismatch: 'Сумма платежа не совпала',
  staff_unexpected_payment: 'Неожиданный платёж',
  staff_supplier_invoice_due: 'Оплатить счёт Rossko',
  staff_refund_failed: 'Возврат не прошёл',
  staff_orphan_payment: 'Оплата после возврата',
  staff_refund_deadline: 'Срок возврата денег',
  staff_payment_rejected: 'ЮKassa не создала платёж',
  staff_refund_receipt_failed: 'Чек возврата не зарегистрирован',
  staff_claim_deadline: 'Претензия',
  staff_claim_opened: 'Претензия',
  staff_install_request: 'Запись на установку',
  // step 8: the deadline alerts and the GetOrders «shipped to the point» push
  staff_not_ordered: DEADLINE_ALERT_HEADLINES.not_ordered,
  staff_supplier_late: DEADLINE_ALERT_HEADLINES.supplier_late,
  staff_supplier_overdue: DEADLINE_ALERT_HEADLINES.supplier_overdue,
  staff_not_picked_up: DEADLINE_ALERT_HEADLINES.not_picked_up,
  staff_supplier_shipped: 'Отгружено Rossko',
};

export function headlineFor(template: OrderNotifyTemplate | null | undefined): string {
  return (template ? HEADLINES[template] : undefined) ?? 'Заказ';
}

/** Owner-only codes are labelled so a seller knows why the press is refused. */
const OWNER_LABEL_SUFFIX = ' (владелец)';

export interface CardOrder {
  id: string;
  number: string;
  status: OrderStatus;
  paymentScheme: PaymentScheme;
  totalKop: number;
  createdAt: Date;
  promisedDate: IsoDate | null;
  attentionReason: string | null;
  supplierReturnDeadlineAt: Date | null;
}

export interface CardItem {
  id: string;
  brand: string;
  article: string;
  qty: number;
  state: OrderItemState;
}

/** An open claim on the card (no texts: the client's description may hold PD). */
export interface CardClaim {
  id: string;
  kind: ClaimKind;
  /**
   * The claimed item; null for the whole order. `fitGuarantee` (step 4): ordered after the
   * master's check with the fit guarantee on — a «не подошла» claim says so.
   */
  item: (Pick<CardItem, 'brand' | 'article'> & { fitGuarantee?: boolean }) | null;
  deadlineAt: Date;
  returnAccepted: boolean;
  /** Photos the client attached (shown in the admin only). */
  photoCount: number;
  decision: ClaimDecision | null;
}

/** An active installation booking (requested / confirmed). No price anywhere. */
export interface CardBooking {
  id: string;
  /** 'чт 9 окт' */
  dayText: string;
  /** '14:00' */
  timeText: string;
  status: InstallBookingStatus;
}

/** A part going back to Rossko (step 7): waiting at the point or waiting for the money. */
export interface CardSupplierReturn {
  id: string;
  brand: string;
  article: string;
  qty: number;
  kind: SupplierReturnKind;
  status: SupplierReturnStatus;
  shippedAt: Date | null;
}

export interface CardData {
  order: CardOrder;
  items: CardItem[];
  /** The client's phone; only the last 4 digits are printed. */
  phone: string | null;
  actions: StaffActionView[];
  /** Phase 1C buttons (claims, bookings, «Фото упаковки»); after the 1B ones. */
  actions1C?: StaffActionView1C[];
  /** Open claims of the order (phase 1C). */
  claims?: CardClaim[];
  /** Active bookings of the order (phase 1C). */
  bookings?: CardBooking[];
  /** Packaging photos stored for the order (phase 1C). */
  packagingPhotos?: number;
  /** Open supplier returns of the order (step 7). */
  returns?: CardSupplierReturn[];
  /** «Сдал водителю» / «Не берут» per return still at the point (step 7). */
  returnActions?: SupplierReturnActionView[];
  /** APP_BASE_URL/admin/orders/<id>. */
  adminUrl: string;
  /**
   * Step 8: the shadow auto-order of the latest «Проверить и заказать» (journal
   * auto_order_shadow), shown while the order is on its way from the supplier.
   */
  autoOrder?: {
    decision: 'yes' | 'no';
    reasons: readonly AutoOrderReason[];
    maxTotalKop: number | null;
  } | null;
  headline?: string | null;
  /** Extra line without PD (recheck failure and the like). */
  note?: string | null;
}

/** A menu of one item (aliases, new ETA, item problem) shown instead of the main keyboard. */
export interface CardMenu {
  itemId: string;
  /** «Аналог для MANN W 914/2 — выберите:» */
  prompt: string;
  options: { code: MenuAction; label: string }[];
}

function itemTitle(item: Pick<CardItem, 'brand' | 'article'>): string {
  return `${item.brand} ${item.article}`;
}

export const BOOKING_STATUS_LABELS: Record<InstallBookingStatus, string> = {
  requested: 'ждёт подтверждения',
  confirmed: 'подтверждена',
  done: 'выполнена',
  cancelled: 'отменена',
  no_show: 'клиент не приехал',
};

/** Hint of a card in ordered_at_supplier (decision С17). */
export const PACKAGING_PHOTO_HINT =
  'Пришлите фото упаковки ответом на эту карточку, затем «Приехало»';

/**
 * «Претензия: брак · позиция MANN W 914/2 · ответить до 12 октября · возврат принят ✓ · фото
 * клиента: 2 (в админке)».
 */
export function claimLine(claim: CardClaim): string {
  const parts = [`Претензия: ${CLAIM_KIND_LABELS[claim.kind].toLowerCase()}`];
  parts.push(claim.item ? `позиция ${itemTitle(claim.item)}` : 'весь заказ');
  // Step 4: information only, the decision stays with the staff.
  const guarantee = fitGuaranteeClaimLabel(claim.kind, {
    fitGuarantee: claim.item?.fitGuarantee === true,
  });
  if (guarantee !== null) parts.push(guarantee);
  parts.push(`ответить до ${deadline(localDate(claim.deadlineAt))}`);
  // A delay needs no returned part (decision С8).
  if (claim.kind !== 'delay') parts.push(`возврат принят ${claim.returnAccepted ? '✓' : 'нет'}`);
  parts.push(
    claim.photoCount > 0 ? `фото клиента: ${claim.photoCount} (в админке)` : 'фото клиента: нет',
  );
  if (claim.decision !== null) {
    const decision = `решение: ${CLAIM_DECISION_LABELS[claim.decision].toLowerCase()}`;
    parts.push(
      claim.decision === 'replace'
        ? `${decision} — закажите замену, затем «Замена выдана»`
        : decision,
    );
  }
  return parts.join(' · ');
}

/**
 * Step 7: «Вернуть Rossko до 12 октября: MANN W 914/2 × 2 — «Сдал водителю» или «Не берут»» while
 * the part waits, «Возврат Rossko: MANN W 914/2 × 2 — сдан водителю 8 октября, ждём деньги» after.
 */
export function supplierReturnLine(ret: CardSupplierReturn, deadlineAt: Date | null): string {
  const part = `${itemTitle(ret)} × ${ret.qty}${ret.kind === 'claim' ? ' (рекламация)' : ''}`;
  if (ret.status === 'requested') {
    const until = deadlineAt ? ` до ${deadline(localDate(deadlineAt))}` : '';
    return `Вернуть Rossko${until}: ${part} — «Сдал водителю» или «Не берут»`;
  }
  const when = ret.shippedAt ? ` ${deadline(localDate(ret.shippedAt))}` : '';
  return ret.status === 'accepted'
    ? `Возврат Rossko: ${part} — принят поставщиком, ждём деньги`
    : `Возврат Rossko: ${part} — сдан водителю${when}, ждём деньги`;
}

/** «Запись на установку: чт 9 окт 14:00 — ждёт подтверждения». */
export function bookingLine(booking: CardBooking): string {
  return `Запись на установку: ${booking.dayText} ${booking.timeText} — ${BOOKING_STATUS_LABELS[booking.status]}`;
}

export function renderCardText(data: CardData, menu: CardMenu | null = null): string {
  const { order } = data;
  const lines: string[] = [];
  lines.push(`${data.headline ?? 'Заказ'} ${order.number}`);
  lines.push(
    `Статус: ${ORDER_STATUS_LABELS[order.status]} · ${SCHEME_LABELS[order.paymentScheme]}`,
  );
  const placed = formatReplyBy(order.createdAt);
  lines.push(`Сумма: ${formatRub(order.totalKop)}${placed ? ` · оформлен ${placed}` : ''}`);
  if (order.promisedDate) lines.push(`Срок: ${promise(order.promisedDate)}`);
  lines.push('Позиции:');
  for (const item of data.items) {
    lines.push(`• ${itemTitle(item)} × ${item.qty} — ${ITEM_STATE_LABELS[item.state]}`);
  }
  lines.push(`Клиент ${maskPhone(data.phone)}`);
  const attention =
    order.status === 'needs_attention' ? attentionLabel(order.attentionReason) : null;
  if (attention) lines.push(`Внимание: ${attention}`);
  if (data.autoOrder) {
    lines.push(
      autoOrderLine(
        { decision: data.autoOrder.decision, reasons: [...data.autoOrder.reasons] },
        { maxTotalKop: data.autoOrder.maxTotalKop },
      ),
    );
  }
  const returns = data.returns ?? [];
  if (returns.length > 0) {
    for (const ret of returns) lines.push(supplierReturnLine(ret, order.supplierReturnDeadlineAt));
  } else if (
    order.supplierReturnDeadlineAt &&
    data.headline === HEADLINES.staff_supplier_return_task
  ) {
    const date = formatReplyBy(order.supplierReturnDeadlineAt);
    if (date) lines.push(`Вернуть Rossko до ${date}`);
  }
  for (const claim of data.claims ?? []) lines.push(claimLine(claim));
  for (const booking of data.bookings ?? []) lines.push(bookingLine(booking));
  if ((data.packagingPhotos ?? 0) > 0) lines.push(`Фото упаковки: ${data.packagingPhotos}`);
  if (order.status === 'ordered_at_supplier') lines.push(PACKAGING_PHOTO_HINT);
  if (data.note) lines.push(data.note);
  const disabled = [...data.actions, ...(data.actions1C ?? [])].filter((action) => !action.enabled);
  for (const action of disabled) {
    lines.push(`«${action.label}» пока недоступно: ${action.disabledReason ?? 'проверьте заказ'}`);
  }
  if (menu) lines.push('', menu.prompt);
  return lines.join('\n');
}

function actionButton(view: StaffActionView, orderId: string, nonce: string): InlineButton {
  // Staff actions that are not event codes have a short callback code (retry_refund -> rrefund).
  const code = callbackCodeForStaffAction(view.code);
  const label = isOwnerOnlyAction(code) ? `${view.label}${OWNER_LABEL_SUFFIX}` : view.label;
  return {
    text: label,
    callback_data: buildCallbackData(code, view.itemId ?? orderId, nonce),
  };
}

/** A phase 1C button: the id is the claim, the booking or (pphoto) the order. */
function action1CButton(view: StaffActionView1C, orderId: string, nonce: string): InlineButton {
  return {
    text: view.label,
    callback_data: buildCallbackData(view.code, view.claimId ?? view.bookingId ?? orderId, nonce),
  };
}

/** A step 7 button: the id is the supplier return. */
function returnButton(view: SupplierReturnActionView, nonce: string): InlineButton {
  return {
    text: view.label,
    callback_data: buildCallbackData(view.code, view.supplierReturnId, nonce),
  };
}

export function adminRow(adminUrl: string): InlineButton[] {
  return [{ text: 'Открыть в админке', url: adminUrl }];
}

/** Enabled actions, one per row, then the admin link. Disabled ones are listed in the text. */
export function mainKeyboard(data: CardData, nonce: string): InlineKeyboard {
  const rows: InlineKeyboard = data.actions
    .filter((action) => action.enabled)
    .map((action) => [actionButton(action, data.order.id, nonce)]);
  for (const action of data.actions1C ?? []) {
    if (action.enabled) rows.push([action1CButton(action, data.order.id, nonce)]);
  }
  for (const action of data.returnActions ?? []) {
    if (action.enabled) rows.push([returnButton(action, nonce)]);
  }
  rows.push(adminRow(data.adminUrl));
  return rows;
}

export function menuKeyboard(data: CardData, menu: CardMenu, nonce: string): InlineKeyboard {
  const rows: InlineKeyboard = menu.options.map((option) => [
    { text: option.label, callback_data: buildCallbackData(option.code, menu.itemId, nonce) },
  ]);
  rows.push([
    { text: MENU_ACTIONS.back.label, callback_data: buildCallbackData('back', menu.itemId, nonce) },
  ]);
  rows.push(adminRow(data.adminUrl));
  return rows;
}

/** Menu codes of the alias options, in the order of the recheck alternatives. */
export const ALTERNATIVE_CODES = ['alt1', 'alt2', 'alt3'] as const satisfies readonly MenuAction[];
export const PROBLEM_CODES = [
  'pdecl',
  'pwrong',
  'pdmg',
  'pdelay',
] as const satisfies readonly MenuAction[];

const ETA_CODES: Record<(typeof ETA_MENU_DAYS)[number], MenuAction> = {
  2: 'eta2',
  5: 'eta5',
  7: 'eta7',
  14: 'eta14',
};

/**
 * Label of a recheck alternative: «FILTRON OP 520 · маржа 30% · к 7 октября». The client price
 * stays the price of the replaced item (RecheckAlternative), so the seller sees the margin at that
 * price and the date (PLAN: «карточка проблемы с альтернативами из кроссов и маржой»).
 */
export function alternativeLabel(
  alternative: Pick<RecheckAlternative, 'offer' | 'marginBp' | 'etaDate'>,
): string {
  const parts = [
    `${alternative.offer.brand} ${alternative.offer.article}`,
    `маржа ${Math.round(alternative.marginBp / 100)}%`,
  ];
  if (alternative.etaDate) parts.push(`к ${deadline(alternative.etaDate)}`);
  return parts.join(' · ');
}

/** «Аналог»: options from the latest recheck alternatives (labels, at most 3, same order). */
export function alternativeMenu(item: CardItem, labels: readonly string[]): CardMenu {
  return {
    itemId: item.id,
    prompt: `Аналог для ${itemTitle(item)} — выберите, клиенту уйдёт вопрос:`,
    options: ALTERNATIVE_CODES.slice(0, labels.length).map((code, index) => ({
      code,
      label: labels[index] ?? MENU_ACTIONS[code].label,
    })),
  };
}

/** «Новый срок»: today (client calendar) + 2 / 5 / 7 / 14 days. */
export function etaMenu(item: CardItem, today: IsoDate): CardMenu {
  return {
    itemId: item.id,
    prompt: `Новый срок для ${itemTitle(item)} — выберите, клиенту уйдёт вопрос:`,
    options: ETA_MENU_DAYS.map((days) => {
      const code = ETA_CODES[days];
      return { code, label: `${MENU_ACTIONS[code].label} (${deadline(addDays(today, days))})` };
    }),
  };
}

export function problemMenu(item: CardItem): CardMenu {
  return {
    itemId: item.id,
    prompt: `Что случилось с ${itemTitle(item)}?`,
    options: PROBLEM_CODES.map((code) => ({ code, label: MENU_ACTIONS[code].label })),
  };
}
