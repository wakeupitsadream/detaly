/**
 * Contract for pages: "when will the car be ready" per offer, per date and for the home page
 * (docs/design.md, section 4). The part's pickup date (OfferView.etaDate + the ETA buffer, the
 * same date as OfferView.promiseText) -> the nearest free lift slot (packages/domain
 * install-window) -> the car is ready. One load snapshot per call; any failure gives an empty
 * answer and a warning in the log, never a failed page.
 */
import {
  addDays,
  buildOfferViews,
  etaDate as stockEtaDate,
  formatPromise,
  dayLoadStrip,
  localDate,
  parseWorkHours,
  planInstallWindow,
  promisedDate,
  weekdayShort,
  zonedWallTime,
  zoneOffsetMin,
  type EtaSettings,
  type InstallPlan,
  type IsoDate,
  type LoadSnapshot,
  type OfferView,
  type WeekSchedule,
} from '@detaly/domain';
import { DEMO_ARTICLES } from '@/lib/demo-articles';
import { getBrand } from '../brand';
import { singleton } from '../globals';
import { getLogger } from '../logger';
import { getSupplier } from '../supplier';
import { INSTALL_TIME_ZONE, INSTALL_WINDOW_OPTIONS } from './config';
import { getLoadSource, type LoadSource } from './load-source';
import type { InstallPlanView } from './types';

export type { InstallPlanView } from './types';
export type { LoadSource } from './load-source';

const DAY_MS = 86_400_000;

const MONTHS_SHORT = [
  'янв',
  'фев',
  'мар',
  'апр',
  'мая',
  'июн',
  'июл',
  'авг',
  'сен',
  'окт',
  'ноя',
  'дек',
] as const;

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

/** Local 'HH:MM' of an instant. */
function clock(instant: Date, timeZone: string): string {
  const { minutes } = zonedWallTime(instant.getTime(), timeZone);
  return `${pad2(Math.floor(minutes / 60))}:${pad2(Math.round(minutes % 60))}`;
}

/** '2026-10-08' -> 'чт 8 окт'. */
export function shortDay(date: IsoDate): string {
  const [, m, d] = date.split('-').map(Number) as [number, number, number];
  return `${weekdayShort(date)} ${d} ${MONTHS_SHORT[m - 1] as string}`;
}

/** 'сегодня' | 'завтра' | 'чт 8 окт' relative to `now`. */
export function relativeDay(date: IsoDate, now: Date, timeZone: string): string {
  const today = localDate(now, timeZone);
  if (date === today) return 'сегодня';
  if (date === addDays(today, 1)) return 'завтра';
  return shortDay(date);
}

/** ISO 8601 with the zone offset: '2026-10-08T14:00:00+05:00'. */
function isoWithOffset(instant: Date, timeZone: string): string {
  const { date } = zonedWallTime(instant.getTime(), timeZone);
  const offset = zoneOffsetMin(instant.getTime(), timeZone);
  const sign = offset < 0 ? '-' : '+';
  const abs = Math.abs(offset);
  return `${date}T${clock(instant, timeZone)}:00${sign}${pad2(Math.floor(abs / 60))}:${pad2(abs % 60)}`;
}

export function toInstallPlanView(
  plan: InstallPlan,
  pickupDate: IsoDate,
  now: Date,
  timeZone: string = INSTALL_TIME_ZONE,
): InstallPlanView {
  const slotDay = localDate(plan.slotStart, timeZone);
  return {
    partText: formatPromise(pickupDate),
    slotText: `${relativeDay(slotDay, now, timeZone)} с ${clock(plan.slotStart, timeZone)}`,
    carReadyText: `к ${clock(plan.carReadyAt, timeZone)}`,
    demo: plan.loadKind === 'demo',
    slotStartIso: isoWithOffset(plan.slotStart, timeZone),
  };
}

/* ---- Planner ----------------------------------------------------------------------------- */

export interface InstallPlannerDeps {
  /** PICKUP_HOURS as written; not understood -> no plans at all. */
  hours: string | null;
  loadSource: LoadSource;
  /** ETA settings: the buffer between the supplier date and the pickup date. */
  loadEta: () => Promise<EtaSettings>;
  timeZone?: string;
  onError?: (error: unknown, what: string) => void;
}

interface PlanContext {
  schedule: WeekSchedule;
  load: LoadSnapshot;
  eta: EtaSettings;
}

/** One planned part with what the home widget draws around the plan. */
export interface PlannedPart {
  plan: InstallPlan;
  view: InstallPlanView;
  pickupDate: IsoDate;
  /** Working hours of the slot day: booked of capacity, and whether the hour is the slot. */
  strip: { hour: number; booked: number; capacity: number; inSlot: boolean }[];
}

export interface InstallPlanner {
  forOffers(offers: readonly OfferView[], now: Date): Promise<Map<string, InstallPlanView | null>>;
  forDate(pickupDate: IsoDate, now: Date): Promise<InstallPlanView | null>;
  /** Pickup dates (buffer applied) planned with one snapshot, for the home widget. */
  forPickupDates(dates: readonly IsoDate[], now: Date): Promise<Map<IsoDate, PlannedPart | null>>;
  /** Pickup date of a part that is in stock in Orenburg today (supplier term 0 + buffer). */
  localPickupDate(now: Date): Promise<IsoDate>;
}

export function createInstallPlanner(deps: InstallPlannerDeps): InstallPlanner {
  const timeZone = deps.timeZone ?? INSTALL_TIME_ZONE;
  const schedule = parseWorkHours(deps.hours);
  const horizonDays = INSTALL_WINDOW_OPTIONS.horizonDays ?? 14;

  async function context(now: Date, latest: IsoDate): Promise<PlanContext | null> {
    if (schedule === null) return null;
    const eta = await deps.loadEta();
    // From now to the end of the horizon after the latest part (+2 days of slack for zones).
    const to = new Date(Date.parse(`${addDays(latest, horizonDays + 2)}T00:00:00Z`) + DAY_MS);
    const load = await deps.loadSource.snapshot(now, to);
    return { schedule, load, eta };
  }

  function planOne(ctx: PlanContext, pickupDate: IsoDate, now: Date): PlannedPart | null {
    const plan = planInstallWindow({
      etaDate: pickupDate,
      now,
      timeZone,
      schedule: ctx.schedule,
      load: ctx.load,
      loadKind: deps.loadSource.kind,
      options: INSTALL_WINDOW_OPTIONS,
    });
    if (plan === null) return null;
    return {
      plan,
      pickupDate,
      view: toInstallPlanView(plan, pickupDate, now, timeZone),
      strip: dayLoadStrip(plan, ctx.schedule, ctx.load, timeZone),
    };
  }

  function fail(error: unknown, what: string): void {
    deps.onError?.(error, what);
  }

  const planner: InstallPlanner = {
    async forOffers(offers, now) {
      const result = new Map<string, InstallPlanView | null>();
      if (offers.length === 0) return result;
      try {
        const latest = offers.reduce((max, o) => (o.etaDate > max ? o.etaDate : max), '0000-01-01');
        const ctx = await context(now, latest);
        if (ctx === null) return result;
        for (const offer of offers) {
          const pickupDate = promisedDate([offer.etaDate], ctx.eta);
          result.set(offer.id, planOne(ctx, pickupDate, now)?.view ?? null);
        }
        return result;
      } catch (error) {
        fail(error, 'install plan for offers');
        return new Map();
      }
    },

    async forDate(pickupDate, now) {
      try {
        const ctx = await context(now, pickupDate);
        return ctx === null ? null : (planOne(ctx, pickupDate, now)?.view ?? null);
      } catch (error) {
        fail(error, 'install plan for date');
        return null;
      }
    },

    async forPickupDates(dates, now) {
      const result = new Map<IsoDate, PlannedPart | null>();
      if (dates.length === 0) return result;
      try {
        const latest = dates.reduce((max, d) => (d > max ? d : max));
        const ctx = await context(now, latest);
        if (ctx === null) return result;
        for (const date of dates) result.set(date, planOne(ctx, date, now));
        return result;
      } catch (error) {
        fail(error, 'install plan for dates');
        return new Map();
      }
    },

    async localPickupDate(now) {
      const eta = await deps.loadEta();
      const supplierDate = stockEtaDate({ deliveryDays: 0, deliveryEnd: null }, now, timeZone);
      return promisedDate([supplierDate], eta);
    },
  };
  return planner;
}

function warn(error: unknown, what: string): void {
  try {
    getLogger().warn(
      { err: error instanceof Error ? error.message : String(error), what },
      'install',
    );
  } catch {
    // Logger unavailable (env not parsed): the page renders without the plan anyway.
  }
}

/** The process-wide planner: PICKUP_HOURS, the load source of this mode, settings ETA. */
function defaultPlanner(): InstallPlanner {
  return singleton('install-planner', () => {
    const hours = getBrand().pickup.hours;
    return createInstallPlanner({
      hours,
      loadSource: getLoadSource(parseWorkHours(hours)),
      loadEta: async () => (await getSupplier().settings.get()).eta,
      onError: warn,
    });
  });
}

/** Plan per OfferView.id; an offer without a plan is absent or null. */
export async function planInstallForOffers(
  offers: readonly OfferView[],
  now: Date,
): Promise<Map<string, InstallPlanView | null>> {
  if (offers.length === 0) return new Map();
  try {
    return await defaultPlanner().forOffers(offers, now);
  } catch (error) {
    warn(error, 'install planner');
    return new Map();
  }
}

/** Plan for a part that is at the pickup point on `etaDate` (the order page). */
export async function planInstallForDate(
  etaDate: IsoDate,
  now: Date,
): Promise<InstallPlanView | null> {
  try {
    return await defaultPlanner().forDate(etaDate, now);
  } catch (error) {
    warn(error, 'install planner');
    return null;
  }
}

/* ---- Home page showcase ------------------------------------------------------------------ */

/** One example of the home widget: a real offer (fixtures) or "a part in stock in Orenburg". */
export interface InstallShowcaseItem {
  key: string;
  /** null for the generic "in stock in Orenburg" example of the live mode. */
  offer: {
    article: string;
    brand: string;
    name: string;
    priceText: string;
    isLocal: boolean;
  } | null;
  view: InstallPlanView;
  /** Slot day: 'сегодня' | 'завтра' | 'чт 8 окт'. */
  slotDayText: string;
  /** Slot start 'HH:MM'. */
  slotClock: string;
  strip: PlannedPart['strip'];
}

export interface InstallShowcase {
  /** examples: the demo articles; local: one generic part from the Orenburg stock. */
  kind: 'examples' | 'local';
  items: InstallShowcaseItem[];
  demo: boolean;
}

/** Fastest sellable offer of an article: the requested article first, then date, then price. */
function fastestOffer(offers: readonly OfferView[]): OfferView | null {
  let best: OfferView | null = null;
  for (const offer of offers) {
    if (offer.excluded) continue;
    if (
      best === null ||
      Number(offer.isCross) - Number(best.isCross) < 0 ||
      (offer.isCross === best.isCross &&
        (offer.etaDate < best.etaDate ||
          (offer.etaDate === best.etaDate && offer.priceClientKop < best.priceClientKop)))
    ) {
      best = offer;
    }
  }
  return best;
}

function showcaseItem(
  key: string,
  offer: InstallShowcaseItem['offer'],
  part: PlannedPart,
  now: Date,
): InstallShowcaseItem {
  const slotDay = localDate(part.plan.slotStart, INSTALL_TIME_ZONE);
  return {
    key,
    offer,
    view: part.view,
    slotDayText: relativeDay(slotDay, now, INSTALL_TIME_ZONE),
    slotClock: clock(part.plan.slotStart, INSTALL_TIME_ZONE),
    strip: part.strip,
  };
}

/** Example offers of the demo articles from the supplier (fixtures), fastest per article. */
async function demoOffers(now: Date): Promise<OfferView[]> {
  const supplier = getSupplier();
  const settings = await supplier.settings.get();
  const found = await Promise.all(
    DEMO_ARTICLES.map(async (article) => {
      try {
        const result = await supplier.rossko.search(article, { priority: 'search' });
        const views = buildOfferViews(result.offers, {
          pricing: settings.pricing,
          excludedRules: settings.excludedRules,
          eta: settings.eta,
          now,
        });
        return fastestOffer(views);
      } catch (error) {
        warn(error, `install showcase ${article}`);
        return null;
      }
    }),
  );
  return found.filter((offer): offer is OfferView => offer !== null);
}

async function buildShowcase(now: Date): Promise<InstallShowcase | null> {
  const brand = getBrand();
  const planner = defaultPlanner();
  if (brand.demoData) {
    const offers = await demoOffers(now);
    const settings = await getSupplier().settings.get();
    const pickup = offers.map((offer) => promisedDate([offer.etaDate], settings.eta));
    const plans = await planner.forPickupDates(pickup, now);
    const items: InstallShowcaseItem[] = [];
    offers.forEach((offer, i) => {
      const part = plans.get(pickup[i] as IsoDate);
      if (!part) return;
      items.push(
        showcaseItem(
          offer.articleNorm,
          {
            article: offer.article,
            brand: offer.brand,
            name: offer.name,
            priceText: offer.priceText,
            isLocal: offer.isLocal,
          },
          part,
          now,
        ),
      );
    });
    if (items.length > 0) return { kind: 'examples', items, demo: items[0]!.view.demo };
  }
  const pickupDate = await planner.localPickupDate(now);
  const part = (await planner.forPickupDates([pickupDate], now)).get(pickupDate);
  if (!part) return null;
  return {
    kind: 'local',
    items: [showcaseItem('local', null, part, now)],
    demo: part.view.demo,
  };
}

const SHOWCASE_TTL_MS = 60_000;

/**
 * The home widget data: the demo articles in fixtures/demo mode, otherwise a part from the
 * Orenburg stock. Cached for a minute per process (the home page is the busiest one); null
 * when there is no plan to show (hours not understood, no free slot, a failure).
 */
export async function planInstallShowcase(now: Date): Promise<InstallShowcase | null> {
  // 'сегодня' / 'завтра' depend on the day: the cache never outlives it.
  const day = localDate(now, INSTALL_TIME_ZONE);
  const cache = singleton('install-showcase', () => ({
    at: 0,
    day: '',
    value: null as InstallShowcase | null,
  }));
  const age = now.getTime() - cache.at;
  if (cache.value !== null && cache.day === day && age >= 0 && age < SHOWCASE_TTL_MS) {
    return cache.value;
  }
  try {
    const value = await buildShowcase(now);
    if (value !== null) Object.assign(cache, { at: now.getTime(), day, value });
    return value;
  } catch (error) {
    warn(error, 'install showcase');
    return null;
  }
}
