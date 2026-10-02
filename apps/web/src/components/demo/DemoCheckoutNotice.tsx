import Link from 'next/link';
import { IconArrowRight } from '@/components/icons';
import { Badge } from '@/components/ui/Badge';
import { ButtonLink } from '@/components/ui/Button';
import { HazardBand } from '@/components/ui/HazardBand';

export const DEMO_CHECKOUT_TITLE = 'В демо оформление отключено';

/**
 * /checkout with DEMO_MODE=true: no form and no personal data, a way to the sample order
 * instead (/o/demo, a static page with a fixture order).
 */
export function DemoCheckoutNotice() {
  return (
    <section
      className="mx-auto max-w-2xl min-w-0 overflow-hidden rounded border border-ink bg-card"
      data-testid="demo-checkout"
    >
      <HazardBand />
      <div className="p-6 md:p-8">
        <Badge tone="demo" className="font-semibold">
          Демо-версия
        </Badge>
        <h2 className="mt-4 font-display text-xl leading-tight font-semibold text-balance md:text-2xl">
          {DEMO_CHECKOUT_TITLE} — посмотрите пример заказа
        </h2>
        <p className="mt-3 text-muted">
          Это показ витрины: заказы здесь не создаются и не уходят поставщику. Что видит покупатель
          после оформления — статус, состав, оплату, точку выдачи и окно установки, — показано на
          примере.
        </p>
        <div className="mt-7 flex flex-wrap items-center gap-x-6 gap-y-3">
          <ButtonLink href="/o/demo" size="lg" prefetch={false}>
            Пример заказа
            <IconArrowRight size={18} />
          </ButtonLink>
          <Link
            href="/cart"
            prefetch={false}
            className="inline-flex min-h-11 items-center text-sm font-semibold underline underline-offset-4"
          >
            Вернуться в корзину
          </Link>
        </div>
      </div>
    </section>
  );
}
