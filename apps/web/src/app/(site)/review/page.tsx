import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { IconPhone, IconStar } from '@/components/icons';
import { InnerPage, PageBody } from '@/components/page/PageBand';
import { buttonClass } from '@/components/ui/Button';
import { cn } from '@/components/ui/cn';
import { getBrand, telHref } from '@/server/brand';
import { serverEnv } from '@/server/env';
import { publicReviewLinks } from '@/server/reviews/links';

// The links come from env at request time (REVIEW_URL_*).
export const dynamic = 'force-dynamic';

/** «Оставьте отзыв — {BRAND_NAME}» (the layout's template); a QR target, never indexed. */
export const metadata: Metadata = {
  title: 'Оставьте отзыв',
  robots: { index: false, follow: false },
};

/**
 * /review (step 3, docs/reviews.md): where the QR of the counter sign and of the return memo
 * leads. Public and without personal data: a heading, one line, a big button per configured map
 * card (REVIEW_URL_*, the card itself — nothing to count on a public page) and, in muted type,
 * where to go when something is wrong with an order. 404 without a review link (src/proxy.ts
 * answers it with the site's not-found page first). Not in the sitemap; noindex.
 */
export default function ReviewPage() {
  const links = publicReviewLinks(serverEnv());
  if (links.length === 0) notFound();
  const brand = getBrand();
  const phone = brand.contactPhone;
  return (
    <InnerPage>
      <PageBody className="pt-8 md:pt-14">
        <section
          aria-labelledby="review-title"
          className="mx-auto w-full max-w-[40rem] min-w-0"
          data-testid="review-page"
        >
          <span
            aria-hidden
            className="mb-5 grid size-16 place-items-center rounded-full bg-brand-soft text-brand"
          >
            <IconStar size={36} fill="currentColor" />
          </span>
          <h1 id="review-title" className="text-h1 text-balance">
            Оставьте отзыв о {brand.name}
          </h1>
          <p className="mt-2 text-body text-pretty text-muted">
            Отзыв помогает другим водителям найти нас
          </p>
          <div
            className={cn('mt-8 grid min-w-0 gap-3', links.length > 1 && 'sm:grid-cols-2')}
            data-testid="review-buttons"
          >
            {links.map((link) => (
              <a
                key={link.platform}
                href={link.href}
                rel="noopener"
                className={cn(buttonClass({ size: 'lg', block: true }), 'min-h-16')}
                data-testid={`review-${link.platform}`}
              >
                <span className="text-h3">{link.label}</span>
              </a>
            ))}
          </div>
          <div
            className="mt-10 rounded-tile bg-surface p-5 text-small text-muted md:p-6"
            data-testid="review-problem"
          >
            <p>
              Что-то не так с заказом? Откройте заказ по ссылке из сообщения
              {phone ? ' или позвоните:' : '.'}
            </p>
            {phone ? (
              <a
                href={telHref(phone)}
                className="mt-1 inline-flex min-h-11 items-center gap-2 font-bold whitespace-nowrap text-ink tabular-nums underline decoration-line-strong underline-offset-4 hover:decoration-ink"
              >
                <IconPhone size={20} className="shrink-0 text-brand" />
                {phone}
              </a>
            ) : null}
          </div>
        </section>
      </PageBody>
    </InnerPage>
  );
}
