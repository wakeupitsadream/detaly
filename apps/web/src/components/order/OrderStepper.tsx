import type { OrderStatus, PaymentScheme } from '@detaly/domain';
import { IconCheck } from '@/components/icons';
import { cn } from '@/components/ui/cn';

type StepState = 'done' | 'current' | 'todo' | 'stopped';

/**
 * Which step of «Оформлен → Оплачен/Подтверждён → Заказан у поставщика → Приехал → Выдан» an
 * order status is at: the index of the step in progress (5 = all done), null for a stopped
 * order. Display only: the statuses themselves and their labels come from the read model.
 */
const CURRENT_STEP: Readonly<Record<OrderStatus, number | null>> = {
  draft: 1,
  awaiting_payment: 1,
  awaiting_confirmation: 1,
  confirmed: 2,
  ordering: 2,
  awaiting_supplier_invoice: 2,
  needs_attention: 2,
  awaiting_client_approval: 2,
  ordered_at_supplier: 3,
  ready: 4,
  out_for_delivery: 4,
  awaiting_handover_payment: 4,
  handed: 5,
  completed: 5,
  cancelled: null,
  refund_pending: null,
  refunded: null,
};

export function orderSteps(
  status: OrderStatus,
  scheme: PaymentScheme,
): { label: string; state: StepState }[] {
  // Past tense once a step is behind, the name of the stage while it is current or ahead:
  // «Оплачен» under «Ждёт оплаты» would read as if the money had come.
  const labels: readonly (readonly [done: string, pending: string])[] = [
    ['Оформлен', 'Оформление'],
    scheme === 'prepay' ? ['Оплачен', 'Оплата'] : ['Подтверждён', 'Подтверждение'],
    ['Заказан у поставщика', 'Заказ у поставщика'],
    ['Приехал', 'Доставка в Оренбург'],
    ['Выдан', 'Выдача'],
  ];
  const current = CURRENT_STEP[status];
  return labels.map(([done, pending], index) => ({
    label: current !== null && index < current ? done : pending,
    state:
      current === null
        ? 'stopped'
        : index < current
          ? 'done'
          : index === current
            ? 'current'
            : 'todo',
  }));
}

const SR_STATE: Record<StepState, string> = {
  done: 'пройден',
  current: 'сейчас',
  todo: 'впереди',
  stopped: 'не выполнен',
};

function Marker({ state, index }: { state: StepState; index: number }) {
  return (
    <span
      aria-hidden
      className={cn(
        'relative z-10 grid size-7 shrink-0 place-items-center rounded-full font-mono text-[0.6875rem] font-semibold',
        state === 'done' && 'bg-paper text-ink',
        state === 'current' &&
          'border-2 border-accent bg-graphite-900 shadow-[0_0_0_5px_rgb(255_91_31/0.18)]',
        state === 'todo' && 'border border-dashed border-steel-400/60 text-steel-400',
        state === 'stopped' && 'border border-graphite-700 bg-graphite-800 text-steel-400/70',
      )}
    >
      {state === 'done' ? (
        <IconCheck size={15} strokeWidth={2.5} />
      ) : state === 'current' ? (
        <span className="size-2.5 rounded-full bg-accent" />
      ) : (
        index + 1
      )}
    </span>
  );
}

/**
 * The order's way as a timeline on the graphite band of /o/<token>: horizontal from md,
 * vertical on phones. Passed steps are a paper disc with a tick, the current one a signal ring,
 * the rest dashed; a cancelled order greys the whole line.
 */
export function OrderStepper({ status, scheme }: { status: OrderStatus; scheme: PaymentScheme }) {
  const steps = orderSteps(status, scheme);
  return (
    <ol
      aria-label="Ход заказа"
      className="grid min-w-0 gap-0 md:grid-cols-5"
      data-testid="order-stepper"
    >
      {steps.map((step, index) => {
        const last = index === steps.length - 1;
        const next = steps[index + 1];
        const solid = step.state === 'done' && next !== undefined && next.state !== 'stopped';
        return (
          <li
            key={step.label}
            className="flex min-w-0 gap-3.5 md:flex-col md:gap-3"
            aria-current={step.state === 'current' ? 'step' : undefined}
          >
            <div className="flex flex-col items-center md:flex-row">
              <Marker state={step.state} index={index} />
              {!last ? (
                <span
                  aria-hidden
                  className={cn(
                    'my-1 min-h-3 w-0 flex-1 border-l md:mx-2 md:my-0 md:h-0 md:min-h-0 md:w-auto md:border-t md:border-l-0',
                    solid ? 'border-steel-200' : 'border-dashed border-graphite-700',
                  )}
                />
              ) : null}
            </div>
            <div className={cn('min-w-0 pt-1 md:pt-0 md:pr-4', last ? 'pb-0' : 'pb-3 md:pb-0')}>
              <p
                className={cn(
                  'text-sm leading-snug',
                  step.state === 'current'
                    ? 'font-semibold text-paper'
                    : step.state === 'done'
                      ? 'text-steel-200'
                      : 'text-steel-400',
                  step.state === 'stopped' && 'line-through decoration-graphite-700',
                )}
              >
                {step.label}
                <span className="sr-only"> — {SR_STATE[step.state]}</span>
              </p>
              {step.state === 'current' ? (
                <p aria-hidden className="mt-1 text-label text-accent">
                  сейчас
                </p>
              ) : null}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
