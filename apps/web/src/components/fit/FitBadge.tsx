import Link from 'next/link';
import { IconCheck, IconShield } from '@/components/icons';
import { Badge } from '@/components/ui/Badge';
import { cn } from '@/components/ui/cn';

/** The badge of a line the master checked under the client's VIN (step 4, docs/fit-check.md). */
export const FIT_CHECKED_TEXT = 'Проверено мастером';
/** Under the badge, only with FIT_GUARANTEE_ENABLED (or an order item with fit_guarantee). */
export const FIT_GUARANTEE_TEXT = 'Не подойдёт по применимости — вернём деньги';
/** The «Гарантия подбора» section of /returns. */
export const FIT_GUARANTEE_HREF = '/returns#fit-guarantee';

/**
 * «Проверено мастером» (+ «Не подойдёт по применимости — вернём деньги» linking to the
 * guarantee on /returns when `guarantee`). Without the guarantee nothing promises money back:
 * the badge states a fact. `demo` marks the demo answer («· демо»).
 */
export function FitCheckedBadge({
  guarantee,
  demo = false,
  className,
}: {
  guarantee: boolean;
  demo?: boolean;
  className?: string;
}) {
  return (
    <div className={cn('flex min-w-0 flex-col items-start gap-1.5', className)}>
      <Badge tone="ok" icon={<IconCheck size={16} strokeWidth={2.5} />} data-testid="fit-checked">
        {FIT_CHECKED_TEXT}
        {demo ? ' · демо' : null}
      </Badge>
      {guarantee ? (
        <Link
          href={FIT_GUARANTEE_HREF}
          prefetch={false}
          className="inline-flex min-h-8 min-w-0 items-start gap-1.5 text-small font-medium text-ink underline decoration-line-strong decoration-1 underline-offset-4 hover:decoration-ink"
          data-testid="fit-guarantee"
        >
          <IconShield size={18} className="mt-px shrink-0 text-ok" />
          <span className="min-w-0">{FIT_GUARANTEE_TEXT}</span>
        </Link>
      ) : null}
    </div>
  );
}
