/**
 * One maintenance kit on /to/<make>/<model> (step 5, docs/kits.md; look: docs/design-v2.md):
 * a section with the kit's slug as its anchor — «ТО Lada Vesta 1.6 16V, 106 л.с.», the years,
 * the lines as cards (the category glyph, the role, brand and article, quantity, price, date)
 * with the alternatives as radio choices «или BRAND ARTICLE — дешевле на N ₽ · быстрее», and a
 * grey total card: the sum, «Получение к …», «Весь набор в корзину» (one plain form post: works
 * without JavaScript; with it the sum follows the choices), the lines the supplier lacks, the
 * fit check hint, the oil sentence and the replacement time when the master noted one. A sample
 * of the demo says so on the section itself.
 */
import { KIT_DEMO_LABEL, KIT_FIT_HINT, KIT_OIL_TEXT, KIT_UNAVAILABLE_TEXT } from '@detaly/domain';
import type { ReactNode } from 'react';
import {
  IconCalendar,
  IconCart,
  IconOil,
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
import { KIT_CART_PATH } from '@/lib/kit-paths';
import { plural } from '@/lib/plural';
import { telHref } from '@/server/brand';
import type { KitGroupView, KitOptionView, KitView } from '@/server/kits/kit-view';
import { KitChoiceSync } from './KitChoiceSync';

/** What a line the client cannot take now says instead of a price. */
const STATE_TEXT: Record<Exclude<KitOptionView['state'], 'ok'>, string> = {
  unavailable: KIT_UNAVAILABLE_TEXT,
  invalid: KIT_UNAVAILABLE_TEXT,
  supplier: 'Поставщик не ответил',
  excluded: 'Не продаём онлайн',
};

/** «MANN-FILTER W 914/2». */
function partTitle(option: KitOptionView): ReactNode {
  return (
    <>
      {option.brand} <span className="tabular-nums">{option.article}</span>
    </>
  );
}

/** «Получение к пт 9 октября» with the calendar. */
function PromiseLine({ text, className }: { text: string; className?: string }) {
  return (
    <span className={cn('inline-flex min-w-0 items-start gap-1.5 text-small', className)}>
      <IconCalendar size={20} className="shrink-0 text-brand" />
      <span className="min-w-0">
        Получение <span className="font-bold whitespace-nowrap">{text}</span>
      </span>
    </span>
  );
}

/** A line without a choice: the part, its stock and date, the price of the line. */
function SingleLine({ option }: { option: KitOptionView }) {
  return (
    <>
      <div className="col-span-2 flex min-w-0 flex-wrap items-center gap-x-4 gap-y-2 md:col-span-1 md:col-start-2">
        {option.offer ? (
          <>
            <StockBadge isLocal={option.offer.isLocal} payment={false} />
            <PromiseLine text={option.offer.promiseText} />
          </>
        ) : (
          <Badge tone="neutral" data-testid="kit-line-unavailable">
            {STATE_TEXT[option.state as Exclude<KitOptionView['state'], 'ok'>]}
          </Badge>
        )}
      </div>
      <div className="col-span-2 flex min-w-0 items-center justify-between gap-4 border-t border-line pt-3 md:col-span-1 md:col-start-3 md:row-span-2 md:row-start-1 md:flex-col md:items-end md:justify-center md:gap-1 md:border-0 md:pt-0 md:text-right">
        <p className="text-small font-normal text-muted tabular-nums md:order-2">
          {option.qty} шт.
          {option.offer ? (
            <>
              {' '}
              × <span className="whitespace-nowrap">{option.offer.priceText}</span>
            </>
          ) : null}
        </p>
        {option.offer ? (
          <Price size="sm" className="md:order-1" data-testid="kit-line-total">
            {option.offer.lineTotalText}
          </Price>
        ) : (
          <span className="text-small text-muted md:order-1" aria-hidden>
            —
          </span>
        )}
      </div>
    </>
  );
}

/** A line with alternatives: one radio per option on offer (the main line first). */
function ChoiceLine({ group, kitSlug }: { group: KitGroupView; kitSlug: string }) {
  const name = `pick_${group.mainLineId}`;
  return (
    <fieldset className="col-span-2 min-w-0 md:col-start-2 md:col-end-4">
      <legend className="sr-only">{`Что взять: ${group.role}`}</legend>
      <div className="flex min-w-0 flex-col gap-2">
        {group.options.map((option) => {
          const id = `${kitSlug}-${option.lineId}`;
          const offer = option.offer;
          return (
            <label
              key={option.lineId}
              htmlFor={id}
              className={cn(
                'grid min-h-14 min-w-0 cursor-pointer grid-cols-[1.375rem_minmax(0,1fr)_auto] items-center gap-x-3 gap-y-2 rounded-control border-[1.5px] border-line-strong bg-bg px-3 py-3 transition-colors hover:border-muted md:px-4',
                'has-checked:border-brand has-checked:bg-brand-soft has-[:focus-visible]:outline-3 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-brand',
                'has-disabled:cursor-default has-disabled:bg-surface has-disabled:hover:border-line-strong',
              )}
              data-testid="kit-option"
              data-line={option.lineId}
              data-alternative={option.alternative ? 'yes' : 'no'}
            >
              <input
                id={id}
                type="radio"
                name={name}
                value={option.lineId}
                defaultChecked={group.chosen === option.lineId}
                disabled={!offer}
                data-kop={offer?.lineTotalKop}
                data-eta={offer?.etaDate}
                data-promise={offer?.promiseText}
                className="size-[22px] shrink-0 cursor-pointer appearance-none rounded-full border-2 border-muted bg-bg transition-[border-width,border-color] checked:border-[7px] checked:border-brand focus-visible:outline-none disabled:cursor-default disabled:border-line-strong"
              />
              <span className="min-w-0 text-[1rem] leading-snug font-bold wrap-anywhere">
                {option.alternative ? <span className="font-normal text-muted">или </span> : null}
                {partTitle(option)}
                <span className="font-normal whitespace-nowrap text-muted tabular-nums">
                  {' '}
                  · {option.qty} шт.
                </span>
              </span>
              {offer ? (
                <Price size="sm" data-testid="kit-option-total">
                  {offer.lineTotalText}
                </Price>
              ) : (
                <span aria-hidden />
              )}
              {offer ? (
                <span className="col-start-2 col-end-4 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1.5">
                  <StockBadge isLocal={offer.isLocal} payment={false} />
                  <PromiseLine text={offer.promiseText} />
                  {option.hint ? (
                    <span
                      className="text-small font-semibold text-ink"
                      data-testid="kit-option-hint"
                    >
                      {option.hint}
                    </span>
                  ) : null}
                </span>
              ) : (
                <span
                  className="col-start-2 col-end-4 text-small text-muted"
                  data-testid="kit-line-unavailable"
                >
                  {STATE_TEXT[option.state as Exclude<KitOptionView['state'], 'ok'>]}
                </span>
              )}
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}

function KitLine({ group, kitSlug }: { group: KitGroupView; kitSlug: string }) {
  const [main] = group.options;
  const choice = group.options.length > 1;
  const off = group.chosen === null;
  return (
    <li
      className={cn(
        'grid min-w-0 grid-cols-[3.5rem_minmax(0,1fr)] gap-x-4 gap-y-3 rounded-tile border border-line p-4',
        'md:grid-cols-[4.5rem_minmax(0,1fr)_auto] md:gap-x-6 md:p-5',
        off ? 'bg-surface' : 'bg-bg',
      )}
      data-testid="kit-line"
      data-state={off ? 'unavailable' : 'ok'}
    >
      <PartTile
        name={`${group.role} ${main?.name ?? ''}`}
        size="sm"
        className="md:row-span-2 md:size-18 md:rounded-tile"
      />
      <div className="min-w-0 self-center">
        {/* h3 under the kit's h2: a screen reader steps line to line. */}
        <h3 className="text-[1.0625rem] leading-snug font-bold wrap-anywhere lg:text-[1.125rem]">
          {group.role}
        </h3>
        {!choice && main ? (
          <p className="mt-0.5 text-small font-normal text-muted wrap-anywhere">
            {partTitle(main)}
          </p>
        ) : null}
      </div>
      {choice ? (
        <ChoiceLine group={group} kitSlug={kitSlug} />
      ) : main ? (
        <SingleLine option={main} />
      ) : null}
    </li>
  );
}

export function KitSection({
  view,
  orderingOpen,
  phone,
  notice,
}: {
  view: KitView;
  /** The checkout gate is open: «Весь набор в корзину»; otherwise the phone. */
  orderingOpen: boolean;
  phone: string | null;
  /** A note about this kit after a post (`?kit=changed` …). */
  notice?: ReactNode;
}) {
  const { kit } = view;
  const formId = `kit-form-${kit.slug}`;
  const titleId = `kit-title-${kit.slug}`;
  const choices = view.groups.filter((group) => group.options.length > 1);
  // What does not change with the choices: the lines without one.
  const fixed = view.groups
    .filter((group) => group.options.length <= 1)
    .flatMap((group) => group.options.filter((option) => option.offer !== null));
  const fixedKop = fixed.reduce((sum, option) => sum + (option.offer?.lineTotalKop ?? 0), 0);
  const positions = view.groups.filter((group) => group.chosen !== null).length;
  const latest = fixed
    .map((option) => option.offer!)
    .sort((a, b) => (a.etaDate < b.etaDate ? 1 : a.etaDate > b.etaDate ? -1 : 0))[0];
  const canTake = view.groups.some((group) => group.chosen !== null);
  return (
    <section
      id={kit.slug}
      aria-labelledby={titleId}
      className="min-w-0 scroll-mt-28"
      data-testid="kit-section"
      data-kit={kit.id}
    >
      <div aria-hidden className="relative h-1.5">
        <div className="h-px bg-line" />
        <div className="absolute top-0 left-0 h-1.5 w-24 bg-brand" />
      </div>
      <h2 id={titleId} className="mt-5 text-h2 text-balance md:mt-6" data-testid="kit-title">
        {view.title}
      </h2>
      <p className="mt-3 flex flex-wrap items-center gap-2">
        <Badge tone="plain" icon={<IconCalendar size={16} className="shrink-0 text-brand" />}>
          {view.years}
        </Badge>
      </p>
      {kit.demo ? (
        <Notice tone="wait" className="mt-4" role="note" data-testid="kit-demo-label">
          {KIT_DEMO_LABEL}
        </Notice>
      ) : null}
      {notice ? <div className="mt-4">{notice}</div> : null}

      <form
        id={formId}
        method="post"
        action={KIT_CART_PATH}
        className="mt-5 grid min-w-0 gap-6 lg:grid-cols-[minmax(0,1fr)_22rem] lg:items-start lg:gap-8"
        data-testid="kit-form"
      >
        <input type="hidden" name="kit" value={kit.id} />
        <input type="hidden" name="version" value={kit.version} />
        <ul className="flex min-w-0 flex-col gap-3" data-testid="kit-lines">
          {view.groups.map((group) => (
            <KitLine key={group.mainLineId} group={group} kitSlug={kit.slug} />
          ))}
        </ul>

        <div className="min-w-0 space-y-4 lg:sticky lg:top-28">
          <div className="min-w-0 rounded-panel bg-surface p-6" data-testid="kit-summary">
            <p className="text-body font-semibold text-muted">
              Весь набор: {positions} {plural(positions, 'позиция', 'позиции', 'позиций')}
            </p>
            <Price size="lg" className="mt-1 block" data-testid="kit-total">
              {view.totalText}
            </Price>
            {view.promiseText ? (
              <p className="mt-3 flex items-start gap-2 text-body" data-testid="kit-promise">
                <IconCalendar size={22} className="mt-0.5 shrink-0 text-brand" />
                <span>
                  Получение{' '}
                  <span className="font-bold whitespace-nowrap" data-kit-promise="">
                    {view.promiseText}
                  </span>
                </span>
              </p>
            ) : null}
            <div className="mt-5">
              {canTake && orderingOpen ? (
                <button
                  type="submit"
                  className={buttonClass({ variant: 'primary', size: 'lg', block: true })}
                  data-testid="kit-add"
                >
                  <IconCart size={22} />
                  Весь набор в корзину
                </button>
              ) : canTake && phone ? (
                <a
                  href={telHref(phone)}
                  className={buttonClass({ variant: 'secondary', size: 'lg', block: true })}
                  data-testid="kit-call"
                >
                  <IconPhone size={20} className="text-brand" />
                  Заказать по телефону
                </a>
              ) : null}
            </div>
            {view.unavailable > 0 ? (
              <p className="mt-3 text-small font-normal text-muted" data-testid="kit-skip-note">
                {KIT_UNAVAILABLE_TEXT}: {view.unavailable}{' '}
                {plural(view.unavailable, 'позиция', 'позиции', 'позиций')} — в корзину не{' '}
                {plural(view.unavailable, 'попадёт', 'попадут', 'попадут')}.
              </p>
            ) : null}
            {view.supplierFailed ? (
              <p className="mt-2 text-small font-normal text-muted">
                Поставщик ответил не по всем позициям — обновите страницу через минуту.
              </p>
            ) : null}
            {canTake && orderingOpen ? (
              <p className="mt-4 flex items-start gap-2 text-small" data-testid="kit-fit-hint">
                <IconShield size={20} className="mt-0.5 shrink-0 text-brand" />
                <span>{KIT_FIT_HINT}</span>
              </p>
            ) : null}
          </div>
          <ul className="space-y-3 px-1 text-small font-normal">
            <li className="flex items-start gap-2" data-testid="kit-oil">
              <IconOil size={20} className="mt-0.5 shrink-0 text-brand" />
              <span>{KIT_OIL_TEXT}.</span>
            </li>
            {view.installText ? (
              <li className="flex items-start gap-2" data-testid="kit-install">
                <IconWrench size={20} className="mt-0.5 shrink-0 text-brand" />
                <span>{view.installText}.</span>
              </li>
            ) : null}
          </ul>
        </div>
      </form>
      {choices.length > 0 ? (
        <KitChoiceSync
          formId={formId}
          base={{
            kop: fixedKop,
            eta: latest?.etaDate ?? null,
            promise: latest?.promiseText ?? null,
          }}
        />
      ) : null}
    </section>
  );
}
