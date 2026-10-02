import { IconCheck } from '@/components/icons';
import { cn } from '@/components/ui/cn';

const STEPS = ['Корзина', 'Оформление', 'Заказ'] as const;

/**
 * Where the client is on the way to an order, in the band of /cart and /checkout (graphite):
 * «01 Корзина — 02 Оформление — 03 Заказ». Done steps get a tick, the current one the signal
 * square. Only a hint: nothing here is a link.
 */
export function CheckoutSteps({ current }: { current: 0 | 1 | 2 }) {
  return (
    <ol className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2 font-mono text-xs font-semibold tracking-[0.08em] uppercase">
      {STEPS.map((label, index) => {
        const done = index < current;
        const active = index === current;
        return (
          <li
            key={label}
            className={cn(
              'flex items-center gap-2',
              active ? 'text-paper' : done ? 'text-steel-200' : 'text-steel-400/70',
            )}
            aria-current={active ? 'step' : undefined}
          >
            <span
              aria-hidden
              className={cn(
                'grid size-5 place-items-center rounded-sm border text-[0.625rem]',
                active
                  ? 'border-accent bg-accent text-ink'
                  : done
                    ? 'border-steel-400 text-paper'
                    : 'border-graphite-700',
              )}
            >
              {done ? <IconCheck size={12} strokeWidth={2.5} /> : `0${index + 1}`}
            </span>
            <span className={active ? undefined : 'sr-only sm:not-sr-only'}>{label}</span>
            {index < STEPS.length - 1 ? (
              <span aria-hidden className="ml-1 h-px w-4 bg-graphite-700 md:w-8" />
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}
