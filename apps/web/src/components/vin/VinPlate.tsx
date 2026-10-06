import type { ReactNode } from 'react';
import { IconSts } from '@/components/icons';
import { MarkerBar } from '@/components/ui/Card';
import { cn } from '@/components/ui/cn';

/** A sample VIN to show what the 17 characters look like; not anybody's car. */
export const SAMPLE_VIN = 'XTA210990Y1234567';

const VIN_PARTS = [
  { from: 0, to: 3, label: 'Завод' },
  { from: 3, to: 9, label: 'Модель' },
  { from: 9, to: 17, label: 'Год и номер' },
] as const;

/**
 * «Где найти VIN» (docs/design-v2.md, /vin): the СТС card icon, the two places in one short
 * line each, then the 17 characters as cells of a data plate grouped by what they mean.
 */
export function VinPlate({ className }: { className?: string }) {
  return (
    <section
      aria-labelledby="vin-where"
      className={cn('relative min-w-0 rounded-panel bg-surface p-6 md:p-8', className)}
      data-testid="vin-plate"
    >
      <MarkerBar className="absolute top-0 left-6 md:left-8" />
      <div className="flex min-w-0 items-center gap-4 pt-2">
        <span
          aria-hidden
          className="grid size-16 shrink-0 place-items-center rounded-tile bg-bg text-brand"
        >
          <IconSts size={44} strokeWidth={1.5} />
        </span>
        <h2 id="vin-where" className="min-w-0 text-h3">
          Где найти VIN
        </h2>
      </div>
      <ul className="mt-5 space-y-2 text-body">
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
      <p className="mt-4 text-small font-normal text-muted">
        Букв O, I и Q в VIN нет: похожий знак — это 0 или 1.
      </p>
    </section>
  );
}

export interface VinStep {
  icon: ReactNode;
  title: string;
  text: string;
}

/**
 * Three steps as icon tiles (the /vin page): a 56 px brand icon on white, a bold title and one
 * short line. A row from md, a list on phones.
 */
export function VinSteps({ steps }: { steps: readonly VinStep[] }) {
  return (
    <ol className="mt-6 grid min-w-0 gap-3 md:mt-8 md:grid-cols-3 md:gap-4">
      {steps.map((step, index) => (
        <li
          key={step.title}
          className="flex min-w-0 items-center gap-4 rounded-tile bg-surface p-4 md:flex-col md:items-start md:p-6"
        >
          <span
            aria-hidden
            className="relative grid size-16 shrink-0 place-items-center rounded-tile bg-bg text-brand"
          >
            {step.icon}
            <span className="absolute -top-2 -left-2 grid size-7 place-items-center rounded-full bg-brand text-[0.875rem] font-extrabold text-on-brand tabular-nums">
              {index + 1}
            </span>
          </span>
          <div className="min-w-0">
            <h3 className="text-h3">{step.title}</h3>
            <p className="mt-1 text-small font-normal text-muted">{step.text}</p>
          </div>
        </li>
      ))}
    </ol>
  );
}
