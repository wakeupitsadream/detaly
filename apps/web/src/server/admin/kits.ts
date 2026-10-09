/**
 * Read models of /admin/kits (step 5, docs/kits.md): the list of kits and the editor of one kit.
 *
 * The editor works without JavaScript: «Проверить» submits the same form by GET to the editor's
 * own page (`?check=1` and the fields), which reads the draft from the query and shows the live
 * check of every line — found at the supplier (with the price, the date and the stock), not found
 * or marked goods — by the VIN preview rule (checkKitLines), with the total of the main lines.
 * «Сохранить», «Опубликовать», «Снять с публикации» and «Удалить» are POSTs (kits-handler.ts). A
 * saved kit shows the live check of its saved lines.
 */
import { asc, kitLines, kits, type Executor } from '@detaly/db';
import {
  formatKitYears,
  formatPromise,
  formatRub,
  groupKitLines,
  kitLineState,
  kitPublishProblems,
  kitTotals,
  promisedDate,
  safeMul,
  validateKitHeader,
  type KitHeader,
  type KitHeaderField,
  type KitLineState,
  type KitStatus,
  type VinPreviewLine,
} from '@detaly/domain';
import type { RosskoClient } from '@detaly/rossko';
import {
  checkKitLines,
  KIT_TEXT_MAX,
  kitLineText,
  parseKitText,
  type KitTextLine,
} from '@detaly/vin';
import { CAR_BRANDS } from '@/lib/brands';
import type { KitRecord } from '../kits/catalog';
import type { SearchSettings } from '../settings';
import { vinSearchOf } from './vin-actions-handler';

/** The makes a kit may be for: the CAR_BRANDS of the storefront (its logos and pages). */
export const KIT_MAKES: ReadonlySet<string> = new Set(CAR_BRANDS.map((brand) => brand.slug));

export const KIT_STATUS_LABELS: Record<KitStatus, string> = {
  draft: 'Черновик',
  published: 'Опубликован',
};

/** The latest year a kit may name: next year (a model year runs ahead of the calendar). */
export function kitMaxYear(now: Date): number {
  return now.getUTCFullYear() + 1;
}

/** The fields of the editor as typed (also the GET query of «Проверить»). */
export interface KitFormValues {
  make: string;
  model: string;
  engine: string;
  yearsFrom: string;
  yearsTo: string;
  note: string;
  lines: string;
}

/** Form field names (the POST body and the GET query of «Проверить» share them). */
export const KIT_FIELDS: Readonly<Record<keyof KitFormValues, string>> = {
  make: 'make',
  model: 'model',
  engine: 'engine',
  yearsFrom: 'years_from',
  yearsTo: 'years_to',
  note: 'note',
  lines: 'lines',
};

const FIELD_MAX: Readonly<Record<keyof KitFormValues, number>> = {
  make: 64,
  model: 200,
  engine: 200,
  yearsFrom: 8,
  yearsTo: 8,
  note: 400,
  lines: KIT_TEXT_MAX + 200,
};

export const EMPTY_KIT_FORM: KitFormValues = {
  make: '',
  model: '',
  engine: '',
  yearsFrom: '',
  yearsTo: '',
  note: '',
  lines: '',
};

/** The fields of a form or a query, each cut to its length (CRLF of a textarea -> LF). */
export function kitFormValues(read: (name: string) => string | null | undefined): KitFormValues {
  const out = { ...EMPTY_KIT_FORM };
  for (const key of Object.keys(KIT_FIELDS) as (keyof KitFormValues)[]) {
    const raw = (read(KIT_FIELDS[key]) ?? '').replace(/\r\n?/g, '\n');
    out[key] = raw.slice(0, FIELD_MAX[key]);
  }
  return out;
}

/** The editor's values of a saved kit. */
export function kitFormOf(kit: KitRecord): KitFormValues {
  return {
    make: kit.makeSlug,
    model: kit.model,
    engine: kit.engine,
    yearsFrom: String(kit.yearsFrom),
    yearsTo: kit.yearsTo === null ? '' : String(kit.yearsTo),
    note: kit.note ?? '',
    lines: groupKitLines(kit.lines)
      .flatMap((group) => [group.main, ...group.alternatives])
      .map((line) =>
        kitLineText({
          alternative: line.alternativeOf !== null,
          brand: line.brand,
          article: line.article,
          qty: line.qty,
          role: line.role,
        }),
      )
      .join('\n'),
  };
}

export type KitFieldErrors = Partial<Record<KitHeaderField, string>>;

export interface KitDraft {
  header: KitHeader | null;
  fieldErrors: KitFieldErrors;
  /** The lines that could be read, in text order. */
  lines: KitTextLine[];
  /** Lines that could not be read, with their numbers. */
  lineErrors: { line: number; raw: string; message: string }[];
  /** The text is too long or has no main line. */
  linesError: string | null;
}

/** The header and the lines of the editor, checked without the supplier. */
export function readKitDraft(values: KitFormValues, now: Date): KitDraft {
  const check = validateKitHeader(
    {
      make: values.make,
      model: values.model,
      engine: values.engine,
      yearsFrom: values.yearsFrom,
      yearsTo: values.yearsTo,
      note: values.note,
    },
    { makes: KIT_MAKES, maxYear: kitMaxYear(now) },
  );
  let linesError: string | null = null;
  let parsed: ReturnType<typeof parseKitText> = { lines: [], errors: [] };
  if (values.lines.length > KIT_TEXT_MAX) {
    linesError = `Строки — до ${KIT_TEXT_MAX} символов`;
  } else {
    parsed = parseKitText(values.lines);
    if (parsed.errors.length === 0 && !parsed.lines.some((line) => !line.alternative)) {
      linesError = 'Напишите позиции строками: БРЕНД АРТИКУЛ КОЛ-ВО — Название';
    }
  }
  return {
    header: check.ok ? check.header : null,
    fieldErrors: check.ok ? {} : check.errors,
    lines: parsed.lines,
    lineErrors: parsed.errors,
    linesError,
  };
}

/** One line of the live check, ready for the admin table. */
export interface AdminKitCheckLine {
  /** Line number in the text. */
  line: number;
  raw: string;
  /** «CASTROL EDGE5W40» as typed, for a line that was read; null for one that was not. */
  part: string | null;
  alternative: boolean;
  /** `parse`: the line cannot be read (then `message` says why). */
  state: KitLineState | 'parse';
  message: string | null;
  role: string | null;
  /** The role the page will show when none is typed: the supplier's name of the part. */
  roleFromOffer: string | null;
  qty: number;
  offer: {
    title: string;
    name: string;
    isLocal: boolean;
    priceText: string;
    lineTotalText: string;
    supplierPriceText: string;
    promiseText: string;
  } | null;
}

export interface AdminKitCheck {
  lines: AdminKitCheckLine[];
  /** The main lines on offer: their sum and the date (the default choice of the page). */
  totalText: string;
  promiseText: string | null;
  /** Why it cannot be published (lines that cannot be read included); empty: it can. */
  problems: string[];
  checkedAt: Date;
}

export interface KitCheckDeps {
  rossko: Pick<RosskoClient, 'search'>;
  settings: Pick<SearchSettings, 'pricing' | 'excludedRules' | 'eta'>;
  now: Date;
}

type OkCheck = Extract<VinPreviewLine, { status: 'ok' }>;

/** Checks the readable lines at the supplier (VIN preview rule): one check per line. */
export function checkDraftLines(
  lines: readonly Pick<KitTextLine, 'brand' | 'article' | 'qty'>[],
  deps: KitCheckDeps,
): Promise<VinPreviewLine[]> {
  return checkKitLines({
    lines,
    search: vinSearchOf(deps.rossko),
    pricing: deps.settings.pricing,
    excludedRules: deps.settings.excludedRules,
    eta: deps.settings.eta,
    now: deps.now,
  });
}

/** The live check of a draft for the editor: every line of the text in order. */
export async function checkKitDraft(draft: KitDraft, deps: KitCheckDeps): Promise<AdminKitCheck> {
  const checks = await checkDraftLines(draft.lines, deps);
  const checked: AdminKitCheckLine[] = draft.lines.map((line, index) => {
    const check = checks[index] as VinPreviewLine;
    const state = kitLineState(check);
    if (check.status !== 'ok') {
      return {
        line: line.line,
        raw: line.raw,
        part: `${line.brand} ${line.article}`,
        alternative: line.alternative,
        state,
        message: check.message,
        role: line.role,
        roleFromOffer: null,
        qty: line.qty,
        offer: null,
      };
    }
    const ok: OkCheck = check;
    return {
      line: line.line,
      raw: line.raw,
      part: `${line.brand} ${line.article}`,
      alternative: line.alternative,
      state,
      message: null,
      role: line.role,
      roleFromOffer: ok.offer.name,
      qty: ok.qty,
      offer: {
        title: `${ok.offer.brand} ${ok.offer.article}`,
        name: ok.offer.name,
        isLocal: ok.isLocal,
        priceText: formatRub(ok.priceClientKop),
        lineTotalText: formatRub(safeMul(ok.priceClientKop, ok.qty)),
        supplierPriceText: formatRub(ok.priceSupplierKop),
        promiseText: formatPromise(promisedDate([ok.etaDate], deps.settings.eta)),
      },
    };
  });
  const parseLines: AdminKitCheckLine[] = draft.lineErrors.map((error) => ({
    line: error.line,
    raw: error.raw,
    part: null,
    alternative: /^или(?:\s|:)/iu.test(error.raw),
    state: 'parse',
    message: error.message,
    role: null,
    roleFromOffer: null,
    qty: 0,
    offer: null,
  }));
  const okMains = draft.lines.flatMap((line, index) => {
    const check = checks[index];
    return !line.alternative && check?.status === 'ok' ? [check] : [];
  });
  const totals = kitTotals(
    okMains.map((check) => ({
      priceClientKop: check.priceClientKop,
      qty: check.qty,
      etaDate: check.etaDate,
    })),
    deps.settings.eta,
  );
  const problems = [
    ...draft.lineErrors.map((error) => `Строка ${error.line}: ${error.message}`),
    ...(draft.linesError
      ? [draft.linesError]
      : kitPublishProblems(
          draft.lines.map((line, index) => ({
            line: line.line,
            alternative: line.alternative,
            state: kitLineState(checks[index] as VinPreviewLine),
          })),
        )),
  ];
  return {
    lines: [...checked, ...parseLines].sort((a, b) => a.line - b.line),
    totalText: formatRub(totals.totalKop),
    promiseText: totals.promised ? formatPromise(totals.promised) : null,
    problems: [...new Set(problems)],
    checkedAt: deps.now,
  };
}

export interface AdminKitRow {
  id: string;
  makeSlug: string;
  makeName: string;
  model: string;
  modelSlug: string;
  engine: string;
  years: string;
  slug: string;
  status: KitStatus;
  mainLines: number;
  alternatives: number;
  updatedAt: Date;
  updatedBy: string;
}

const MAKE_NAMES = new Map(CAR_BRANDS.map((brand) => [brand.slug, brand.name]));

export function makeName(makeSlug: string): string {
  return MAKE_NAMES.get(makeSlug) ?? makeSlug;
}

/** Every kit, by make, model, years and engine (a shop has tens of them). */
export async function loadAdminKits(db: Executor): Promise<AdminKitRow[]> {
  const rows = await db
    .select()
    .from(kits)
    .orderBy(asc(kits.makeSlug), asc(kits.modelSlug), asc(kits.yearsFrom), asc(kits.engine));
  const lines = await db
    .select({ kitId: kitLines.kitId, alternativeOf: kitLines.alternativeOf })
    .from(kitLines);
  const counts = new Map<string, { main: number; alt: number }>();
  for (const line of lines) {
    const count = counts.get(line.kitId) ?? { main: 0, alt: 0 };
    if (line.alternativeOf === null) count.main += 1;
    else count.alt += 1;
    counts.set(line.kitId, count);
  }
  return rows.map((row) => ({
    id: row.id,
    makeSlug: row.makeSlug,
    makeName: makeName(row.makeSlug),
    model: row.model,
    modelSlug: row.modelSlug,
    engine: row.engine,
    years: formatKitYears(row.yearsFrom, row.yearsTo),
    slug: row.slug,
    status: row.status as KitStatus,
    mainLines: counts.get(row.id)?.main ?? 0,
    alternatives: counts.get(row.id)?.alt ?? 0,
    updatedAt: row.updatedAt,
    updatedBy: row.updatedBy,
  }));
}
