import type { OrderMinimumsResult } from '@detaly/domain';
import { telHref } from '@/server/brand';
import type { InstallPlanView } from '@/server/install/types';
import { IconArrowRight, IconClock, IconPhone } from './icons';
import { InstallLine } from './install/InstallLine';
import { Notice } from './page/Notice';
import { Badge } from './ui/Badge';
import { buttonClass } from './ui/Button';
import { cn } from './ui/cn';
import { Price } from './ui/Price';

/**
 * Sum, the order's date, the minimum-order hint and "Оформить заказ" — or, while online
 * checkout is closed, the gate's text with a call button (every closed reason), so the client
 * who collected a cart still has a way to order. A key card: drawing corner marks.
 */
export function CartSummary({
  subtotalText,
  itemsCount,
  promiseText,
  minimums,
  gate,
  install,
}: {
  /** The lift slot after the order's date; undefined: not planned (no date or no hours). */
  install?: InstallPlanView | null;
  subtotalText: string;
  itemsCount: number;
  promiseText: string | null;
  minimums: OrderMinimumsResult;
  gate: { open: true } | { open: false; message: string; phone: string | null };
}) {
  return (
    <section
      className="corner-marks min-w-0 rounded border border-ink bg-card p-5 md:p-6"
      aria-label="Итого"
      data-testid="cart-summary"
    >
      <p className="text-label text-muted">Итого, {itemsCount} шт.</p>
      <Price size="lg" className="mt-3 block" data-testid="cart-total">
        {subtotalText}
      </Price>
      {promiseText ? (
        <p className="mt-4 flex items-start gap-2 border-t border-dashed border-line pt-4 text-sm text-muted">
          <IconClock size={16} className="mt-0.5 shrink-0 text-ink" />
          <span>
            Получение заказа <span className="font-semibold text-ink">{promiseText}</span>
          </span>
        </p>
      ) : null}
      {promiseText && install !== undefined ? (
        <div className="mt-2.5 space-y-2">
          <InstallLine plan={install} />
          {install?.demo ? <Badge tone="demo">загрузка демонстрационная</Badge> : null}
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
              <IconArrowRight size={18} />
            </a>
          ) : (
            <span
              className="inline-flex min-h-13 w-full cursor-not-allowed items-center justify-center rounded bg-paper-2 px-7 font-semibold text-faint"
              aria-disabled="true"
            >
              Оформить заказ
            </span>
          )
        ) : (
          <div className="space-y-3" data-testid="checkout-closed">
            <p className="text-sm text-muted">{gate.message}</p>
            {gate.phone ? (
              <a
                href={telHref(gate.phone)}
                className={cn(
                  buttonClass({ variant: 'primary', size: 'lg', block: true }),
                  'whitespace-nowrap',
                )}
                data-testid="call-to-order"
              >
                <IconPhone size={18} />
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
 * Phones only (below md) on /cart: the sum and «Оформить» fixed at the bottom, so checkout is
 * one tap away however long the cart is. The spacer keeps the footer reachable above it.
 */
export function CartCheckoutBar({
  totalText,
  itemsCount,
}: {
  totalText: string;
  itemsCount: number;
}) {
  return (
    <>
      <div aria-hidden className="h-[calc(4.5rem+env(safe-area-inset-bottom))] md:hidden" />
      <div
        className="fixed inset-x-0 bottom-0 z-40 border-t border-graphite-700 bg-graphite-950 pb-[env(safe-area-inset-bottom)] text-paper md:hidden"
        data-testid="cart-checkout-bar"
      >
        <div className="flex h-[4.5rem] items-center justify-between gap-3 px-4">
          <p className="min-w-0">
            <span className="block font-display text-lg leading-none font-semibold whitespace-nowrap tabular-nums">
              {totalText}
            </span>
            <span className="mt-1 block font-mono text-xs text-steel-400">{itemsCount} шт.</span>
          </p>
          <a
            href="/checkout"
            className={cn(buttonClass({ variant: 'primary', onDark: true }), 'shrink-0 px-5')}
          >
            Оформить
            <IconArrowRight size={18} />
          </a>
        </div>
      </div>
    </>
  );
}
