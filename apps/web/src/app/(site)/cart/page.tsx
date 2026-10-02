import { promisedDate, type IsoDate } from '@detaly/domain';
import type { Metadata } from 'next';
import { cookies } from 'next/headers';
import Link from 'next/link';
import { CartLineRow } from '@/components/CartLineRow';
import { CartCheckoutBar, CartSummary } from '@/components/CartSummary';
import { CheckoutSteps } from '@/components/checkout/CheckoutSteps';
import { DiffBanner } from '@/components/DiffBanner';
import { IconArrowRight, IconCart, IconSearch } from '@/components/icons';
import { Notice } from '@/components/page/Notice';
import { InnerPage, PageBand, PageBody } from '@/components/page/PageBand';
import { PaymentModeNotice } from '@/components/PaymentModeNotice';
import { buttonClass } from '@/components/ui/Button';
import { cartCountLabel } from '@/lib/plural';
import { getCartService } from '@/server/cart';
import { CART_ERROR_MESSAGES, isCartErrorCode } from '@/server/cart/errors';
import { STALE_PRICES_TEXT, summarizeCart } from '@/server/cart/summary';
import { readCartToken } from '@/server/cart-store';
import { getBrand } from '@/server/brand';
import type { CartView } from '@/server/cart/cart-service';
import { currentCheckoutGate } from '@/server/checkout-gate';
import { errorInfo, PageDataError } from '@/server/errors';
import { planInstallForDate, type InstallPlanView } from '@/server/install';
import { getLogger } from '@/server/logger';

export const metadata: Metadata = {
  title: 'Корзина',
  robots: { index: false, follow: false },
};

type SearchParams = Record<string, string | string[] | undefined>;

function first(value: string | string[] | undefined): string {
  return (Array.isArray(value) ? value[0] : value) ?? '';
}

function EmptyCart() {
  return (
    <div
      className="mx-auto flex max-w-xl min-w-0 flex-col items-center rounded border border-line bg-card px-5 py-10 text-center md:py-14"
      data-testid="cart-empty"
    >
      <div
        aria-hidden
        className="grid size-20 place-items-center rounded bg-graphite-800 bg-tread text-steel-200"
      >
        <IconCart size={34} />
      </div>
      <h2 className="mt-6 text-h2">Корзина пуста</h2>
      <p className="mt-3 max-w-sm text-muted">
        Найдите деталь по артикулу и нажмите «В корзину». Цену и дату получения покажем сразу.
      </p>
      <Link href="/" className={`${buttonClass({ size: 'lg' })} mt-7`}>
        <IconSearch size={18} strokeWidth={2} />
        Искать по артикулу
      </Link>
    </div>
  );
}

export default async function CartPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const params = await searchParams;
  const errorCode = first(params.error);
  const added = first(params.added) === '1';
  const token = readCartToken(await cookies());
  let view: CartView | null;
  try {
    // Re-prices from the supplier cache and stores the result: the banner shows once.
    view = await getCartService().viewCart(token);
  } catch (error) {
    // Names and SQLSTATE only: a driver message carries the cart token from the cookie.
    getLogger().error(errorInfo(error), 'cart page failed');
    throw new PageDataError('cart page: data unavailable');
  }
  const lines = view?.lines ?? [];
  const gate = lines.length > 0 ? await currentCheckoutGate() : null;
  const summary = view && lines.length > 0 ? summarizeCart(lines, view.settings) : null;
  const phone = getBrand().contactPhone;
  // The lift slot after the whole order's date, as the order page will show it.
  let install: InstallPlanView | null | undefined;
  if (view && summary) {
    const dates = view.lines
      .map((line) => line.etaDate)
      .filter((date): date is IsoDate => date !== null);
    if (dates.length > 0) {
      try {
        install = await planInstallForDate(promisedDate(dates, view.settings.eta), new Date());
      } catch (error) {
        getLogger().warn({ err: error }, 'cart page: install plan unavailable');
      }
    }
  }
  const checkoutReady = Boolean(summary && gate?.open && summary.minimums.ok);

  return (
    <InnerPage>
      <PageBand
        eyebrow={summary ? `В корзине ${cartCountLabel(summary.lines.length)}` : 'Корзина'}
        title="Корзина"
        meta={<CheckoutSteps current={0} />}
      />
      <PageBody className="space-y-6">
        {isCartErrorCode(errorCode) ? (
          <Notice tone="danger" role="alert" data-testid="cart-error">
            {CART_ERROR_MESSAGES[errorCode]}
          </Notice>
        ) : null}
        {added && !isCartErrorCode(errorCode) && lines.length > 0 ? (
          <Notice tone="ok" role="status">
            Добавили в корзину
          </Notice>
        ) : null}
        {view ? <DiffBanner changes={view.changes} /> : null}
        {view?.stale && lines.length > 0 ? (
          <Notice tone="neutral" role="status" data-testid="cart-stale">
            {STALE_PRICES_TEXT}
          </Notice>
        ) : null}

        {summary && gate ? (
          <div className="grid min-w-0 gap-8 lg:grid-cols-[minmax(0,1fr)_22rem] lg:items-start lg:gap-10">
            <div className="min-w-0 space-y-5">
              <ul className="min-w-0 space-y-3">
                {summary.lines.map((line) => (
                  <CartLineRow key={line.id} line={line} />
                ))}
              </ul>
              <p className="min-w-0" data-testid="cart-more">
                <Link href="/" className={buttonClass({ variant: 'secondary' })}>
                  Найти ещё деталь
                  <IconArrowRight size={18} />
                </Link>
              </p>
            </div>
            <div className="min-w-0 space-y-5 lg:sticky lg:top-24">
              <CartSummary
                subtotalText={summary.subtotalText}
                itemsCount={summary.itemsCount}
                promiseText={summary.promiseText}
                minimums={summary.minimums}
                install={install}
                gate={gate.open ? { open: true } : { open: false, message: gate.message, phone }}
              />
              {/* Below the minimum no part of the cart can be checked out either. */}
              <PaymentModeNotice
                payment={summary.payment}
                checkoutOpen={gate.open && summary.minimums.ok}
                hasToOrder={summary.lines.some((line) => !line.isLocal)}
              />
            </div>
          </div>
        ) : (
          <EmptyCart />
        )}
      </PageBody>
      {summary && checkoutReady ? (
        <CartCheckoutBar totalText={summary.subtotalText} itemsCount={summary.itemsCount} />
      ) : null}
    </InnerPage>
  );
}
