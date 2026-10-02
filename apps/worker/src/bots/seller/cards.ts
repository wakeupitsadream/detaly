// Seller bot cards (decision Б17, docs/phase-1b-implementation.md section 13.1): a card is the
// order text plus buttons from availableStaffActions, one message and one nonce (seller_cards).
// Wave 1 ships the port only; wave 4 (seller-bot) renders and sends the cards.
import type { SellerCardPort, WorkerDeps } from '../../deps';

export const SELLER_CARDS_NOT_IMPLEMENTED = 'not implemented: seller cards (phase 1B wave 4)';

export function createSellerCards(_deps: WorkerDeps): SellerCardPort {
  const fail = async (): Promise<never> => {
    throw new Error(SELLER_CARDS_NOT_IMPLEMENTED);
  };
  return {
    post: fail,
    refresh: fail,
    sendHandoverQr: fail,
  };
}
