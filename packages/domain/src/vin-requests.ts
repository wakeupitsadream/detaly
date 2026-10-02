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
