import type { OrderStatus, PaymentScheme } from '@detaly/domain';
import {
  IconBox,
  IconCard,
  IconCheck,
  IconPin,
  IconReceipt,
  IconRoute,
  IconShield,
  type IconComponent,
} from '@/components/icons';
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
  // The parts are on their way: the stage «Заказан у поставщика» stays current until they
  // arrive, so the stepper says what the status badge says (and «едет в Оренбург» under it).
  ordered_at_supplier: 2,
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
): { label: string; state: StepState; hint?: string }[] {
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
  // At the supplier stage the order is placed already: the badge reads «Заказан у поставщика»,
  // so does the current step, with where the parts are as the hint.
  const atSupplier = status === 'ordered_at_supplier';
  return labels.map(([done, pending], index) => ({
    label:
      current !== null && (index < current || (atSupplier && index === current)) ? done : pending,
    hint: atSupplier && index === current ? 'едет в Оренбург' : undefined,
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

/** The icon of each step: receipt, payment (card) or confirmation (shield), box, route, pin. */
function stepIcons(scheme: PaymentScheme): readonly IconComponent[] {
  return [IconReceipt, scheme === 'prepay' ? IconCard : IconShield, IconBox, IconRoute, IconPin];
}

function Marker({ state, Icon }: { state: StepState; Icon: IconComponent }) {
  return (
    <span
      aria-hidden
      className={cn(
        'relative z-10 grid size-11 shrink-0 place-items-center rounded-full md:size-12',
        state === 'done' && 'bg-ok text-on-brand',
        state === 'current' && 'bg-brand text-on-brand ring-4 ring-brand-soft',
        state === 'todo' && 'border-2 border-line-strong bg-bg text-muted',
        state === 'stopped' && 'bg-surface-2 text-faint',
      )}
    >
      {state === 'done' ? <IconCheck size={22} strokeWidth={2.5} /> : <Icon size={22} />}
    </span>
  );
}

/**
 * The order's way (docs/design-v2.md, Stepper): steps with icons in circles, horizontal from md,
 * a vertical list on phones. Passed steps are green with a tick, the current one is the brand
 * with a soft ring and «сейчас», the rest are outlined; a cancelled order greys the whole line.
 */
export function OrderStepper({ status, scheme }: { status: OrderStatus; scheme: PaymentScheme }) {
  const steps = orderSteps(status, scheme);
  const icons = stepIcons(scheme);
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
        const Icon = icons[index] ?? IconCheck;
        return (
          <li
            key={step.label}
            className="flex min-w-0 gap-4 md:flex-col md:items-center md:gap-3 md:text-center"
            aria-current={step.state === 'current' ? 'step' : undefined}
          >
            <div className="flex flex-col items-center md:relative md:w-full md:flex-row md:justify-center">
              <Marker state={step.state} Icon={Icon} />
              {!last ? (
                <span
                  aria-hidden
                  className={cn(
                    'my-1 min-h-4 w-0.5 flex-1 rounded-full',
                    'md:absolute md:top-1/2 md:left-[calc(50%+1.75rem)] md:my-0 md:h-0.5 md:min-h-0 md:w-[calc(100%-3.5rem)] md:flex-none md:-translate-y-1/2',
                    solid ? 'bg-ok' : 'bg-line-strong',
                  )}
                />
              ) : null}
            </div>
            <div className={cn('min-w-0 pt-2.5 md:px-1 md:pt-0', last ? 'pb-0' : 'pb-3 md:pb-0')}>
              <p
                className={cn(
                  'text-body leading-snug md:text-small',
                  step.state === 'current'
                    ? 'font-bold text-ink'
                    : step.state === 'done'
                      ? 'font-semibold text-ink'
                      : 'text-muted',
                  step.state === 'stopped' && 'line-through decoration-line-strong',
                )}
              >
                {step.label}
                <span className="sr-only"> — {SR_STATE[step.state]}</span>
              </p>
              {step.state === 'current' ? (
                <p aria-hidden className="mt-0.5 text-small font-semibold text-brand">
                  сейчас{step.hint ? ` · ${step.hint}` : ''}
                </p>
              ) : null}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
