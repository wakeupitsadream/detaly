import type { Metadata } from 'next';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { CheckoutClosed } from '@/components/checkout/CheckoutClosed';
import { CheckoutForm } from '@/components/checkout/CheckoutForm';
import { CheckoutSteps } from '@/components/checkout/CheckoutSteps';
import { CheckoutSummary, PickupPoint } from '@/components/checkout/CheckoutSummary';
import { PaymentSchemeNote } from '@/components/checkout/PaymentSchemeNote';
import { DemoCheckoutNotice } from '@/components/demo/DemoCheckoutNotice';
import { DiffBanner } from '@/components/DiffBanner';
import { IconArrowRight } from '@/components/icons';
import { Notice } from '@/components/page/Notice';
import { InnerPage, PageBand, PageBody } from '@/components/page/PageBand';
import { getBrand } from '@/server/brand';
import { STALE_PRICES_TEXT } from '@/server/cart/summary';
import { readCartToken } from '@/server/cart-store';
import { getCheckoutGate } from '@/server/checkout-gate';
import {
  loadCheckoutPage,
  parseCartPart,
  type CheckoutPageData,
} from '@/server/checkout/page-data';
import { getDb } from '@/server/db';
import { errorInfo, PageDataError } from '@/server/errors';
import { serverEnv } from '@/server/env';
import { getLogger } from '@/server/logger';
import { isDemoMode } from '@/server/mode';
import { getSupplier } from '@/server/supplier';

// Personal data form and a cart-specific page: never indexed (also X-Robots-Tag from proxy).
export const metadata: Metadata = {
  title: 'Оформление заказа',
  robots: { index: false, follow: false },
};

type SearchParams = Record<string, string | string[] | undefined>;

function Band({ lead }: { lead?: string }) {
  return (
    <PageBand
      eyebrow="Самовывоз в Оренбурге"
      title="Оформление заказа"
      lead={lead}
      meta={<CheckoutSteps current={1} />}
    />
  );
}

export default async function CheckoutPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  // Demo (no database): no form and no personal data, the sample order instead.
  if (isDemoMode()) {
    return (
      <InnerPage>
        <Band />
        <PageBody>
          <DemoCheckoutNotice />
        </PageBody>
      </InnerPage>
    );
  }

  const params = await searchParams;
  const env = serverEnv();
  const db = getDb();
  const supplier = getSupplier();
  const brand = getBrand();
  const cookieStore = await cookies();

  let data: CheckoutPageData;
  try {
    data = await loadCheckoutPage(
      {
        db,
        supplier,
        loadSettings: () => supplier.settings.get(),
        gate: () => getCheckoutGate({ env, db, logger: getLogger() }),
      },
      { cartToken: readCartToken(cookieStore), part: parseCartPart(params.part) },
    );
  } catch (error) {
    // Names and SQLSTATE only: a driver message carries the cart token from the cookie.
    getLogger().error(errorInfo(error), 'checkout page failed');
    throw new PageDataError('checkout page: data unavailable');
  }

  if (data.kind === 'no_cart') redirect('/cart');

  if (data.kind === 'closed') {
    return (
      <InnerPage>
        <Band />
        <PageBody>
          <CheckoutClosed message={data.message} phone={brand.contactPhone} />
        </PageBody>
      </InnerPage>
    );
  }

  if (data.kind === 'emptied') {
    return (
      <InnerPage>
        <Band />
        <PageBody>
          <div className="mx-auto max-w-2xl space-y-4">
            <DiffBanner changes={data.changes} cartChanged />
            <p className="text-muted">В этой части корзины не осталось деталей для заказа.</p>
            <a
              className="inline-flex min-h-11 items-center gap-1.5 font-semibold underline underline-offset-4"
              href="/cart"
            >
              Вернуться в корзину
              <IconArrowRight size={16} />
            </a>
          </div>
        </PageBody>
      </InnerPage>
    );
  }

  const notes = (
    <>
      <DiffBanner changes={data.changes} />
      {data.staleCount > 0 ? (
        <Notice tone="neutral" data-testid="checkout-stale-prices">
          {STALE_PRICES_TEXT}.
        </Notice>
      ) : null}
      {data.mixed && data.part === 'local' ? (
        <Notice tone="info">
          Сначала оформляем детали со склада в Оренбурге. Позиции под заказ останутся в корзине — их
          оформим вторым заказом.
        </Notice>
      ) : null}
      {data.mixed && data.part === 'order' ? (
        <Notice tone="info">
          Оформляем детали под заказ. Позиции из Оренбурга останутся в корзине.
        </Notice>
      ) : null}
      {data.offerSplit ? (
        <Notice tone="info">
          В корзине есть детали в Оренбурге и под заказ. Одним заказом — предоплата 100%.{' '}
          <a className="font-semibold underline underline-offset-4" href="/checkout?part=local">
            Разделить на два заказа
          </a>
          : сначала детали из Оренбурга с оплатой при получении, затем — под заказ.
        </Notice>
      ) : null}
    </>
  );

  return (
    <InnerPage>
      <Band lead="Один экран: телефон, имя и два согласия. Цены и наличие сверим с поставщиком в момент оформления." />
      <PageBody className="space-y-6">
        <div className="space-y-3 empty:hidden">{notes}</div>
        <div className="grid min-w-0 gap-6 lg:grid-cols-[minmax(0,1fr)_25rem] lg:items-start lg:gap-x-10">
          <div className="min-w-0 lg:col-start-2 lg:row-start-1">
            <CheckoutSummary
              lines={data.lines}
              totalKop={data.totals.subtotalKop}
              promisedDate={data.promisedDate}
              linePromises={data.linePromises}
            />
          </div>
          <div className="min-w-0 lg:col-start-2 lg:row-start-2">
            <PaymentSchemeNote scheme={data.decision.scheme} sentences={data.explanation} />
          </div>
          <div className="min-w-0 lg:col-start-1 lg:row-span-3 lg:row-start-1">
            <CheckoutForm
              part={data.part}
              expectedTotalKop={data.totals.subtotalKop}
              itemsHash={data.itemsHash}
              checkoutKey={data.checkoutKey}
              documents={data.documents}
              expectedScheme={data.decision.scheme}
              expectedPromisedDate={data.promisedDate}
              marketingAvailable={data.marketingAvailable}
              blockedMessage={data.minimums.ok ? null : data.minimums.message}
              contactPhone={brand.contactPhone}
            />
          </div>
          <div className="min-w-0 lg:col-start-2 lg:row-start-3">
            <PickupPoint pickup={brand.pickup} />
          </div>
        </div>
      </PageBody>
    </InnerPage>
  );
}
