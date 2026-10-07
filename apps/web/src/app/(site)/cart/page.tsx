import { promisedDate, type IsoDate } from '@detaly/domain';
import type { Metadata } from 'next';
import { cookies } from 'next/headers';
import { CartLineRow } from '@/components/CartLineRow';
import { CartCheckoutBar, CartSummary, type CartPaymentMode } from '@/components/CartSummary';
import { CheckoutSteps } from '@/components/checkout/CheckoutSteps';
import { DiffBanner } from '@/components/DiffBanner';
import { IconCart, IconPlus, IconSearch, IconSts } from '@/components/icons';
import { EmptyPanel } from '@/components/page/EmptyPanel';
import { Notice } from '@/components/page/Notice';
import { InnerPage, PageBand, PageBody } from '@/components/page/PageBand';
import { PaymentModeNotice } from '@/components/PaymentModeNotice';
import { ButtonLink } from '@/components/ui/Button';
import { cartCountLabel } from '@/lib/plural';
import { vinRequestHref } from '@/lib/vin-link';
import { getCartService } from '@/server/cart';
import { CART_ERROR_MESSAGES, isCartErrorCode } from '@/server/cart/errors';
import { FINAL_SCHEME_NOTE, STALE_PRICES_TEXT, summarizeCart } from '@/server/cart/summary';
import { readCartToken } from '@/server/cart-store';
import { getBrand } from '@/server/brand';
import type { CartView } from '@/server/cart/cart-service';
import { currentCheckoutGate } from '@/server/checkout-gate';
import { errorInfo, PageDataError } from '@/server/errors';
import { planInstallForDate, type InstallPlanView } from '@/server/install';
import { getLogger } from '@/server/logger';
import { FindByArticleLink } from './FindByArticleLink';

export const metadata: Metadata = {
  title: 'Корзина',
  robots: { index: false, follow: false },
};

type SearchParams = Record<string, string | string[] | undefined>;

function first(value: string | string[] | undefined): string {
  return (Array.isArray(value) ? value[0] : value) ?? '';
}

/** An empty cart: a large cart icon, one line and the two ways to find a part. */
function EmptyCart() {
  return (
    <EmptyPanel
      icon={<IconCart size={64} strokeWidth={1.5} />}
      title="Корзина пуста"
      testId="cart-empty"
      text="Найдите деталь по артикулу или отдайте подбор мастеру."
      actions={
        <>
          <FindByArticleLink icon={<IconSearch size={22} />}>Найти по артикулу</FindByArticleLink>
          <ButtonLink
            href={vinRequestHref()}
            variant="secondary"
            size="lg"
            className="bg-bg"
            icon={<IconSts size={22} className="text-brand" />}
          >
            Подобрать по VIN
          </ButtonLink>
        </>
      }
    />
  );
}

/** How the summary badge names the payment: summarizeCart adds the phone note only on pickup. */
function paymentMode(payment: { mixed: boolean; sentences: string[] }): CartPaymentMode {
  return !payment.mixed && payment.sentences.includes(FINAL_SCHEME_NOTE) ? 'on_pickup' : 'prepay';
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
        tone="light"
        title="Корзина"
        lead={summary ? cartCountLabel(summary.lines.length) : undefined}
        meta={summary ? <CheckoutSteps current={0} /> : undefined}
      />
      <PageBody className="space-y-4">
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
          <div className="grid min-w-0 gap-6 pt-2 lg:grid-cols-[minmax(0,1fr)_24rem] lg:items-start lg:gap-8">
            <div className="min-w-0 space-y-4">
              <ul className="min-w-0 space-y-3">
                {summary.lines.map((line) => (
                  <CartLineRow key={line.id} line={line} />
                ))}
              </ul>
              <p className="min-w-0" data-testid="cart-more">
                <ButtonLink href="/" variant="secondary" icon={<IconPlus size={20} />}>
                  Найти ещё деталь
                </ButtonLink>
              </p>
            </div>
            {/* top-28: clear of the sticky search plate (80 px) with a gap. */}
            <div className="min-w-0 space-y-3 lg:sticky lg:top-28">
              <CartSummary
                subtotalText={summary.subtotalText}
                itemsCount={summary.itemsCount}
                promiseText={summary.promiseText}
                minimums={summary.minimums}
                install={install}
                payment={paymentMode(summary.payment)}
                gate={gate.open ? { open: true } : { open: false, message: gate.message, phone }}
                paymentNotice={
                  summary.payment.mixed ? undefined : (
                    <PaymentModeNotice
                      payment={summary.payment}
                      checkoutOpen={gate.open && summary.minimums.ok}
                      hasToOrder={summary.lines.some((line) => !line.isLocal)}
                      inline
                    />
                  )
                }
              />
              {/* A mixed cart needs the decision (one prepaid order or two): its own card.
                  Below the minimum no part of the cart can be checked out either. */}
              {summary.payment.mixed ? (
                <PaymentModeNotice
                  payment={summary.payment}
                  checkoutOpen={gate.open && summary.minimums.ok}
                  hasToOrder={summary.lines.some((line) => !line.isLocal)}
                />
              ) : null}
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
