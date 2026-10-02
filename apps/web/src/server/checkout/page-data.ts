/**
 * Data of the /checkout page (docs/phase-1a-implementation.md section 6.1): the gate, the cart
 * part, a repricing through the supplier cache (as /cart) with its changes stored and shown
 * once, totals, the delivery promise, the payment scheme as it would be without no-shows, the
 * order minimums and the hidden values of the form (expected total, items hash, checkout key).
 * POST /api/checkout repeats the repricing past the cache and answers 409 on any difference.
 */
import type { Executor } from '@detaly/db';
import {
  cartTotals,
  checkOrderMinimums,
  choosePaymentScheme,
  explainPaymentScheme,
  promisedDate,
  repriceCartLines,
  selectCartPart,
  splitAdvice,
  splitCartLines,
  type CartPart,
  type CartTotals,
  type IsoDate,
  type LineChange,
  type OrderMinimumsResult,
  type PaymentSchemeDecision,
  type RepricedLine,
} from '@detaly/domain';
import type { RosskoClient } from '@detaly/rossko';
import { fetchFreshOffers, findActiveCart, persistRepricing } from '../cart-store';
import type { CheckoutGate } from '../checkout-gate';
import type { CheckoutSettings } from './checkout-service';
import { itemsHash } from './hash';
import { CART_PARTS } from './input';
import { uuidV7 } from './uuid';

export interface CheckoutPageDeps {
  db: Executor;
  supplier: { rossko: Pick<RosskoClient, 'search'> };
  loadSettings: () => Promise<CheckoutSettings>;
  gate: () => Promise<CheckoutGate>;
  now?: () => Date;
}

export interface CheckoutPageReady {
  kind: 'ready';
  /** Part actually checked out: 'all' for a homogeneous cart whatever was asked. */
  part: CartPart;
  /** Lines of the part after repricing (only `ok` ones). */
  lines: RepricedLine[];
  /** What the repricing changed (shown once in the DiffBanner). */
  changes: LineChange[];
  /** Lines whose supplier search failed: prices from the cart, re-checked at submit. */
  staleCount: number;
  totals: CartTotals;
  itemsHash: string;
  promisedDate: IsoDate | null;
  /** Scheme with no-shows counted as 0; the server decides finally by the phone. */
  decision: PaymentSchemeDecision;
  explanation: string[];
  minimums: OrderMinimumsResult;
  mixed: boolean;
  /** Mixed cart checked out whole: offer the split when the local part alone qualifies. */
  offerSplit: boolean;
  /** Lines of the cart that stay for a second order (the other part). */
  remainingCount: number;
  marketingAvailable: boolean;
  checkoutKey: string;
}

export type CheckoutPageData =
  | { kind: 'closed'; message: string }
  | { kind: 'no_cart' }
  | { kind: 'emptied'; changes: LineChange[] }
  | CheckoutPageReady;

export function parseCartPart(value: string | string[] | undefined): CartPart {
  const raw = Array.isArray(value) ? value[0] : value;
  return (CART_PARTS as readonly string[]).includes(raw ?? '') ? (raw as CartPart) : 'all';
}

export async function loadCheckoutPage(
  deps: CheckoutPageDeps,
  { cartToken, part: requested }: { cartToken: string | null; part: CartPart },
): Promise<CheckoutPageData> {
  const gate = await deps.gate();
  if (!gate.open) return { kind: 'closed', message: gate.message };

  const active = cartToken === null ? null : await findActiveCart(deps.db, cartToken);
  if (!active || active.lines.length === 0) return { kind: 'no_cart' };
  const { mixed } = splitCartLines(active.lines);
  const part: CartPart = mixed ? requested : 'all';
  const partLines = selectCartPart(active.lines, part);
  if (partLines.length === 0) return { kind: 'no_cart' };

  const now = (deps.now ?? (() => new Date()))();
  const [settings, fresh] = await Promise.all([
    deps.loadSettings(),
    // Through the cache; a failed article keeps its line as is (null) instead of failing.
    fetchFreshOffers(
      deps.supplier.rossko,
      partLines.map((l) => l.searchArticleNorm),
      { priority: 'search' },
    ),
  ]);
  const repriced = repriceCartLines(partLines, fresh, {
    markupRules: settings.markupRules,
    excludedRules: settings.excludedRules,
    eta: settings.eta,
    now,
  });
  if (repriced.changes.length > 0) {
    await persistRepricing(deps.db, active.cart.id, repriced.lines, { now });
  }
  const lines = repriced.lines.filter((l) => l.status === 'ok');
  if (lines.length === 0) return { kind: 'emptied', changes: repriced.changes };

  const totals = cartTotals(lines);
  const etaDates = lines.map((l) => l.etaDate).filter((d): d is IsoDate => d !== null);
  const decision = choosePaymentScheme({
    allItemsLocal: lines.every((l) => l.isLocal),
    totalKop: totals.subtotalKop,
    noShowCount: 0,
    noShowLimit: settings.order.noShowLimit,
    onPickupMaxTotalKop: settings.order.onPickupMaxTotalKop,
    fulfillment: 'pickup',
  });
  const removedIds = new Set(repriced.lines.filter((l) => l.status !== 'ok').map((l) => l.id));
  const partIds = new Set(partLines.map((l) => l.id));
  return {
    kind: 'ready',
    part,
    lines,
    changes: repriced.changes,
    staleCount: lines.filter((l) => l.stale).length,
    totals,
    itemsHash: itemsHash(lines),
    promisedDate: etaDates.length > 0 ? promisedDate(etaDates, settings.eta) : null,
    decision,
    explanation: explainPaymentScheme(decision, {
      onPickupMaxTotalKop: settings.order.onPickupMaxTotalKop,
    }),
    minimums: checkOrderMinimums({
      subtotalKop: totals.subtotalKop,
      marginKop: totals.marginKop,
      minOrderTotalKop: settings.order.minOrderTotalKop,
      minMarginKop: settings.order.minMarginKop,
    }),
    mixed,
    offerSplit:
      mixed &&
      part === 'all' &&
      splitAdvice(active.lines, {
        onPickupMaxTotalKop: settings.order.onPickupMaxTotalKop,
        noShowLimit: settings.order.noShowLimit,
      }).offerSplit,
    remainingCount: active.lines.filter((l) => !partIds.has(l.id) && !removedIds.has(l.id)).length,
    marketingAvailable: gate.docs.consentMarketing !== null,
    checkoutKey: uuidV7(now.getTime()),
  };
}
