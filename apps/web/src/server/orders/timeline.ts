/**
 * Client timeline of an order from order_events (docs/phase-1a-implementation.md 7.1, item 4;
 * phase 1B section 14.4): events in time order, each as a human phrase with the time in the
 * client time zone. Every transition event (ORDER_EVENTS) and journal event (JOURNAL_EVENTS)
 * has a phrase or is hidden on purpose: service records (reminders, rechecks, stale webhooks,
 * payment attempts, seller-only steps) mean nothing to the client.
 *
 * Payloads are never shown: only a few fields steer the wording (the item an event is about,
 * the receipt kind), and an item is named by brand and article only.
 */
import {
  CLAIM_DECISION_LABELS,
  CLIENT_TIME_ZONE,
  formatDayMonth,
  installSlotOf,
  localDate,
  type ClaimDecision,
  type JournalEvent,
  type OrderEvent,
} from '@detaly/domain';
import { orderStatusLabel } from './status-labels';

/** The fields of an order_events row the timeline needs. */
export interface TimelineEvent {
  id: string;
  type: string;
  fromStatus: string | null;
  toStatus: string | null;
  createdAt: Date;
  actorType?: string | null;
  payload?: unknown;
}

export interface TimelineEntry {
  id: string;
  /** ISO instant for <time dateTime>. */
  at: string;
  /** '2 октября, 14:05' (Asia/Yekaterinburg). */
  timeText: string;
  text: string;
}

/** Items by id for wording (brand and article only). */
export type TimelineItems = ReadonlyMap<string, { brand: string; article: string }>;

const timeFormatters = new Map<string, Intl.DateTimeFormat>();

function timeFormatter(timeZone: string): Intl.DateTimeFormat {
  let formatter = timeFormatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-GB', {
      timeZone,
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    });
    timeFormatters.set(timeZone, formatter);
  }
  return formatter;
}

/** 2026-10-02T09:05:00Z -> '2 октября, 14:05' (own month names, ICU only for the clock). */
export function formatEventTime(at: Date, timeZone: string = CLIENT_TIME_ZONE): string {
  const parts = timeFormatter(timeZone).formatToParts(at);
  const get = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((p) => p.type === type)?.value ?? '00';
  return `${formatDayMonth(localDate(at, timeZone))}, ${get('hour')}:${get('minute')}`;
}

/**
 * Events never shown to the client. Transition events here are steps of the sellers (QR,
 * receipts, Rossko invoice) or alerts for the owner; journal events are service records.
 */
export const HIDDEN_TIMELINE_EVENTS: ReadonlySet<OrderEvent | JournalEvent> = new Set<
  OrderEvent | JournalEvent
>([
  'checkout_stale',
  'supplier_invoice_paid',
  'client_arrived',
  'offset_receipt_requested',
  'refund_failed',
  'partial_refund_failed',
  'recheck_requested',
  'recheck_result',
  'payment_created',
  'payment_status',
  'receipt_failed',
  'receipt_retry_requested',
  'refund_created',
  'approval_created',
  'approval_notified',
  'approval_unreachable',
  'approval_reminder',
  'reminder',
  'supplier_order_manual',
  'supplier_return_created',
  'stock_item_created',
  'webhook_stale',
  'deferred_1a_processed',
  'claim_deferred',
  // Phase 1C (section 10.5): a reminder is a service record; switching the notifications off
  // is the person's choice in the bot and says nothing about the order.
  'install_reminder',
  'messenger_unbound',
]);

type PhraseInput = Pick<TimelineEvent, 'type' | 'toStatus'> &
  Partial<Pick<TimelineEvent, 'fromStatus' | 'actorType' | 'payload'>>;

function payloadField(payload: unknown, key: string): unknown {
  return typeof payload === 'object' && payload !== null
    ? (payload as Record<string, unknown>)[key]
    : undefined;
}

/** «Knecht OC 90» of the event's item, or null. */
function itemTitle(event: PhraseInput, items: TimelineItems | undefined): string | null {
  const id = payloadField(event.payload, 'itemId');
  if (typeof id !== 'string' || items === undefined) return null;
  const item = items.get(id);
  return item ? `${item.brand} ${item.article}` : null;
}

function withItem(text: string, title: string | null): string {
  return title === null ? text : `${text}: ${title}`;
}

/** 'чт 8 окт, 14:00' of an installation booking (payload.slotAt), or null. */
function slotText(payload: unknown, timeZone: string = CLIENT_TIME_ZONE): string | null {
  const raw = payloadField(payload, 'slotAt');
  if (typeof raw !== 'string') return null;
  const start = new Date(raw);
  if (Number.isNaN(start.getTime())) return null;
  const slot = installSlotOf({ slotStart: start, carReadyAt: start }, timeZone);
  return `${slot.dayText}, ${slot.timeText}`;
}

const RECEIPT_PHRASES: Record<string, string> = {
  prepayment: 'Чек об оплате отправлен',
  full: 'Чек об оплате отправлен',
  offset: 'Чек о получении заказа отправлен',
  refund_prepayment: 'Чек возврата отправлен',
  refund_full: 'Чек возврата отправлен',
};

/** Phrases of transition events (PLAN section 3); null hides the event. */
function transitionPhrase(event: PhraseInput, items: TimelineItems | undefined): string | null {
  const to = event.toStatus;
  const from = event.fromStatus ?? null;
  const byClient = event.actorType === 'client';
  const item = itemTitle(event, items);
  switch (event.type as OrderEvent) {
    case 'checkout':
      if (to === 'awaiting_payment') return 'Заказ оформлен, ждём оплату';
      if (to === 'awaiting_confirmation') return 'Заказ оформлен, оплата при получении';
      return 'Заказ оформлен';
    case 'payment_succeeded':
      if (from === 'cancelled') return 'Оплата пришла после отмены заказа — возвращаем деньги';
      if (to === 'needs_attention') return 'Оплата получена, уточняем детали заказа';
      if (from === to && (to === 'handed' || to === 'completed' || to === 'refund_pending')) {
        return 'Получена лишняя оплата — мы свяжемся с вами и вернём её';
      }
      return 'Оплата получена';
    case 'payment_canceled':
      if (to === 'cancelled') return 'Платёж не прошёл, заказ отменён';
      if (from === 'awaiting_handover_payment') return 'Оплата на месте не прошла';
      return 'Платёж не прошёл — оплатите заказ при получении';
    case 'payment_ttl_expired':
      if (to === 'cancelled') return 'Срок оплаты истёк, заказ отменён';
      if (from === 'awaiting_handover_payment') return 'Срок действия QR-кода для оплаты истёк';
      return 'Срок оплаты истёк — оплатите заказ при получении';
    case 'client_confirmed':
      return 'Вы подтвердили заказ';
    case 'confirmation_timeout':
      return 'Заказ не подтверждён вовремя и отменён';
    case 'client_cancelled':
      return 'Вы отменили заказ';
    case 'supplier_order_requested':
      return to === 'needs_attention'
        ? 'Уточняем наличие и цену у поставщика'
        : 'Заказываем детали у поставщика';
    case 'supplier_checkout_succeeded':
      if (to === 'needs_attention') return 'Часть позиций не удалось заказать, уточняем';
      if (from === 'ordered_at_supplier') return 'Позиция заказана у поставщика повторно';
      return 'Заказали детали у поставщика';
    case 'supplier_checkout_failed':
      return 'Не удалось заказать у поставщика, уточняем';
    case 'item_problem':
      return withItem('С позицией возникла проблема, уточняем', item);
    case 'order_anyway':
      return 'Продолжаем выполнять заказ';
    case 'alternative_proposed':
      return 'Предлагаем замену позиции — нужно ваше решение';
    case 'new_eta_proposed':
      return 'Предлагаем новый срок — нужно ваше решение';
    case 'client_approved':
      return 'Вы согласились с предложением';
    case 'client_refund_requested':
      return 'Вы выбрали возврат денег';
    case 'approval_timeout':
      return 'Ответа на предложение не было — оформляем возврат';
    case 'item_cancelled':
      return withItem(byClient ? 'Вы отменили позицию' : 'Позиция отменена', item);
    case 'order_cancelled':
      return to === 'refund_pending' ? 'Заказ отменён, возвращаем деньги' : 'Заказ отменён';
    case 'item_arrived':
      return to === 'ready' ? 'Заказ приехал и готов к выдаче' : withItem('Приехала позиция', item);
    case 'item_damaged_on_receipt':
      return withItem('Позиция пришла повреждённой — заказали замену', item);
    case 'eta_changed':
      return 'Срок поставки изменился';
    case 'handover_payment_requested':
      return 'Ждём оплату заказа на месте';
    case 'handed_over':
      return 'Заказ выдан';
    case 'switch_to_prepay':
      return byClient ? 'Вы решили оплатить заказ заранее' : 'Заказ переведён на предоплату';
    case 'courier_dispatched':
      return 'Заказ передан курьеру';
    case 'delivery_failed':
      return 'Курьер не смог передать заказ';
    case 'storage_expired':
      return to === 'refund_pending'
        ? 'Срок хранения истёк — возвращаем деньги'
        : 'Срок хранения истёк, заказ отменён';
    case 'completion_timeout':
      return 'Заказ завершён';
    case 'claim_opened':
      return to === 'handed' || to === 'completed'
        ? 'Претензия принята'
        : 'Претензия о просрочке принята';
    case 'claim_refund_approved':
      return withItem('Возврат по претензии одобрен', item);
    case 'client_refused':
      if (to === 'refund_pending') {
        return byClient
          ? 'Вы отказались от заказа — возвращаем деньги'
          : 'Заказ отменён — возвращаем деньги';
      }
      return byClient ? 'Вы отказались от заказа' : 'Заказ отменён';
    case 'refund_succeeded':
      return 'Деньги отправлены';
    case 'partial_refund_succeeded':
      return 'Деньги за позицию отправлены';
    // Hidden (HIDDEN_TIMELINE_EVENTS): seller-only steps and owner alerts.
    case 'checkout_stale':
    case 'supplier_invoice_paid':
    case 'client_arrived':
    case 'offset_receipt_requested':
    case 'refund_failed':
    case 'partial_refund_failed':
      return null;
    default:
      // Not an OrderEvent (a journal or an unknown type).
      return null;
  }
}

/** Phrases of journal events that the client should see. */
function journalPhrase(event: PhraseInput): string | null {
  switch (event.type as JournalEvent) {
    case 'receipt_succeeded': {
      const kind = payloadField(event.payload, 'kind');
      return typeof kind === 'string' ? (RECEIPT_PHRASES[kind] ?? null) : null;
    }
    case 'orphan_payment': {
      const status = payloadField(event.payload, 'status');
      if (status === undefined) return 'Получена повторная оплата — возвращаем её';
      return status === 'succeeded' ? 'Повторная оплата возвращена' : null;
    }
    // Hidden (HIDDEN_TIMELINE_EVENTS): service records.
    case 'recheck_requested':
    case 'recheck_result':
    case 'payment_created':
    case 'payment_status':
    case 'receipt_failed':
    case 'receipt_retry_requested':
    case 'refund_created':
    case 'approval_created':
    case 'approval_notified':
    case 'approval_unreachable':
    case 'approval_reminder':
    case 'reminder':
    case 'supplier_order_manual':
    case 'supplier_return_created':
    case 'stock_item_created':
    case 'webhook_stale':
    case 'deferred_1a_processed':
    case 'claim_deferred':
      return null;
    // Phase 1C (section 10.5): claims, installation bookings, notifications, photos.
    case 'claim_return_accepted':
      return 'Мастер принял возвращённую деталь';
    case 'claim_decided': {
      const decision = payloadField(event.payload, 'decision');
      return typeof decision === 'string' && Object.hasOwn(CLAIM_DECISION_LABELS, decision)
        ? `Ответ по претензии готов: ${CLAIM_DECISION_LABELS[decision as ClaimDecision].toLowerCase()}`
        : 'Ответ по претензии готов';
    }
    case 'claim_closed':
      return payloadField(event.payload, 'decision') === 'replace'
        ? 'Замена выдана, претензия закрыта'
        : 'Претензия закрыта';
    case 'claim_compensation':
      return 'Назначена компенсация за просрочку';
    case 'install_requested': {
      const slot = slotText(event.payload);
      return slot === null
        ? 'Запись на установку, ждём подтверждения мастера'
        : `Запись на установку: ${slot}, ждём подтверждения мастера`;
    }
    case 'install_confirmed': {
      const slot = slotText(event.payload);
      return slot === null
        ? 'Мастер подтвердил запись на установку'
        : `Мастер подтвердил запись на установку: ${slot}`;
    }
    case 'install_declined':
      return 'Мастер не сможет принять в выбранное время — выберите другое';
    case 'install_cancelled':
      return event.actorType === 'client'
        ? 'Вы отменили запись на установку'
        : 'Запись на установку отменена';
    case 'install_done':
      return 'Установка выполнена';
    case 'install_no_show':
      return 'Запись на установку пропущена';
    case 'messenger_bound':
      return payloadField(event.payload, 'channel') === 'max'
        ? 'Уведомления о статусе подключены в MAX'
        : 'Уведомления о статусе подключены в Telegram';
    case 'photo_added':
      return payloadField(event.payload, 'kind') === 'handover'
        ? 'Добавлено фото выдачи'
        : 'Добавлено фото упаковки';
    case 'vin_order':
      return 'Заказ собран по подборке мастера';
    // Hidden (HIDDEN_TIMELINE_EVENTS).
    case 'install_reminder':
    case 'messenger_unbound':
      return null;
    default:
      // Not a JournalEvent: an unknown type.
      return null;
  }
}

/**
 * Phrase of one event, or null when it is hidden. An unknown event that changed the status
 * reads «Статус заказа: <статус>»; unknown events without a status change are hidden.
 */
export function eventPhrase(event: PhraseInput, items?: TimelineItems): string | null {
  if (HIDDEN_TIMELINE_EVENTS.has(event.type as OrderEvent)) return null;
  const phrase = transitionPhrase(event, items) ?? journalPhrase(event);
  if (phrase !== null) return phrase;
  if (event.toStatus === null || event.toStatus === (event.fromStatus ?? null)) {
    return null;
  }
  return `Статус заказа: ${orderStatusLabel(event.toStatus)}`;
}

/** Oldest first; ties broken by id (uuid v7 is time ordered). */
export function buildTimeline(
  events: readonly TimelineEvent[],
  timeZone: string = CLIENT_TIME_ZONE,
  items?: TimelineItems,
): TimelineEntry[] {
  return [...events]
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id))
    .flatMap((event) => {
      const text = eventPhrase(event, items);
      if (text === null) return [];
      return [
        {
          id: event.id,
          at: event.createdAt.toISOString(),
          timeText: formatEventTime(event.createdAt, timeZone),
          text,
        },
      ];
    });
}
