import { reviewPlatforms } from '@detaly/config';
import { REVIEW_PLATFORM_LABELS, REVIEW_PLATFORMS } from '@detaly/domain';
import type { Metadata } from 'next';
import Link from 'next/link';
import { PrintButton } from '@/components/admin/PrintButton';
import { ReviewSign, type SignSize } from '@/components/admin/ReviewSign';
import { requireAdmin } from '@/server/admin/guard';
import { qrSvgPrintDataUri } from '@/server/admin/qr';
import { reviewPageUrl } from '@/server/admin/reviews';
import { getBrand } from '@/server/brand';
import { serverEnv } from '@/server/env';

export const metadata: Metadata = { title: 'Табличка для отзывов' };

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

const LINK =
  'inline-flex min-h-11 items-center rounded-md border border-line-strong bg-card px-4 py-2 font-semibold hover:border-ink';
const BUTTON =
  'inline-flex min-h-11 items-center rounded-md bg-accent px-4 py-2 font-semibold text-white hover:bg-accent-strong';

/**
 * /admin/reviews/sign (step 3, docs/reviews.md): the printable counter sign with the QR of
 * APP_BASE_URL/review; A5 by default, `?size=a4` for A4. The controls are not printed.
 */
export default async function ReviewSignPage({ searchParams }: { searchParams: SearchParams }) {
  await requireAdmin();
  const params = await searchParams;
  const size: SignSize =
    (Array.isArray(params.size) ? params.size[0] : params.size) === 'a4' ? 'a4' : 'a5';
  const env = serverEnv();
  const url = reviewPageUrl(env);
  const configured = reviewPlatforms(env);
  // Before the links are set the sign still shows both services: it is printed for them.
  const platforms = (configured.length > 0 ? configured : REVIEW_PLATFORMS).map(
    (platform) => REVIEW_PLATFORM_LABELS[platform],
  );
  return (
    <div className="flex min-w-0 flex-col gap-4">
      <div className="flex min-w-0 flex-col gap-3" data-print-hide>
        <h1 className="text-2xl font-bold">Табличка для отзывов</h1>
        {configured.length === 0 ? (
          <p
            className="rounded-card border border-warn bg-warn-soft px-4 py-2 text-warn"
            role="status"
          >
            Ссылки на отзывы не заданы (REVIEW_URL_YANDEX, REVIEW_URL_2GIS): пока QR ведёт на
            страницу 404.
          </p>
        ) : null}
        <div className="flex flex-wrap gap-3">
          <PrintButton className={BUTTON} />
          <Link
            href={size === 'a4' ? '/admin/reviews/sign' : '/admin/reviews/sign?size=a4'}
            className={LINK}
            data-testid="review-sign-size"
          >
            {size === 'a4' ? 'Формат A5' : 'Формат A4'}
          </Link>
          <a href="/api/admin/reviews/qr" download="review-qr.svg" className={LINK}>
            Скачать QR (SVG)
          </a>
          <Link href="/admin/reviews" className={LINK}>
            К отзывам
          </Link>
        </div>
      </div>
      <ReviewSign
        brandName={getBrand().name}
        qrSrc={await qrSvgPrintDataUri(url, { margin: 1 })}
        platforms={platforms}
        url={url}
        size={size}
      />
    </div>
  );
}
