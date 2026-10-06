import type { OrderMinimumsResult } from '@detaly/domain';
import type { ReactNode } from 'react';
import { telHref } from '@/server/brand';
import type { InstallPlanView } from '@/server/install/types';
import { IconArrowRight, IconCalendar, IconCard, IconPhone, IconWallet } from './icons';
import { InstallLine } from './install/InstallLine';
import { Notice } from './page/Notice';
import { Badge } from './ui/Badge';
import { buttonClass } from './ui/Button';
import { cn } from './ui/cn';
import { Price } from './ui/Price';

/** How the cart will be paid, as the badge of the summary. */
export type CartPaymentMode = 'on_pickup' | 'prepay';

const PAYMENT_BADGE: Record<CartPaymentMode, { text: string; tone: 'ok' | 'info' }> = {
  on_pickup: { text: 'Оплата при получении', tone: 'ok' },
  prepay: { text: 'Предоплата онлайн', tone: 'info' },
};

/**
 * The total of /cart on a grey panel (docs/design-v2.md, «Корзина»): the sum large, the payment
 * mode as a badge, the order's date, the install line and «Оформить заказ» — or, while online
 * checkout is closed, the gate's text with a call button (every closed reason), so the client
 * who collected a cart still has a way to order.
 */
export function CartSummary({
  subtotalText,
  itemsCount,
  promiseText,
  minimums,
  gate,
  install,
  payment,
  paymentNotice,
}: {
  /** The lift slot after the order's date; undefined: not planned (no date or no hours). */
  install?: InstallPlanView | null;
  subtotalText: string;
  itemsCount: number;
  promiseText: string | null;
  minimums: OrderMinimumsResult;
  gate: { open: true } | { open: false; message: string; phone: string | null };
  /** The payment mode badge; none when not given. */
  payment?: CartPaymentMode;
  /** «Как это работает» under the badge (PaymentModeNotice `inline`). */
  paymentNotice?: ReactNode;
}) {
  const badge = payment ? PAYMENT_BADGE[payment] : null;
  return (
    <section
      className="min-w-0 rounded-panel bg-surface p-5 md:p-6"
      aria-label="Итого"
      data-testid="cart-summary"
    >
      <p className="text-small text-muted">Итого, {itemsCount} шт.</p>
      <Price size="lg" className="mt-1 block" data-testid="cart-total">
        {subtotalText}
      </Price>
      {badge ? (
        <Badge
          tone={badge.tone}
          size="lg"
          className="mt-3"
          icon={
            payment === 'on_pickup' ? (
              <IconWallet size={18} className="shrink-0" />
            ) : (
              <IconCard size={18} className="shrink-0" />
            )
          }
        >
          {badge.text}
        </Badge>
      ) : null}
      {paymentNotice}
      {promiseText ? (
        <p className="mt-4 flex items-start gap-2 border-t border-surface-2 pt-4 text-body">
          <IconCalendar size={22} className="shrink-0 text-brand" />
          <span>
            Получение <span className="font-bold whitespace-nowrap">{promiseText}</span>
          </span>
        </p>
      ) : null}
      {promiseText && install !== undefined ? (
        <div className="mt-2 space-y-2">
          <InstallLine plan={install} size="md" />
          {install?.demo ? <Badge tone="demo">Демо: время условное</Badge> : null}
        </div>
      ) : null}
      {!minimums.ok ? (
        <Notice tone="wait" className="mt-4" data-testid="cart-minimum">
          {minimums.message}
        </Notice>
      ) : null}
      <div className="mt-5">
        {gate.open ? (
          minimums.ok ? (
            <a
              href="/checkout"
              className={buttonClass({ variant: 'primary', size: 'lg', block: true })}
              data-testid="checkout-link"
            >
              Оформить заказ
              <IconArrowRight size={20} />
            </a>
          ) : (
            <span
              className="inline-flex min-h-13 w-full cursor-not-allowed items-center justify-center rounded-control bg-surface-2 px-6 text-[1.0625rem] font-semibold text-muted"
              aria-disabled="true"
            >
              Оформить заказ
            </span>
          )
        ) : (
          <div className="space-y-3" data-testid="checkout-closed">
            <p className="text-small font-normal text-muted">{gate.message}</p>
            {gate.phone ? (
              <a
                href={telHref(gate.phone)}
                className={cn(
                  buttonClass({ variant: 'primary', size: 'lg', block: true }),
                  'whitespace-nowrap',
                )}
                data-testid="call-to-order"
              >
                <IconPhone size={20} />
                Позвонить {gate.phone}
              </a>
            ) : null}
          </div>
        )}
      </div>
    </section>
  );
}

/**
 * Phones only (below md) on /cart: the sum and «Оформить» on a white floating panel at the
 * bottom, so checkout is one tap away however long the cart is. The footer makes room for it
 * (`.mobile-cart-bar` in globals.css).
 */
export function CartCheckoutBar({
  totalText,
  itemsCount,
}: {
  totalText: string;
  itemsCount: number;
}) {
  return (
    <div
      className="mobile-cart-bar fixed inset-x-0 bottom-0 z-40 px-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))] md:hidden"
      data-testid="cart-checkout-bar"
    >
      <div className="flex h-17 items-center justify-between gap-3 rounded-tile border border-line bg-bg pr-2.5 pl-4 text-ink shadow-float">
        <p className="min-w-0">
          <span className="block text-[1.25rem] leading-tight font-extrabold whitespace-nowrap tabular-nums">
            {totalText}
          </span>
          <span className="block text-small text-muted">{itemsCount} шт.</span>
        </p>
        <a href="/checkout" className={cn(buttonClass({ variant: 'primary' }), 'shrink-0 px-5')}>
          Оформить
          <IconArrowRight size={20} />
        </a>
      </div>
    </div>
  );
}
