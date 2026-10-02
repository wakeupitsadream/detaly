/**
 * Seller requisites that are not set yet (a demo before the launch, SELLER_REQUISITES_* empty):
 * one neutral line instead of «уточняется» in every row, and blanks instead of the seed's
 * «[не задано: …]» markers in a draft legal text. Pure, shared by the footer plate, /about and
 * the legal sheet.
 */

/** Shown wherever the seller's requisites would be while none of them is set. */
export const REQUISITES_PENDING = 'Реквизиты продавца появятся к запуску';

/** Under the rows that are set while others are still missing. */
export const REQUISITES_PARTIAL = 'Остальные реквизиты появятся к запуску';

export interface SellerRequisites {
  name: string | null;
  inn: string | null;
  ogrnip: string | null;
  address: string | null;
  email: string | null;
  phone: string | null;
}

/** True when at least one requisite of the seller is set. */
export function hasSellerRequisites(seller: SellerRequisites): boolean {
  return Object.values(seller).some((value) => value !== null && value.trim() !== '');
}

/** The marker renderLegal leaves in a draft for an env value that is not set. */
const MISSING_VALUE_RE = /\[не задано: ([A-Z0-9_]+)\]/g;

/** A blank to be filled in, as on a paper form. */
export const LEGAL_BLANK = '________';

/** Placeholder names a rendered draft still has no value for, e.g. ['SELLER_INN']. */
export function missingLegalValues(text: string): string[] {
  return [...new Set(Array.from(text.matchAll(MISSING_VALUE_RE), (match) => match[1] ?? ''))];
}

/** The one line above a legal text with blanks: what is missing and why the gaps. */
export function legalBlanksNotice(missing: readonly string[]): string | null {
  if (missing.length === 0) return null;
  const what = missing.some((name) => name.startsWith('SELLER_'))
    ? REQUISITES_PENDING
    : 'Недостающие данные появятся к запуску';
  return `${what}: в тексте на их месте пока пропуски «${LEGAL_BLANK}».`;
}

/**
 * Display only: «[не задано: SELLER_INN]» -> «________». The stored text and its hash keep the
 * seed's markers; the page explains the blanks with one notice.
 */
export function blankMissingLegalValues(text: string): string {
  return text.replace(MISSING_VALUE_RE, LEGAL_BLANK);
}
