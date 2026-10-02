import { IconArrowRight, IconInfo, IconPhone } from '@/components/icons';
import { buttonClass } from '@/components/ui/Button';
import { cn } from '@/components/ui/cn';
import { telHref } from '@/server/brand';

/**
 * Checkout before Roskomnadzor registration or without published documents (decision Д4):
 * the gate's text and the point's phone, and no form at all, so no personal data is collected.
 */
export function CheckoutClosed({ message, phone }: { message: string; phone: string | null }) {
  return (
    <section
      className="mx-auto max-w-2xl min-w-0 rounded border border-line bg-card p-6 md:p-8"
      data-testid="checkout-closed"
    >
      <div className="flex items-start gap-3">
        <IconInfo size={24} className="mt-0.5 shrink-0 text-info" />
        <div className="min-w-0">
          <h2 className="font-display text-xl leading-tight font-semibold">
            Оформление на сайте пока закрыто
          </h2>
          <p className="mt-3 text-muted">{message}</p>
        </div>
      </div>
      <div className="mt-6 flex flex-wrap items-center gap-x-6 gap-y-3">
        {phone ? (
          <a href={telHref(phone)} className={cn(buttonClass({ size: 'lg' }), 'whitespace-nowrap')}>
            <IconPhone size={18} />
            Позвонить {phone}
          </a>
        ) : null}
        <a
          className="inline-flex min-h-11 items-center gap-1.5 text-sm font-semibold underline underline-offset-4"
          href="/cart"
        >
          Вернуться в корзину
          <IconArrowRight size={16} />
        </a>
      </div>
    </section>
  );
}
