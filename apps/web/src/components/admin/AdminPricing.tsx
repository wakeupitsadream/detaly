/**
 * /admin/pricing (step 2, docs/pricing.md): the base markup table (view only), the floor and the
 * ceiling, the editor of group adjustments (a GET form: the draft goes to the preview), the
 * preview of the draft on three recent comparisons with «Сохранить поправки» behind a
 * «подтверждаю» tick, and the audit of past changes. Plain forms, no client JavaScript.
 */
import {
  formatBpPercent,
  formatPercentPoints,
  formatRub,
  groupAdjustmentOf,
  PRICE_GROUP_LABELS,
  PRICE_GROUPS,
  type BenchmarkGroupStats,
  type GroupAdjustment,
  type PriceGroup,
} from '@detaly/domain';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { CONFIRM_FIELD, CONFIRM_VALUE } from '@/server/admin/destructive';
import {
  bpField,
  draftField,
  sameAdjustments,
  type AdminPricingData,
  type PricingAuditRow,
} from '@/server/admin/pricing';
import { dateTime } from './format';
import { deltaInputValue, hintText, hintTone, rangeLabel } from './price-format';

const BUTTON =
  'rounded-md bg-accent px-4 py-2 font-semibold text-white hover:bg-accent-strong min-h-11';
const INPUT =
  'w-full min-w-0 rounded-md border border-line-strong bg-card px-2 py-2 text-right tabular-nums';
/** Columns of the preview from `lg`: position, wholesale, competitor, now, new. */
const EXAMPLE_GRID = 'lg:grid-cols-[minmax(0,1.6fr)_repeat(4,minmax(0,1fr))]';
/** Columns of the editor from `sm`: group, Orenburg, to order, hint. */
const EDITOR_GRID = 'sm:grid-cols-[minmax(0,12rem)_6.5rem_6.5rem_minmax(0,1fr)]';

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
  testId,
}: {
  label: string;
  children: ReactNode;
  testId?: string;
}) {
  return (
    <div className="min-w-0 whitespace-nowrap" data-testid={testId}>
      <span className="block text-xs whitespace-normal text-muted lg:hidden">{label}</span>
      {children}
    </div>
  );
}

function deltaOf(list: readonly GroupAdjustment[], group: PriceGroup, side: 'local' | 'order') {
  const adjustment = groupAdjustmentOf(list, group);
  return side === 'local' ? adjustment.localDeltaBp : adjustment.orderDeltaBp;
}

function adjustmentsText(list: readonly GroupAdjustment[] | null): string {
  if (list === null) return 'не читается';
  if (list.length === 0) return 'без поправок';
  return list
    .map(
      (a) =>
        `${PRICE_GROUP_LABELS[a.group]} ${formatPercentPoints(a.localDeltaBp)} / ${formatPercentPoints(a.orderDeltaBp)}`,
    )
    .join(', ');
}

function Hint({ stats }: { stats: BenchmarkGroupStats | undefined }) {
  if (!stats) return <span className="text-muted">нет сравнений</span>;
  return (
    <>
      {(['local', 'order'] as const).map((side) => {
        const { hint, compared } = stats[side];
        const tone = hintTone(hint);
        const color =
          tone === 'raise' ? 'text-local' : tone === 'lower' ? 'text-danger' : 'text-muted';
        return (
          <span key={side} className={`block ${color}`} data-side={side} data-hint={hint.kind}>
            {side === 'local' ? 'Оренбург' : 'заказ'}:{' '}
            {compared === 0 ? 'нет сравнений' : hintText(hint)}
          </span>
        );
      })}
    </>
  );
}

function AuditList({ rows }: { rows: PricingAuditRow[] }) {
  if (rows.length === 0) {
    return (
      <p className="text-muted" data-testid="pricing-audit-empty">
        Поправки ещё не меняли.
      </p>
    );
  }
  return (
    <ul className="flex flex-col gap-2 text-sm">
      {rows.map((row) => (
        <li key={row.id} className="wrap-anywhere" data-testid="pricing-audit-row">
          <span className="font-semibold">{dateTime(row.changedAt)}</span>{' '}
          <span className="text-muted">({row.changedBy})</span>: {adjustmentsText(row.oldValue)} →{' '}
          {adjustmentsText(row.newValue)}
        </li>
      ))}
    </ul>
  );
}

export function AdminPricing({ data, done }: { data: AdminPricingData; done: string | null }) {
  const { config, bounds, draft, draftConfig } = data;
  const rules = [...config.markupRules].sort((a, b) => a.fromKop - b.fromKop);
  const reportByGroup = new Map(data.report.map((stats) => [stats.group, stats]));
  const changed =
    draftConfig !== null && !sameAdjustments(config.groupAdjustments, draftConfig.groupAdjustments);

  return (
    <div className="flex min-w-0 flex-col gap-4" data-testid="admin-pricing">
      {done ? (
        <p
          className="rounded-card border border-local bg-local-soft px-4 py-2 text-local"
          role="status"
          data-testid="admin-done"
        >
          {done}
        </p>
      ) : null}

      <Section title="Базовая наценка" testId="pricing-base">
        <div className="min-w-0 overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-line text-muted">
              <tr>
                <th className="px-3 py-2 font-medium">Закупка</th>
                <th className="px-3 py-2 font-medium">В Оренбурге</th>
                <th className="px-3 py-2 font-medium">Под заказ</th>
              </tr>
            </thead>
            <tbody>
              {rules.map((rule) => (
                <tr key={rule.fromKop} className="border-b border-line last:border-0">
                  <td className="px-3 py-2 whitespace-nowrap">{rangeLabel(rule)}</td>
                  <td className="px-3 py-2">{formatBpPercent(rule.localBp)}</td>
                  <td className="px-3 py-2">{formatBpPercent(rule.orderBp)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="mt-2 text-xs text-muted">
          Только просмотр (настройка pricing.markup_rules). Цена клиенту = закупка × (1 + наценка),
          вверх до рубля.
        </p>
      </Section>

      <Section title="Пол и потолок" testId="pricing-bounds">
        <p className="text-sm">
          Поправка не опустит наценку ниже{' '}
          <span className="font-semibold">{formatBpPercent(bounds.minMarkupBp)}</span> и не поднимет
          выше <span className="font-semibold">{formatBpPercent(bounds.maxMarkupBp)}</span>.
        </p>
        <p className="mt-1 text-xs text-muted">
          Пол — большее из {formatBpPercent(bounds.configuredMinBp)} (pricing.min_markup_bp) и{' '}
          {formatBpPercent(bounds.marginFloorMarkupBp)}: ниже маржа меньше{' '}
          {String(data.marginFloorPct).replace('.', ',')}% и «Заказать всё равно» недоступна.
          Потолок — pricing.max_markup_bp.
        </p>
      </Section>

      <Section title="Поправки по группам" testId="pricing-editor">
        <p className="mb-3 text-sm text-muted">
          Наценка = базовая + поправка группы, в п.п. (+3 — на 3 процентных пункта выше, −1,5 —
          ниже). Пусто — без поправки. Подсказки — из{' '}
          <Link href="/admin/prices" className="text-accent underline">
            сравнения цен
          </Link>{' '}
          за {data.reportDays} дней.
        </p>
        <form method="get" action="/admin/pricing" className="flex min-w-0 flex-col gap-2">
          <input type="hidden" name="draft" value="1" />
          <div
            className={`hidden gap-x-3 text-sm text-muted sm:grid ${EDITOR_GRID}`}
            aria-hidden="true"
          >
            <span>Группа</span>
            <span className="text-right">В Оренбурге</span>
            <span className="text-right">Под заказ</span>
            <span>Подсказка</span>
          </div>
          {PRICE_GROUPS.map((group) => (
            <div
              key={group}
              className={`grid grid-cols-[minmax(0,1fr)_5.5rem_5.5rem] items-start gap-x-3 gap-y-1 border-b border-line py-2 last:border-0 ${EDITOR_GRID}`}
              data-testid="pricing-group"
              data-group={group}
            >
              <span className="self-center font-semibold">{PRICE_GROUP_LABELS[group]}</span>
              {(['local', 'order'] as const).map((side) => {
                const name = draftField(side, group);
                const field = draft?.fields[name];
                const value = field
                  ? field.text
                  : deltaInputValue(deltaOf(config.groupAdjustments, group, side));
                return (
                  <label key={side} className="flex min-w-0 flex-col gap-1">
                    <span className="sr-only">
                      {PRICE_GROUP_LABELS[group]}, {side === 'local' ? 'в Оренбурге' : 'под заказ'}
                    </span>
                    <span className="text-xs text-muted sm:hidden">
                      {side === 'local' ? 'Оренбург' : 'Под заказ'}
                    </span>
                    <input
                      name={name}
                      defaultValue={value}
                      placeholder="0"
                      inputMode="decimal"
                      autoComplete="off"
                      maxLength={8}
                      aria-invalid={field?.error ? true : undefined}
                      className={`${INPUT} ${field?.error ? 'border-danger' : ''}`}
                    />
                    {field?.error ? (
                      <span className="text-xs text-danger" data-testid="pricing-field-error">
                        {field.error}
                      </span>
                    ) : null}
                  </label>
                );
              })}
              <span className="col-span-3 text-xs sm:col-span-1 sm:self-center">
                <Hint stats={reportByGroup.get(group)} />
              </span>
            </div>
          ))}
          <div>
            <button type="submit" className={BUTTON}>
              Показать, как изменятся цены
            </button>
          </div>
        </form>
      </Section>

      {draft && draftConfig === null ? (
        <p className="font-semibold text-danger" data-testid="pricing-draft-invalid">
          Исправьте отмеченные значения — предпросмотр появится после этого.
        </p>
      ) : null}

      {draftConfig ? (
        <Section title="Предпросмотр" testId="pricing-preview">
          {changed ? (
            <ul className="mb-3 flex flex-col gap-1 text-sm" data-testid="pricing-changes">
              {PRICE_GROUPS.flatMap((group) =>
                (['local', 'order'] as const).flatMap((side) => {
                  const before = deltaOf(config.groupAdjustments, group, side);
                  const after = deltaOf(draftConfig.groupAdjustments, group, side);
                  if (before === after) return [];
                  return [
                    <li key={`${group}:${side}`}>
                      {PRICE_GROUP_LABELS[group]}, {side === 'local' ? 'в Оренбурге' : 'под заказ'}:{' '}
                      {formatPercentPoints(before)} → <b>{formatPercentPoints(after)}</b> п.п.
                    </li>,
                  ];
                }),
              )}
            </ul>
          ) : (
            <p className="mb-3 text-sm text-muted" data-testid="pricing-no-changes">
              Изменений нет — это текущие поправки.
            </p>
          )}

          {data.examples.length === 0 ? (
            <p className="text-sm text-muted" data-testid="pricing-no-examples">
              Пока нет сравнений с нашей ценой — внесите их на странице{' '}
              <Link href="/admin/prices" className="text-accent underline">
                «Цены»
              </Link>
              .
            </p>
          ) : (
            <ul className="flex min-w-0 flex-col">
              <li
                className={`hidden gap-x-3 border-b border-line pb-2 text-sm text-muted lg:grid ${EXAMPLE_GRID}`}
                aria-hidden="true"
              >
                <span>Позиция</span>
                <span>Закупка</span>
                <span>Конкурент с доставкой</span>
                <span>Сейчас</span>
                <span>Станет</span>
              </li>
              {data.examples.map((example) => {
                const delta = example.draft.priceClientKop - example.current.priceClientKop;
                return (
                  <li
                    key={example.id}
                    className={`grid grid-cols-2 gap-x-3 gap-y-2 border-b border-line py-3 text-sm last:border-0 lg:items-start ${EXAMPLE_GRID}`}
                    data-testid="pricing-example"
                    data-group={example.group}
                  >
                    <div className="col-span-2 min-w-0 wrap-anywhere lg:col-span-1">
                      <span className="font-semibold">{example.title}</span>
                      <span className="block text-xs text-muted">
                        {PRICE_GROUP_LABELS[example.group]},{' '}
                        {example.isLocal ? 'в Оренбурге' : 'под заказ'}
                      </span>
                    </div>
                    <Cell label="Закупка">{formatRub(example.supplierKop)}</Cell>
                    <Cell label="Конкурент с доставкой">
                      {formatRub(example.competitorTotalKop)}
                    </Cell>
                    <Cell label="Сейчас" testId="pricing-example-now">
                      {formatRub(example.current.priceClientKop)}
                      <span className="block text-xs text-muted">
                        {formatBpPercent(example.current.markupBp)}
                      </span>
                    </Cell>
                    <Cell label="Станет" testId="pricing-example-new">
                      <span className="font-semibold">
                        {formatRub(example.draft.priceClientKop)}
                      </span>
                      {delta !== 0 ? (
                        <span className={delta > 0 ? 'text-local' : 'text-danger'}>
                          {' '}
                          ({delta > 0 ? '+' : '\u2212'}
                          {formatRub(Math.abs(delta))})
                        </span>
                      ) : null}
                      <span className="block text-xs text-muted">
                        {formatBpPercent(example.draft.markupBp)}
                      </span>
                    </Cell>
                  </li>
                );
              })}
            </ul>
          )}

          {changed ? (
            <form
              method="post"
              action="/api/admin/pricing"
              className="mt-4 flex flex-wrap items-center gap-3"
              data-testid="pricing-save"
            >
              <input type="hidden" name="action" value="save" />
              <input type="hidden" name="version" value={data.version} />
              {PRICE_GROUPS.flatMap((group) =>
                (['local', 'order'] as const).map((side) => (
                  <input
                    key={`${group}:${side}`}
                    type="hidden"
                    name={bpField(side, group)}
                    value={String(deltaOf(draftConfig.groupAdjustments, group, side))}
                  />
                )),
              )}
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" name={CONFIRM_FIELD} value={CONFIRM_VALUE} required />
                подтверждаю: цены на сайте изменятся сразу
              </label>
              <button type="submit" className={BUTTON}>
                Сохранить поправки
              </button>
            </form>
          ) : null}
        </Section>
      ) : null}

      <Section title="Журнал изменений" testId="pricing-audit">
        {data.updatedAt ? (
          <p className="mb-2 text-xs text-muted">
            Сейчас: {adjustmentsText(config.groupAdjustments)} · изменено {dateTime(data.updatedAt)}
            {data.updatedBy ? ` (${data.updatedBy})` : ''}
          </p>
        ) : null}
        <AuditList rows={data.audit} />
      </Section>
    </div>
  );
}
