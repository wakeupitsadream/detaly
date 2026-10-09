/**
 * Step 5 (docs/kits.md): maintenance kits by car model («Наборы ТО»). Pure helpers: the URL
 * slugs of a kit (model and engine), the checks of the kit header the master types on
 * /admin/kits, the shape of the lines (a main line and its alternatives «или …»), the publish
 * rule, the totals of the chosen lines with the date the client is promised, and the words that
 * compare an alternative with its main line.
 *
 * Founder decisions (fixed): kits are made by the shop's master in the admin and the site never
 * invents applicability; marked goods (the excluded groups: oil, antifreeze, tyres, brake fluid)
 * never go into a kit; prices are live — every line is priced from the supplier offer of the
 * moment by priceOffer (the VIN preview rule picks the offer), never stored with the kit.
 */
import { promisedDate } from './dates';
import { formatRub, safeMul, sumKop } from './money';
import type { EtaSettings, IsoDate, Kop, VinPreviewLine } from './types';

/** Longest model name («Niva Travel», «Granta Cross»). */
export const KIT_MODEL_MAX = 60;
/** Longest engine text («1.6 16V, 106 л.с.»). */
export const KIT_ENGINE_MAX = 80;
/** Longest note of a kit (for the staff; only the replacement time reaches the page). */
export const KIT_NOTE_MAX = 300;
/** Longest role of a line («Фильтр масляный»). */
export const KIT_ROLE_MAX = 60;
/** Longest slug in a URL. */
export const KIT_SLUG_MAX = 64;
/** Years a kit may name. */
export const KIT_YEAR_MIN = 1970;
export const KIT_YEAR_MAX = 2100;
/**
 * Main lines of one kit: at most MAX_CART_SEARCHES (10) of the cart, so the whole kit always
 * fits one cart (10 distinct searches, 20 lines).
 */
export const KIT_MAIN_LINES_MAX = 10;
/** Alternatives («или …») of one main line («1–2 аналога», audit roadmap r09). */
export const KIT_ALTERNATIVES_MAX = 2;
/** Lines of one kit, alternatives included: at most this many supplier searches per kit. */
export const KIT_LINES_MAX = 20;

/** A URL slug: lower-case latin letters and digits in hyphen-separated words. */
export const KIT_SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** What the page says about the oil (the wording of «Масла — только в сервисе»). */
export const KIT_OIL_TEXT =
  'Масло и антифриз в набор не входят — их подберут и зальют в автосервисе при пункте выдачи по его прайсу';

/** The fit check hint under «Весь набор в корзину» (step 4, docs/fit-check.md). */
export const KIT_FIT_HINT = 'Не уверены? В корзине нажмите «Проверить под мою машину»';

/** A line the supplier does not offer right now. */
export const KIT_UNAVAILABLE_TEXT = 'Нет у поставщика';

/**
 * The label of every sample kit of the demo (its page title area and every kit section): a
 * sample of how a kit looks, never applicability data for a real car.
 */
export const KIT_DEMO_LABEL = 'Пример набора — состав для демонстрации, не для покупки';

const TRANSLIT: Readonly<Record<string, string>> = {
  а: 'a',
  б: 'b',
  в: 'v',
  г: 'g',
  д: 'd',
  е: 'e',
  ё: 'e',
  ж: 'zh',
  з: 'z',
  и: 'i',
  й: 'y',
  к: 'k',
  л: 'l',
  м: 'm',
  н: 'n',
  о: 'o',
  п: 'p',
  р: 'r',
  с: 's',
  т: 't',
  у: 'u',
  ф: 'f',
  х: 'h',
  ц: 'ts',
  ч: 'ch',
  ш: 'sh',
  щ: 'sch',
  ъ: '',
  ы: 'y',
  ь: '',
  э: 'e',
  ю: 'yu',
  я: 'ya',
};

/**
 * A URL slug of any text: Cyrillic transliterated, Latin diacritics dropped, everything but
 * letters and digits turned into single hyphens. 'Vesta' -> 'vesta', 'Нива Travel' ->
 * 'niva-travel', '1.6 16V' -> '1-6-16v', 'Škoda' -> 'skoda'. '' when nothing is left.
 */
export function slugify(text: string, max = KIT_SLUG_MAX): string {
  let out = '';
  for (const ch of text.toLowerCase()) {
    // Cyrillic first: NFKD would turn «й» into «и» + a mark.
    out += TRANSLIT[ch] ?? ch.normalize('NFKD').replace(/\p{M}+/gu, '');
  }
  const slug = out.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return slug.length <= max ? slug : slug.slice(0, max).replace(/-+$/, '');
}

/** The model in the URL: /to/lada/vesta. */
export function kitModelSlug(model: string): string {
  return slugify(model);
}

/**
 * Candidate slugs of a kit inside its model, best first: the engine before the first comma
 * («1.6 16V, 106 л.с.» -> '1-6-16v'), the whole engine, both with the first year. A kit of a model
 * is addressed as /to/<make>/<model>#<slug>.
 */
export function kitSlugCandidates(engine: string, yearsFrom: number): string[] {
  const short = slugify(engine.split(',')[0] ?? '') || 'nabor';
  const full = slugify(engine) || short;
  const out = [short, full, `${short}-${yearsFrom}`, `${full}-${yearsFrom}`];
  return [...new Set(out.map((slug) => slug.slice(0, KIT_SLUG_MAX).replace(/-+$/, '')))];
}

/** The first candidate slug not taken by another kit of the model; `-2`, `-3`… after them. */
export function pickKitSlug(engine: string, yearsFrom: number, taken: ReadonlySet<string>): string {
  const candidates = kitSlugCandidates(engine, yearsFrom);
  const free = candidates.find((slug) => !taken.has(slug));
  if (free !== undefined) return free;
  const base = (candidates[0] ?? 'nabor').slice(0, KIT_SLUG_MAX - 4);
  for (let n = 2; ; n += 1) {
    const slug = `${base}-${n}`;
    if (!taken.has(slug)) return slug;
  }
}

// ---------------------------------------------------------------------------
// The header of a kit: make, model, engine, years, note
// ---------------------------------------------------------------------------

export interface KitHeader {
  /** One of the CAR_BRANDS slugs of the storefront. */
  makeSlug: string;
  /** As shown: «Vesta». */
  model: string;
  modelSlug: string;
  /** As shown: «1.6 16V, 106 л.с.». */
  engine: string;
  yearsFrom: number;
  /** null: still produced. */
  yearsTo: number | null;
  /** For the staff; null when empty. */
  note: string | null;
}

/** The form fields as typed. */
export interface KitHeaderInput {
  make: string;
  model: string;
  engine: string;
  yearsFrom: string;
  yearsTo: string;
  note: string;
}

export type KitHeaderField = keyof KitHeaderInput;

export type KitHeaderCheck =
  { ok: true; header: KitHeader } | { ok: false; errors: Partial<Record<KitHeaderField, string>> };

/** Spaces collapsed, ends trimmed. */
function clean(text: string): string {
  return text.replace(/\s+/gu, ' ').trim();
}

const YEAR_RE = /^\d{4}$/;

/**
 * The header of a kit from the admin form. `makes`: the make slugs the storefront knows
 * (CAR_BRANDS); `maxYear`: the latest year accepted (next year: a model year runs ahead).
 */
export function validateKitHeader(
  input: KitHeaderInput,
  { makes, maxYear }: { makes: ReadonlySet<string>; maxYear: number },
): KitHeaderCheck {
  const errors: Partial<Record<KitHeaderField, string>> = {};
  const makeSlug = input.make.trim();
  if (!makes.has(makeSlug)) errors.make = 'Выберите марку из списка';
  const model = clean(input.model);
  const modelSlug = kitModelSlug(model);
  if (model === '') errors.model = 'Модель, например Vesta';
  else if (model.length > KIT_MODEL_MAX) errors.model = `Модель — до ${KIT_MODEL_MAX} символов`;
  else if (modelSlug === '') errors.model = 'Модель — буквами или цифрами, например Vesta';
  const engine = clean(input.engine);
  if (engine === '') errors.engine = 'Двигатель, например «1.6 16V, 106 л.с.»';
  else if (engine.length > KIT_ENGINE_MAX) {
    errors.engine = `Двигатель — до ${KIT_ENGINE_MAX} символов`;
  } else if (slugify(engine) === '') {
    errors.engine = 'Двигатель — буквами или цифрами, например «1.6 16V, 106 л.с.»';
  }
  const top = Math.min(maxYear, KIT_YEAR_MAX);
  const fromText = input.yearsFrom.trim();
  const yearsFrom = YEAR_RE.test(fromText) ? Number(fromText) : null;
  if (yearsFrom === null || yearsFrom < KIT_YEAR_MIN || yearsFrom > top) {
    errors.yearsFrom = `Год начала — четыре цифры, от ${KIT_YEAR_MIN} до ${top}`;
  }
  const toText = input.yearsTo.trim();
  let yearsTo: number | null = null;
  if (toText !== '') {
    yearsTo = YEAR_RE.test(toText) ? Number(toText) : null;
    if (yearsTo === null || yearsTo < KIT_YEAR_MIN || yearsTo > top) {
      errors.yearsTo = `Год окончания — четыре цифры до ${top} или пусто (выпускается)`;
    } else if (yearsFrom !== null && yearsTo < yearsFrom) {
      errors.yearsTo = 'Год окончания не раньше года начала';
    }
  }
  const note = input.note.trim();
  if (note.length > KIT_NOTE_MAX) errors.note = `Заметка — до ${KIT_NOTE_MAX} символов`;
  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return {
    ok: true,
    header: {
      makeSlug,
      model,
      modelSlug,
      engine,
      yearsFrom: yearsFrom as number,
      yearsTo,
      note: note === '' ? null : note,
    },
  };
}

/** «2015–2022», «с 2015 г.», «2019 г.». */
export function formatKitYears(yearsFrom: number, yearsTo: number | null): string {
  if (yearsTo === null) return `с ${yearsFrom} г.`;
  if (yearsTo === yearsFrom) return `${yearsFrom} г.`;
  return `${yearsFrom}–${yearsTo}`;
}

/** «ТО Lada Vesta 1.6 16V, 106 л.с.» (the heading of a kit). */
export function kitTitle(makeName: string, model: string, engine: string): string {
  return `ТО ${makeName} ${model} ${engine}`;
}

const INSTALL_RE =
  /(?:замен[аыу]?\s*[≈~]?|[≈~])\s*(\d{1,2}(?:[.,]\d)?)\s*(?:ч|час|часа|часов)(?![\p{L}\p{N}])/iu;

/**
 * The replacement time the master noted («замена ≈ 1 ч», «замена 1,5 часа», «≈ 2 ч»): the hours
 * as the page writes them ('1', '1,5'), or null. Only this reaches the kit page, never the rest of
 * the note and never a price: installing is the service's work, paid at the service.
 */
export function kitInstallHours(note: string | null): string | null {
  if (!note) return null;
  const match = INSTALL_RE.exec(note);
  if (!match?.[1]) return null;
  const value = Number(match[1].replace(',', '.'));
  if (!(value > 0 && value <= 12)) return null;
  return String(value).replace('.', ',');
}

/** «Замена ≈ 1 ч — можно записаться на установку после оформления». */
export function kitInstallText(hours: string): string {
  return `Замена ≈ ${hours} ч — можно записаться на установку после оформления`;
}

// ---------------------------------------------------------------------------
// Lines: main lines and their alternatives
// ---------------------------------------------------------------------------

export interface KitLineLink {
  id: string;
  position: number;
  /** The main line this one is an alternative of; null for a main line. */
  alternativeOf: string | null;
}

export interface KitLineGroup<T> {
  main: T;
  /** In position order. */
  alternatives: T[];
}

/**
 * Lines in position order as main lines with their alternatives. An alternative of an unknown
 * line or of another alternative is left out (the writer never stores one).
 */
export function groupKitLines<T extends KitLineLink>(lines: readonly T[]): KitLineGroup<T>[] {
  const ordered = [...lines].sort((a, b) => a.position - b.position);
  const groups = new Map<string, KitLineGroup<T>>();
  for (const line of ordered) {
    if (line.alternativeOf === null) groups.set(line.id, { main: line, alternatives: [] });
  }
  for (const line of ordered) {
    if (line.alternativeOf !== null) groups.get(line.alternativeOf)?.alternatives.push(line);
  }
  return [...groups.values()];
}

/**
 * What a line is right now, from its check by the VIN preview rule: priced (`ok`), marked goods
 * (`excluded`), not offered by the supplier now (`unavailable`: no such article or brand, no
 * stock or price), the supplier did not answer (`supplier`), a line that cannot be read
 * (`invalid`).
 */
export type KitLineState = 'ok' | 'excluded' | 'unavailable' | 'supplier' | 'invalid';

export function kitLineState(check: VinPreviewLine): KitLineState {
  if (check.status === 'ok') return 'ok';
  switch (check.reason) {
    case 'excluded':
      return 'excluded';
    case 'supplier_unavailable':
      return 'supplier';
    case 'parse':
      return 'invalid';
    case 'not_found':
    case 'brand_mismatch':
    case 'no_stock':
      return 'unavailable';
  }
}

export interface KitCheckedLine {
  /** Line number in the master's text (1-based). */
  line: number;
  alternative: boolean;
  state: KitLineState;
}

const PUBLISH_PROBLEM: Record<Exclude<KitLineState, 'ok'>, string> = {
  excluded: 'маркируемый товар — в набор нельзя',
  unavailable: 'нет у поставщика',
  supplier: 'поставщик не ответил — проверьте позже',
  invalid: 'строку не прочитать',
};

/**
 * Why a kit cannot be published (empty: it can). Every main line must be found and priced at
 * the supplier; no line, an alternative included, may be marked goods. An alternative the
 * supplier does not offer right now is fine: the page shows only the main line then.
 */
export function kitPublishProblems(lines: readonly KitCheckedLine[]): string[] {
  const problems: string[] = [];
  if (!lines.some((line) => !line.alternative)) problems.push('В наборе нет ни одной позиции');
  for (const line of lines) {
    if (line.state === 'ok') continue;
    if (line.alternative && line.state !== 'excluded') continue;
    problems.push(`Строка ${line.line}: ${PUBLISH_PROBLEM[line.state]}`);
  }
  return problems;
}

// ---------------------------------------------------------------------------
// Prices of the chosen lines
// ---------------------------------------------------------------------------

/** A priced line the client takes: the price per unit (priceOffer), the quantity, the date. */
export interface KitPricedChoice {
  priceClientKop: Kop;
  qty: number;
  etaDate: IsoDate;
}

export interface KitTotals {
  /** Sum of price × quantity. */
  totalKop: Kop;
  /** Sum of quantities. */
  itemsCount: number;
  /** «Получение к …»: the latest of the lines with the buffer days; null without lines. */
  promised: IsoDate | null;
}

/** Total and date of the lines the client takes (lines the supplier lacks are not among them). */
export function kitTotals(chosen: readonly KitPricedChoice[], eta: EtaSettings): KitTotals {
  let itemsCount = 0;
  for (const line of chosen) itemsCount += line.qty;
  return {
    totalKop: sumKop(chosen.map((line) => safeMul(line.priceClientKop, line.qty))),
    itemsCount,
    promised:
      chosen.length > 0
        ? promisedDate(
            chosen.map((line) => line.etaDate),
            eta,
          )
        : null,
  };
}

export interface KitOptionDelta {
  /** Line total of the alternative minus that of the main line (negative: cheaper). */
  deltaKop: number;
  /** The alternative arrives earlier / later than the main line. */
  faster: boolean;
  slower: boolean;
}

export function kitOptionDelta(
  main: KitPricedChoice,
  alternative: KitPricedChoice,
): KitOptionDelta {
  return {
    deltaKop:
      safeMul(alternative.priceClientKop, alternative.qty) - safeMul(main.priceClientKop, main.qty),
    faster: alternative.etaDate < main.etaDate,
    slower: alternative.etaDate > main.etaDate,
  };
}

/** «дешевле на 18 ₽», «дороже на 120 ₽ · быстрее», «быстрее», «та же цена». */
export function kitOptionHint(delta: KitOptionDelta): string {
  const parts: string[] = [];
  if (delta.deltaKop < 0) parts.push(`дешевле на ${formatRub(-delta.deltaKop)}`);
  else if (delta.deltaKop > 0) parts.push(`дороже на ${formatRub(delta.deltaKop)}`);
  if (delta.faster) parts.push('быстрее');
  else if (delta.slower) parts.push('дольше');
  return parts.length > 0 ? parts.join(' · ') : 'та же цена';
}
