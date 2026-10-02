/**
 * Order access by the secret link token and the client cancellation context, shared by the
 * order page and POST /api/orders/<token>/cancel.
 */
import type { PaymentScheme, PaymentStatus, TransitionContext } from '@detaly/domain';

/** orders.access_token: 32 random bytes base64url (43 characters, 256 bits). */
export const ORDER_TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

/** Checked before any database query: a malformed token is a 404 without touching the DB. */
export function isOrderToken(value: unknown): value is string {
  return typeof value === 'string' && ORDER_TOKEN_RE.test(value);
}

/**
 * Context of the `client_cancelled` event (decision Д3): the client acts, and for prepay the
 * guard needs the status of the order's latest payment (null when there is none).
 */
export function clientCancelContext({
  scheme,
  latestPaymentStatus,
}: {
  scheme: PaymentScheme;
  latestPaymentStatus: PaymentStatus | null;
}): TransitionContext {
  return { actor: 'client', scheme, providerPaymentStatus: latestPaymentStatus };
}
