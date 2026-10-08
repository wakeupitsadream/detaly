import { IconArrowRight, IconStar } from '@/components/icons';
import { buttonClass } from '@/components/ui/Button';
import { cn } from '@/components/ui/cn';
import type { ReviewLink } from '@/server/reviews/links';
import { Card } from './OrderSections';

/** Orders the card is shown on: the part is with the client. */
export const REVIEW_CARD_STATUSES: ReadonlySet<string> = new Set(['handed', 'completed']);

/**
 * «Оцените нас» of /o/<token> (step 3, docs/reviews.md): after the handover, the review buttons
 * of the configured platforms (our redirect /o/<token>/review/<platform>, which notes the open)
 * and an equal way to the claim form («Что-то не так? → Претензия», the #claim card above).
 * Everyone sees the same card: no rating first, nothing hidden from an unhappy client, no reward.
 * Without a review link (REVIEW_URL_*) there is no card at all.
 */
export function ReviewCard({ links }: { links: readonly ReviewLink[] }) {
  if (links.length === 0) return null;
  return (
    <Card title="Оцените нас" icon={<IconStar size={24} />} testId="order-reviews" id="review">
      <p className="text-body">Отзыв помогает другим водителям найти нас.</p>
      <div className={cn('mt-4 grid min-w-0 gap-2', links.length > 1 && 'sm:grid-cols-2')}>
        {links.map((link) => (
          <a
            key={link.platform}
            href={link.href}
            target="_blank"
            rel="noopener noreferrer"
            className={cn(buttonClass({ variant: 'secondary', block: true }), 'px-3')}
            data-testid={`order-review-${link.platform}`}
          >
            <IconStar size={20} className="shrink-0 text-brand" />
            {link.buttonText}
          </a>
        ))}
      </div>
      <p className="mt-4 text-small font-normal text-muted">
        Что-то не так?{' '}
        <a
          href="#claim"
          className="inline-flex min-h-11 items-center gap-1 font-semibold text-brand underline underline-offset-4 hover:text-brand-hover"
          data-testid="order-review-claim"
        >
          <IconArrowRight size={18} className="shrink-0" />
          Претензия
        </a>
      </p>
    </Card>
  );
}
