import {
  formatDayMonth,
  formatRatingX10,
  REVIEW_PLATFORM_LABELS,
  REVIEW_PLATFORM_PLACE,
  REVIEW_PLATFORM_WHERE,
  type RatingBlock,
  type RatingLine as RatingLineData,
} from '@detaly/domain';
import { IconStar } from '@/components/icons';
import { cn } from '@/components/ui/cn';
import { plural } from '@/lib/plural';

/** «37 отзывов», «21 отзыв», «3 отзыва». */
export function reviewsCountText(count: number): string {
  return `${count} ${plural(count, 'отзыв', 'отзыва', 'отзывов')}`;
}

/** «на 20 октября»: the day the owner read the numbers off the cards. */
export function ratingDateText(block: Pick<RatingBlock, 'asOf'>): string {
  return `на ${formatDayMonth(block.asOf)}`;
}

/** The plain text of the line, for tests and the admin preview. */
export function ratingLineText(block: RatingBlock): string {
  return block.lines
    .map((line, index) =>
      index === 0
        ? `${formatRatingX10(line.ratingX10)} ${REVIEW_PLATFORM_WHERE[line.platform]} · ${reviewsCountText(line.count)}`
        : `${REVIEW_PLATFORM_LABELS[line.platform]} ${formatRatingX10(line.ratingX10)} · ${line.count}`,
    )
    .join('   ');
}

type Tone = 'light' | 'dark';

/** The name of the service links to its review page (the env link, a new tab). */
function ServiceLink({ line, text, tone }: { line: RatingLineData; text: string; tone: Tone }) {
  return (
    <a
      href={line.url}
      target="_blank"
      rel="noopener noreferrer"
      className={cn(
        'inline-flex min-h-11 items-center font-semibold underline underline-offset-4',
        tone === 'dark'
          ? 'decoration-on-brand/50 hover:decoration-on-brand focus-visible:outline-on-brand'
          : 'decoration-line-strong hover:decoration-ink',
      )}
      data-testid={`rating-link-${line.platform}`}
    >
      {text}
    </a>
  );
}

/**
 * The shop's rating on its own map cards (step 3, docs/reviews.md): «★ 4,9 на Яндекс Картах ·
 * 37 отзывов», a second platform short («2ГИС 4,8 · 12»), and the day of the numbers in small
 * muted type («на 20 октября»). Drawn only with a block that ratingBlock allowed (link set,
 * enough reviews, a fresh snapshot); never in the demo. No schema.org rating markup: search
 * engines do not accept a shop's own rating of itself.
 *
 * `tone="dark"` sits under the title of the dark advantages panel on the home page; `compact`
 * (/search above the offers) puts the date on the same line to keep the first offer high.
 */
export function RatingLine({
  block,
  tone = 'light',
  compact = false,
  className,
}: {
  block: RatingBlock;
  tone?: Tone;
  compact?: boolean;
  className?: string;
}) {
  const muted = tone === 'dark' ? 'text-on-brand/75' : 'text-muted';
  const date = (
    <span className={cn('text-caption', muted)} data-testid="rating-date">
      {ratingDateText(block)}
    </span>
  );
  return (
    <div
      className={cn('min-w-0', tone === 'dark' ? 'text-on-brand' : 'text-ink', className)}
      data-testid="rating-line"
    >
      {/* The gaps of the flex rows draw the spaces; the {' '} keep them in the text a screen
          reader (and a copy) gets, without changing the layout. */}
      {/* The dark panel is narrow on a phone (~295 px at 375): one size down keeps «★ 4,9 на
          Яндекс Картах · 37 отзывов» on one line there. */}
      <p
        className={cn(
          'flex min-w-0 flex-wrap items-center gap-x-5 text-body',
          tone === 'dark' && 'max-sm:text-small',
        )}
      >
        {block.lines.map((line, index) => (
          <span
            key={line.platform}
            className="inline-flex min-w-0 flex-wrap items-center gap-x-1.5"
            data-testid={`rating-${line.platform}`}
          >
            {index === 0 ? (
              <>
                <IconStar
                  size={20}
                  fill="currentColor"
                  className={cn('shrink-0', tone === 'dark' ? 'text-on-brand' : 'text-brand')}
                />
                <span className="sr-only">Рейтинг магазина: </span>
                <span className="font-extrabold tabular-nums">
                  {formatRatingX10(line.ratingX10)}
                </span>{' '}
                {/* One unbreakable group: a narrow column (the dark panel on a phone) breaks
                    after «★ 4,9», never before «· 37 отзывов». */}
                <span className="whitespace-nowrap tabular-nums">
                  {REVIEW_PLATFORM_PLACE[line.platform].preposition}{' '}
                  <ServiceLink
                    line={line}
                    tone={tone}
                    text={REVIEW_PLATFORM_PLACE[line.platform].place}
                  />{' '}
                  · {reviewsCountText(line.count)}
                </span>
              </>
            ) : (
              <>
                <ServiceLink line={line} tone={tone} text={REVIEW_PLATFORM_LABELS[line.platform]} />{' '}
                <span className="font-extrabold tabular-nums">
                  {formatRatingX10(line.ratingX10)}
                </span>{' '}
                <span className="whitespace-nowrap tabular-nums">
                  · {line.count}
                  <span className="sr-only">
                    {' '}
                    {plural(line.count, 'отзыв', 'отзыва', 'отзывов')}
                  </span>
                </span>
              </>
            )}{' '}
          </span>
        ))}
        {compact ? date : null}
      </p>
      {compact ? null : <p className="-mt-1">{date}</p>}
    </div>
  );
}
