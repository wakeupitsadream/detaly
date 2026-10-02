/**
 * Receipt provider contract, separate from payments (PLAN decision 9): plan A is
 * "Чеки от ЮKassa", plan B a cloud KKT (ATOL Online / Ferma) behind the same interface.
 * Prepayment and full receipts travel inside the payment; this provider issues the offset
 * receipt at handover and reads receipt status.
 */
import type {
  CreateCorrectionReceiptRequest,
  CreateOffsetReceiptRequest,
  ProviderReceipt,
} from './types';

export interface ReceiptProvider {
  readonly name: 'yookassa' | 'cloud_kkt';
  /** POST /receipts {type: payment, settlements: [{type: prepayment}]}; same key on retry. */
  createOffsetReceipt(request: CreateOffsetReceiptRequest): Promise<ProviderReceipt>;
  /** Polled until `succeeded` (every 2 min up to 15 min, then alert). */
  getReceipt(id: string): Promise<ProviderReceipt>;
  /** Only if the provider supports correction receipts (to verify with YooKassa). */
  createCorrectionReceipt?(request: CreateCorrectionReceiptRequest): Promise<ProviderReceipt>;
}
