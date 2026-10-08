/**
 * /admin/prices (step 2, docs/pricing.md): the weekly comparison with competitors. A form to
 * record one position (our own price is found by the server), the report per group over the
 * period with the hint for the group adjustment, and the latest records. Internal data only:
 * competitor prices are never shown to clients. Plain forms, no client JavaScript.
 *
 * The report and the list are rows of a CSS grid: a table from `lg` on, cards with a label per
 * value on a phone (no horizontal scrolling inside the cards).
 */
import {
  BENCHMARK_COMPETITORS,
  BENCHMARK_HINT_STEP_BP,
  BENCHMARK_MIN_POSITIONS,
  formatBpPercent,
  formatPercentPoints,
  formatRub,
  PRICE_GROUP_LABELS,
  PRICE_GROUPS,
  roundDiv,
  type BenchmarkGroupStats,
  type BenchmarkSideStats,
  type PricingConfig,
} from '@detaly/domain';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { CONFIRM_FIELD, CONFIRM_VALUE } from '@/server/admin/destructive';
import {
  COMPETITOR_LABELS,
  PRICE_PERIODS,
  PRICE_WEEK_TARGET,
  type AdminPriceRow,
  type AdminPricesData,
  type AdminPricesQuery,
} from '@/server/admin/prices';
import { dateTime } from './format';
import { etaDiffText, hintText, hintTone, signedPercent, signedRub } from './price-format';

const BUTTON =
  'min-h-11 rounded-md bg-accent px-4 py-2 font-semibold text-white hover:bg-accent-strong';
const SMALL_BUTTON =
  'min-h-9 rounded-md border border-line-strong bg-card px-3 py-1 text-sm font-semibold hover:border-ink';
const INPUT = 'w-full min-w-0 rounded-md border border-line-strong bg-card px-2 py-2';
const LABEL = 'flex min-w-0 flex-col gap-1 text-sm';

/** Columns of the report from `lg`: group, hint, positions, difference, cheaper, term, delta. */
const REPORT_GRID =
  'lg:grid-cols-[9rem_minmax(0,2.2fr)_5rem_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)_6rem]';
/** Columns of the list from `lg`: when, position, theirs, ours, difference, delete. */
const LIST_GRID =
  'lg:grid-cols-[8.5rem_minmax(0,1.4fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)_7.5rem]';

function Section({
  title,
  children,
  testId,
}: {
  title: string;
  children: ReactNode;
  testId?: string;
}) {
  return (
    <section className="min-w-0 rounded-card border border-line bg-card p-4" data-testid={testId}>
      <h2 className="mb-3 text-lg font-semibold">{title}</h2>
      {children}
    </section>
  );
}

/** A value with its label above it on a phone (the header row names it from `lg` on). */
function Cell({
  label,
  children,
  className = '',
  testId,
}: {
  label: string;
  children: ReactNode;
  className?: string;
  testId?: string;
}) {
  return (
    <div className={`min-w-0 ${className}`} data-testid={testId}>
      <span className="block text-xs text-muted lg:hidden">{label}</span>
      {children}
    </div>
  );
}

function HeaderRow({ grid, labels }: { grid: string; labels: string[] }) {
  return (
    <div
      className={`hidden gap-x-3 border-b border-line pb-2 text-sm text-muted lg:grid ${grid}`}
      aria-hidden="true"
    >
      {labels.map((label, index) => (
        <span key={`${label}:${index}`}>{label}</span>
      ))}
    </div>
  );
}

function Diff({ kop, bp }: { kop: number | null; bp: number | null }) {
  if (kop === null || bp === null) return <span className="text-muted">—</span>;
  const tone = kop < 0 ? 'text-local' : kop > 0 ? 'text-danger' : '';
  return (
    <span className={`whitespace-nowrap ${tone}`}>
      {signedRub(kop)} <span className="text-xs">({signedPercent(bp)})</span>
    </span>
  );
}

function SideHint({ kind, side }: { kind: 'local' | 'order'; side: BenchmarkSideStats }) {
  const tone = hintTone(side.hint);
  const color = tone === 'raise' ? 'text-local' : tone === 'lower' ? 'text-danger' : 'text-muted';
  return (
    <span className="block" data-side={kind} data-hint={side.hint.kind}>
      <span className="text-muted">{kind === 'local' ? 'в Оренбурге' : 'под заказ'}:</span>{' '}
      {side.compared === 0 ? (
        <span className="text-muted">нет сравнений</span>
      ) : (
        <>
          <span className={`font-semibold ${color}`}>{hintText(side.hint)}</span>
          <span className="text-xs text-muted"> · поз.: {side.compared}</span>
        </>
      )}
    </span>
  );
}

function ReportRow({ stats }: { stats: BenchmarkGroupStats }) {
  return (
    <li
      className={`grid grid-cols-2 gap-x-3 gap-y-2 border-b border-line py-3 text-sm last:border-0 lg:items-start ${REPORT_GRID}`}
      data-testid="report-row"
      data-group={stats.group}
    >
      <span className="col-span-2 text-base font-semibold lg:col-span-1 lg:text-sm">
        {PRICE_GROUP_LABELS[stats.group]}
      </span>
      <Cell label="Подсказка" className="col-span-2 lg:col-span-1">
        <SideHint kind="local" side={stats.local} />
        <SideHint kind="order" side={stats.order} />
      </Cell>
      <Cell label="Позиций">
        {stats.compared}
        {stats.records > stats.compared ? (
          <span className="block text-xs text-muted">
            без нашей цены: {stats.records - stats.compared}
          </span>
        ) : null}
      </Cell>
      <Cell label="Разница">
        <Diff kop={stats.medianDiffKop} bp={stats.medianDiffBp} />
      </Cell>
      <Cell label="Мы дешевле">
        {stats.compared > 0
          ? `${stats.cheaper} из ${stats.compared} (${roundDiv(stats.cheaper * 100, stats.compared)}%)`
          : '—'}
      </Cell>
      <Cell label="Срок">{etaDiffText(stats.medianEtaDiffDays)}</Cell>
      <Cell label="Поправка, п.п.">
        {formatPercentPoints(stats.local.currentDeltaBp)} /{' '}
        {formatPercentPoints(stats.order.currentDeltaBp)}
      </Cell>
    </li>
  );
}

function RecordRow({ row, query }: { row: AdminPriceRow; query: AdminPricesQuery }) {
  const total = row.competitorPriceKop + row.competitorDeliveryKop;
  const competitor = COMPETITOR_LABELS[row.competitor];
  return (
    <li
      className={`grid grid-cols-2 gap-x-3 gap-y-2 border-b border-line py-3 text-sm last:border-0 lg:items-start ${LIST_GRID}`}
      data-testid="price-row"
      data-group={row.priceGroup}
      data-article={row.article}
    >
      <span className="col-span-2 order-2 text-xs text-muted lg:order-none lg:col-span-1 lg:text-sm lg:text-ink">
        {dateTime(row.capturedAt)}
      </span>
      <div className="col-span-2 order-1 min-w-0 wrap-anywhere lg:order-none lg:col-span-1">
        <span className="font-semibold">
          {row.brand} {row.article}
        </span>
        <span className="block text-xs text-muted">{PRICE_GROUP_LABELS[row.priceGroup]}</span>
        {row.note ? <span className="block text-xs text-muted">{row.note}</span> : null}
      </div>
      <Cell label="У них" className="order-3 lg:order-none" testId="price-row-theirs">
        <span className="whitespace-nowrap">{formatRub(total)}</span>{' '}
        {row.sourceUrl ? (
          <a
            href={row.sourceUrl}
            target="_blank"
            rel="noopener noreferrer nofollow"
            className="text-accent underline"
          >
            {competitor}
          </a>
        ) : (
          <span>{competitor}</span>
        )}
        {row.competitorDeliveryKop > 0 ? (
          <span className="block text-xs text-muted">
            {formatRub(row.competitorPriceKop)} + доставка {formatRub(row.competitorDeliveryKop)}
          </span>
        ) : null}
        {row.competitorEtaDays !== null ? (
          <span className="block text-xs text-muted">{row.competitorEtaDays} дн.</span>
        ) : null}
      </Cell>
      <Cell label="У нас" className="order-4 lg:order-none" testId="price-row-ours">
        {row.ourPriceKop !== null ? (
          <>
            <span className="whitespace-nowrap">{formatRub(row.ourPriceKop)}</span>
            <span className="block text-xs text-muted">
              {row.ourIsLocal ? 'в Оренбурге' : 'под заказ'}
              {row.ourEtaDays !== null ? `, ${row.ourEtaDays} дн.` : ''}
            </span>
          </>
        ) : (
          <span className="text-muted">нет у поставщика</span>
        )}
      </Cell>
      <Cell label="Разница" className="order-5 lg:order-none">
        <Diff kop={row.diff?.diffKop ?? null} bp={row.diff?.diffBp ?? null} />
      </Cell>
      <form
        method="post"
        action="/api/admin/prices"
        className="order-6 flex flex-wrap items-center gap-2 lg:order-none lg:flex-col lg:items-start lg:gap-1"
      >
        <input type="hidden" name="action" value="delete" />
        <input type="hidden" name="id" value={row.id} />
        <input type="hidden" name="back_group" value={query.group ?? ''} />
        <input type="hidden" name="back_days" value={String(query.days)} />
        <label className="flex items-center gap-1 text-xs text-muted">
          <input type="checkbox" name={CONFIRM_FIELD} value={CONFIRM_VALUE} required /> подтверждаю
        </label>
        <button type="submit" className={SMALL_BUTTON}>
          Удалить
        </button>
      </form>
    </li>
  );
}

export function AdminPrices({
  query,
  data,
  pricing,
  done,
}: {
  query: AdminPricesQuery;
  data: AdminPricesData;
  pricing: PricingConfig;
  done: string | null;
}) {
  const weekDone = data.lastWeek >= PRICE_WEEK_TARGET;
  return (
    <div className="flex min-w-0 flex-col gap-4" data-testid="admin-prices">
      <p className="text-sm text-muted">
        Внутренние данные: цены конкурентов клиентам не показываем. Раз в неделю внесите 20–30
        ходовых позиций — отчёт подскажет, где поправить наценку на странице{' '}
        <Link href="/admin/pricing" className="text-accent underline">
          «Наценка»
        </Link>
        .
      </p>
      {done ? (
        <p
          className="rounded-card border border-local bg-local-soft px-4 py-2 text-local"
          role="status"
          data-testid="admin-done"
        >
          {done}
        </p>
      ) : null}
      <p
        className={`text-sm font-semibold ${weekDone ? 'text-local' : 'text-warn'}`}
        data-testid="prices-week"
      >
        За 7 дней внесено: {data.lastWeek} из {PRICE_WEEK_TARGET}
      </p>

      <Section title="Записать сравнение" testId="prices-form">
        <form
          method="post"
          action="/api/admin/prices"
          className="grid min-w-0 gap-3 sm:grid-cols-2 lg:grid-cols-4"
        >
          <input type="hidden" name="action" value="record" />
          <input type="hidden" name="back_group" value={query.group ?? ''} />
          <input type="hidden" name="back_days" value={String(query.days)} />
          <label className={LABEL}>
            <span className="text-muted">Бренд</span>
            <input name="brand" required maxLength={64} autoComplete="off" className={INPUT} />
          </label>
          <label className={LABEL}>
            <span className="text-muted">Артикул</span>
            <input name="article" required maxLength={64} autoComplete="off" className={INPUT} />
          </label>
          <label className={LABEL}>
            <span className="text-muted">Где смотрели</span>
            <select name="competitor" required defaultValue="" className={INPUT}>
              <option value="" disabled>
                Выберите
              </option>
              {BENCHMARK_COMPETITORS.map((competitor) => (
                <option key={competitor} value={competitor}>
                  {COMPETITOR_LABELS[competitor]}
                </option>
              ))}
            </select>
          </label>
          <label className={LABEL}>
            <span className="text-muted">Цена, ₽</span>
            <input name="price" required inputMode="decimal" autoComplete="off" className={INPUT} />
          </label>
          <label className={LABEL}>
            <span className="text-muted">Доставка до Оренбурга, ₽</span>
            <input
              name="delivery"
              inputMode="decimal"
              placeholder="0 — самовывоз"
              autoComplete="off"
              className={INPUT}
            />
          </label>
          <label className={LABEL}>
            <span className="text-muted">Срок, дней</span>
            <input
              name="eta"
              inputMode="numeric"
              maxLength={3}
              autoComplete="off"
              className={INPUT}
            />
          </label>
          <label className={LABEL}>
            <span className="text-muted">Ссылка</span>
            <input name="url" type="url" maxLength={500} autoComplete="off" className={INPUT} />
          </label>
          <label className={LABEL}>
            <span className="text-muted">Заметка</span>
            <input name="note" maxLength={300} autoComplete="off" className={INPUT} />
          </label>
          <label className={`${LABEL} sm:col-span-2`}>
            <span className="text-muted">Группа, если у нас такой позиции нет</span>
            <select name="group" defaultValue="" className={INPUT}>
              <option value="">Определить по нашей позиции</option>
              {PRICE_GROUPS.map((group) => (
                <option key={group} value={group}>
                  {PRICE_GROUP_LABELS[group]}
                </option>
              ))}
            </select>
          </label>
          <div className="flex items-end sm:col-span-2">
            <button type="submit" className={BUTTON}>
              Записать
            </button>
          </div>
        </form>
        <p className="mt-3 text-xs text-muted">
          Нашу цену сервер найдёт сам: самое дешёвое точное предложение того же бренда и артикула с
          текущей наценкой. Цену конкурента пишите без доставки, доставку — отдельно.
        </p>
      </Section>

      <form
        method="get"
        action="/admin/prices"
        className="flex flex-wrap items-end gap-3 rounded-card border border-line bg-card p-4"
        data-testid="prices-filter"
      >
        <label className={LABEL}>
          <span className="text-muted">Период</span>
          <select name="days" defaultValue={String(query.days)} className={INPUT}>
            {PRICE_PERIODS.map((days) => (
              <option key={days} value={String(days)}>
                {days} дней
              </option>
            ))}
          </select>
        </label>
        <label className={LABEL}>
          <span className="text-muted">Группа в списке</span>
          <select name="group" defaultValue={query.group ?? ''} className={INPUT}>
            <option value="">Все группы</option>
            {PRICE_GROUPS.map((group) => (
              <option key={group} value={group}>
                {PRICE_GROUP_LABELS[group]}
              </option>
            ))}
          </select>
        </label>
        <button type="submit" className={BUTTON}>
          Показать
        </button>
      </form>

      <Section title={`Отчёт по группам за ${query.days} дней`} testId="prices-report">
        <p className="mb-3 text-sm text-muted">
          Разница — медиана «наша цена − (цена конкурента + доставка)». Подсказка: запас позиции —
          на сколько п.п. можно изменить нашу наценку, чтобы сравняться с конкурентом; берём медиану
          запаса по группе (от {BENCHMARK_MIN_POSITIONS} позиций, шаг{' '}
          {formatPercentPoints(BENCHMARK_HINT_STEP_BP).replace('+', '')} п.п.) — тогда мы не дороже
          конкурентов хотя бы в половине позиций. Поднимаем, только если везём не дольше; итог не
          ниже пола ({formatBpPercent(pricing.minMarkupBp)}) и не выше потолка (
          {formatBpPercent(pricing.maxMarkupBp)}). Ничего не применяется само.
        </p>
        {data.report.length === 0 ? (
          <p className="text-muted" data-testid="prices-report-empty">
            За период сравнений нет.
          </p>
        ) : (
          <>
            <HeaderRow
              grid={REPORT_GRID}
              labels={[
                'Группа',
                'Подсказка',
                'Позиций',
                'Разница',
                'Мы дешевле',
                'Срок',
                'Поправка, п.п.',
              ]}
            />
            <ul className="flex min-w-0 flex-col">
              {data.report.map((stats) => (
                <ReportRow key={stats.group} stats={stats} />
              ))}
            </ul>
          </>
        )}
        <p className="mt-2 text-xs text-muted">
          Поправка — «в Оренбурге / под заказ». Всего за период: {data.periodRecords}, с нашей
          ценой: {data.periodCompared}.
        </p>
      </Section>

      <Section title="Последние записи" testId="prices-list">
        {data.rows.length === 0 ? (
          <p className="text-muted" data-testid="prices-empty">
            Записей нет.
          </p>
        ) : (
          <>
            <HeaderRow
              grid={LIST_GRID}
              labels={['Когда', 'Позиция', 'У них', 'У нас', 'Разница', '']}
            />
            <ul className="flex min-w-0 flex-col">
              {data.rows.map((row) => (
                <RecordRow key={row.id} row={row} query={query} />
              ))}
            </ul>
          </>
        )}
        {data.truncated ? (
          <p className="mt-2 text-xs text-muted">Показаны последние 200 записей периода.</p>
        ) : null}
      </Section>
    </div>
  );
}
