/**
 * Preview of a master's answer to a VIN request (docs/phase-1c-implementation.md decision С13).
 *
 * The answer is plain text, one position per line: «БРЕНД АРТИКУЛ [КОЛ-ВО] [# заметка]»
 * (parseManualAnswer); a line starting with '>' is the master's comment to the client. Every
 * position is checked with GetSearch through the caller's `search` (the caller owns the
 * 15-minute cache and the Rossko limiter), and the preview says, line by line, what the client
 * will be offered or why a line cannot be offered. A failing line never fails the others.
 *
 * Choice among the supplier offers of a line: the same brand (see brandMatches) and the same
 * normalized article, not marked goods, a usable price and date, enough stock for the quantity
 * (and its multiplicity); then a local (Orenburg) stock first, the nearest date, the lower price.
 * Prices come from price() and dates from etaDate() through cartLineFromOffer(), so an `ok`
 * line is exactly the cart line the proposal will hold.
 *
 * Pure apart from `search`: no database, no logging (the seller's text may contain anything).
 */
import {
  ARTICLE_NORM_RE,
  CartError,
  cartLineFromOffer,
  CLIENT_TIME_ZONE,
  DateError,
  etaDate as offerEtaDate,
  isExcluded,
  MAX_CART_SEARCHES,
  MAX_LINE_QTY,
  MoneyError,
  offerViewId,
  price,
  promisedDate,
  safeMul,
  sumKop,
  validateQty,
  VIN_ANSWER_LINES_MAX,
  type EtaSettings,
  type ExcludedRule,
  type IsoDate,
  type MarkupRule,
  type Offer,
  type RepriceContext,
  type VinPreview,
  type VinPreviewErrorReason,
  type VinPreviewLine,
} from '@detaly/domain';
import { normalizeArticle } from '@detaly/rossko';
import { parseManualAnswer } from './manual-resolver';

/**
 * Distinct query articles in one proposal: MAX_CART_SEARCHES of @detaly/domain. Checkout re-runs
 * GetSearch per distinct article and refuses a cart with more, so a proposal must not have more.
 */
export const VIN_PROPOSAL_SEARCHES_MAX = MAX_CART_SEARCHES;
/** The '>' comment to the client, characters. */
export const VIN_COMMENT_MAX = 500;
/** The '# заметка' of a line, characters. */
export const VIN_LINE_NOTE_MAX = 200;
/** Shortest normalized article accepted (shorter is a typo or a missing article: 'OC90 1'). */
export const VIN_ARTICLE_MIN = 3;
/** Parallel GetSearch calls of one preview (the caller's limiter still applies). */
const SEARCH_CONCURRENCY = 4;

/** GetSearch of one normalized article: the supplier offers (crosses included). */
export type VinSearch = (articleNorm: string) => Promise<readonly Offer[]>;

export interface VinPreviewInput {
  /** The master's answer as typed. */
  text: string;
  search: VinSearch;
  markupRules: readonly MarkupRule[];
  excludedRules: readonly ExcludedRule[];
  eta: EtaSettings;
  now: Date;
  /** Zone of client dates; default Asia/Yekaterinburg. */
  timeZone?: string;
}

type ErrorLine = Extract<VinPreviewLine, { status: 'error' }>;
type OkLine = Extract<VinPreviewLine, { status: 'ok' }>;

interface ParsedLine {
  line: number;
  raw: string;
  brand: string;
  article: string;
  articleNorm: string;
  qty: number;
  note: string | null;
}

function errorLine(
  line: number,
  raw: string,
  reason: VinPreviewErrorReason,
  message: string,
  brands?: string[],
): ErrorLine {
  return brands === undefined
    ? { line, raw, status: 'error', reason, message }
    : { line, raw, status: 'error', reason, brands, message };
}

/** Brand comparison key: upper case, letters and digits only ('Mann-Filter' -> 'MANNFILTER'). */
function brandKey(brand: string): string {
  return brand.toUpperCase().replace(/[^\p{L}\p{N}]+/gu, '');
}

/**
 * Offers of the typed brand. Exact match first (case, spaces and hyphens ignored); when there is
 * none, the first word of the supplier brand ('MANN' -> 'MANN-FILTER', 'TRW' -> 'TRW
 * AUTOMOTIVE'): masters type the short brand, Rossko answers with the full one.
 * VERIFY: brand spellings of live GetSearch answers (docs/external.md).
 */
export function brandMatches(offers: readonly Offer[], typed: string): Offer[] {
  const key = brandKey(typed);
  if (key === '') return [];
  const exact = offers.filter((o) => brandKey(o.brand) === key);
  if (exact.length > 0) return exact;
  return offers.filter((o) => brandKey(o.brand.trim().split(/[\s\-_/]+/u)[0] ?? '') === key);
}

interface PricedOffer {
  offer: Offer;
  priceClientKop: number;
  etaDate: IsoDate;
}

function priceOf(offer: Offer, ctx: RepriceContext): PricedOffer | null {
  if (!Number.isSafeInteger(offer.priceSupplierKop) || offer.priceSupplierKop <= 0) return null;
  try {
    const eta = offerEtaDate(offer.stock, ctx.now, ctx.timeZone ?? CLIENT_TIME_ZONE);
    const { priceClientKop } = price(ctx.markupRules, offer.priceSupplierKop, offer.stock.isLocal);
    return { offer, priceClientKop, etaDate: eta };
  } catch (error) {
    if (error instanceof DateError || error instanceof MoneyError) return null;
    throw error;
  }
}

/** Local stock first, then the nearest date, then the lower price; ties by offer key. */
function compareChoice(a: PricedOffer, b: PricedOffer): number {
  const ka = offerViewId(a.offer);
  const kb = offerViewId(b.offer);
  return (
    Number(b.offer.stock.isLocal) - Number(a.offer.stock.isLocal) ||
    (a.etaDate < b.etaDate ? -1 : a.etaDate > b.etaDate ? 1 : 0) ||
    a.priceClientKop - b.priceClientKop ||
    a.offer.priceSupplierKop - b.offer.priceSupplierKop ||
    (ka < kb ? -1 : ka > kb ? 1 : 0)
  );
}

/** Parses one line of the answer; comment and empty lines are handled by the caller. */
function parseLine(line: number, raw: string): ParsedLine | ErrorLine {
  const parsed = parseManualAnswer(raw);
  const error = parsed.errors[0];
  if (error !== undefined) {
    return error.reason === 'bad_quantity'
      ? errorLine(line, raw, 'parse', `Количество — целое число от 1 до ${MAX_LINE_QTY}`)
      : errorLine(line, raw, 'parse', 'Нужно «БРЕНД АРТИКУЛ [КОЛ-ВО]», например «MANN W914/2 1»');
  }
  const candidate = parsed.candidates[0];
  if (candidate === undefined) {
    return errorLine(line, raw, 'parse', 'Пустая строка');
  }
  const articleNorm = normalizeArticle(candidate.article);
  if (articleNorm.length < VIN_ARTICLE_MIN) {
    return errorLine(
      line,
      raw,
      'parse',
      'Нет артикула: нужно «БРЕНД АРТИКУЛ [КОЛ-ВО]», например «MANN W914/2 1»',
    );
  }
  if (!ARTICLE_NORM_RE.test(articleNorm)) {
    return errorLine(line, raw, 'parse', 'Артикул слишком длинный');
  }
  if (candidate.note !== null && candidate.note.length > VIN_LINE_NOTE_MAX) {
    return errorLine(line, raw, 'parse', `Заметка длиннее ${VIN_LINE_NOTE_MAX} символов`);
  }
  return {
    line,
    raw,
    brand: candidate.brand,
    article: candidate.article,
    articleNorm,
    qty: candidate.quantity,
    note: candidate.note,
  };
}

/** Runs `task` over `items` with at most `limit` in flight; results keep the input order. */
async function mapLimited<T, R>(
  items: readonly T[],
  limit: number,
  task: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  async function worker(): Promise<void> {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await task(items[index] as T);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return results;
}

type SearchOutcome = { ok: true; offers: readonly Offer[] } | { ok: false };

function resolveLine(
  parsed: ParsedLine,
  outcome: SearchOutcome,
  ctx: RepriceContext,
): OkLine | ErrorLine {
  const { line, raw, articleNorm, qty } = parsed;
  if (!outcome.ok) {
    return errorLine(
      line,
      raw,
      'supplier_unavailable',
      'Поставщик не ответил — проверьте строку ещё раз позже',
    );
  }
  const sameArticle = outcome.offers.filter((o) => o.articleNorm === articleNorm);
  if (sameArticle.length === 0) {
    return errorLine(line, raw, 'not_found', `Артикул ${parsed.article} не найден у поставщика`);
  }
  const ofBrand = brandMatches(sameArticle, parsed.brand);
  if (ofBrand.length === 0) {
    const brands = [...new Set(sameArticle.map((o) => o.brand))].sort((a, b) =>
      a.localeCompare(b, 'ru'),
    );
    return errorLine(
      line,
      raw,
      'brand_mismatch',
      `Бренд ${parsed.brand} не найден для ${parsed.article}, есть: ${brands.join(', ')}`,
      brands,
    );
  }
  const sellable = ofBrand.filter(
    (o) => !isExcluded({ name: o.name, group: o.group }, ctx.excludedRules).excluded,
  );
  if (sellable.length === 0) {
    const first = ofBrand[0] as Offer;
    const reason = isExcluded({ name: first.name, group: first.group }, ctx.excludedRules).reason;
    return errorLine(
      line,
      raw,
      'excluded',
      `Не продаём онлайн${reason ? `: ${reason}` : ''} — только в сервисе`,
    );
  }
  const priced = sellable.map((o) => priceOf(o, ctx)).filter((p) => p !== null);
  if (priced.length === 0) {
    return errorLine(line, raw, 'no_stock', 'У поставщика нет цены или срока поставки');
  }
  const fitting = priced.filter(
    (p) =>
      validateQty(qty, { available: p.offer.stock.count, multiplicity: p.offer.stock.multiplicity })
        .ok,
  );
  if (fitting.length === 0) {
    const largest = [...priced].sort((a, b) => b.offer.stock.count - a.offer.stock.count)[0];
    const check = largest
      ? validateQty(qty, {
          available: largest.offer.stock.count,
          multiplicity: largest.offer.stock.multiplicity,
        })
      : null;
    const message = check && !check.ok ? check.message : 'Нет в наличии';
    return errorLine(line, raw, 'no_stock', message);
  }
  const chosen = [...fitting].sort(compareChoice)[0] as PricedOffer;
  let cartLine: ReturnType<typeof cartLineFromOffer>;
  try {
    cartLine = cartLineFromOffer(chosen.offer, articleNorm, qty, ctx);
  } catch (error) {
    if (!(error instanceof CartError)) throw error;
    const reason: VinPreviewErrorReason =
      error.code === 'excluded' ? 'excluded' : error.code === 'article' ? 'parse' : 'no_stock';
    return errorLine(line, raw, reason, error.message);
  }
  return {
    line,
    raw,
    status: 'ok',
    brand: cartLine.offer.brand,
    article: cartLine.offer.article,
    name: cartLine.offer.name,
    qty: cartLine.qty,
    offer: cartLine.offer,
    searchArticleNorm: cartLine.searchArticleNorm,
    offerKey: cartLine.offerKey,
    priceClientKop: cartLine.priceClientKop,
    priceSupplierKop: cartLine.priceSupplierKop,
    markupBp: cartLine.markupBp,
    etaDate: cartLine.etaDate as IsoDate,
    isLocal: cartLine.isLocal,
    note: parsed.note,
  };
}

/**
 * Checks the master's answer line by line (decision С13). Never throws for a bad line or a
 * supplier failure; throws only for broken settings (markup rules) or a programming error.
 */
export async function previewVinAnswer(input: VinPreviewInput): Promise<VinPreview> {
  const ctx: RepriceContext = {
    markupRules: input.markupRules,
    excludedRules: input.excludedRules,
    eta: input.eta,
    now: input.now,
    timeZone: input.timeZone ?? CLIENT_TIME_ZONE,
  };
  const slots: (ParsedLine | ErrorLine)[] = [];
  const comments: string[] = [];
  let commentLine: { line: number; raw: string } | null = null;
  let positions = 0;
  const searches = new Set<string>();

  input.text.split(/\r?\n/u).forEach((source, index) => {
    const line = index + 1;
    const raw = source.trim();
    if (raw === '') return;
    if (raw.startsWith('>')) {
      const text = raw.replace(/^>+/u, '').trim();
      if (text !== '') comments.push(text);
      commentLine ??= { line, raw };
      return;
    }
    positions += 1;
    if (positions > VIN_ANSWER_LINES_MAX) {
      slots.push(
        errorLine(line, raw, 'parse', `Не больше ${VIN_ANSWER_LINES_MAX} позиций в одном ответе`),
      );
      return;
    }
    const parsed = parseLine(line, raw);
    if ('status' in parsed) {
      slots.push(parsed);
      return;
    }
    if (!searches.has(parsed.articleNorm) && searches.size >= VIN_PROPOSAL_SEARCHES_MAX) {
      slots.push(
        errorLine(
          line,
          raw,
          'parse',
          `Не больше ${VIN_PROPOSAL_SEARCHES_MAX} разных артикулов в одной подборке`,
        ),
      );
      return;
    }
    searches.add(parsed.articleNorm);
    slots.push(parsed);
  });

  const comment = comments.length > 0 ? comments.join('\n') : null;

  const articles = [...searches];
  const outcomes = await mapLimited(articles, SEARCH_CONCURRENCY, async (article) => {
    try {
      return { ok: true, offers: await input.search(article) } satisfies SearchOutcome;
    } catch {
      // Quota breaker, rate limit, timeout, SOAP fault: only the lines of this article fail.
      return { ok: false } satisfies SearchOutcome;
    }
  });
  const byArticle = new Map<string, SearchOutcome>(articles.map((a, i) => [a, outcomes[i]!]));

  const lines: VinPreviewLine[] = [];
  const seenOffers = new Map<string, number>();
  for (const slot of slots) {
    if ('status' in slot) {
      lines.push(slot);
      continue;
    }
    const resolved = resolveLine(slot, byArticle.get(slot.articleNorm) ?? { ok: false }, ctx);
    if (resolved.status === 'ok') {
      const earlier = seenOffers.get(resolved.offerKey);
      if (earlier !== undefined) {
        lines.push(
          errorLine(
            slot.line,
            slot.raw,
            'parse',
            `Та же позиция, что в строке ${earlier}: укажите количество одной строкой`,
          ),
        );
        continue;
      }
      seenOffers.set(resolved.offerKey, resolved.line);
    }
    lines.push(resolved);
  }

  if (comment !== null && comment.length > VIN_COMMENT_MAX) {
    const at = commentLine as { line: number; raw: string } | null;
    lines.push(
      errorLine(
        at?.line ?? 0,
        at?.raw ?? '>',
        'parse',
        `Комментарий длиннее ${VIN_COMMENT_MAX} символов`,
      ),
    );
    lines.sort((a, b) => a.line - b.line);
  }

  const ok = lines.filter((l): l is OkLine => l.status === 'ok');
  return {
    lines,
    comment,
    totalKop: sumKop(ok.map((l) => safeMul(l.priceClientKop, l.qty))),
    okCount: ok.length,
    errorCount: lines.length - ok.length,
    checkedAt: input.now.toISOString(),
  };
}

/**
 * The date promised to the client for an `ok` line ('к чт 9 октября' with formatPromise): the
 * supplier date plus the buffer days, as on /search.
 */
export function vinLinePromisedDate(line: Pick<OkLine, 'etaDate'>, eta: EtaSettings): IsoDate {
  return promisedDate([line.etaDate], eta);
}

/** Whether the preview can be sent to the client (decision С13: no errors, at least one line). */
export function isVinPreviewSendable(preview: VinPreview | null | undefined): boolean {
  return preview != null && preview.errorCount === 0 && preview.okCount > 0;
}
