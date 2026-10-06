import { IconCheck } from '@/components/icons';
import { cn } from '@/components/ui/cn';

const STEPS = ['Корзина', 'Оформление', 'Заказ'] as const;

/**
 * Where the client is on the way to an order, next to the title of /cart and /checkout:
 * «1 Корзина — 2 Оформление — 3 Заказ» in circles from sm. A done step is a green tick, the
 * current one a brand circle with its number, the rest grey. Only a hint: nothing here is a link.
 * Phones get one line «Шаг 2 из 3 · Оформление» instead: bare numbered circles said nothing and
 * met the numbered sections of the form right under them.
 */
export function CheckoutSteps({ current }: { current: 0 | 1 | 2 }) {
  return (
    <>
      <p className="text-small text-muted sm:hidden">
        Шаг {current + 1} из {STEPS.length} ·{' '}
        <span className="font-bold text-ink">{STEPS[current]}</span>
      </p>
      <ol className="hidden min-w-0 flex-wrap items-center gap-x-2 gap-y-2 text-small sm:flex">
        {STEPS.map((label, index) => {
          const done = index < current;
          const active = index === current;
          return (
            <li
              key={label}
              className={cn(
                'flex items-center gap-2',
                active ? 'font-bold text-ink' : done ? 'text-ink' : 'text-muted',
              )}
              aria-current={active ? 'step' : undefined}
            >
              <span
                aria-hidden
                className={cn(
                  'grid size-8 shrink-0 place-items-center rounded-full text-base font-extrabold tabular-nums',
                  active
                    ? 'bg-brand text-on-brand'
                    : done
                      ? 'bg-ok-soft text-ok'
                      : 'bg-surface text-muted',
                )}
              >
                {done ? <IconCheck size={18} strokeWidth={2.5} /> : index + 1}
              </span>
              <span>{label}</span>
              {index < STEPS.length - 1 ? (
                <span aria-hidden className="mx-1 h-0.5 w-5 rounded-full bg-line-strong md:w-8" />
              ) : null}
            </li>
          );
        })}
      </ol>
    </>
  );
}
