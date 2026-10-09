/**
 * VIN validation: 17 characters, digits and Latin letters except I, O and Q (ISO 3779).
 * The check digit (position 9) is not verified: it is mandatory only for North American
 * vehicles and many cars sold in Russia do not follow it.
 *
 * Lives in @detaly/domain since step 6 (docs/garage.md: the client's car is normalised by the
 * pure vehicle helpers); @detaly/vin re-exports it. Import-free: client components take it from
 * the `@detaly/domain/vin` subpath without the rest of the package.
 */

const VIN_RE = /^[A-HJ-NPR-Z0-9]{17}$/;

/** Cyrillic letters that look like Latin ones and are often typed by mistake. */
const CYRILLIC_LOOKALIKES: Readonly<Record<string, string>> = {
  А: 'A',
  В: 'B',
  Е: 'E',
  К: 'K',
  М: 'M',
  Н: 'H',
  Р: 'P',
  С: 'C',
  Т: 'T',
  У: 'Y',
  Х: 'X',
};

/** Strict check of an already normalized value (upper case, no spaces). */
export function isValidVin(vin: string): boolean {
  return VIN_RE.test(vin);
}

/**
 * Cleans user input: trims, drops spaces and dashes, upper-cases and maps Cyrillic look-alikes
 * to Latin. Returns the VIN or null when the result is not a valid VIN. 'O', 'I' and 'Q' are
 * not silently replaced with digits: the client is asked to re-check instead.
 */
export function normalizeVin(input: string): string | null {
  const cleaned = [...input.replace(/[\s-]+/gu, '').toUpperCase()]
    .map((ch) => CYRILLIC_LOOKALIKES[ch] ?? ch)
    .join('');
  return isValidVin(cleaned) ? cleaned : null;
}

/** '…' masked VIN for logs and messenger texts: first 3 (manufacturer) and last 4. */
export function maskVin(vin: string): string {
  return vin.length === 17 ? `${vin.slice(0, 3)}**********${vin.slice(-4)}` : '*****';
}

/**
 * The last 4 characters of a VIN as the bots show it: '…4567' (step 6, docs/garage.md: a
 * message never carries more of a VIN). '' for anything that is not a VIN.
 */
export function vinTail(vin: string | null | undefined): string {
  return typeof vin === 'string' && isValidVin(vin) ? `…${vin.slice(-4)}` : '';
}
