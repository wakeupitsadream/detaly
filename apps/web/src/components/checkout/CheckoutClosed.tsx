import { IconArrowRight, IconLock, IconPhone } from '@/components/icons';
import { buttonClass } from '@/components/ui/Button';
import { CtaCard } from '@/components/ui/CtaCard';
import { cn } from '@/components/ui/cn';
import { telHref } from '@/server/brand';

/**
 * Checkout before Roskomnadzor registration or without published documents (decision Д4): a
 * CtaCard with a lock, the gate's text and the point's phone, and no form at all, so no
 * personal data is collected.
 */
export function CheckoutClosed({ message, phone }: { message: string; phone: string | null }) {
  return (
    <div className="mx-auto max-w-2xl min-w-0" data-testid="checkout-closed">
      <CtaCard
        title="Оформление на сайте пока закрыто"
        titleId="checkout-closed-title"
        icon={<IconLock size={56} />}
        text={message}
      >
        <div className="flex min-w-0 flex-col gap-3 sm:flex-row sm:flex-wrap">
          {phone ? (
            <a
              href={telHref(phone)}
              className={cn(buttonClass({ size: 'lg' }), 'whitespace-nowrap')}
            >
              <IconPhone size={22} />
              Позвонить {phone}
            </a>
          ) : null}
          <a href="/cart" className={buttonClass({ variant: 'secondary', size: 'lg' })}>
            Вернуться в корзину
            <IconArrowRight size={20} />
          </a>
        </div>
      </CtaCard>
    </div>
  );
}
