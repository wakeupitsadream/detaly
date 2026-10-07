/**
 * /p/<token>: the master's proposal (docs/phase-1c-implementation.md section 11 item 2; look:
 * docs/design-v2.md, /p/[token]): the master's comment on a `surface` card with the master's
 * icon, the lines as offer cards (tile, brand and article, name, stock badge, date, price), the
 * total with «Оформить и оплатить» — a plain form post (no JavaScript needed) — and the rule
 * «подобрали мы и не подошло — вернём деньги». Phones get the sum and the button in a white bar
 * fixed at the bottom. An expired proposal is read-only.
 */
import {
  IconArrowRight,
  IconCalendar,
  IconPhone,
  IconShield,
  IconWrench,
} from '@/components/icons';
import { Notice } from '@/components/page/Notice';
import { StockBadge } from '@/components/StockBadge';
import { Badge } from '@/components/ui/Badge';
import { buttonClass } from '@/components/ui/Button';
import { cn } from '@/components/ui/cn';
import { PartTile } from '@/components/ui/PartTile';
import { Price } from '@/components/ui/Price';
import { SectionHeading } from '@/components/ui/Section';
import { telHref } from '@/server/brand';
import type { ProposalLineView, ProposalPageView } from '@/server/vin/proposal-page';

export type ProposalMode =
  /** A live proposal: the form posts to `action`. */
  | { kind: 'live'; action: string }
  /** Past its date, replaced or closed: view only. */
  | { kind: 'expired' }
  /** The /p/demo sample outside the demo: a link to the VIN form instead of the button. */
  | { kind: 'sample' };

const STATUS_TEXT: Record<Exclude<ProposalLineView['status'], 'ok'>, string> = {
  unavailable: 'Сейчас нет в наличии — мастер подберёт замену',
  excluded: 'Не продаём онлайн — спросите в сервисе',
};

/**
 * One line as an offer card: tile | brand, article, name | price, the badge and the date under
 * the name. On phones the badge row takes the card's full width (as in OfferRow), so «В
 * Оренбурге — оплата при получении» stays on one line.
 */
function ProposalLine({ line }: { line: ProposalLineView }) {
  const off = line.status !== 'ok';
  return (
    <li
      className={cn(
        'grid min-w-0 grid-cols-[3.5rem_minmax(0,1fr)] gap-x-4 gap-y-3 rounded-tile border border-line p-4',
        'md:grid-cols-[4.5rem_minmax(0,1fr)_auto] md:gap-x-6 md:p-5',
        off ? 'bg-surface' : 'bg-bg',
      )}
      data-testid="proposal-line"
      data-status={line.status}
    >
      <PartTile name={line.name} size="sm" className="md:row-span-2 md:size-18 md:rounded-tile" />
      <div className="min-w-0 self-center">
        <p className="text-[1.0625rem] leading-snug font-bold wrap-anywhere">
          {line.brand} <span className="tabular-nums">{line.article}</span>
        </p>
        <p className="mt-1 line-clamp-2 text-small font-normal text-muted wrap-anywhere">
          {line.name}
        </p>
      </div>
      <div className="col-span-2 min-w-0 md:col-span-1 md:col-start-2">
        {line.status !== 'ok' ? (
          <p className="text-small font-semibold text-danger">{STATUS_TEXT[line.status]}</p>
        ) : (
          <div className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-2">
            <StockBadge isLocal={line.isLocal} />
            {line.promiseText ? (
              <span
                className="inline-flex min-w-0 items-center gap-1.5 text-small"
                data-testid="proposal-line-promise"
              >
                <IconCalendar size={20} className="shrink-0 text-brand" />
                <span>
                  Получение <span className="font-bold">{line.promiseText}</span>
                </span>
              </span>
            ) : null}
          </div>
        )}
      </div>
      <div className="col-span-2 flex min-w-0 items-center justify-between gap-4 border-t border-line pt-3 md:col-span-1 md:col-start-3 md:row-span-2 md:row-start-1 md:flex-col md:items-end md:justify-center md:gap-1 md:border-0 md:pt-0 md:text-right">
        <p className="text-small font-normal text-muted tabular-nums md:order-2">
          {line.qty} шт. × <span className="whitespace-nowrap">{line.priceText}</span>
        </p>
        <Price
          className={cn('md:order-1', off && 'text-muted line-through')}
          data-testid="proposal-line-total"
        >
          {line.lineTotalText}
        </Price>
      </div>
    </li>
  );
}

function TakeButton({
  mode,
  block = false,
  compact = false,
  testId,
}: {
  mode: ProposalMode;
  block?: boolean;
  /** The phone bar: a shorter label and the regular height. */
  compact?: boolean;
  testId: string;
}) {
  const size = compact ? 'md' : 'lg';
  if (mode.kind === 'expired') return null;
  if (mode.kind === 'sample') {
    return (
      <a
        href="/vin"
        className={cn(buttonClass({ variant: 'primary', size, block }), 'shrink-0')}
        data-testid={testId}
      >
        {compact ? 'Прислать VIN' : 'Прислать свой VIN'}
        <IconArrowRight size={20} />
      </a>
    );
  }
  return (
    <form method="post" action={mode.action} className={cn('min-w-0', block && 'w-full')}>
      <button
        type="submit"
        className={cn(buttonClass({ variant: 'primary', size, block }), 'shrink-0')}
        data-testid={testId}
      >
        {compact ? 'Оформить' : 'Оформить и оплатить'}
        <IconArrowRight size={20} />
      </button>
    </form>
  );
}

export function ProposalSheet({
  view,
  mode,
  contactPhone,
}: {
  view: ProposalPageView;
  mode: ProposalMode;
  contactPhone: string | null;
}) {
  const sellable = view.lines.length > view.unavailable;
  const canTake = mode.kind !== 'expired' && sellable;
  return (
    <div className="grid min-w-0 gap-8 lg:grid-cols-[minmax(0,1fr)_24rem] lg:gap-10">
      <div className="min-w-0 space-y-6">
        {mode.kind === 'sample' ? (
          <Notice tone="info" title="Это пример подборки" data-testid="proposal-sample">
            Пришлите свой VIN — подберём бесплатно.
          </Notice>
        ) : null}
        {mode.kind === 'expired' ? (
          <Notice tone="wait" title="Подборка больше не действует" data-testid="proposal-expired">
            Попросите мастера обновить подборку
            {contactPhone ? (
              <>
                {' '}
                —{' '}
                <a
                  href={telHref(contactPhone)}
                  className="font-semibold whitespace-nowrap underline"
                >
                  {contactPhone}
                </a>
              </>
            ) : null}
            .
          </Notice>
        ) : null}
        {view.changed && mode.kind !== 'expired' ? (
          <Notice tone="info" data-testid="proposal-changed">
            Цены или наличие изменились — показываем актуальные.
          </Notice>
        ) : null}

        {view.comment ? (
          <section
            className="flex min-w-0 items-start gap-4 rounded-panel bg-surface p-5 md:p-6"
            aria-labelledby="proposal-comment"
            data-testid="proposal-comment"
          >
            <span
              aria-hidden
              className="grid size-14 shrink-0 place-items-center rounded-full bg-brand text-on-brand"
            >
              <IconWrench size={28} />
            </span>
            <div className="min-w-0">
              <h2 id="proposal-comment" className="text-h3">
                Комментарий мастера
              </h2>
              <p className="mt-2 text-body whitespace-pre-line wrap-anywhere">{view.comment}</p>
            </div>
          </section>
        ) : null}

        <section aria-labelledby="proposal-lines" className="min-w-0">
          <SectionHeading id="proposal-lines">Что подобрал мастер</SectionHeading>
          <ul className="mt-5 flex min-w-0 flex-col gap-3" data-testid="proposal-lines">
            {view.lines.map((line) => (
              <ProposalLine key={line.id} line={line} />
            ))}
          </ul>
        </section>
      </div>

      <aside className="min-w-0 space-y-4 lg:pt-1" aria-label="Итого">
        <section
          className="min-w-0 rounded-panel bg-surface p-6 md:p-7"
          data-testid="proposal-summary"
        >
          <p className="text-body font-semibold text-muted">Итого, {view.itemsCount} шт.</p>
          <Price size="lg" className="mt-1 block" data-testid="proposal-total">
            {view.totalText}
          </Price>
          {view.promiseText ? (
            <p className="mt-4 flex items-start gap-2 text-body">
              <IconCalendar size={22} className="mt-0.5 shrink-0 text-brand" />
              <span>
                Получение <span className="font-bold">{view.promiseText}</span>
              </span>
            </p>
          ) : null}
          <p className="mt-2 text-small font-normal text-muted">
            {mode.kind === 'expired' ? 'Цены действовали до' : 'Цены действуют до'}{' '}
            <span className="whitespace-nowrap">{view.expiresText}</span>
          </p>
          {view.stale && mode.kind === 'live' ? (
            <p className="mt-1 text-small font-normal text-muted">
              При оформлении сверим цены ещё раз.
            </p>
          ) : null}
          <div className="mt-5">
            {canTake ? (
              <TakeButton mode={mode} block testId="proposal-take" />
            ) : mode.kind === 'expired' && contactPhone ? (
              <a
                href={telHref(contactPhone)}
                className={buttonClass({ variant: 'secondary', size: 'lg', block: true })}
              >
                <IconPhone size={20} className="text-brand" />
                Позвонить мастеру
              </a>
            ) : null}
          </div>
          {mode.kind === 'sample' ? (
            <Badge tone="demo" className="mt-4">
              пример, цены условные
            </Badge>
          ) : null}
        </section>

        <section className="flex min-w-0 items-start gap-4 rounded-tile border border-line p-5 md:p-6">
          <IconShield size={40} strokeWidth={1.5} className="shrink-0 text-brand" />
          <div className="min-w-0">
            <h2 className="text-h3">Подобрали мы&nbsp;— отвечаем мы</h2>
            <p className="mt-1 text-small font-normal text-muted" data-testid="proposal-guarantee">
              Деталь не подошла к автомобилю из заявки — вернём деньги полностью.
            </p>
          </div>
        </section>
      </aside>

      {canTake ? (
        <>
          {/* The footer makes room for the bar (`.mobile-cart-bar` in globals.css). */}
          {/* The same floating card as MobileCartBar on the other pages. */}
          <div
            className="mobile-cart-bar fixed inset-x-0 bottom-0 z-50 px-3 pb-[calc(0.5rem+env(safe-area-inset-bottom))] md:hidden"
            data-testid="proposal-bar"
          >
            <div className="flex h-15 items-center justify-between gap-3 rounded-tile border border-line bg-bg pr-1.5 pl-4 shadow-float">
              <p className="min-w-0">
                <span className="block text-[1.375rem] leading-none font-extrabold whitespace-nowrap tabular-nums">
                  {view.totalText}
                </span>
                <span className="mt-1 block text-caption text-muted tabular-nums">
                  {view.itemsCount} шт.
                </span>
              </p>
              <TakeButton mode={mode} compact testId="proposal-take-bar" />
            </div>
          </div>
        </>
      ) : null}
    </div>
  );
}
