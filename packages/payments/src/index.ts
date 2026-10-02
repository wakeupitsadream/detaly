// Public API of @detaly/payments: provider interfaces (PaymentProvider and a separate
// ReceiptProvider, PLAN decision 9). Step 0 stubs; implemented in work package P2.
import type { Kop } from '@detaly/domain/types';

export interface CreatePaymentRequest {
  orderId: string;
  orderNumber: string;
  amountKop: Kop;
  idempotenceKey: string;
  returnUrl: string;
}

export interface ProviderPayment {
  id: string;
  status: string;
  amountKop: Kop;
  confirmationUrl: string | null;
  raw: unknown;
}

export interface PaymentProvider {
  createPayment(request: CreatePaymentRequest): Promise<ProviderPayment>;
  getPayment(id: string): Promise<ProviderPayment>;
  createRefund(request: unknown): Promise<unknown>;
  getRefund(id: string): Promise<unknown>;
  parseWebhook(body: unknown): unknown;
}

export interface ReceiptProvider {
  createOffsetReceipt(request: unknown): Promise<unknown>;
  getReceipt(id: string): Promise<unknown>;
  createCorrectionReceipt?(request: unknown): Promise<unknown>;
}

export function createYooKassaProvider(_options: {
  shopId: string;
  secretKey: string;
  apiUrl: string;
}): PaymentProvider & ReceiptProvider {
  throw new Error('not implemented: @detaly/payments createYooKassaProvider');
}
