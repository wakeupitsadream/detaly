/**
 * Article normalization and ruble -> kopeck conversion. No floating point arithmetic.
 */
import type { Kop } from '@detaly/domain/types';

/** Cyrillic letters that look like Latin ones: users often type articles on a Russian layout. */
const CYRILLIC_LOOKALIKES: Readonly<Record<string, string>> = {
  А: 'A',
  В: 'B',
  Е: 'E',
  Ё: 'E',
  К: 'K',
  М: 'M',
  Н: 'H',
  О: 'O',
  Р: 'P',
  С: 'C',
  Т: 'T',
  У: 'Y',
  Х: 'X',
};

/**
 * Upper case, Cyrillic look-alikes mapped to Latin, everything except [A-Z0-9] removed.
 * 'W 914/2' -> 'W9142', 'oc-90' -> 'OC90', 'ОС90' (Cyrillic) -> 'OC90'.
 */
export function normalizeArticle(value: string): string {
  let out = '';
  for (const ch of value.toUpperCase()) {
    const mapped = CYRILLIC_LOOKALIKES[ch] ?? ch;
    if ((mapped >= 'A' && mapped <= 'Z') || (mapped >= '0' && mapped <= '9')) out += mapped;
  }
  return out;
}

const DECIMAL_RE = /^(\d+)(?:\.(\d+))?$/;

/**
 * Rubles to kopecks without floats: '1234.50' -> 123450, '1 234,5' -> 123450, 412 -> 41200.
 * More than two fraction digits are rounded half up ('10.005' -> 1001).
 * Numbers are converted through their shortest decimal representation (1234.5 -> '1234.5').
 * Throws RangeError for negative, empty or malformed values.
 */
export function rubToKop(value: string | number): Kop {
  let text: string;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new RangeError(`invalid ruble amount: ${value}`);
    // Exponent notation (1e21, 5e-7) is not a price Rossko would send.
    text = String(value);
  } else {
    text = value;
  }
  // \s includes NBSP (U+00A0) and narrow NBSP (U+202F) used as thousands separators.
  text = text.replace(/\s/g, '').replace(',', '.');
  const match = DECIMAL_RE.exec(text);
  if (!match) throw new RangeError(`invalid ruble amount: ${JSON.stringify(value)}`);
  const rubles = match[1] ?? '0';
  const fraction = match[2] ?? '';
  const kopDigits = (fraction + '00').slice(0, 2);
  const roundUp = fraction.length > 2 && (fraction[2] ?? '0') >= '5';
  const kop = Number(rubles) * 100 + Number(kopDigits) + (roundUp ? 1 : 0);
  if (!Number.isSafeInteger(kop)) throw new RangeError(`ruble amount too large: ${text}`);
  return kop;
}
