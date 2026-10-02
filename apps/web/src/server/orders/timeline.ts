/**
 * Client timeline of an order from order_events (docs/phase-1a-implementation.md 7.1, item 4):
 * events in time order, each as a human phrase with the time in the client time zone.
 * Payloads are never shown (they may hold internal details).
 */
import { CLIENT_TIME_ZONE, formatDayMonth, localDate } from '@detaly/domain';
import { orderStatusLabel } from './status-labels';

/** The fields of an order_events row the timeline needs. */
export interface TimelineEvent {
  id: string;
  type: string;
  fromStatus: string | null;
  toStatus: string | null;
  createdAt: Date;
}

export interface TimelineEntry {
  id: string;
  /** ISO instant for <time dateTime>. */
  at: string;
  /** '2 октября, 14:05' (Asia/Yekaterinburg). */
  timeText: string;
  text: string;
}

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
 * Phrase of one event. Known 1A events get their own wording; any other status change reads
 * «Статус заказа: <статус>». Events without a target status (notes, technical records) are
 * not shown: null.
 */
export function eventPhrase(event: Pick<TimelineEvent, 'type' | 'toStatus'>): string | null {
  if (event.type === 'checkout') {
    if (event.toStatus === 'awaiting_payment') return 'Заказ оформлен, ждём оплату';
    if (event.toStatus === 'awaiting_confirmation') return 'Заказ оформлен, оплата при получении';
  }
  if (event.type === 'client_cancelled') return 'Вы отменили заказ';
  if (event.toStatus === null) return null;
  return `Статус заказа: ${orderStatusLabel(event.toStatus)}`;
}

/** Oldest first; ties broken by id (uuid v7 is time ordered). */
export function buildTimeline(
  events: readonly TimelineEvent[],
  timeZone: string = CLIENT_TIME_ZONE,
): TimelineEntry[] {
  return [...events]
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id))
    .flatMap((event) => {
      const text = eventPhrase(event);
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
