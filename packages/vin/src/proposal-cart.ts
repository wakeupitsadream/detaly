/**
 * «Оформить и оплатить» on /p/<token> (docs/phase-1c-implementation.md decision С14): the
 * proposal lines are copied into the visitor's own cart (the 1A `cart` cookie), which then goes
 * through the ordinary checkout (fresh GetSearch, DiffBanner, consents).
 *
 * - Lines are copied with their snapshots (offer, prices, date, fetched_at): checkout re-prices
 *   them past the cache like any cart line.
 * - A line with the same offer_key already in the cart gets the proposal's quantity (the master
 *   chose it), not the sum.
 * - The target cart remembers the request (`carts.vin_request_id`): the order created from it
 *   carries `orders.vin_request_id` and marks the request converted (markVinConverted).
 * - The cart limits of the web cart hold (lines and distinct query articles), otherwise
 *   checkout would refuse the cart later.
 *
 * Runs in the caller's transaction; both carts are locked (`for update`), the proposal first.
 */
import { and, cartItems, carts, eq, isNull, type Executor } from '@detaly/db';
import { v7 as uuidv7 } from 'uuid';
import { VIN_PROPOSAL_SEARCHES_MAX } from './preview';
import { isUuidString } from './requests';

/** Lines of one cart; mirrors MAX_CART_LINES of the web cart (apps/web/src/server/cart-store.ts). */
export const PROPOSAL_TARGET_LINES_MAX = 20;

export type CopyProposalRefusal =
  /** No proposal cart with this id, or the target is not an active client cart. */
  | 'not_found'
  /** Past proposal_expires_at, replaced by a newer proposal or the request was closed. */
  | 'expired'
  /** The merged cart would exceed PROPOSAL_TARGET_LINES_MAX lines. */
  | 'cart_full'
  /** The merged cart would need more than VIN_PROPOSAL_SEARCHES_MAX distinct searches. */
  | 'too_many_searches';

export type CopyProposalResult =
  | {
      ok: true;
      /** New lines inserted into the target cart. */
      inserted: number;
      /** Existing target lines whose quantity was set from the proposal. */
      updated: number;
      vinRequestId: string | null;
    }
  | { ok: false; reason: CopyProposalRefusal };

export async function copyProposalToCart(
  tx: Executor,
  input: { proposalCartId: string; targetCartId: string; now?: Date },
): Promise<CopyProposalResult> {
  if (!isUuidString(input.proposalCartId) || !isUuidString(input.targetCartId)) {
    return { ok: false, reason: 'not_found' };
  }
  if (input.proposalCartId === input.targetCartId) return { ok: false, reason: 'not_found' };
  const at = input.now ?? new Date();

  const [proposal] = await tx
    .select()
    .from(carts)
    .where(eq(carts.id, input.proposalCartId))
    .for('update');
  if (!proposal || proposal.proposalToken === null || proposal.proposalExpiresAt === null) {
    return { ok: false, reason: 'not_found' };
  }
  if (proposal.status !== 'active' || at.getTime() >= proposal.proposalExpiresAt.getTime()) {
    return { ok: false, reason: 'expired' };
  }
  const [target] = await tx
    .select()
    .from(carts)
    .where(
      and(
        eq(carts.id, input.targetCartId),
        eq(carts.status, 'active'),
        isNull(carts.proposalToken),
      ),
    )
    .for('update');
  if (!target) return { ok: false, reason: 'not_found' };

  const proposalLines = await tx.select().from(cartItems).where(eq(cartItems.cartId, proposal.id));
  const targetLines = await tx
    .select({
      id: cartItems.id,
      offerKey: cartItems.offerKey,
      searchArticleNorm: cartItems.searchArticleNorm,
    })
    .from(cartItems)
    .where(eq(cartItems.cartId, target.id));

  const byKey = new Map(targetLines.map((line) => [line.offerKey, line]));
  const toInsert = proposalLines.filter((line) => !byKey.has(line.offerKey));
  const toUpdate = proposalLines.filter((line) => byKey.has(line.offerKey));
  if (targetLines.length + toInsert.length > PROPOSAL_TARGET_LINES_MAX) {
    return { ok: false, reason: 'cart_full' };
  }
  const searches = new Set([
    ...targetLines.map((l) => l.searchArticleNorm),
    ...toInsert.map((l) => l.searchArticleNorm),
  ]);
  if (searches.size > VIN_PROPOSAL_SEARCHES_MAX) {
    return { ok: false, reason: 'too_many_searches' };
  }

  for (const line of toUpdate) {
    const existing = byKey.get(line.offerKey);
    if (!existing) continue;
    await tx
      .update(cartItems)
      .set({ qty: line.qty, updatedAt: at })
      .where(eq(cartItems.id, existing.id));
  }
  if (toInsert.length > 0) {
    await tx.insert(cartItems).values(
      toInsert.map((line) => ({
        id: uuidv7(),
        cartId: target.id,
        offerKey: line.offerKey,
        searchArticleNorm: line.searchArticleNorm,
        brand: line.brand,
        article: line.article,
        name: line.name,
        qty: line.qty,
        stockId: line.stockId,
        isLocal: line.isLocal,
        etaDate: line.etaDate,
        priceSupplierKop: line.priceSupplierKop,
        priceClientKop: line.priceClientKop,
        markupBp: line.markupBp,
        offerSnapshot: line.offerSnapshot,
        fetchedAt: line.fetchedAt,
        createdAt: at,
        updatedAt: at,
      })),
    );
  }
  await tx
    .update(carts)
    .set({ vinRequestId: proposal.vinRequestId, updatedAt: at })
    .where(eq(carts.id, target.id));
  return {
    ok: true,
    inserted: toInsert.length,
    updated: toUpdate.length,
    vinRequestId: proposal.vinRequestId,
  };
}
