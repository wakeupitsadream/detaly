import { cn } from '@/components/ui/cn';

/** A sample VIN to show what the 17 characters look like; not anybody's car. */
export const SAMPLE_VIN = 'XTA210990Y1234567';

const VIN_PARTS = [
  { from: 0, to: 3, label: 'Завод' },
  { from: 3, to: 9, label: 'Модель и комплектация' },
  { from: 9, to: 17, label: 'Год и номер кузова' },
] as const;

/** The 17 characters of a VIN as cells of a data plate, grouped by what they mean. */
export function VinPlate() {
  return (
    <figure className="min-w-0 rounded border border-line bg-card p-4 md:p-6">
      <figcaption className="text-label text-muted">Так выглядит VIN</figcaption>
      <div className="mt-4 grid grid-cols-[repeat(17,minmax(0,1fr))] gap-px overflow-hidden rounded-sm border border-ink bg-ink">
        {SAMPLE_VIN.split('').map((char, index) => (
          <span
            key={index}
            className={cn(
              'grid h-9 place-items-center bg-card font-mono text-[0.8125rem] font-semibold md:h-12 md:text-lg',
              index < 3 && 'bg-accent-soft',
            )}
          >
            {char}
          </span>
        ))}
      </div>
      <div className="mt-2 grid grid-cols-[repeat(17,minmax(0,1fr))] gap-px">
        {VIN_PARTS.map((part) => (
          <p
            key={part.label}
            className="border-t-2 border-ink pt-1.5 text-[0.6875rem] leading-tight text-muted md:text-xs"
            style={{ gridColumn: `${part.from + 1} / ${part.to + 1}` }}
          >
            {part.label}
          </p>
        ))}
      </div>
      <p className="mt-4 text-sm text-muted">
        В VIN нет букв O, I и Q: если видите похожий знак, это цифра 0 или 1.
      </p>
    </figure>
  );
}

/** Numbered steps with a rail between them (the /vin page). */
export function VinSteps({ steps }: { steps: readonly { title: string; text: string }[] }) {
  return (
    <ol className="mt-6 min-w-0 md:mt-8">
      {steps.map((step, index) => (
        <li key={step.title} className="flex min-w-0 gap-4">
          <div className="flex flex-col items-center">
            <span className="grid size-9 shrink-0 place-items-center rounded-sm bg-ink font-mono text-xs font-semibold text-paper">
              {String(index + 1).padStart(2, '0')}
            </span>
            {index < steps.length - 1 ? (
              <span aria-hidden className="my-1 w-px flex-1 bg-line-strong" />
            ) : null}
          </div>
          <div className={cn('min-w-0 pt-1.5', index < steps.length - 1 && 'pb-7')}>
            <h3 className="text-h3">{step.title}</h3>
            <p className="mt-1 text-muted">{step.text}</p>
          </div>
        </li>
      ))}
    </ol>
  );
}
