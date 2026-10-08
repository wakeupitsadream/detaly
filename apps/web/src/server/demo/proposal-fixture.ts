/**
 * The sample VIN proposal /p/demo (docs/phase-1c-implementation.md decision С21): the master's
 * comment and two positions picked from the bundled supplier fixtures with the prices and dates
 * the search shows right now: an oil filter on order and brake pads in Orenburg.
 *
 * DEMO_MODE: «Оформить и оплатить» puts these positions into the demo cart (the signed
 * `demo_cart` cookie, POST /api/proposals/demo/take). Outside the demo the page is a read-only
 * sample built from the same fixtures (never the live supplier: it costs no Rossko call).
 * Nothing here is a client's data.
 */
import {
  cartLineFromOffer,
  CartError,
  offerViewId,
  PROPOSAL_TTL_DAYS,
  type CartLine,
  type Offer,
  type RepriceContext,
} from '@detaly/domain';
import type { RosskoClient } from '@detaly/rossko';
import type { SearchSettings } from '../settings';

/** The token of the sample proposal (real tokens are 32 characters, never this). */
export const DEMO_PROPOSAL_TOKEN = 'demo';

/** The master's comment of the sample (no personal data). */
export const DEMO_PROPOSAL_COMMENT =
  'Подобрали по VIN: масляный фильтр — оригинальный размер, колодки — передние, в наличии в Оренбурге. Свечи менять пока не нужно.';

/** Query articles of the sample: an oil filter (to order) and brake pads (Orenburg). */
export const DEMO_PROPOSAL_ARTICLES = ['W9142', 'GDB1330'] as const;

const DAY_MS = 86_400_000;

export interface DemoProposalDeps {
  rossko: Pick<RosskoClient, 'search'>;
  loadSettings: () => Promise<Pick<SearchSettings, 'pricing' | 'excludedRules' | 'eta'>>;
  now?: Date;
}

/** One position of the sample as the demo cart cookie stores it. */
export interface DemoProposalPick {
  /** Normalized query article. */
  q: string;
  /** offerViewId of the offer. */
  offerId: string;
  qty: number;
}

export interface DemoProposal {
  comment: string;
  lines: CartLine[];
  picks: DemoProposalPick[];
  expiresAt: Date;
}

/** The requested article itself (not a cross), sellable, Orenburg stock first, then cheaper. */
function pickOffer(offers: readonly Offer[], ctx: RepriceContext, q: string): CartLine | null {
  const own = offers
    .filter((offer) => !offer.isCross && offer.priceSupplierKop > 0)
    .sort(
      (a, b) =>
        Number(b.stock.isLocal) - Number(a.stock.isLocal) ||
        a.priceSupplierKop - b.priceSupplierKop,
    );
  for (const offer of own) {
    try {
      const qty = Math.max(1, offer.stock.multiplicity);
      const line = cartLineFromOffer(offer, q, qty, ctx);
      return { id: `demo-${offerViewId(offer)}`, ...line };
    } catch (error) {
      if (error instanceof CartError) continue;
      throw error;
    }
  }
  return null;
}

export async function buildDemoProposal(deps: DemoProposalDeps): Promise<DemoProposal> {
  const now = deps.now ?? new Date();
  const settings = await deps.loadSettings();
  const ctx: RepriceContext = {
    pricing: settings.pricing,
    excludedRules: settings.excludedRules,
    eta: settings.eta,
    now,
  };
  const lines: CartLine[] = [];
  for (const q of DEMO_PROPOSAL_ARTICLES) {
    const { offers } = await deps.rossko.search(q, { priority: 'search' });
    const line = pickOffer(offers, ctx, q);
    if (line) lines.push(line);
  }
  if (lines.length === 0) throw new Error('demo proposal: no fixture offers');
  return {
    comment: DEMO_PROPOSAL_COMMENT,
    lines,
    picks: lines.map((line) => ({
      q: line.searchArticleNorm,
      offerId: line.offerKey,
      qty: line.qty,
    })),
    expiresAt: new Date(now.getTime() + PROPOSAL_TTL_DAYS * DAY_MS),
  };
}
