/** Small formatting helpers shared by templates. */
import {
  CLIENT_TIME_ZONE,
  formatDayMonth,
  formatPromise,
  formatRub,
  isIsoDate,
  localDate,
} from '@detaly/domain';
import type { IsoDate, Kop } from '@detaly/domain/types';

/** '+7 999 123-45-67' -> '•••4567'; anything without 4 digits -> '•••'. */
export function maskPhone(phone: string | null | undefined): string {
  const digits = (phone ?? '').replace(/\D/gu, '');
  return digits.length >= 4 ? `•••${digits.slice(-4)}` : '•••';
}

export function itemsLine(items: readonly { brand: string; article: string }[]): string {
  if (items.length === 0) return '';
  const shown = items.slice(0, 3).map((i) => `${i.brand} ${i.article}`);
  const more = items.length > 3 ? ` и ещё ${items.length - 3}` : '';
  return `${shown.join(', ')}${more}`;
}

export function promise(date: IsoDate | null | undefined): string {
  return date ? formatPromise(date) : 'в ближайшие дни';
}

export function rub(kop: Kop | null | undefined): string {
  return typeof kop === 'number' ? formatRub(kop) : '—';
}

export function lines(...parts: (string | null | undefined | false)[]): string {
  return parts.filter((p): p is string => typeof p === 'string' && p !== '').join('\n');
}

const CLIENT_CLOCK = new Intl.DateTimeFormat('en-GB', {
  timeZone: CLIENT_TIME_ZONE,
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

/**
 * An instant as the client's wall clock: '2026-10-03T09:30:00Z' -> '14:30 3 октября'
 * (Asia/Yekaterinburg). null for a missing or unparsable value.
 */
export function formatReplyBy(value: Date | string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const instant = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(instant.getTime())) return null;
  const parts: Record<string, string> = {};
  for (const part of CLIENT_CLOCK.formatToParts(instant)) parts[part.type] = part.value;
  return `${parts.hour}:${parts.minute} ${formatDayMonth(localDate(instant))}`;
}

/** '2026-10-20' -> '20 октября'; anything else is returned as is, missing -> fallback. */
export function deadline(date: IsoDate | null | undefined, fallback = '—'): string {
  if (date === null || date === undefined || date === '') return fallback;
  return isIsoDate(date) ? formatDayMonth(date) : date;
}
