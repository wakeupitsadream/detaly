/**
 * items_hash of a checkout (decision Д8): sha256 hex of the canonical `offerKey|qty|price`
 * payload from @detaly/domain. Rendered into the checkout form and recomputed by
 * POST /api/checkout from a fresh supplier answer; any difference means 409.
 */
import { createHash } from 'node:crypto';
import { itemsHashPayload, type CartLine } from '@detaly/domain';

export const ITEMS_HASH_RE = /^[0-9a-f]{64}$/;

export function itemsHash(
  lines: readonly Pick<CartLine, 'offerKey' | 'qty' | 'priceClientKop'>[],
): string {
  return createHash('sha256').update(itemsHashPayload(lines), 'utf8').digest('hex');
}
