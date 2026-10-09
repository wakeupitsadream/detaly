'use client';

/**
 * The fit check of one cart line (step 4, docs/fit-check.md, «Строка корзины»):
 * - none: «Проверить под мою машину» (the form in a sheet; inline without JavaScript);
 * - pending: «Мастер проверяет · ответит в течение часа» (the page refreshes itself every 30 s
 *   with JavaScript, FitAutoRefresh; without it an «Обновить» link);
 * - fits and an accepted analog: «Проверено мастером» (+ the guarantee line when enabled);
 * - analog_offer: «Мастер предлагает аналог: BRAND ARTICLE · 450 ₽ · к пт 10 октября» with
 *   «Заменить» and «Оставить как есть» (plain form posts to /api/cart/items/<id>/fit);
 * - analog_kept: the analog stays offered under the line, the line is not checked;
 * - not_fit: «Не подходит для вашей машины», «Удалить из корзины» and the VIN request link;
 * - call_needed: «Мастеру нужно уточнить — позвоните <phone>» (tel: link);
 * - expired: «Мастер не успел ответить» and «Отправить снова».
 * DEMO_MODE: the form answers itself (FitDemoProvider): «Мастер проверяет» for ~3 s, then
 * «Проверено мастером · демо»; a submit without JavaScript comes back as `?fit_demo=<line>`.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {
  IconAlert,
  IconPhone,
  IconReturn,
  IconShield,
  IconSts,
  IconTrash,
} from '@/components/icons';
import { Badge } from '@/components/ui/Badge';
import { Spinner, buttonClass } from '@/components/ui/Button';
import { cn } from '@/components/ui/cn';
import type { FitLineView, FitShared } from '@/server/fit-checks/cart-fit';
import { fitAnchor } from '@/server/fit-checks/paths';
import { FitCheckedBadge } from './FitBadge';
import { FitCheckForm, type FitFormLine } from './FitCheckForm';
import { FitSheet } from './FitSheet';

/** How long the demo «Мастер проверяет» lasts before the demo answer. */
export const FIT_DEMO_PENDING_MS = 3_000;

type DemoState = 'pending' | 'done';

interface FitDemo {
  stateOf: (lineId: string) => DemoState | null;
  start: (lineIds: readonly string[]) => void;
}

const FitDemoContext = createContext<FitDemo>({ stateOf: () => null, start: () => {} });

/**
 * DEMO_MODE with JavaScript: the demo answers of the cart, in memory only (a reload forgets
 * them; nothing is stored or sent).
 */
export function FitDemoProvider({ children }: { children: ReactNode }) {
  const [states, setStates] = useState<ReadonlyMap<string, DemoState>>(() => new Map());
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  useEffect(() => {
    const pending = timers.current;
    return () => pending.forEach(clearTimeout);
  }, []);
  const start = useCallback((lineIds: readonly string[]) => {
    const mark = (state: DemoState) =>
      setStates((current) => {
        const next = new Map(current);
        for (const id of lineIds) next.set(id, state);
        return next;
      });
    mark('pending');
    timers.current.push(setTimeout(() => mark('done'), FIT_DEMO_PENDING_MS));
  }, []);
  const value = useMemo<FitDemo>(
    () => ({ stateOf: (lineId) => states.get(lineId) ?? null, start }),
    [states, start],
  );
  return <FitDemoContext.Provider value={value}>{children}</FitDemoContext.Provider>;
}

const ACTION_BUTTON = 'w-full sm:w-auto';

/** «Заменить» / «Оставить как есть»: plain form posts (work without JavaScript). */
function AnalogAction({
  lineId,
  action,
  variant,
  label,
  testId,
}: {
  lineId: string;
  action: 'replace' | 'keep';
  variant: 'primary' | 'secondary' | 'ghost';
  label: string;
  testId: string;
}) {
  return (
    <form method="post" action={`/api/cart/items/${lineId}/fit`} className="min-w-0">
      <input type="hidden" name="action" value={action} />
      <button
        type="submit"
        className={cn(buttonClass({ variant }), ACTION_BUTTON)}
        data-testid={testId}
      >
        {label}
      </button>
    </form>
  );
}

function AnalogText({ analog }: { analog: NonNullable<FitLineView['analog']> }) {
  return (
    <>
      {/* One piece: «MANN-FILTER W 914/2» never breaks at its hyphen or spaces. */}
      <span className="font-bold whitespace-nowrap">
        {analog.brand} <span className="tabular-nums">{analog.article}</span>
      </span>
      {' · '}
      <span className="font-bold whitespace-nowrap tabular-nums">{analog.priceText}</span>
      {analog.promiseText ? (
        <>
          {' · '}
          <span className="whitespace-nowrap">{analog.promiseText}</span>
        </>
      ) : null}
    </>
  );
}

export function FitLineBlock({
  lineId,
  view,
  shared,
  lines,
  openInitially = false,
  error = null,
  demoDone = false,
  refreshHref,
}: {
  lineId: string;
  view: FitLineView;
  shared: FitShared;
  /** Every line of the cart, for the list in the form. */
  lines: readonly FitFormLine[];
  /** `/cart?check=<line>` or a returned form error: the form opens. */
  openInitially?: boolean;
  error?: string | null;
  /** DEMO_MODE without JavaScript: this line came back from the demo form (`?fit_demo=`). */
  demoDone?: boolean;
  /** «Обновить» without JavaScript: the cart again (a new URL every render, so it reloads). */
  refreshHref: string;
}) {
  const demo = useContext(FitDemoContext);
  const [enhanced, setEnhanced] = useState(false);
  useEffect(() => setEnhanced(true), []);

  const local = shared.demo ? demo.stateOf(lineId) : null;
  const state =
    local === 'pending'
      ? 'pending'
      : local === 'done' || (shared.demo && demoDone)
        ? 'demo_done'
        : view.state;

  const sheet = (label: string, testId: string) => (
    <FitSheet
      title="Проверим, подойдёт ли"
      triggerLabel={label}
      triggerIcon={<IconShield size={20} className="shrink-0 text-brand" />}
      triggerClassName="w-full sm:w-auto"
      openInitially={openInitially}
      testId={testId}
    >
      <FitCheckForm
        lineId={lineId}
        lines={lines}
        shared={shared}
        error={error}
        onDemoSent={shared.demo ? demo.start : undefined}
      />
    </FitSheet>
  );

  let body: ReactNode;
  switch (state) {
    case 'none':
      body = sheet('Проверить под мою машину', 'fit-open');
      break;
    case 'pending':
      body = (
        <div className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-2">
          <p
            className="inline-flex min-w-0 items-start gap-2 rounded-[1.25rem] bg-info-soft px-3 py-1.5 text-sm leading-snug font-semibold text-info"
            role="status"
            data-testid="fit-pending"
          >
            <Spinner className="mt-px size-[1.125rem]" />
            <span className="min-w-0">{shared.pendingText}</span>
          </p>
          {enhanced ? null : (
            <a
              href={refreshHref}
              className="inline-flex min-h-12 items-center gap-2 font-semibold text-brand underline decoration-1 underline-offset-4 hover:text-brand-hover hover:decoration-2"
              data-testid="fit-refresh"
            >
              <IconReturn size={20} className="shrink-0" />
              Обновить
            </a>
          )}
        </div>
      );
      break;
    case 'fits':
    case 'analog_accepted':
      body = <FitCheckedBadge guarantee={shared.guarantee} />;
      break;
    case 'demo_done':
      body = <FitCheckedBadge guarantee={shared.guarantee} demo />;
      break;
    case 'analog_offer':
      body = view.analog ? (
        <div
          className="min-w-0 space-y-3 rounded-control bg-info-soft p-3 md:p-4"
          data-testid="fit-analog"
        >
          <p className="min-w-0 text-body">
            Мастер предлагает аналог:{' '}
            <span className="block">
              <AnalogText analog={view.analog} />
            </span>
          </p>
          {view.analog.name ? (
            <p className="-mt-2 text-small font-normal text-muted wrap-anywhere">
              {view.analog.name}
            </p>
          ) : null}
          <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:flex-wrap">
            <AnalogAction
              lineId={lineId}
              action="replace"
              variant="primary"
              label="Заменить"
              testId="fit-analog-replace"
            />
            <AnalogAction
              lineId={lineId}
              action="keep"
              variant="secondary"
              label="Оставить как есть"
              testId="fit-analog-keep"
            />
          </div>
        </div>
      ) : (
        <p className="text-small text-muted" data-testid="fit-analog">
          Мастер предлагает аналог — позвоните нам, расскажем подробнее.
        </p>
      );
      break;
    case 'analog_kept':
      body = (
        <div className="min-w-0 space-y-2" data-testid="fit-analog-kept">
          <p className="min-w-0 text-small font-normal text-muted">
            Вы оставили свою деталь.
            {view.analog ? (
              <>
                {' '}
                Мастер предлагал аналог: <AnalogText analog={view.analog} />
              </>
            ) : null}
          </p>
          {view.analog ? (
            <AnalogAction
              lineId={lineId}
              action="replace"
              variant="secondary"
              label="Заменить на аналог"
              testId="fit-analog-replace"
            />
          ) : null}
        </div>
      );
      break;
    case 'not_fit':
      body = (
        <div className="min-w-0 space-y-3" data-testid="fit-not-fit">
          <Badge tone="danger" icon={<IconAlert size={16} />}>
            Не подходит для вашей машины
          </Badge>
          <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:flex-wrap">
            <form method="post" action={`/api/cart/items/${lineId}`} className="min-w-0">
              <input type="hidden" name="_method" value="delete" />
              <button
                type="submit"
                className={cn(buttonClass({ variant: 'danger' }), ACTION_BUTTON)}
                data-testid="fit-remove"
              >
                <IconTrash size={20} />
                Удалить из корзины
              </button>
            </form>
            <a href="/vin" className={cn(buttonClass({ variant: 'secondary' }), ACTION_BUTTON)}>
              <IconSts size={20} className="shrink-0 text-brand" />
              Подобрать по VIN
            </a>
          </div>
        </div>
      );
      break;
    case 'call_needed':
      body = (
        <div className="min-w-0 space-y-3" data-testid="fit-call">
          <p className="flex min-w-0 items-start gap-2 text-body">
            <IconPhone size={20} className="mt-0.5 shrink-0 text-wait" />
            <span className="min-w-0">
              Мастеру нужно уточнить —{' '}
              {shared.phone ? (
                <>
                  позвоните{' '}
                  <a
                    href={shared.phone.href}
                    className="font-bold whitespace-nowrap text-brand underline decoration-1 underline-offset-4 hover:text-brand-hover"
                    data-testid="fit-call-phone"
                  >
                    {shared.phone.text}
                  </a>
                </>
              ) : (
                'спросите в пункте выдачи'
              )}
            </span>
          </p>
        </div>
      );
      break;
    case 'expired':
      body = (
        <div className="min-w-0 space-y-3" data-testid="fit-expired">
          <p className="text-small font-normal text-muted">Мастер не успел ответить</p>
          {sheet('Отправить снова', 'fit-open')}
        </div>
      );
      break;
  }

  return (
    <div
      id={fitAnchor(lineId)}
      // Focused after a send (FitSheet), so a screen reader reads the new state.
      tabIndex={-1}
      className="min-w-0 scroll-mt-28 focus:outline-none"
      data-testid="fit-line"
      data-state={state}
    >
      {body}
    </div>
  );
}
