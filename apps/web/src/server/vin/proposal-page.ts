/**
 * What /p/<token> shows (docs/phase-1c-implementation.md decision С14): the master's comment,
 * the lines with the client price, date and stock badge, the total. Prices are re-checked from
 * the 15-minute supplier cache only, like the cart page (no Rossko call on a page view); the
 * fresh check past the cache is the ordinary checkout's (409 + DiffBanner).
 *
 * Client-safe: no supplier price, markup or offer snapshot leaves this module, nor the token.
 */
import {
  CLIENT_TIME_ZONE,
  formatRub,
  repriceCartLines,
  safeMul,
  sumKop,
  type CartLine,
  type RepricedLine,
} from '@detaly/domain';
import type { RosskoClient } from '@detaly/rossko';
import { fetchFreshOffers } from '../cart-store';
import type { CartSettings } from '../cart/cart-service';
import { promiseFor } from '../cart/summary';

export type ProposalLineStatus = 'ok' | 'unavailable' | 'excluded';

export interface ProposalLineView {
  id: string;
  brand: string;
  article: string;
  name: string;
  qty: number;
  isLocal: boolean;
  priceText: string;
  lineTotalText: string;
  /** «к чт 9 октября», null without a date. */
  promiseText: string | null;
  status: ProposalLineStatus;
}

export interface ProposalPageView {
  comment: string | null;
  lines: ProposalLineView[];
  /** Sum of the lines still available. */
  totalKop: number;
  totalText: string;
  itemsCount: number;
  /** Promised date of one order with every available line. */
  promiseText: string | null;
  /** Read-only: past its date, replaced by a newer proposal or the request was closed. */
  expired: boolean;
  /** «до 10 октября, 14:05» (Asia/Yekaterinburg). */
  expiresText: string;
  /** Some prices could not be re-checked now (cache miss or supplier failure). */
  stale: boolean;
  /** A price or quantity differs from what the master sent. */
  changed: boolean;
  /** Lines that cannot be sold any more (out of stock, stop list). */
  unavailable: number;
}

export interface ProposalSource {
  comment: string | null;
  lines: readonly CartLine[];
  expiresAt: Date;
  expired: boolean;
}

export interface ProposalPageDeps {
  rossko: Pick<RosskoClient, 'search'>;
  loadSettings: () => Promise<CartSettings>;
  now?: Date;
}

const EXPIRES_DAY = new Intl.DateTimeFormat('ru-RU', {
  timeZone: CLIENT_TIME_ZONE,
  day: 'numeric',
  month: 'long',
});

/**
 * «14 октября» for «Цены действуют до …»: the day the proposal ends, no clock time (a machine-like
 * «04:44» scared buyers). «До» the day of the end never promises more than the proposal holds.
 */
export function expiresTextOf(at: Date): string {
  return EXPIRES_DAY.format(at);
}

function lineView(line: RepricedLine, settings: CartSettings): ProposalLineView {
  return {
    id: line.id,
    brand: line.offer.brand,
    article: line.offer.article,
    name: line.offer.name,
    qty: line.qty,
    isLocal: line.isLocal,
    priceText: formatRub(line.priceClientKop),
    lineTotalText: formatRub(safeMul(line.priceClientKop, line.qty)),
    promiseText: promiseFor([line.etaDate], settings),
    status: line.status,
  };
}

/** The page view of re-priced proposal lines (pure). */
export function buildProposalPageView(
  source: ProposalSource,
  repriced: readonly RepricedLine[],
  settings: CartSettings,
  changes: number,
): ProposalPageView {
  const live = repriced.filter((line) => line.status === 'ok');
  const totalKop = sumKop(live.map((line) => safeMul(line.priceClientKop, line.qty)));
  let itemsCount = 0;
  for (const line of live) itemsCount += line.qty;
  return {
    comment: source.comment,
    lines: repriced.map((line) => lineView(line, settings)),
    totalKop,
    totalText: formatRub(totalKop),
    itemsCount,
    promiseText: promiseFor(
      live.map((line) => line.etaDate),
      settings,
    ),
    expired: source.expired,
    expiresText: expiresTextOf(source.expiresAt),
    stale: repriced.some((line) => line.stale),
    changed: changes > 0,
    unavailable: repriced.length - live.length,
  };
}

/** Re-prices the proposal lines from the supplier cache and builds the page view. */
export async function proposalPageView(
  source: ProposalSource,
  deps: ProposalPageDeps,
): Promise<ProposalPageView> {
  const settings = await deps.loadSettings();
  const now = deps.now ?? new Date();
  const fresh = await fetchFreshOffers(
    deps.rossko,
    source.lines.map((line) => line.searchArticleNorm),
    { priority: 'search', cacheOnly: true },
  );
  const { lines, changes } = repriceCartLines(source.lines, fresh, {
    pricing: settings.pricing,
    excludedRules: settings.excludedRules,
    eta: settings.eta,
    now,
  });
  return buildProposalPageView(source, lines, settings, changes.length);
}
