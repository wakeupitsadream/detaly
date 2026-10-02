import type { Metadata } from 'next';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { CheckoutClosed } from '@/components/checkout/CheckoutClosed';
import { CheckoutForm } from '@/components/checkout/CheckoutForm';
import { CheckoutSummary, PickupPoint } from '@/components/checkout/CheckoutSummary';
import { PaymentSchemeNote } from '@/components/checkout/PaymentSchemeNote';
import { DiffBanner } from '@/components/DiffBanner';
import { getBrand } from '@/server/brand';
import { readCartToken } from '@/server/cart-store';
import { getCheckoutGate } from '@/server/checkout-gate';
import { loadCheckoutPage, parseCartPart } from '@/server/checkout/page-data';
import { getDb } from '@/server/db';
import { serverEnv } from '@/server/env';
import { getLogger } from '@/server/logger';
import { getSupplier } from '@/server/supplier';

// Personal data form and a cart-specific page: never indexed (also X-Robots-Tag from proxy).
export const metadata: Metadata = {
  title: 'Оформление заказа',
  robots: { index: false, follow: false },
};

type SearchParams = Record<string, string | string[] | undefined>;

export default async function CheckoutPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const params = await searchParams;
  const env = serverEnv();
  const db = getDb();
  const supplier = getSupplier();
  const brand = getBrand();
  const cookieStore = await cookies();

  const data = await loadCheckoutPage(
    {
      db,
      supplier,
      loadSettings: () => supplier.settings.get(),
      gate: () => getCheckoutGate({ env, db, logger: getLogger() }),
    },
    { cartToken: readCartToken(cookieStore), part: parseCartPart(params.part) },
  );

  if (data.kind === 'no_cart') redirect('/cart');

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold md:text-3xl">Оформление заказа</h1>
      {data.kind === 'closed' ? (
        <CheckoutClosed message={data.message} phone={brand.contactPhone} />
      ) : data.kind === 'emptied' ? (
        <div className="space-y-4">
          <DiffBanner changes={data.changes} cartChanged />
          <p className="text-muted">В этой части корзины не осталось деталей для заказа.</p>
          <a className="underline" href="/cart">
            Вернуться в корзину
          </a>
        </div>
      ) : (
        <div className="grid min-w-0 gap-6 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] md:items-start">
          <div className="min-w-0 space-y-4">
            <DiffBanner changes={data.changes} />
            {data.staleCount > 0 ? (
              <p className="rounded-xl border border-warn/30 bg-warn-soft px-4 py-3 text-sm text-warn">
                Не удалось обновить цены, проверим при оформлении.
              </p>
            ) : null}
            {data.mixed && data.part === 'local' ? (
              <p className="rounded-xl border border-line bg-card px-4 py-3 text-sm text-muted">
                Сначала оформляем детали со склада в Оренбурге. Позиции под заказ останутся в
                корзине — их оформим вторым заказом.
              </p>
            ) : null}
            {data.mixed && data.part === 'order' ? (
              <p className="rounded-xl border border-line bg-card px-4 py-3 text-sm text-muted">
                Оформляем детали под заказ. Позиции из Оренбурга останутся в корзине.
              </p>
            ) : null}
            {data.offerSplit ? (
              <p className="rounded-xl border border-line bg-card px-4 py-3 text-sm text-muted">
                В корзине есть детали в Оренбурге и под заказ. Одним заказом — предоплата 100%.{' '}
                <a className="font-medium text-ink underline" href="/checkout?part=local">
                  Разделить на два заказа
                </a>
                : сначала детали из Оренбурга с оплатой при получении, затем — под заказ.
              </p>
            ) : null}
            <CheckoutSummary
              lines={data.lines}
              totalKop={data.totals.subtotalKop}
              promisedDate={data.promisedDate}
            />
          </div>
          <div className="min-w-0 space-y-4">
            <PaymentSchemeNote scheme={data.decision.scheme} sentences={data.explanation} />
            <PickupPoint pickup={brand.pickup} />
            <CheckoutForm
              part={data.part}
              expectedTotalKop={data.totals.subtotalKop}
              itemsHash={data.itemsHash}
              checkoutKey={data.checkoutKey}
              marketingAvailable={data.marketingAvailable}
              blockedMessage={data.minimums.ok ? null : data.minimums.message}
              contactPhone={brand.contactPhone}
            />
          </div>
        </div>
      )}
    </div>
  );
}
