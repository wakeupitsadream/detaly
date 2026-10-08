/**
 * /admin/reviews (step 3, docs/reviews.md): whether the review links are set, what the storefront
 * shows now, the form of the rating snapshot (the numbers off the cards, saved with an audit row),
 * its history, the funnel of the last 30 and 90 days and the counter sign with the QR. Plain
 * forms, no client JavaScript.
 */
import {
  formatDayMonth,
  formatRatingX10,
  REVIEW_PLATFORM_LABELS,
  REVIEW_PLATFORMS,
  type ReviewPlatform,
  type ReviewSnapshot,
} from '@detaly/domain';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { RatingLine } from '@/components/reviews/RatingLine';
import {
  SNAPSHOT_FIELDS,
  type AdminReviewsData,
  type RatingHiddenReason,
  type SnapshotAuditRow,
} from '@/server/admin/reviews';
import { dateTime } from './format';

const BUTTON =
  'inline-flex min-h-11 items-center rounded-md bg-accent px-4 py-2 font-semibold text-white hover:bg-accent-strong';
const SECONDARY =
  'inline-flex min-h-11 items-center rounded-md border border-line-strong bg-card px-4 py-2 font-semibold hover:border-ink';
const INPUT =
  'w-full min-w-0 rounded-md border border-line-strong bg-card px-3 py-2 tabular-nums min-h-11';

function Section({
  title,
  children,
  testId,
}: {
  title: string;
  children: ReactNode;
  testId?: string;
}) {
  return (
    <section className="min-w-0 rounded-card border border-line bg-card p-4" data-testid={testId}>
      <h2 className="mb-3 text-lg font-semibold">{title}</h2>
      {children}
    </section>
  );
}

/** «Яндекс Карты 4,9 · 37, 2ГИС —, на 20 октября». */
function snapshotText(snapshot: ReviewSnapshot | null): string {
  if (snapshot === null) return 'не внесён';
  const parts = REVIEW_PLATFORMS.map((platform) => {
    const rating = snapshot.ratings[platform];
    return `${REVIEW_PLATFORM_LABELS[platform]} ${
      rating ? `${formatRatingX10(rating.ratingX10)} · ${rating.count}` : '—'
    }`;
  });
  return `${parts.join(', ')}, на ${formatDayMonth(snapshot.asOf)}`;
}

const HIDDEN_TEXT: Record<Exclude<RatingHiddenReason, null>, string> = {
  no_links: 'не задана ни одна ссылка на отзывы',
  no_snapshot: 'рейтинг ещё не внесён',
  too_old: 'данные устарели — обновите их',
  too_few: 'отзывов пока меньше порога (или у площадки с отзывами нет ссылки)',
};

function AuditList({ rows }: { rows: SnapshotAuditRow[] }) {
  if (rows.length === 0) {
    return (
      <p className="text-muted" data-testid="reviews-audit-empty">
        Рейтинг ещё не вносили.
      </p>
    );
  }
  return (
    <ul className="flex flex-col gap-2 text-sm">
      {rows.map((row) => (
        <li key={row.id} className="wrap-anywhere" data-testid="reviews-audit-row">
          <span className="font-semibold">{dateTime(row.changedAt)}</span>{' '}
          <span className="text-muted">({row.changedBy})</span>: {snapshotText(row.oldValue)} →{' '}
          {snapshotText(row.newValue)}
        </li>
      ))}
    </ul>
  );
}

function PlatformFields({
  platform,
  snapshot,
}: {
  platform: ReviewPlatform;
  snapshot: ReviewSnapshot | null;
}) {
  const rating = snapshot?.ratings[platform];
  const label = REVIEW_PLATFORM_LABELS[platform];
  return (
    <fieldset
      className="grid min-w-0 grid-cols-2 gap-3 rounded-md border border-line p-3"
      data-testid={`reviews-fields-${platform}`}
    >
      <legend className="px-1 font-semibold">{label}</legend>
      <label className="flex min-w-0 flex-col gap-1 text-sm">
        Оценка
        <input
          name={SNAPSHOT_FIELDS.rating(platform)}
          defaultValue={rating ? formatRatingX10(rating.ratingX10) : ''}
          placeholder="4,9"
          inputMode="decimal"
          autoComplete="off"
          maxLength={3}
          pattern="[1-5]([,.][0-9])?"
          title="От 1,0 до 5,0, один знак после запятой"
          className={INPUT}
        />
      </label>
      <label className="flex min-w-0 flex-col gap-1 text-sm">
        Отзывов
        <input
          name={SNAPSHOT_FIELDS.count(platform)}
          defaultValue={rating ? String(rating.count) : ''}
          placeholder="37"
          type="number"
          min={0}
          step={1}
          inputMode="numeric"
          autoComplete="off"
          className={INPUT}
        />
      </label>
    </fieldset>
  );
}

export function AdminReviews({ data, done }: { data: AdminReviewsData; done: string | null }) {
  const [last30, last90] = data.funnel;
  const funnelRows: { label: string; value: (f: NonNullable<typeof last30>) => number }[] = [
    { label: '«Как деталь?» отправлено', value: (f) => f.howIsItSent },
    { label: 'Напоминаний об отзыве отправлено', value: (f) => f.reminderSent },
    ...REVIEW_PLATFORMS.map((platform) => ({
      label: `Открыли ссылку на отзыв: ${REVIEW_PLATFORM_LABELS[platform]}`,
      value: (f: NonNullable<typeof last30>) => f.opened[platform],
    })),
    { label: 'Заказов, где открыли ссылку', value: (f) => f.openedOrders },
    { label: 'Претензий после выдачи', value: (f) => f.claimsAfterHandover },
  ];
  return (
    <div className="flex min-w-0 flex-col gap-4" data-testid="admin-reviews">
      {done ? (
        <p
          className="rounded-card border border-local bg-local-soft px-4 py-2 text-local"
          role="status"
          data-testid="admin-done"
        >
          {done}
        </p>
      ) : null}

      <Section title="Ссылки на отзывы" testId="reviews-links">
        <ul className="flex flex-col gap-2">
          {data.links.map((link) => (
            <li
              key={link.platform}
              className="wrap-anywhere"
              data-testid={`reviews-link-${link.platform}`}
              data-set={link.url ? 'true' : 'false'}
            >
              <span className="font-semibold">{link.label}:</span>{' '}
              {link.url ? (
                <>
                  <span className="text-local">задана</span> —{' '}
                  <a
                    href={link.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-accent underline"
                  >
                    {link.url}
                  </a>
                </>
              ) : (
                <span className="text-muted">не задана</span>
              )}
            </li>
          ))}
        </ul>
        <p className="mt-3 text-sm text-muted">
          Ссылки задаются в переменных окружения REVIEW_URL_YANDEX и REVIEW_URL_2GIS (после
          изменения — передеплой). Площадка без ссылки нигде не показывается; без обеих нет кнопок
          отзывов в сообщениях, страницы /review и рейтинга на витрине.
        </p>
      </Section>

      <Section title="Рейтинг на витрине" testId="reviews-storefront">
        {data.storefront ? (
          <div className="rounded-md bg-paper-2 p-3" data-testid="reviews-storefront-line">
            <RatingLine block={data.storefront} />
          </div>
        ) : (
          <p data-testid="reviews-storefront-hidden" data-reason={data.hiddenReason ?? ''}>
            Сейчас не показывается: {HIDDEN_TEXT[data.hiddenReason ?? 'no_snapshot']}.
          </p>
        )}
        <p className="mt-2 text-sm text-muted">
          На главной и в поиске, если у площадки есть ссылка, отзывов не меньше {data.minCount} и
          данным не больше {data.maxAgeDays} дней (настройки reviews.min_count и
          reviews.max_age_days). В демо рейтинга нет.
        </p>
      </Section>

      <Section title="Обновить рейтинг" testId="reviews-form">
        <p className="mb-3 text-sm text-muted">
          Откройте свои карточки в Яндекс Картах и 2ГИС и перепишите оценку и число отзывов.
          Площадку без оценки оставьте пустой. Сейчас: {snapshotText(data.snapshot)}
          {data.updatedAt
            ? ` · изменено ${dateTime(data.updatedAt)}${data.updatedBy ? ` (${data.updatedBy})` : ''}`
            : ''}
          .
        </p>
        <form
          method="post"
          action="/api/admin/reviews"
          className="flex min-w-0 flex-col gap-3"
          data-testid="reviews-save"
        >
          <input type="hidden" name="action" value="save" />
          <input type="hidden" name="version" value={data.version} />
          <div className="grid min-w-0 gap-3 md:grid-cols-2">
            {REVIEW_PLATFORMS.map((platform) => (
              <PlatformFields key={platform} platform={platform} snapshot={data.snapshot} />
            ))}
          </div>
          <label className="flex max-w-xs min-w-0 flex-col gap-1 text-sm">
            На дату
            <input
              type="date"
              name={SNAPSHOT_FIELDS.asOf}
              defaultValue={data.today}
              max={data.today}
              required
              className={INPUT}
            />
          </label>
          <div>
            <button type="submit" className={BUTTON}>
              Сохранить
            </button>
          </div>
        </form>
      </Section>

      <Section title="История изменений" testId="reviews-audit">
        <AuditList rows={data.audit} />
      </Section>

      <Section title="Воронка отзывов" testId="reviews-funnel">
        {last30 && last90 ? (
          <div className="min-w-0 overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-line text-muted">
                <tr>
                  <th className="px-3 py-2 font-medium">Что</th>
                  <th className="px-3 py-2 text-right font-medium">{last30.days} дней</th>
                  <th className="px-3 py-2 text-right font-medium">{last90.days} дней</th>
                </tr>
              </thead>
              <tbody>
                {funnelRows.map((row) => (
                  <tr key={row.label} className="border-b border-line last:border-0">
                    <td className="px-3 py-2">{row.label}</td>
                    <td className="px-3 py-2 text-right tabular-nums" data-testid="funnel-30">
                      {row.value(last30)}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums" data-testid="funnel-90">
                      {row.value(last90)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
        <p className="mt-2 text-sm text-muted">
          «Как деталь?» уходит, когда заказ завершён, напоминание —{' '}
          {data.reminderDays > 0
            ? `через ${data.reminderDays} дн. после него, один раз`
            : 'выключено'}{' '}
          (reviews.reminder_days), только в мессенджер. Открытие ссылки считается один раз на
          площадку и заказ.
        </p>
      </Section>

      <Section title="Табличка на стойку и QR" testId="reviews-sign">
        <p className="text-sm">
          QR ведёт на{' '}
          <span className="font-mono wrap-anywhere" data-testid="reviews-qr-url">
            {data.reviewPageUrl}
          </span>{' '}
          — страницу с кнопками отзывов{data.enabled ? '' : ' (пока нет ссылок, она отвечает 404)'}.
        </p>
        <div className="mt-3 flex flex-wrap gap-3">
          <Link href="/admin/reviews/sign" className={SECONDARY} data-testid="reviews-sign-link">
            Табличка для печати
          </Link>
          <a
            href="/api/admin/reviews/qr"
            download="review-qr.svg"
            className={SECONDARY}
            data-testid="reviews-qr-download"
          >
            Скачать QR (SVG)
          </a>
        </div>
      </Section>
    </div>
  );
}
