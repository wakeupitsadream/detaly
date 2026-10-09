/**
 * Step 5 (docs/kits.md): the lines of a maintenance kit («Наборы ТО») in the format the master
 * already knows from VIN answers — «БРЕНД АРТИКУЛ КОЛ-ВО», read by parseManualAnswer through the
 * preview's own position check (parseVinPosition) — with two marks of a kit:
 *
 * - a line starting with «или » is an alternative of the main line above it (an analog the
 *   client may pick instead; without its own quantity it takes the main line's);
 * - « — Роль» at the end names the line: «MANN W914/2 1 — Фильтр масляный» (without it the
 *   caller takes the role from the supplier's offer name).
 *
 * checkKitLines prices every line by the rule of the VIN proposal preview (resolveVinPosition:
 * the same brand and article at the supplier, not marked goods, a usable price and date, stock
 * for the quantity; Orenburg first, then the nearest date, then the lower price; priceOffer), so
 * a kit line is exactly the cart line «Весь набор в корзину» adds.
 *
 * Pure apart from `search` (the caller's cached supplier client); nothing is logged.
 */
import {
  CLIENT_TIME_ZONE,
  KIT_ALTERNATIVES_MAX,
  KIT_LINES_MAX,
  KIT_MAIN_LINES_MAX,
  KIT_ROLE_MAX,
  type EtaSettings,
  type ExcludedRule,
  type PricingConfig,
  type RepriceContext,
  type VinPreviewLine,
} from '@detaly/domain';
import { normalizeArticle } from '@detaly/rossko';
import {
  parseVinPosition,
  resolveVinPosition,
  searchVinArticles,
  type VinPosition,
  type VinSearch,
} from './preview';

/** Longest text of the lines field (20 lines with roles fit in it several times). */
export const KIT_TEXT_MAX = 2000;

/** One line of the kit text. */
export interface KitTextLine {
  /** 1-based line number in the text. */
  line: number;
  /** The line as typed (trimmed). */
  raw: string;
  /** «или …»: an alternative of the closest main line above. */
  alternative: boolean;
  /** « — Роль», null when not typed. */
  role: string | null;
  brand: string;
  article: string;
  articleNorm: string;
  qty: number;
}

export interface KitTextError {
  line: number;
  raw: string;
  message: string;
}

export interface KitText {
  lines: KitTextLine[];
  errors: KitTextError[];
}

const ALTERNATIVE_RE = /^или(?:\s+|:\s*)/iu;
/** The first « — » (em or en dash after a space) or « - » (a hyphen between spaces). */
const ROLE_RE = /\s+[—–]\s*|\s+-\s+/u;
const QTY_RE = /^(?:0|[1-9]\d*)$/u;

/** Brand comparison key, as brandMatches compares brands: 'Mann-Filter' -> 'MANNFILTER'. */
function brandKey(brand: string): string {
  return brand.toUpperCase().replace(/[^\p{L}\p{N}]+/gu, '');
}

/**
 * Whether the line ends with a quantity: the rule of parseManualAnswer (the last of at least
 * three words, a whole number without a leading zero), so «или BOSCH FR7DCX+» takes the main
 * line's quantity.
 */
function hasTypedQty(body: string): boolean {
  const words = (body.split('#')[0] ?? '')
    .trim()
    .split(/\s+/u)
    .filter((word) => word !== '');
  return words.length >= 3 && QTY_RE.test(words.at(-1) as string);
}

/**
 * Reads the lines field of the kit form. Empty lines and lines starting with '#' are skipped; a
 * line that cannot be read is reported with its number and the others are still read. Limits:
 * KIT_MAIN_LINES_MAX main lines, KIT_ALTERNATIVES_MAX alternatives each, KIT_LINES_MAX in all; a
 * part (brand and article) only once.
 */
export function parseKitText(text: string): KitText {
  const lines: KitTextLine[] = [];
  const errors: KitTextError[] = [];
  const seen = new Map<string, number>();
  let positions = 0;
  let mains = 0;
  /** The main line alternatives attach to; `invalid` after a main line that failed. */
  let current: { line: KitTextLine; alternatives: number } | 'invalid' | null = null;

  text.split(/\r?\n/u).forEach((source, index) => {
    const line = index + 1;
    const raw = source.trim();
    if (raw === '' || raw.startsWith('#')) return;
    const fail = (message: string) => errors.push({ line, raw, message });
    positions += 1;
    if (positions > KIT_LINES_MAX) {
      fail(`Не больше ${KIT_LINES_MAX} строк в наборе (с аналогами)`);
      return;
    }
    let body = raw;
    const alternativeMark = ALTERNATIVE_RE.exec(body);
    const alternative = alternativeMark !== null;
    if (alternativeMark) body = body.slice(alternativeMark[0].length);
    let role: string | null = null;
    const dash = ROLE_RE.exec(body);
    if (dash) {
      role = body
        .slice(dash.index + dash[0].length)
        .replace(/\s+/gu, ' ')
        .trim();
      body = body.slice(0, dash.index).trim();
      if (role === '') role = null;
    }
    if (!alternative) current = 'invalid';
    if (role !== null && role.length > KIT_ROLE_MAX) {
      fail(`Название позиции — до ${KIT_ROLE_MAX} символов`);
      return;
    }
    const parsed = parseVinPosition(line, body);
    if ('status' in parsed) {
      fail(parsed.message);
      return;
    }
    let qty = parsed.qty;
    if (alternative) {
      if (current === null) {
        fail('«или …» — аналог строки выше: сначала напишите основную позицию');
        return;
      }
      if (current === 'invalid') {
        fail('Сначала исправьте основную строку выше');
        return;
      }
      if (current.alternatives >= KIT_ALTERNATIVES_MAX) {
        fail(`Не больше ${KIT_ALTERNATIVES_MAX} аналогов на позицию`);
        return;
      }
      if (!hasTypedQty(body)) qty = current.line.qty;
    } else if (mains >= KIT_MAIN_LINES_MAX) {
      fail(`Не больше ${KIT_MAIN_LINES_MAX} позиций в наборе`);
      return;
    }
    const key = `${brandKey(parsed.brand)}:${parsed.articleNorm}`;
    const earlier = seen.get(key);
    if (earlier !== undefined) {
      fail(`Та же деталь, что в строке ${earlier}`);
      return;
    }
    seen.set(key, line);
    const entry: KitTextLine = {
      line,
      raw,
      alternative,
      role,
      brand: parsed.brand,
      article: parsed.article,
      articleNorm: parsed.articleNorm,
      qty,
    };
    lines.push(entry);
    if (alternative && current !== null && current !== 'invalid') current.alternatives += 1;
    else {
      mains += 1;
      current = { line: entry, alternatives: 0 };
    }
  });
  return { lines, errors };
}

/** A stored line back in the text of the form: «или BOSCH FR7DCX+ 4 — Свечи зажигания». */
export function kitLineText(line: {
  alternative: boolean;
  brand: string;
  article: string;
  qty: number;
  role: string | null;
}): string {
  const role = line.role ? ` — ${line.role}` : '';
  return `${line.alternative ? 'или ' : ''}${line.brand} ${line.article} ${line.qty}${role}`;
}

export interface KitCheckInput {
  /** The lines in order (main lines and alternatives alike). */
  lines: readonly { brand: string; article: string; qty: number }[];
  search: VinSearch;
  /** The shop's PricingConfig (settings): the same object search, cart and checkout use. */
  pricing: PricingConfig;
  excludedRules: readonly ExcludedRule[];
  eta: EtaSettings;
  now: Date;
  /** Zone of client dates; default Asia/Yekaterinburg. */
  timeZone?: string;
}

/**
 * Checks and prices every line by the VIN preview rule, one GetSearch per distinct article
 * through the caller's `search`. Never throws for a line or a supplier failure (that line gets
 * `supplier_unavailable`); throws only for broken settings or a programming error. The results
 * keep the order of `lines`; `line` of each is its index + 1.
 */
export async function checkKitLines(input: KitCheckInput): Promise<VinPreviewLine[]> {
  const ctx: RepriceContext = {
    pricing: input.pricing,
    excludedRules: input.excludedRules,
    eta: input.eta,
    now: input.now,
    timeZone: input.timeZone ?? CLIENT_TIME_ZONE,
  };
  const positions: VinPosition[] = input.lines.map((line, index) => ({
    line: index + 1,
    raw: `${line.brand} ${line.article} ${line.qty}`,
    brand: line.brand,
    article: line.article,
    articleNorm: normalizeArticle(line.article),
    qty: line.qty,
    note: null,
  }));
  const outcomes = await searchVinArticles(
    [...new Set(positions.map((position) => position.articleNorm))],
    input.search,
  );
  return positions.map((position) =>
    resolveVinPosition(position, outcomes.get(position.articleNorm) ?? { ok: false }, ctx),
  );
}
