import type { OrderMinimumsResult } from '@detaly/domain';
import { telHref } from '@/server/brand';
import { IconArrowRight, IconClock, IconPhone } from './icons';
import { Notice } from './page/Notice';
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
}: {
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
