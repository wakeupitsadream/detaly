/**
 * Wording and formatting of the admin pages (staff language, Asia/Yekaterinburg time).
 */
import {
  CLIENT_TIME_ZONE,
  formatRub,
  isOneOf,
  ORDER_STATUSES,
  type OrderItemState,
  type OrderStatus,
  type PaymentScheme,
} from '@detaly/domain';
import { ORDER_STATUS_LABELS } from '@detaly/orders';

export function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** Staff wording of a status («Требует внимания»); an unknown value is shown as is. */
export function adminStatusLabel(status: string): string {
  return isOneOf(ORDER_STATUSES, status)
    ? capitalize(ORDER_STATUS_LABELS[status as OrderStatus])
    : status;
}

export const SCHEME_LABELS: Record<PaymentScheme, string> = {
  prepay: 'Предоплата',
  pay_on_handover: 'При получении',
};

export const ITEM_STATE_LABELS: Record<OrderItemState, string> = {
  pending: 'ждёт заказа',
  ordered: 'заказана',
  failed: 'не заказана',
  replaced: 'заменена',
  arrived: 'приехала',
  handed: 'выдана',
  return_requested: 'возврат запрошен',
  returned: 'возвращена',
  refund_pending: 'возврат денег',
  refunded: 'деньги возвращены',
};

export const ATTENTION_LABELS: Record<string, string> = {
  price_drift: 'Цена выросла выше допуска',
  unavailable: 'Нет в наличии',
  item_errors: 'Rossko не принял часть позиций',
  checkout_disabled: 'Автозаказ выключен — закажите в ЛК Rossko и отметьте здесь',
  unknown_after_timeout: 'Проверьте ЛК Rossko: заказ мог создаться',
  checkout_failed: 'Заказ у Rossko не прошёл',
  amount_mismatch: 'Сумма оплаты не совпала с заказом',
  unexpected_payment: 'Неожиданный платёж',
  'item_problem:declined': 'Проблема с позицией: отказ поставщика',
  'item_problem:wrong': 'Проблема с позицией: приехало не то',
  'item_problem:damaged': 'Проблема с позицией: повреждено',
  'item_problem:delay': 'Проблема с позицией: сдвиг срока',
};

export function attentionLabel(reason: string | null): string | null {
  if (reason === null) return null;
  return ATTENTION_LABELS[reason] ?? reason;
}

export const rub = formatRub;

const DATE_TIME = new Intl.DateTimeFormat('ru-RU', {
  timeZone: CLIENT_TIME_ZONE,
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

/** 02.10.2026, 14:05 (Asia/Yekaterinburg); «—» for null. */
export function dateTime(value: Date | null | undefined): string {
  return value ? DATE_TIME.format(value) : '—';
}

/** 2026-10-08 -> 08.10.2026; «—» for null. */
export function isoDate(value: string | null | undefined): string {
  if (!value) return '—';
  const [y, m, d] = value.split('-');
  return y && m && d ? `${d}.${m}.${y}` : value;
}

/** Payload of a journal row as indented JSON (ids, codes and amounts only, no PD). */
export function payloadText(payload: unknown): string {
  try {
    return JSON.stringify(payload ?? {}, null, 2);
  } catch {
    return String(payload);
  }
}
