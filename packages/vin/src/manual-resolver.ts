/**
 * Phase 1C manual resolver: the request goes to the seller bot and a seller answers with lines
 * "БРЕНД АРТИКУЛ КОЛ-ВО". `resolve` only validates the VIN and reports `manual_required`;
 * `parseManualAnswer` turns the seller's reply into candidates (each is then rechecked with
 * GetSearch by the caller).
 */
import { InvalidVinError, type VinCandidate, type VinResolution, type VinResolver } from './types';
import { isValidVin } from './vin';

export function createManualResolver(): VinResolver {
  return {
    provider: 'manual',
    resolve(vin: string, _need: string): Promise<VinResolution> {
      if (!isValidVin(vin)) return Promise.reject(new InvalidVinError('invalid VIN'));
      return Promise.resolve({
        provider: 'manual',
        status: 'manual_required',
        vehicle: null,
        candidates: [],
      });
    },
  };
}

export interface ManualAnswerError {
  /** 1-based line number in the seller's message. */
  line: number;
  text: string;
  reason: 'too_short' | 'bad_quantity';
}

export interface ManualAnswer {
  candidates: VinCandidate[];
  errors: ManualAnswerError[];
}

const MAX_QUANTITY = 99;

/**
 * Parses "БРЕНД АРТИКУЛ [КОЛ-ВО] [# комментарий]" per line. The first word is the brand, the
 * last word is the quantity when it is a whole number (default 1), everything between is the
 * article (articles may contain spaces: 'MANN W 914/2 1'). Empty lines are ignored.
 */
export function parseManualAnswer(text: string): ManualAnswer {
  const candidates: VinCandidate[] = [];
  const errors: ManualAnswerError[] = [];
  text.split(/\r?\n/u).forEach((raw, index) => {
    const [body = '', ...commentParts] = raw.split('#');
    const note = commentParts.join('#').trim() || null;
    const words = body
      .trim()
      .split(/\s+/u)
      .filter((w) => w !== '');
    if (words.length === 0) return;
    let quantity = 1;
    const last = words.at(-1) as string;
    if (words.length >= 3 && /^\d+$/u.test(last)) {
      quantity = Number(last);
      words.pop();
      if (quantity < 1 || quantity > MAX_QUANTITY) {
        errors.push({ line: index + 1, text: raw.trim(), reason: 'bad_quantity' });
        return;
      }
    }
    if (words.length < 2) {
      errors.push({ line: index + 1, text: raw.trim(), reason: 'too_short' });
      return;
    }
    const [brand = '', ...article] = words;
    candidates.push({ brand, article: article.join(' '), quantity, note });
  });
  return { candidates, errors };
}
