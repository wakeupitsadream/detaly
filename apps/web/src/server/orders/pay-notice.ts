/**
 * Query flags of /o/<token> after the payment page (section 14.4): `?paid=1` is YooKassa's
 * return_url, `?pay=error|unavailable` a failed «Оплатить», `since` the start of the
 * «Проверяем оплату…» refresh loop (it stops after two minutes).
 */
import type { OrderView } from './order-view';

/** How long the page keeps refreshing while the payment is pending. */
export const PAY_CHECK_WINDOW_MS = 2 * 60_000;
/** Seconds between two refreshes. */
export const PAY_CHECK_REFRESH_SEC = 5;

export interface PayNotice {
  /** Returned from the payment page. */
  paid: boolean;
  /** ?pay=error (creating the payment failed) or ?pay=unavailable (payments disabled). */
  payError: 'error' | 'unavailable' | null;
  /** Start of the refresh loop (epoch ms), null on the first visit. */
  since: number | null;
}

type SearchParams = Record<string, string | string[] | undefined>;

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export function parsePayNotice(params: SearchParams, nowMs: number = Date.now()): PayNotice {
  const pay = first(params.pay);
  const sinceRaw = first(params.since);
  const since = sinceRaw !== undefined && /^\d{1,15}$/.test(sinceRaw) ? Number(sinceRaw) : null;
  return {
    paid: first(params.paid) === '1',
    payError: pay === 'error' || pay === 'unavailable' ? pay : null,
    // A start in the future or older than a day is ignored (a stale or edited link).
    since: since !== null && since <= nowMs && nowMs - since < 86_400_000 ? since : null,
  };
}

export type PayCheck =
  /** Pending at the provider: «Проверяем оплату…» and a refresh to `refreshUrl`. */
  | { kind: 'checking'; refreshUrl: string; refreshSec: number }
  /** Still pending after two minutes: no more refreshes. */
  | { kind: 'slow' }
  | { kind: 'paid' }
  | { kind: 'failed' };

/**
 * State of the payment block after the return from YooKassa; null without `?paid=1`.
 *
 * «Оплата получена» needs the order to agree, not only the payment row. The webhook moves the
 * payment and the order in one transaction and the view reads them from one snapshot, so a
 * succeeded payment on an order still `awaiting_payment` means the order has not moved with it
 * (a guard held it back for the owner, or a writer to come). The page then keeps «Проверяем
 * оплату…» and its refresh, up to the same two minutes, and never shows «Оплата получена» next
 * to «Ждёт оплаты».
 */
export function payCheckState(
  view: Pick<OrderView, 'token' | 'payment' | 'status'>,
  notice: PayNotice,
  nowMs: number = Date.now(),
): PayCheck | null {
  if (!notice.paid || view.payment === null) return null;
  const { status } = view.payment;
  if (status === 'succeeded' && view.status !== 'awaiting_payment') return { kind: 'paid' };
  if (status === 'canceled') return { kind: 'failed' };
  const since = notice.since ?? nowMs;
  if (nowMs - since >= PAY_CHECK_WINDOW_MS) return { kind: 'slow' };
  return {
    kind: 'checking',
    refreshUrl: `/o/${view.token}?paid=1&since=${since}`,
    refreshSec: PAY_CHECK_REFRESH_SEC,
  };
}
