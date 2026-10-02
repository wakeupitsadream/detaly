/** Small formatting helpers shared by templates. */
import { formatPromise, formatRub } from '@detaly/domain';
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
