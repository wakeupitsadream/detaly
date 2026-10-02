/**
 * SMS text: segment counting (GSM 03.38 or UCS-2) and rendering of a template message into at
 * most two segments without losing the link to the order page.
 *
 * One segment holds 160 GSM-7 or 70 UCS-2 characters; a concatenated message spends a header on
 * every part, leaving 153 / 67. Any Cyrillic letter turns the whole message into UCS-2, so a
 * two-segment Russian SMS is 134 characters, the URL included. VERIFY: SMS Aero and smsc count
 * segments the same way (both document the 70/67 rule; tariff per segment).
 */
import type { RenderedMessage } from './types';

/** GSM 03.38 basic character set. */
const GSM7_BASIC = new Set(
  '@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?' +
    '¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà',
);
/** GSM 03.38 extension table: each costs two septets (escape + char). */
const GSM7_EXTENDED = new Set('^{}\\[~]|€\f');

export type SmsEncoding = 'gsm7' | 'ucs2';

export interface SmsSegmentInfo {
  encoding: SmsEncoding;
  /** Characters as the gateway counts them: septets for GSM-7, UTF-16 units for UCS-2. */
  units: number;
  segments: number;
}

const LIMITS = {
  gsm7: { single: 160, multi: 153 },
  ucs2: { single: 70, multi: 67 },
} as const;

function gsm7Units(text: string): number | null {
  let units = 0;
  for (const ch of text) {
    if (GSM7_BASIC.has(ch)) units += 1;
    else if (GSM7_EXTENDED.has(ch)) units += 2;
    else return null;
  }
  return units;
}

export function smsSegments(text: string): SmsSegmentInfo {
  const gsm = gsm7Units(text);
  const encoding: SmsEncoding = gsm === null ? 'ucs2' : 'gsm7';
  const units = gsm ?? text.length;
  const limit = LIMITS[encoding];
  const segments = units === 0 ? 0 : units <= limit.single ? 1 : Math.ceil(units / limit.multi);
  return { encoding, units, segments };
}

/** Largest number of units that fits into `segments` parts of the encoding. */
export function smsCapacity(encoding: SmsEncoding, segments: number): number {
  const limit = LIMITS[encoding];
  return segments <= 1 ? limit.single : limit.multi * segments;
}

export const SMS_MAX_SEGMENTS = 2;

/** Cuts `text` (by code points) so that its UCS-2 length is at most `max`, ending with '…'. */
function cut(text: string, max: number): string {
  if (text.length <= max) return text;
  if (max <= 1) return '';
  let out = '';
  for (const ch of text) {
    if (out.length + ch.length > max - 1) break;
    out += ch;
  }
  return `${out.trimEnd()}…`;
}

/**
 * Plain text for SMS: `smsText` (or `text`) plus the URLs of url buttons (action buttons are
 * dropped: SMS has no buttons). When the result exceeds `maxSegments`, the text is shortened
 * and the URLs are kept whole. The ellipsis turns a GSM-7 text into UCS-2, so the budget is
 * counted in UCS-2 whenever the text has to be cut.
 */
export function renderSmsText(
  message: RenderedMessage,
  { maxSegments = SMS_MAX_SEGMENTS }: { maxSegments?: number } = {},
): string {
  const urls = message.buttons.flat().flatMap((b) => (b.kind === 'url' ? [b.url] : []));
  const text = message.smsText ?? message.text;
  const full = [text, ...urls].filter((part) => part !== '').join('\n');
  if (smsSegments(full).segments <= maxSegments) return full;

  const tail = urls.join('\n');
  const capacity = smsCapacity('ucs2', maxSegments);
  // The newline between the text and the URLs counts too.
  const budget = capacity - tail.length - (tail === '' ? 0 : 1);
  const shortened = cut(text, budget);
  return [shortened, tail].filter((part) => part !== '').join('\n');
}
