/**
 * /p/<token>: the master's proposal in «Техкарта» (docs/phase-1c-implementation.md section 11
 * item 2): the comment, the lines (tile, brand, article, name, quantity, price, date, stock
 * badge), the total, the rule «подобрали мы и не подошло — вернём деньги» and «Оформить и
 * оплатить», a plain form post (no JavaScript needed). Phones get the sum and the button in a
 * bar fixed at the bottom. An expired proposal is read-only.
 */
import { IconArrowRight, IconClock, IconPhone, IconShield } from '@/components/icons';
import { Notice } from '@/components/page/Notice';
import { SheetTitle } from '@/components/page/SheetTitle';
import { StockBadge } from '@/components/StockBadge';
import { Badge } from '@/components/ui/Badge';
import { buttonClass } from '@/components/ui/Button';
import { cn } from '@/components/ui/cn';
import { PartTile } from '@/components/ui/PartTile';
import { Price } from '@/components/ui/Price';
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

function ProposalLine({ line }: { line: ProposalLineView }) {
  const off = line.status !== 'ok';
  return (
    <li
      className={cn(
        'grid min-w-0 grid-cols-[3.5rem_minmax(0,1fr)] gap-x-4 gap-y-3 rounded border border-line bg-card p-4 md:grid-cols-[4.5rem_minmax(0,1fr)_auto] md:gap-x-6 md:p-5',
        off && 'bg-paper-2',
      )}
      data-testid="proposal-line"
      data-status={line.status}
    >
      <PartTile name={line.name} size="sm" className="md:size-18" />
      <div className="min-w-0">
        <p className="text-label text-muted wrap-anywhere">{line.brand}</p>
        <p className="mt-1 font-mono text-lg leading-tight font-semibold tracking-wide wrap-anywhere">
          {line.article}
        </p>
        <p className="mt-1 text-[0.9375rem] leading-snug wrap-anywhere">{line.name}</p>
        {line.status !== 'ok' ? (
          <p className="mt-3 text-sm text-danger">{STATUS_TEXT[line.status]}</p>
        ) : (
          <div className="mt-3 flex min-w-0 flex-wrap items-center gap-x-4 gap-y-2">
            <StockBadge isLocal={line.isLocal} />
            {line.promiseText ? (
              <span
                className="inline-flex min-w-0 items-center gap-1.5 text-sm text-muted"
                data-testid="proposal-line-promise"
              >
                <IconClock size={15} className="shrink-0 text-ink" />
                <span>
                  Получение <span className="font-semibold text-ink">{line.promiseText}</span>
                </span>
              </span>
            ) : null}
          </div>
        )}
      </div>
      <div className="col-span-2 flex min-w-0 items-baseline justify-between gap-4 border-t border-dashed border-line pt-3 md:col-span-1 md:flex-col md:items-end md:justify-start md:gap-0 md:border-0 md:pt-0 md:text-right">
        <p className="font-mono text-xs text-muted md:order-2 md:mt-1.5">
          {line.qty} шт. × <span className="whitespace-nowrap">{line.priceText}</span>
        </p>
        <Price
          size="sm"
          className={cn('md:order-1 md:[--price-size:1.5rem]', off && 'text-faint line-through')}
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
  onDark = false,
  compact = false,
  testId,
}: {
  mode: ProposalMode;
  block?: boolean;
  onDark?: boolean;
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
        className={cn(buttonClass({ variant: 'primary', size, block, onDark }), 'shrink-0')}
        data-testid={testId}
      >
        {compact ? 'Прислать VIN' : 'Прислать свой VIN'}
        <IconArrowRight size={18} />
      </a>
    );
  }
  return (
    <form method="post" action={mode.action} className={cn('min-w-0', block && 'w-full')}>
      <button
        type="submit"
        className={cn(buttonClass({ variant: 'primary', size, block, onDark }), 'shrink-0')}
        data-testid={testId}
      >
        {compact ? 'Оформить' : 'Оформить и оплатить'}
        <IconArrowRight size={18} />
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
    <div className="grid min-w-0 gap-8 lg:grid-cols-[minmax(0,1fr)_22rem] lg:gap-12">
      <div className="min-w-0 space-y-6">
        {mode.kind === 'sample' ? (
          <Notice tone="info" title="Это пример подборки" data-testid="proposal-sample">
            Так выглядит ответ мастера на заявку по VIN. Пришлите свой VIN — подберём бесплатно.
          </Notice>
        ) : null}
        {mode.kind === 'expired' ? (
          <Notice tone="wait" title="Подборка больше не действует" data-testid="proposal-expired">
            Срок подборки истёк или мастер прислал новую. Попросите мастера обновить подборку
            {contactPhone ? (
              <>
                {' '}
                —{' '}
                <a href={telHref(contactPhone)} className="font-semibold underline">
                  {contactPhone}
                </a>
              </>
            ) : null}
            .
          </Notice>
        ) : null}
        {view.changed && mode.kind !== 'expired' ? (
          <Notice tone="info" data-testid="proposal-changed">
            Цены или наличие изменились с момента подборки — показываем актуальные.
          </Notice>
        ) : null}

        {view.comment ? (
          <section
            className="min-w-0 rounded border border-line border-l-[3px] border-l-accent bg-card p-5 md:p-6"
            aria-labelledby="proposal-comment"
            data-testid="proposal-comment"
          >
            <h2 id="proposal-comment" className="text-label text-muted">
              Комментарий мастера
            </h2>
            <p className="mt-2 text-[0.9375rem] leading-relaxed whitespace-pre-line wrap-anywhere">
              {view.comment}
            </p>
          </section>
        ) : null}

        <section aria-labelledby="proposal-lines" className="min-w-0">
          <SheetTitle index="01" id="proposal-lines" tight>
            Что подобрал мастер
          </SheetTitle>
          <ul className="mt-4 flex min-w-0 flex-col gap-3" data-testid="proposal-lines">
            {view.lines.map((line) => (
              <ProposalLine key={line.id} line={line} />
            ))}
          </ul>
        </section>
      </div>

      <aside className="min-w-0 space-y-5" aria-label="Итого">
        <section
          className="corner-marks min-w-0 rounded border border-ink bg-card p-5 md:p-6"
          data-testid="proposal-summary"
        >
          <p className="text-label text-muted">Итого, {view.itemsCount} шт.</p>
          <Price size="lg" className="mt-3 block" data-testid="proposal-total">
            {view.totalText}
          </Price>
          {view.promiseText ? (
            <p className="mt-4 flex items-start gap-2 border-t border-dashed border-line pt-4 text-sm text-muted">
              <IconClock size={16} className="mt-0.5 shrink-0 text-ink" />
              <span>
                Получение заказа <span className="font-semibold text-ink">{view.promiseText}</span>
              </span>
            </p>
          ) : null}
          <p className="mt-2 text-sm text-muted">
            {mode.kind === 'expired' ? 'Действовала' : 'Действует'} {view.expiresText}
          </p>
          {view.stale && mode.kind === 'live' ? (
            <p className="mt-2 text-sm text-muted">
              Цены и наличие ещё раз сверим у поставщика при оформлении.
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
                <IconPhone size={18} />
                Позвонить мастеру
              </a>
            ) : null}
          </div>
        </section>

        <section className="min-w-0 rounded border border-line bg-card p-5 md:p-6">
          <div className="flex items-start gap-3">
            <IconShield size={24} className="shrink-0 text-ok" />
            <div className="min-w-0">
              <h2 className="text-h3">Подобрали мы&nbsp;— отвечаем мы</h2>
              <p className="mt-2 text-sm text-muted" data-testid="proposal-guarantee">
                Если деталь из этой подборки не подошла к автомобилю из заявки, вернём деньги
                полностью.
              </p>
            </div>
          </div>
        </section>
        {mode.kind === 'sample' ? <Badge tone="demo">пример, цены условные</Badge> : null}
      </aside>

      {canTake ? (
        <>
          <div aria-hidden className="h-[calc(4.5rem+env(safe-area-inset-bottom))] md:hidden" />
          <div
            className="fixed inset-x-0 bottom-0 z-50 border-t border-graphite-700 bg-graphite-950 pb-[env(safe-area-inset-bottom)] text-paper md:hidden"
            data-testid="proposal-bar"
          >
            <div className="flex h-[4.5rem] items-center justify-between gap-3 px-4">
              <p className="min-w-0">
                <span className="block font-display text-lg leading-none font-semibold whitespace-nowrap tabular-nums">
                  {view.totalText}
                </span>
                <span className="mt-1 block font-mono text-xs text-steel-400">
                  {view.itemsCount} шт.
                </span>
              </p>
              <TakeButton mode={mode} onDark compact testId="proposal-take-bar" />
            </div>
          </div>
        </>
      ) : null}
    </div>
  );
}
