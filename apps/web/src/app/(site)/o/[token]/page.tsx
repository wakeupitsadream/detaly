import { paymentsEnabled } from '@detaly/payments';
import type { Metadata } from 'next';
import { cookies } from 'next/headers';
import { notFound } from 'next/navigation';
import { cache } from 'react';
import { OrderDetails } from '@/components/order/OrderDetails';
import { getBrand } from '@/server/brand';
import { readCartToken } from '@/server/cart-store';
import { getDb } from '@/server/db';
import { serverEnv } from '@/server/env';
import { errorInfo, PageDataError } from '@/server/errors';
import { getLogger } from '@/server/logger';
import { isOrderToken } from '@/server/orders/access';
import { findCartReminder } from '@/server/orders/cart-reminder';
import { loadOrderView } from '@/server/orders/order-view';
import { parsePayNotice } from '@/server/orders/pay-notice';

type Params = Promise<{ token: string }>;
type SearchParams = Promise<Record<string, string | string[] | undefined>>;

/**
 * One query per request for both the metadata and the page. A database failure is logged
 * with names and SQLSTATE only and rethrown without the driver message: that message carries
 * the query parameters, and the access token is one of them (the error page shows nothing).
 */
const getOrderView = cache(async (token: string) => {
  try {
    const env = serverEnv();
    return await loadOrderView(getDb(), token, { env, paymentsEnabled: paymentsEnabled(env) });
  } catch (error) {
    getLogger().error(errorInfo(error), 'order page: database unavailable');
    throw new PageDataError('order page: database unavailable');
  }
});

const PRIVATE: Pick<Metadata, 'robots' | 'referrer'> = {
  robots: { index: false, follow: false },
  // The link token is a secret: never send it in Referer (headers are also set by proxy.ts).
  referrer: 'no-referrer',
};

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { token } = await params;
  if (!isOrderToken(token)) return { ...PRIVATE, title: 'Заказ' };
  const view = await getOrderView(token);
  return { ...PRIVATE, title: view ? `Заказ ${view.number}` : 'Заказ' };
}

export default async function OrderPage({
  params,
  searchParams,
}: {
  params: Params;
  searchParams?: SearchParams;
}) {
  const { token } = await params;
  if (!isOrderToken(token)) notFound();
  const view = await getOrderView(token);
  if (!view) notFound();

  const nowMs = Date.now();
  const notice = parsePayNotice((await searchParams) ?? {}, nowMs);
  const brand = getBrand();
  const cartReminder = await findCartReminder(getDb(), readCartToken(await cookies()), (error) =>
    getLogger().warn(errorInfo(error), 'order page: cart lookup failed'),
  );

  return (
    <OrderDetails
      view={view}
      pickup={brand.pickup}
      contactPhone={brand.contactPhone}
      cartReminder={cartReminder}
      notice={notice}
      nowMs={nowMs}
    />
  );
}
