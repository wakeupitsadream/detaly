/**
 * Client phone numbers. Identity is the phone in E.164, and only the +7 numbering plan
 * (Russia and Kazakhstan) is accepted: SMS and the pickup point serve local clients only.
 */

/** Separators people type inside a number: spaces, brackets, dashes, dots. */
const SEPARATORS_RE = /[\s().‐-―-]/g;
/**
 * National significant number: 10 digits, first one 3, 4, 8 (ABC, geographic, and 800-809
 * non-geographic) or 9 (DEF, mobile). Codes 88x and 89x are not allocated: a 10-digit input
 * starting with 89 is almost always '8 9xx…' with a digit missing, and reading it as
 * +7 89x… would send order statuses to a stranger's number.
 */
const NSN_RE = /^(?:[349]\d|8[0-7])\d{8}$/;

/**
 * '8 (912) 345-67-89', '+7 912 345 67 89', '79123456789' and '9123456789' -> '+79123456789'.
 * Anything else (other countries, wrong length, letters, empty) -> null.
 */
export function normalizePhone(input: string): string | null {
  if (typeof input !== 'string') return null;
  const compact = input.trim().replace(SEPARATORS_RE, '');
  let nsn: string;
  if (/^\+7\d{10}$/.test(compact)) nsn = compact.slice(2);
  else if (/^[78]\d{10}$/.test(compact)) nsn = compact.slice(1);
  else if (/^\d{10}$/.test(compact)) nsn = compact;
  else return null;
  return NSN_RE.test(nsn) ? `+7${nsn}` : null;
}

/**
 * A mobile (DEF 9xx) number in E.164, or null. Checkout accepts only these: SMS is the fallback
 * channel for confirmations and decisions (PLAN), and a landline or an 8-800 number cannot
 * receive it.
 */
export function normalizeMobilePhone(input: string): string | null {
  const e164 = normalizePhone(input);
  return e164 !== null && e164.startsWith('+79') ? e164 : null;
}

/** Last four digits ('+79123456789' -> '6789'): the order cancellation check. */
export function phoneLast4(e164: string): string {
  return e164.replace(/\D/g, '').slice(-4);
}

/** '+79123456789' -> '+7 ••• •••-67-89': cards and logs without the full number. */
export function maskPhone(e164: string): string {
  const last4 = phoneLast4(e164).padStart(4, '•');
  return `+7 ••• •••-${last4.slice(0, 2)}-${last4.slice(2)}`;
}
