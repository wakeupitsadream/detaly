import type { Metadata } from 'next';
import { cookies } from 'next/headers';
import Link from 'next/link';
import { CartLineRow } from '@/components/CartLineRow';
import { CartSummary } from '@/components/CartSummary';
import { DiffBanner } from '@/components/DiffBanner';
import { PaymentModeNotice } from '@/components/PaymentModeNotice';
import { getCartService } from '@/server/cart';
import { CART_ERROR_MESSAGES, isCartErrorCode } from '@/server/cart/errors';
import { STALE_PRICES_TEXT, summarizeCart } from '@/server/cart/summary';
import { readCartToken } from '@/server/cart-store';
import {
  CHECKOUT_CLOSED_DOCUMENTS_MESSAGE,
  getCheckoutGate,
  type CheckoutGate,
} from '@/server/checkout-gate';
import { getDb } from '@/server/db';
import { serverEnv } from '@/server/env';
import { getLogger } from '@/server/logger';

export const metadata: Metadata = {
  title: 'Корзина',
  robots: { index: false, follow: false },
};

type SearchParams = Record<string, string | string[] | undefined>;

function first(value: string | string[] | undefined): string {
  return (Array.isArray(value) ? value[0] : value) ?? '';
}

async function checkoutGate(): Promise<CheckoutGate> {
  try {
    return await getCheckoutGate({ env: serverEnv(), db: getDb(), logger: getLogger() });
  } catch (error) {
    getLogger().warn(
      { err: error instanceof Error ? error.message : String(error) },
      'checkout gate failed',
    );
    return { open: false, reason: 'documents', message: CHECKOUT_CLOSED_DOCUMENTS_MESSAGE };
  }
}

function EmptyCart() {
  return (
    <div
      className="rounded-card border border-dashed border-line bg-card p-6 text-center"
      data-testid="cart-empty"
    >
      <h2 className="text-lg font-semibold">Корзина пуста</h2>
      <p className="mx-auto mt-2 max-w-md text-muted">
        Найдите деталь по артикулу и нажмите «В корзину».
      </p>
      <Link
        href="/"
        className="mt-4 inline-flex h-11 items-center rounded-xl bg-accent px-5 font-semibold text-white hover:bg-accent-strong"
      >
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
  // Re-prices through the supplier cache and stores the result: the banner shows once.
  const view = await getCartService().viewCart(token);
  const lines = view?.lines ?? [];
  const gate = lines.length > 0 ? await checkoutGate() : null;
  const summary = view && lines.length > 0 ? summarizeCart(lines, view.settings) : null;

  return (
    <div className="min-w-0 space-y-6">
      <h1 className="text-2xl font-bold md:text-3xl">Корзина</h1>

      {isCartErrorCode(errorCode) ? (
        <p
          className="rounded-xl border border-warn/30 bg-warn-soft px-4 py-3 text-warn"
          role="alert"
          data-testid="cart-error"
        >
          {CART_ERROR_MESSAGES[errorCode]}
        </p>
      ) : null}
      {added && !isCartErrorCode(errorCode) && lines.length > 0 ? (
        <p
          className="rounded-xl border border-local/30 bg-local-soft px-4 py-3 text-local"
          role="status"
        >
          Добавили в корзину
        </p>
      ) : null}
      {view ? <DiffBanner changes={view.changes} /> : null}
      {view?.stale && lines.length > 0 ? (
        <p
          className="rounded-xl border border-line bg-card px-4 py-3 text-sm text-muted"
          role="status"
          data-testid="cart-stale"
        >
          {STALE_PRICES_TEXT}
        </p>
      ) : null}

      {summary && gate ? (
        <div className="grid min-w-0 gap-6 md:grid-cols-[minmax(0,1fr)_20rem] md:items-start">
          <ul className="min-w-0 space-y-3">
            {summary.lines.map((line) => (
              <CartLineRow key={line.id} line={line} />
            ))}
          </ul>
          <div className="min-w-0 space-y-4">
            <CartSummary
              subtotalText={summary.subtotalText}
              itemsCount={summary.itemsCount}
              promiseText={summary.promiseText}
              minimums={summary.minimums}
              gate={gate.open ? { open: true } : { open: false, message: gate.message }}
            />
            {/* Below the minimum no part of the cart can be checked out either. */}
            <PaymentModeNotice
              payment={summary.payment}
              checkoutOpen={gate.open && summary.minimums.ok}
            />
          </div>
        </div>
      ) : (
        <EmptyCart />
      )}
    </div>
  );
}
