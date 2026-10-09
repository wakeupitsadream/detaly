/**
 * Step 6 (docs/garage.md): «Купить снова» in the client bot — a fresh «repeat» proposal from the
 * items of one of the client's orders, through the proposal machinery of the VIN flow:
 *
 * - every live item of the order (dropped ones left out) is a position «БРЕНД АРТИКУЛ КОЛ-ВО» of
 *   the same part; the same part twice is one position with the quantities added;
 * - each position is searched again (the caller's `search`: the 15-minute cache and the Rossko
 *   limiter) and resolved by the rule of the VIN preview (resolveVinPosition): the same brand and
 *   article, not marked goods, enough stock, the price of today through priceOffer, the date;
 * - a position the supplier does not offer now, a marked good or a failed search is skipped and
 *   named in the proposal's note («Не вошли: …»); with nothing left there is no proposal;
 * - the found lines become a proposal cart (/p/<token>, PROPOSAL_TTL_DAYS days) with
 *   `repeat_order_id` = the order (carts.vin_request_id stays null): /p shows it as «Купить
 *   снова», «Оформить» copies it into the client's cart with the same context, and the checkout
 *   fills «Моя машина» from that order's car.
 *
 * A second press while an identical repeat proposal of the order is live returns it
 * (`duplicate`). Nothing here logs; the caller logs the order number and counts, never the token.
 */
import {
  and,
  asc,
  cartItems,
  carts,
  desc,
  eq,
  isNotNull,
  orderItems,
  orders,
  type Database,
  type Executor,
} from '@detaly/db';
import {
  ARTICLE_NORM_RE,
  CLIENT_TIME_ZONE,
  DROPPED_ORDER_ITEM_STATES,
  MAX_LINE_QTY,
  PROPOSAL_TTL_DAYS,
  safeMul,
  sumKop,
  type EtaSettings,
  type ExcludedRule,
  type IsoDate,
  type OrderItemState,
  type PricingConfig,
  type RepriceContext,
  type VinPreviewErrorReason,
  type VinPreviewLine,
} from '@detaly/domain';
import { normalizeArticle } from '@detaly/rossko';
import { v7 as uuidv7 } from 'uuid';
import {
  resolveVinPosition,
  searchVinArticles,
  VIN_PROPOSAL_SEARCHES_MAX,
  type VinPosition,
  type VinSearch,
} from './preview';
import { isUuidString } from './requests';
import { newProposalToken } from './workflow';

export type RepeatSkipReason =
  /** The supplier has no such part (of this brand) now. */
  | 'not_found'
  /** Marked goods: not sold online. */
  | 'excluded'
  /** No price, date or stock for the quantity. */
  | 'no_stock'
  /** The search failed (quota, timeout): try again later. */
  | 'supplier'
  /** Over VIN_PROPOSAL_SEARCHES_MAX distinct parts in one proposal. */
  | 'too_many';

export const REPEAT_SKIP_LABELS: Readonly<Record<RepeatSkipReason, string>> = {
  not_found: 'нет у поставщика',
  excluded: 'не продаём онлайн',
  no_stock: 'нет в наличии',
  supplier: 'поставщик не ответил',
  too_many: 'не поместилось в одну подборку',
};

export interface RepeatLine {
  brand: string;
  article: string;
  name: string;
  qty: number;
  priceClientKop: number;
  etaDate: IsoDate;
  isLocal: boolean;
}

export interface RepeatSkipped {
  brand: string;
  article: string;
  reason: RepeatSkipReason;
}

export type RepeatProposalResult =
  | {
      ok: true;
      token: string;
      cartId: string;
      expiresAt: Date;
      orderNumber: string;
      lines: RepeatLine[];
      skipped: RepeatSkipped[];
      totalKop: number;
      /** The live identical repeat proposal of the order was returned (a second press). */
      duplicate: boolean;
    }
  | {
      ok: false;
      /**
       * not_found: no such order of this client (or a draft); empty: no live items; none_available:
       * nothing can be offered now; supplier_unavailable: every search failed.
       */
      reason: 'not_found' | 'empty' | 'none_available' | 'supplier_unavailable';
      orderNumber: string | null;
      skipped: RepeatSkipped[];
    };

export interface RepeatProposalInput {
  orderId: string;
  /** The client asking (the bot's binding): the order must be theirs. */
  userId: string;
  search: VinSearch;
  pricing: PricingConfig;
  excludedRules: readonly ExcludedRule[];
  eta: EtaSettings;
  now: Date;
  timeZone?: string;
}

const DROPPED: readonly OrderItemState[] = DROPPED_ORDER_ITEM_STATES;

/** Brand comparison key, as the preview compares brands. */
function brandKey(brand: string): string {
  return brand.toUpperCase().replace(/[^\p{L}\p{N}]+/gu, '');
}

function skipReason(reason: VinPreviewErrorReason): RepeatSkipReason {
  switch (reason) {
    case 'supplier_unavailable':
      return 'supplier';
    case 'excluded':
      return 'excluded';
    case 'no_stock':
      return 'no_stock';
    case 'not_found':
    case 'brand_mismatch':
    case 'parse':
      return 'not_found';
  }
}

/** «Не вошли: MANN W 914/2 — нет у поставщика; …» for the proposal page, or null. */
export function repeatSkippedNote(skipped: readonly RepeatSkipped[]): string | null {
  if (skipped.length === 0) return null;
  return `Не вошли: ${skipped
    .map((s) => `${s.brand} ${s.article} — ${REPEAT_SKIP_LABELS[s.reason]}`)
    .join('; ')}`;
}

type OkLine = Extract<VinPreviewLine, { status: 'ok' }>;

/** The order's live parts as preview positions (the same part twice: one, quantities added). */
async function positionsOf(
  db: Executor,
  orderId: string,
): Promise<{ positions: VinPosition[]; invalid: RepeatSkipped[] }> {
  const rows = await db
    .select({
      brand: orderItems.brand,
      article: orderItems.article,
      qty: orderItems.qty,
      state: orderItems.state,
      snapshot: orderItems.offerSnapshot,
    })
    .from(orderItems)
    .where(eq(orderItems.orderId, orderId))
    .orderBy(asc(orderItems.createdAt), asc(orderItems.id));
  const positions: VinPosition[] = [];
  const invalid: RepeatSkipped[] = [];
  const byKey = new Map<string, VinPosition>();
  for (const row of rows) {
    if (DROPPED.includes(row.state)) continue;
    const fromSnapshot = row.snapshot?.articleNorm;
    const articleNorm =
      typeof fromSnapshot === 'string' && ARTICLE_NORM_RE.test(fromSnapshot)
        ? fromSnapshot
        : normalizeArticle(row.article);
    if (!ARTICLE_NORM_RE.test(articleNorm)) {
      invalid.push({ brand: row.brand, article: row.article, reason: 'not_found' });
      continue;
    }
    const key = `${brandKey(row.brand)}|${articleNorm}`;
    const existing = byKey.get(key);
    if (existing) {
      existing.qty = Math.min(MAX_LINE_QTY, existing.qty + row.qty);
      continue;
    }
    const position: VinPosition = {
      line: positions.length + 1,
      raw: `${row.brand} ${row.article} ${row.qty}`,
      brand: row.brand,
      article: row.article,
      articleNorm,
      qty: Math.min(MAX_LINE_QTY, row.qty),
      note: null,
    };
    byKey.set(key, position);
    positions.push(position);
  }
  return { positions, invalid };
}

/** The order's live identical repeat proposal (same offers, quantities and prices), if any. */
async function liveSameRepeat(
  tx: Executor,
  orderId: string,
  lines: readonly OkLine[],
  note: string | null,
  at: Date,
): Promise<{ token: string; cartId: string; expiresAt: Date } | null> {
  const [cart] = await tx
    .select({
      id: carts.id,
      token: carts.proposalToken,
      expiresAt: carts.proposalExpiresAt,
      note: carts.sellerNote,
    })
    .from(carts)
    .where(
      and(
        eq(carts.repeatOrderId, orderId),
        eq(carts.status, 'active'),
        isNotNull(carts.proposalToken),
      ),
    )
    .orderBy(desc(carts.createdAt), desc(carts.id))
    .limit(1);
  if (
    !cart ||
    cart.token === null ||
    cart.expiresAt === null ||
    at.getTime() >= cart.expiresAt.getTime() ||
    cart.note !== note
  ) {
    return null;
  }
  const items = await tx
    .select({
      offerKey: cartItems.offerKey,
      qty: cartItems.qty,
      priceClientKop: cartItems.priceClientKop,
    })
    .from(cartItems)
    .where(eq(cartItems.cartId, cart.id));
  const signature = (l: { offerKey: string; qty: number; priceClientKop: number }) =>
    `${l.offerKey}|${l.qty}|${l.priceClientKop}`;
  const stored = items.map(signature).sort();
  const wanted = lines.map(signature).sort();
  if (stored.length !== wanted.length || stored.some((s, i) => s !== wanted[i])) return null;
  return { token: cart.token, cartId: cart.id, expiresAt: cart.expiresAt };
}

/** «Купить снова»: a fresh repeat proposal of the client's order (see the module comment). */
export async function createRepeatProposal(
  db: Database,
  input: RepeatProposalInput,
): Promise<RepeatProposalResult> {
  const refuse = (
    reason: Extract<RepeatProposalResult, { ok: false }>['reason'],
    orderNumber: string | null = null,
    skipped: RepeatSkipped[] = [],
  ): RepeatProposalResult => ({ ok: false, reason, orderNumber, skipped });
  if (!isUuidString(input.orderId) || !isUuidString(input.userId)) return refuse('not_found');
  const [order] = await db
    .select({ id: orders.id, number: orders.number, userId: orders.userId, status: orders.status })
    .from(orders)
    .where(eq(orders.id, input.orderId));
  if (!order || order.userId !== input.userId || order.status === 'draft') {
    return refuse('not_found');
  }

  const { positions, invalid } = await positionsOf(db, order.id);
  if (positions.length === 0 && invalid.length === 0) return refuse('empty', order.number);

  const skipped: RepeatSkipped[] = [...invalid];
  const searched: VinPosition[] = [];
  const articles = new Set<string>();
  for (const position of positions) {
    if (!articles.has(position.articleNorm) && articles.size >= VIN_PROPOSAL_SEARCHES_MAX) {
      skipped.push({ brand: position.brand, article: position.article, reason: 'too_many' });
      continue;
    }
    articles.add(position.articleNorm);
    searched.push(position);
  }

  const ctx: RepriceContext = {
    pricing: input.pricing,
    excludedRules: input.excludedRules,
    eta: input.eta,
    now: input.now,
    timeZone: input.timeZone ?? CLIENT_TIME_ZONE,
  };
  const outcomes = await searchVinArticles([...articles], input.search);
  const lines: OkLine[] = [];
  const offerKeys = new Set<string>();
  for (const position of searched) {
    const resolved = resolveVinPosition(
      position,
      outcomes.get(position.articleNorm) ?? { ok: false },
      ctx,
    );
    if (resolved.status === 'ok') {
      if (offerKeys.has(resolved.offerKey)) continue;
      offerKeys.add(resolved.offerKey);
      lines.push(resolved);
      continue;
    }
    skipped.push({
      brand: position.brand,
      article: position.article,
      reason: skipReason(resolved.reason),
    });
  }
  if (lines.length === 0) {
    const allFailed = skipped.length > 0 && skipped.every((s) => s.reason === 'supplier');
    return refuse(allFailed ? 'supplier_unavailable' : 'none_available', order.number, skipped);
  }

  const note = repeatSkippedNote(skipped);
  const at = input.now;
  const result = await db.transaction(async (tx) => {
    const live = await liveSameRepeat(tx, order.id, lines, note, at);
    if (live) return { ...live, duplicate: true };
    const token = newProposalToken();
    const expiresAt = new Date(at.getTime() + PROPOSAL_TTL_DAYS * 24 * 60 * 60 * 1000);
    const cartId = uuidv7();
    await tx.insert(carts).values({
      id: cartId,
      status: 'active',
      proposalToken: token,
      proposalExpiresAt: expiresAt,
      sellerNote: note,
      repeatOrderId: order.id,
      createdAt: at,
      updatedAt: at,
    });
    await tx.insert(cartItems).values(
      lines.map((line) => ({
        id: uuidv7(),
        cartId,
        offerKey: line.offerKey,
        searchArticleNorm: line.searchArticleNorm,
        brand: line.offer.brand,
        article: line.offer.article,
        name: line.offer.name,
        qty: line.qty,
        stockId: line.offer.stock.stockId,
        isLocal: line.isLocal,
        etaDate: line.etaDate,
        priceSupplierKop: line.priceSupplierKop,
        priceClientKop: line.priceClientKop,
        markupBp: line.markupBp,
        offerSnapshot: line.offer,
        fetchedAt: at,
        createdAt: at,
        updatedAt: at,
      })),
    );
    return { token, cartId, expiresAt, duplicate: false };
  });
  return {
    ok: true,
    ...result,
    orderNumber: order.number,
    lines: lines.map((line) => ({
      brand: line.brand,
      article: line.article,
      name: line.name,
      qty: line.qty,
      priceClientKop: line.priceClientKop,
      etaDate: line.etaDate,
      isLocal: line.isLocal,
    })),
    skipped,
    totalKop: sumKop(lines.map((line) => safeMul(line.priceClientKop, line.qty))),
  };
}
