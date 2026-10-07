import { paymentsEnabled } from '@detaly/payments';
import type { Metadata } from 'next';
import { cookies } from 'next/headers';
import { notFound } from 'next/navigation';
import { cache } from 'react';
import { OrderDetails } from '@/components/order/OrderDetails';
import { pickupRoutes } from '@/components/PickupRouteLinks';
import { getBrand } from '@/server/brand';
import { readCartToken } from '@/server/cart-store';
import { getDb } from '@/server/db';
import { serverEnv } from '@/server/env';
import { errorInfo, PageDataError } from '@/server/errors';
import { photosEnabled } from '@/server/files';
import { planInstallForDate, type InstallPlanView } from '@/server/install';
import { getLogger } from '@/server/logger';
import { isOrderToken } from '@/server/orders/access';
import { findCartReminder } from '@/server/orders/cart-reminder';
import { parseOrderFlash } from '@/server/orders/flash';
import {
  EMPTY_SERVICES,
  loadOrderServices,
  type OrderServicesView,
} from '@/server/orders/order-services';
import { loadOrderView, type OrderView } from '@/server/orders/order-view';
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

/**
 * The phase 1C blocks. A failure (the photo store, a booking query) hides them with a warning
 * instead of failing the page: the order itself is already loaded.
 */
async function getOrderServices(view: OrderView, now: Date): Promise<OrderServicesView> {
  try {
    const env = serverEnv();
    return await loadOrderServices(getDb(), view, {
      env,
      now,
      photosEnabled: photosEnabled(),
      maxFileMb: env.FILES_MAX_UPLOAD_MB,
    });
  } catch (error) {
    getLogger().warn(errorInfo(error), 'order page: phase 1C blocks unavailable');
    return EMPTY_SERVICES;
  }
}

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
  const query = (await searchParams) ?? {};
  const notice = parsePayNotice(query, nowMs);
  const flash = parseOrderFlash(query);
  const brand = getBrand();
  const cartReminder = await findCartReminder(getDb(), readCartToken(await cookies()), (error) =>
    getLogger().warn(errorInfo(error), 'order page: cart lookup failed'),
  );

  // The nearest lift slot after the order's date: a calculation shown in «Самовывоз», never a
  // booking. A failure of the load source only hides the line.
  let install: InstallPlanView | null | undefined;
  if (view.promisedDate && !view.closed && view.fulfillment === 'pickup') {
    try {
      install = await planInstallForDate(view.promisedDate, new Date(nowMs));
    } catch (error) {
      getLogger().warn(errorInfo(error), 'order page: install plan unavailable');
      install = undefined;
    }
  }

  const services = await getOrderServices(view, new Date(nowMs));

  return (
    <OrderDetails
      view={view}
      install={install}
      services={services}
      flash={flash}
      pickup={brand.pickup}
      routes={pickupRoutes(brand)}
      contactPhone={brand.contactPhone}
      cartReminder={cartReminder}
      notice={notice}
      nowMs={nowMs}
    />
  );
}
