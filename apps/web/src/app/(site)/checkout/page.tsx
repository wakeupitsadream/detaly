import {
  cartTotals,
  choosePaymentScheme,
  explainPaymentScheme,
  promisedDate,
  type IsoDate,
} from '@detaly/domain';
import type { Metadata } from 'next';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { CheckoutClosed } from '@/components/checkout/CheckoutClosed';
import { CheckoutForm } from '@/components/checkout/CheckoutForm';
import { CheckoutSteps } from '@/components/checkout/CheckoutSteps';
import { CheckoutSummary, PickupPoint } from '@/components/checkout/CheckoutSummary';
import { PaymentSchemeNote } from '@/components/checkout/PaymentSchemeNote';
import { DiffBanner } from '@/components/DiffBanner';
import { IconArrowRight } from '@/components/icons';
import { Notice } from '@/components/page/Notice';
import { buttonClass } from '@/components/ui/Button';
import { InnerPage, PageBand, PageBody } from '@/components/page/PageBand';
import { getBrand } from '@/server/brand';
import { getCartService } from '@/server/cart';
import { promiseFor, STALE_PRICES_TEXT } from '@/server/cart/summary';
import { readCartToken } from '@/server/cart-store';
import { getCheckoutGate } from '@/server/checkout-gate';
import { FIELD_MESSAGES } from '@/server/checkout/input';
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

/** The checkout column: one column up to 40rem (docs/design-v2.md, «Оформление»). */
const COLUMN = 'mx-auto w-full max-w-[44rem] min-w-0';

function Band({ lead }: { lead?: string }) {
  return (
    <div className={COLUMN}>
      <PageBand tone="light" title="Оформление заказа" lead={lead}>
        <CheckoutSteps current={1} />
      </PageBand>
    </div>
  );
}

const DEMO_DOCUMENTS = {
  offerVersionId: 'demo',
  consentPdVersionId: 'demo',
  consentMarketingVersionId: null,
} as const;

async function DemoCheckout() {
  const brand = getBrand();
  const view = await getCartService().viewCart(readCartToken(await cookies()));
  const lines = view?.lines ?? [];
  if (!view || lines.length === 0) redirect('/cart');
  const { settings } = view;
  const totals = cartTotals(lines);
  const dates = lines.map((line) => line.etaDate).filter((d): d is IsoDate => d !== null);
  const promised = dates.length > 0 ? promisedDate(dates, settings.eta) : null;
  const decision = choosePaymentScheme({
    allItemsLocal: lines.every((line) => line.isLocal),
    totalKop: totals.subtotalKop,
    noShowCount: 0,
    noShowLimit: settings.order.noShowLimit,
    onPickupMaxTotalKop: settings.order.onPickupMaxTotalKop,
    fulfillment: 'pickup',
  });
  const linePromises = Object.fromEntries(
    lines.map((line) => [line.id, promiseFor([line.etaDate], settings)]),
  );
  return (
    <InnerPage>
      <Band lead="В демо поля уже заполнены примером." />
      <div className={COLUMN}>
        <PageBody>
          <div className="min-w-0" data-testid="demo-checkout">
            <CheckoutForm
              part="all"
              expectedTotalKop={totals.subtotalKop}
              itemsHash=""
              checkoutKey="demo"
              documents={DEMO_DOCUMENTS}
              expectedScheme={decision.scheme}
              expectedPromisedDate={promised}
              marketingAvailable={false}
              blockedMessage={null}
              contactPhone={brand.contactPhone}
              invalidMessages={FIELD_MESSAGES}
              demo={{ href: '/o/demo' }}
              receive={<PickupPoint pickup={brand.pickup} />}
              payment={
                <PaymentSchemeNote
                  scheme={decision.scheme}
                  sentences={explainPaymentScheme(decision, {
                    onPickupMaxTotalKop: settings.order.onPickupMaxTotalKop,
                  })}
                />
              }
              summary={
                <CheckoutSummary
                  lines={lines}
                  totalKop={totals.subtotalKop}
                  promisedDate={promised}
                  linePromises={linePromises}
                />
              }
            />
          </div>
        </PageBody>
      </div>
    </InnerPage>
  );
}

export default async function CheckoutPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  // Demo (no database): the real form over the demo cart, filled with an example; its button
  // opens the sample order and nothing is sent (POST /api/checkout answers 403 in the demo).
  if (isDemoMode()) return <DemoCheckout />;

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
        <div className={COLUMN}>
          <PageBody>
            <CheckoutClosed message={data.message} phone={brand.contactPhone} />
          </PageBody>
        </div>
      </InnerPage>
    );
  }

  if (data.kind === 'emptied') {
    return (
      <InnerPage>
        <Band />
        <div className={COLUMN}>
          <PageBody>
            <div className="space-y-4">
              <DiffBanner changes={data.changes} cartChanged />
              <p className="text-body text-muted">
                В этой части корзины не осталось деталей для заказа.
              </p>
              <a className={buttonClass({ variant: 'secondary', size: 'lg' })} href="/cart">
                Вернуться в корзину
                <IconArrowRight size={20} />
              </a>
            </div>
          </PageBody>
        </div>
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
        <Notice tone="info" title="Одним заказом — предоплата 100%">
          <a
            className="inline-flex min-h-11 items-center gap-1.5 font-semibold text-brand underline underline-offset-4"
            href="/checkout?part=local"
          >
            Разделить на два заказа
            <IconArrowRight size={18} />
          </a>
          <p>Сначала детали из Оренбурга с оплатой при получении, затем — под заказ.</p>
        </Notice>
      ) : null}
    </>
  );

  return (
    <InnerPage>
      <Band lead="Телефон, имя и два согласия — это всё." />
      <div className={COLUMN}>
        <PageBody className="space-y-4">
          <div className="space-y-3 empty:hidden">{notes}</div>
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
            invalidMessages={FIELD_MESSAGES}
            receive={<PickupPoint pickup={brand.pickup} />}
            payment={
              <PaymentSchemeNote scheme={data.decision.scheme} sentences={data.explanation} />
            }
            summary={
              <CheckoutSummary
                lines={data.lines}
                totalKop={data.totals.subtotalKop}
                promisedDate={data.promisedDate}
                linePromises={data.linePromises}
              />
            }
          />
        </PageBody>
      </div>
    </InnerPage>
  );
}
