/**
 * Manual VIN requests and seller proposals (PLAN section 4 «VIN-слой»;
 * docs/phase-1c-implementation.md decisions С2, С3, С12–С16, С20): policy constants in one place.
 */

/** Photos of a VIN request (VIN plate, СТС, the old part); CHECK in the database. */
export const VIN_PHOTOS_MAX = 3;
/** «Что нужно», characters. */
export const VIN_NEED_TEXT_MAX = 1000;
/** «Марка и модель», characters. */
export const VIN_CAR_TEXT_MAX = 200;
/** VIN request photos are deleted after this many days (PLAN section 7, item 8). */
export const VIN_PHOTO_RETENTION_DAYS = 90;
/** A seller proposal (/p/<token>) can be checked out for this many days. */
export const PROPOSAL_TTL_DAYS = 7;
/** Lines in one master's answer (more is a `parse` error of the preview). */
export const VIN_ANSWER_LINES_MAX = 20;

/** Client templates of a VIN request (notify/vin); only vin_proposal is in the SMS allowlist. */
export const VIN_NOTIFY_TEMPLATES = ['vin_received', 'vin_proposal'] as const;
export type VinNotifyTemplate = (typeof VIN_NOTIFY_TEMPLATES)[number];

/** A messenger deep-link token lives 24 hours and is used once (decision С3). */
export const LINK_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Seven or more digits in a row, optionally separated by spaces, hyphens or brackets
 * (a phone number, a document or card number), with an optional leading '+'. Digits glued to a
 * Latin letter are part of a code (a VIN 'XTA21099012345', an article), not a number to hide.
 */
const DIGIT_RUN_RE = /(?<![A-Za-z\d])\+?\d(?:[\s\-()]*\d){6,}(?![A-Za-z])/g;

/**
 * Masks digit runs before a client's text goes to the sellers chat (decision С2): the client may
 * type their phone or a document number into «что нужно» or a claim. '8 (912) 345-67-89' ->
 * '•••'. Shorter numbers (years, quantities, articles like 'W 914/2') are kept.
 */
export function maskDigits(text: string): string {
  return text.replace(DIGIT_RUN_RE, '•••');
}

/** Letters of Russian registration plates (Cyrillic and their Latin look-alikes). */
const PLATE_LETTER = '[АВЕКМНОРСТУХABEKMHOPCTYX]';
/**
 * Russian registration plates (ГОСТ Р 50577): «А123ВС56», «а 123 вс 156», «АВ123 56» (taxi),
 * «А123ВС» without the region when written in Cyrillic. A plate ties the car to its owner in
 * the traffic police register, so it is personal data next to a phone or a name (decision С2).
 */
const PLATE_RES: readonly RegExp[] = [
  // Л ЦЦЦ ЛЛ РР(Р)
  new RegExp(
    `(?<![\\p{L}\\d])${PLATE_LETTER}\\s?\\d{3}\\s?${PLATE_LETTER}{2}\\s?\\d{2,3}(?![\\p{L}\\d])`,
    'giu',
  ),
  // ЛЛ ЦЦЦ РР(Р): taxi and trailers, Cyrillic only (a Latin «HC12356» may be an article)
  /(?<![\p{L}\d])[АВЕКМНОРСТУХ]{2}\s?\d{3}\s?\d{2,3}(?![\p{L}\d])/giu,
  // Л ЦЦЦ ЛЛ without the region, Cyrillic only (a Latin «A123BC» may be an article)
  /(?<![\p{L}\d])[АВЕКМНОРСТУХ]\s?\d{3}\s?[АВЕКМНОРСТУХ]{2}(?![\p{L}\d])/giu,
];
const EMAIL_RE = /[\p{L}\d._%+-]+@[\p{L}\d-]+(?:\.[\p{L}\d-]+)+/giu;

/**
 * A client's free text on its way to the sellers chat (Telegram is a foreign service, PLAN
 * section 4): digit runs (maskDigits), registration plates and e-mail addresses become '•••'.
 * Names and addresses cannot be recognised reliably: the chat gets a short fragment only and the
 * full text stays in the admin.
 */
export function maskClientText(text: string): string {
  let out = text.replace(EMAIL_RE, '•••');
  for (const re of PLATE_RES) out = out.replace(re, '•••');
  return maskDigits(out);
}
