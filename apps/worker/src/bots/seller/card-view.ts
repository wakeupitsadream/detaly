// Pure rendering of seller cards (decision Б17, docs/phase-1b-implementation.md section 13.1):
// the text is drawn from the database state (number, scheme, sum, date, items with their states,
// the masked client phone, the needs_attention reason), the buttons from availableStaffActions.
// No full phone, no address, no order token: the sellers chat lives in Telegram (PD minimisation).
import {
  addDays,
  formatRub,
  type IsoDate,
  type OrderItemState,
  type OrderNotifyTemplate,
  type OrderStatus,
  type PaymentScheme,
} from '@detaly/domain';
import {
  buildCallbackData,
  deadline,
  formatReplyBy,
  maskPhone,
  MENU_ACTIONS,
  promise,
  type MenuAction,
} from '@detaly/notify';
import { ETA_MENU_DAYS, ORDER_STATUS_LABELS, type StaffActionView } from '@detaly/orders';

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
  staff_claim_deadline: 'Претензия',
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

export interface CardData {
  order: CardOrder;
  items: CardItem[];
  /** The client's phone; only the last 4 digits are printed. */
  phone: string | null;
  actions: StaffActionView[];
  /** APP_BASE_URL/admin/orders/<id>. */
  adminUrl: string;
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
  if (order.supplierReturnDeadlineAt && data.headline === HEADLINES.staff_supplier_return_task) {
    const date = formatReplyBy(order.supplierReturnDeadlineAt);
    if (date) lines.push(`Вернуть Rossko до ${date}`);
  }
  if (data.note) lines.push(data.note);
  const disabled = data.actions.filter((action) => !action.enabled);
  for (const action of disabled) {
    lines.push(`«${action.label}» пока недоступно: ${action.disabledReason ?? 'проверьте заказ'}`);
  }
  if (menu) lines.push('', menu.prompt);
  return lines.join('\n');
}

function actionButton(view: StaffActionView, orderId: string, nonce: string): InlineButton {
  const label = view.code === 'invpaid' ? `${view.label}${OWNER_LABEL_SUFFIX}` : view.label;
  return {
    text: label,
    callback_data: buildCallbackData(view.code, view.itemId ?? orderId, nonce),
  };
}

function adminRow(adminUrl: string): InlineButton[] {
  return [{ text: 'Открыть в админке', url: adminUrl }];
}

/** Enabled actions, one per row, then the admin link. Disabled ones are listed in the text. */
export function mainKeyboard(data: CardData, nonce: string): InlineKeyboard {
  const rows: InlineKeyboard = data.actions
    .filter((action) => action.enabled)
    .map((action) => [actionButton(action, data.order.id, nonce)]);
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

/** «Аналог»: options from the engine's menu (labels of the recheck alternatives, at most 3). */
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
