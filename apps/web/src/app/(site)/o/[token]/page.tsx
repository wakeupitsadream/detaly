import type { Metadata } from 'next';
import { cookies } from 'next/headers';
import { notFound } from 'next/navigation';
import { cache } from 'react';
import { OrderDetails } from '@/components/order/OrderDetails';
import { getBrand } from '@/server/brand';
import { readCartToken } from '@/server/cart-store';
import { getDb } from '@/server/db';
import { getLogger } from '@/server/logger';
import { isOrderToken } from '@/server/orders/access';
import { findCartReminder } from '@/server/orders/cart-reminder';
import { loadOrderView } from '@/server/orders/order-view';

type Params = Promise<{ token: string }>;

/** One query per request for both the metadata and the page. */
const getOrderView = cache((token: string) => loadOrderView(getDb(), token));

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

export default async function OrderPage({ params }: { params: Params }) {
  const { token } = await params;
  if (!isOrderToken(token)) notFound();
  const view = await getOrderView(token);
  if (!view) notFound();

  const brand = getBrand();
  const cartReminder = await findCartReminder(getDb(), readCartToken(await cookies()), (error) =>
    getLogger().warn(
      { err: error instanceof Error ? error.message : 'error' },
      'order page: cart lookup failed',
    ),
  );

  return (
    <OrderDetails
      view={view}
      pickup={brand.pickup}
      contactPhone={brand.contactPhone}
      cartReminder={cartReminder}
    />
  );
}
