/**
 * Step 5 (docs/kits.md): a kit priced for the page and for «Весь набор в корзину». Every line —
 * main lines and alternatives — is checked and priced right now by the VIN proposal preview rule
 * (checkKitLines: one GetSearch per article through the shared 15-minute cache, the single-flight
 * and the quota breaker of the web Rossko client; priceOffer for the price). Nothing priced is
 * stored or taken from the client.
 *
 * Per main line the client gets one choice: the main line, or one of its alternatives the
 * supplier offers now (an alternative it does not offer is not shown). The default is the main
 * line, or the first alternative on offer when the main line is not. A main line with nothing on
 * offer is «Нет у поставщика» and the cart button skips it.
 */
import {
  formatKitYears,
  formatPromise,
  formatRub,
  groupKitLines,
  kitInstallHours,
  kitInstallText,
  kitLineState,
  kitOptionDelta,
  kitOptionHint,
  kitTitle,
  kitTotals,
  promisedDate,
  safeMul,
  type IsoDate,
  type KitLineState,
  type KitPricedChoice,
  type VinPreviewLine,
} from '@detaly/domain';
import type { RosskoClient } from '@detaly/rossko';
import { checkKitLines } from '@detaly/vin';
import { vinSearchOf } from '../admin/vin-actions-handler';
import type { SearchSettings } from '../settings';
import { kitBrand, type KitLineRecord, type KitRecord } from './catalog';

type OkCheck = Extract<VinPreviewLine, { status: 'ok' }>;

/** One line the client may take: priced when `state` is `ok`. */
export interface KitOptionView {
  lineId: string;
  alternative: boolean;
  state: KitLineState;
  /** The supplier's brand and article when on offer, as typed otherwise. */
  brand: string;
  article: string;
  /** The supplier's name of the part; null when not on offer. */
  name: string | null;
  qty: number;
  /** On offer only (null otherwise). */
  offer: {
    /** Query article and offer id of the cart line (what the cart service is asked to add). */
    searchArticleNorm: string;
    offerKey: string;
    isLocal: boolean;
    priceClientKop: number;
    lineTotalKop: number;
    priceText: string;
    lineTotalText: string;
    etaDate: IsoDate;
    /** «к чт 9 октября» for this line alone. */
    promiseText: string;
  } | null;
  /** An alternative against its main line: «дешевле на 18 ₽ · быстрее»; null otherwise. */
  hint: string | null;
}

export interface KitGroupView {
  /** The main line's id: the name of its choice (`pick_<id>`). */
  mainLineId: string;
  /** «Фильтр масляный»: the master's role, else the supplier's name, else brand and article. */
  role: string;
  /** The main line first, then the alternatives on offer. */
  options: KitOptionView[];
  /** The option taken by default; null: nothing on offer (skipped by the button). */
  chosen: string | null;
}

export interface KitView {
  kit: KitRecord;
  /** «Lada». */
  makeName: string;
  /** «ТО Lada Vesta 1.6 16V, 106 л.с.». */
  title: string;
  /** «с 2015 г.», «2017–2022». */
  years: string;
  groups: KitGroupView[];
  /** The default choice: its sum, its pieces and «к …» (null when nothing is on offer). */
  totalKop: number;
  totalText: string;
  itemsCount: number;
  promiseText: string | null;
  /** Main lines with nothing on offer now. */
  unavailable: number;
  /** A supplier search failed: some lines could not be priced now. */
  supplierFailed: boolean;
  /** «Замена ≈ 1 ч — …» when the note names the replacement time. */
  installText: string | null;
}

export interface KitPricingDeps {
  rossko: Pick<RosskoClient, 'search'>;
  settings: Pick<SearchSettings, 'pricing' | 'excludedRules' | 'eta'>;
  now: Date;
}

function promiseOf(etaDate: IsoDate, settings: KitPricingDeps['settings']): string {
  return formatPromise(promisedDate([etaDate], settings.eta));
}

/** What kitOptionDelta compares: the line total and the date of an option on offer. */
function choiceOf(option: KitOptionView): KitPricedChoice | null {
  return option.offer
    ? {
        priceClientKop: option.offer.priceClientKop,
        qty: option.qty,
        etaDate: option.offer.etaDate,
      }
    : null;
}

function optionOf(
  line: KitLineRecord,
  check: VinPreviewLine,
  settings: KitPricingDeps['settings'],
): KitOptionView {
  const state = kitLineState(check);
  if (check.status !== 'ok') {
    return {
      lineId: line.id,
      alternative: line.alternativeOf !== null,
      state,
      brand: line.brand,
      article: line.article,
      name: null,
      qty: line.qty,
      offer: null,
      hint: null,
    };
  }
  const ok: OkCheck = check;
  const lineTotalKop = safeMul(ok.priceClientKop, ok.qty);
  return {
    lineId: line.id,
    alternative: line.alternativeOf !== null,
    state,
    brand: ok.offer.brand,
    article: ok.offer.article,
    name: ok.offer.name,
    qty: ok.qty,
    offer: {
      searchArticleNorm: ok.searchArticleNorm,
      offerKey: ok.offerKey,
      isLocal: ok.isLocal,
      priceClientKop: ok.priceClientKop,
      lineTotalKop,
      priceText: formatRub(ok.priceClientKop),
      lineTotalText: formatRub(lineTotalKop),
      etaDate: ok.etaDate,
      promiseText: promiseOf(ok.etaDate, settings),
    },
    hint: null,
  };
}

/** The options a client may take in a group, in its current choice (picks by line id). */
export function chosenOptions(
  view: Pick<KitView, 'groups'>,
  picks: ReadonlyMap<string, string> = new Map(),
): (KitOptionView | null)[] {
  return view.groups.map((group) => {
    const id = picks.get(group.mainLineId) ?? group.chosen;
    return group.options.find((option) => option.lineId === id) ?? null;
  });
}

/** Prices one kit (see the module comment). Never throws for a line or a supplier failure. */
export async function priceKit(kit: KitRecord, deps: KitPricingDeps): Promise<KitView> {
  const checks = await checkKitLines({
    lines: kit.lines,
    search: vinSearchOf(deps.rossko),
    pricing: deps.settings.pricing,
    excludedRules: deps.settings.excludedRules,
    eta: deps.settings.eta,
    now: deps.now,
  });
  const byId = new Map(
    kit.lines.map((line, index) => [line.id, optionOf(line, checks[index]!, deps.settings)]),
  );
  const groups: KitGroupView[] = groupKitLines(kit.lines).map(({ main, alternatives }) => {
    const mainOption = byId.get(main.id)!;
    const mainChoice = choiceOf(mainOption);
    const alternativeOptions = alternatives
      .map((line) => byId.get(line.id)!)
      .filter((option) => option.offer !== null)
      .map((option) => {
        const choice = choiceOf(option);
        return {
          ...option,
          hint: mainChoice && choice ? kitOptionHint(kitOptionDelta(mainChoice, choice)) : null,
        };
      });
    const options = [mainOption, ...alternativeOptions];
    const chosen = options.find((option) => option.offer !== null)?.lineId ?? null;
    return {
      mainLineId: main.id,
      role:
        main.role ??
        mainOption.name ??
        alternativeOptions[0]?.name ??
        `${main.brand} ${main.article}`,
      options,
      chosen,
    };
  });
  const chosen = chosenOptions({ groups }).filter(
    (option): option is KitOptionView & { offer: NonNullable<KitOptionView['offer']> } =>
      option?.offer != null,
  );
  const totals = kitTotals(
    chosen.map((option) => ({
      priceClientKop: option.offer.priceClientKop,
      qty: option.qty,
      etaDate: option.offer.etaDate,
    })),
    deps.settings.eta,
  );
  const hours = kitInstallHours(kit.note);
  const makeName = kitBrand(kit.makeSlug)?.name ?? kit.makeSlug;
  return {
    kit,
    makeName,
    title: kitTitle(makeName, kit.model, kit.engine),
    years: formatKitYears(kit.yearsFrom, kit.yearsTo),
    groups,
    totalKop: totals.totalKop,
    totalText: formatRub(totals.totalKop),
    itemsCount: totals.itemsCount,
    promiseText: totals.promised ? formatPromise(totals.promised) : null,
    unavailable: groups.filter((group) => group.chosen === null).length,
    supplierFailed: checks.some((check) => kitLineState(check) === 'supplier'),
    installText: hours ? kitInstallText(hours) : null,
  };
}
