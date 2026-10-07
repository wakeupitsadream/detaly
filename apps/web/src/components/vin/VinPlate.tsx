import { type IconComponent, IconChevronDown, IconSts } from '@/components/icons';
import { IconCard } from '@/components/ui/Card';
import { cn } from '@/components/ui/cn';
import { StepIconTile } from '@/components/ui/StepNumber';

/** A sample VIN to show what the 17 characters look like; not anybody's car. */
export const SAMPLE_VIN = 'XTA210990Y1234567';

const VIN_PARTS = [
  { from: 0, to: 3, label: 'Завод' },
  { from: 3, to: 9, label: 'Модель' },
  { from: 9, to: 17, label: 'Год и номер' },
] as const;

/**
 * What «Где найти VIN» says: the two places in one short line each, then the 17 characters as
 * cells of a data plate grouped by what they mean. `note` adds the O/0, I/1 line.
 */
export function VinPlateBody({ note = true }: { note?: boolean }) {
  return (
    <>
      <ul className="space-y-2 text-body">
        <li className="flex gap-2">
          <span aria-hidden className="mt-2.5 size-2 shrink-0 rounded-full bg-brand" />
          <span className="min-w-0">
            В СТС — строка <span className="font-semibold">«VIN»</span>
          </span>
        </li>
        <li className="flex gap-2">
          <span aria-hidden className="mt-2.5 size-2 shrink-0 rounded-full bg-brand" />
          <span className="min-w-0">На табличке под лобовым стеклом</span>
        </li>
      </ul>

      <p className="mt-6 text-small font-semibold text-muted">Так выглядит VIN</p>
      <div
        className="mt-2 grid grid-cols-[repeat(17,minmax(0,1fr))] gap-px overflow-hidden rounded-control border border-line-strong bg-line-strong"
        aria-label={`Пример VIN: ${SAMPLE_VIN}`}
        role="img"
      >
        {SAMPLE_VIN.split('').map((char, index) => (
          <span
            key={index}
            aria-hidden
            className={cn(
              'grid h-10 place-items-center bg-bg text-[0.875rem] font-bold tabular-nums md:h-12 md:text-base',
              index < 3 && 'bg-brand-soft text-brand',
            )}
          >
            {char}
          </span>
        ))}
      </div>
      <div aria-hidden className="mt-2 grid grid-cols-[repeat(17,minmax(0,1fr))] gap-px">
        {VIN_PARTS.map((part) => (
          <p
            key={part.label}
            className="border-t-2 border-ink pt-1 text-caption text-muted"
            style={{ gridColumn: `${part.from + 1} / ${part.to + 1}` }}
          >
            {part.label}
          </p>
        ))}
      </div>
      {note ? (
        <p className="mt-4 text-small font-normal text-muted">
          Букв O, I и Q в VIN нет: похожий знак — это 0 или 1.
        </p>
      ) : null}
    </>
  );
}

/**
 * «Где найти VIN» (docs/design-v2.md, /vin): VinPlateBody in the same white card as the other
 * help cards beside the form — the СТС icon 24 and the `text-h3` title in its head.
 */
export function VinPlate({ className }: { className?: string }) {
  return (
    <IconCard
      icon={<IconSts size={24} />}
      title="Где найти VIN"
      titleId="vin-where"
      className={className}
      data-testid="vin-plate"
    >
      <VinPlateBody />
    </IconCard>
  );
}

/**
 * Phones (below lg): «Где найти VIN?» folded right under the VIN field, so whoever does not
 * know the word finds the answer before sending, not after the button.
 */
export function VinWhereFold({ className }: { className?: string }) {
  return (
    <details
      className={cn('details-plain group mt-3 min-w-0 rounded-tile bg-surface', className)}
      data-testid="vin-where-fold"
    >
      <summary className="flex min-h-12 items-center gap-2.5 rounded-tile px-4 text-body font-semibold">
        <IconSts size={24} className="shrink-0 text-brand" />
        <span className="min-w-0 flex-1">Где найти VIN?</span>
        <IconChevronDown
          size={22}
          className="shrink-0 text-muted transition-transform duration-150 group-open:rotate-180"
        />
      </summary>
      <div className="min-w-0 px-4 pt-1 pb-5">
        <VinPlateBody note={false} />
      </div>
    </details>
  );
}

export interface VinStep {
  icon: IconComponent;
  title: string;
  text: string;
}

/**
 * Three steps as icon tiles (the /vin page): the numbered icon plate (StepIconTile), a bold
 * title and one short line. A row from md, a list on phones.
 */
export function VinSteps({ steps }: { steps: readonly VinStep[] }) {
  return (
    <ol className="mt-6 grid min-w-0 gap-3 md:mt-8 md:grid-cols-3 md:gap-4">
      {steps.map((step, index) => (
        <li
          key={step.title}
          className="flex min-w-0 items-center gap-4 rounded-tile bg-surface p-4 md:flex-col md:items-start md:p-6"
        >
          <StepIconTile n={index + 1} icon={step.icon} />
          <div className="min-w-0">
            <h3 className="min-w-0 text-h3">{step.title}</h3>
            <p className="mt-1 text-small font-normal text-muted">{step.text}</p>
          </div>
        </li>
      ))}
    </ol>
  );
}
