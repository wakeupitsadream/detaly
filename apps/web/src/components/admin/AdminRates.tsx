/**
 * /admin/month/rates (step 7, docs/month-close.md): the editor of settings contract.rates — a
 * price per operation of the pickup point contract and a percentage of the turnover. A GET form
 * makes the draft; the preview shows the act of the chosen month with the current and the draft
 * rates; «Сохранить ставки» posts the draft behind a «подтверждаю» tick to the audited settings
 * writer. Plain forms, no client JavaScript.
 */
import {
  ACT_OPERATIONS,
  ACT_OPERATION_TITLES,
  formatBpPercent,
  formatRub,
  monthTitle,
  rateOf,
  sameContractRates,
  type ActSummary,
} from '@detaly/domain';
import Link from 'next/link';
import { CONFIRM_FIELD, CONFIRM_VALUE } from '@/server/admin/destructive';
import {
  kopField,
  percentInputValue,
  rateField,
  rubInputValue,
  STORAGE_FIELD,
  TURNOVER_BP_FIELD,
  TURNOVER_FIELD,
  type AdminRatesData,
} from '@/server/admin/month';
import {
  BUTTON,
  DataTable,
  Done,
  INPUT,
  Notice,
  PhoneLine,
  Section,
  SECONDARY,
  Td,
} from './finance-ui';
import { dateTime } from './format';

function lineOf(summary: ActSummary, key: string) {
  return summary.lines.find((line) => line.key === key) ?? null;
}

export function AdminRates({ data, done }: { data: AdminRatesData; done: string | null }) {
  const { rates, draft, current, preview, month } = data;
  const storageOn = draft ? draft.storage : rateOf(rates, 'store_day') !== null;
  const changed = draft?.rates ? !sameContractRates(rates, draft.rates) : false;
  const keys = [
    ...ACT_OPERATIONS.filter(
      (operation) =>
        lineOf(current, operation) !== null || (preview && lineOf(preview, operation) !== null),
    ),
    ...(lineOf(current, 'turnover') || (preview && lineOf(preview, 'turnover'))
      ? ['turnover']
      : []),
  ];

  return (
    <div className="flex min-w-0 flex-col gap-4" data-testid="admin-rates">
      <div className="flex min-w-0 flex-col gap-3">
        <h1 className="text-2xl font-bold">Ставки договора с пунктом выдачи</h1>
        <p className="text-sm text-muted">
          Цена каждой операции из договора и процент с оборота (от продаж выданных заказов). Пусто —
          0 ₽. Ставки одни для всех месяцев: акт любого месяца считается по текущим.
        </p>
        <Done message={done} />
      </div>

      <Section title="Ставки" testId="rates-editor">
        <form method="get" action="/admin/month/rates" className="flex min-w-0 flex-col gap-3">
          <input type="hidden" name="draft" value="1" />
          <input type="hidden" name="m" value={month} />
          {ACT_OPERATIONS.map((operation) => {
            const name = rateField(operation);
            const field = draft?.fields[name];
            const rate = rateOf(rates, operation);
            const value = field ? field.text : rate === null ? '' : rubInputValue(rate);
            const { title, unit } = ACT_OPERATION_TITLES[operation];
            return (
              <div
                key={operation}
                className="grid grid-cols-[minmax(0,1fr)_7rem] items-center gap-x-3 gap-y-1 border-b border-line pb-3 last:border-0 sm:grid-cols-[minmax(0,1fr)_8rem_4rem]"
                data-testid="rates-row"
                data-op={operation}
              >
                <div className="min-w-0">
                  <label htmlFor={name}>
                    {title}
                    <span className="block text-xs text-muted sm:hidden">₽/{unit}</span>
                  </label>
                  {operation === 'store_day' ? (
                    <label className="mt-1 flex items-center gap-2 text-sm text-muted">
                      <input
                        type="checkbox"
                        name={STORAGE_FIELD}
                        value="on"
                        defaultChecked={storageOn}
                      />
                      оплачивается по договору
                    </label>
                  ) : null}
                </div>
                <input
                  id={name}
                  name={name}
                  defaultValue={value}
                  placeholder="0"
                  inputMode="decimal"
                  autoComplete="off"
                  maxLength={12}
                  aria-invalid={field?.error ? true : undefined}
                  className={`${INPUT} w-full text-right ${field?.error ? 'border-danger' : ''}`}
                />
                <span className="hidden text-sm text-muted sm:block">₽/{unit}</span>
                {field?.error ? (
                  <span className="col-span-full text-xs text-danger" data-testid="rates-error">
                    {field.error}
                  </span>
                ) : null}
              </div>
            );
          })}
          <div className="grid grid-cols-[minmax(0,1fr)_7rem] items-center gap-x-3 gap-y-1 sm:grid-cols-[minmax(0,1fr)_8rem_4rem]">
            <label htmlFor={TURNOVER_FIELD}>
              Процент с оборота
              <span className="block text-xs text-muted sm:hidden">%</span>
            </label>
            <input
              id={TURNOVER_FIELD}
              name={TURNOVER_FIELD}
              defaultValue={
                draft?.fields[TURNOVER_FIELD]?.text ??
                (rates.turnoverBp > 0 ? percentInputValue(rates.turnoverBp) : '')
              }
              placeholder="0"
              inputMode="decimal"
              autoComplete="off"
              maxLength={6}
              aria-invalid={draft?.fields[TURNOVER_FIELD]?.error ? true : undefined}
              className={`${INPUT} w-full text-right ${draft?.fields[TURNOVER_FIELD]?.error ? 'border-danger' : ''}`}
            />
            <span className="hidden text-sm text-muted sm:block">%</span>
            {draft?.fields[TURNOVER_FIELD]?.error ? (
              <span className="col-span-full text-xs text-danger" data-testid="rates-error">
                {draft.fields[TURNOVER_FIELD].error}
              </span>
            ) : null}
          </div>
          <div className="flex flex-wrap gap-3">
            <button type="submit" className={BUTTON}>
              Показать акт с этими ставками
            </button>
            <Link href={`/admin/month?m=${month}`} className={SECONDARY}>
              К закрытию месяца
            </Link>
          </div>
        </form>
        <p className="mt-3 text-xs text-muted">
          {data.updatedAt
            ? `Сейчас: изменено ${dateTime(data.updatedAt)} (${data.updatedBy ?? '—'}).`
            : 'Ставки ещё не задавали.'}
        </p>
      </Section>

      {draft && draft.rates === null ? (
        <p className="font-semibold text-danger" data-testid="rates-draft-invalid">
          Исправьте отмеченные значения — предпросмотр появится после этого.
        </p>
      ) : null}

      <Section title={`Акт за ${monthTitle(month)}`} testId="rates-preview">
        {!current.ratesSet && !preview ? (
          <div className="mb-3">
            <Notice tone="warn">Ставки не заданы: акт сейчас выходит на 0 ₽.</Notice>
          </div>
        ) : null}
        <DataTable
          head={preview ? ['Услуга', 'Кол-во', 'Сейчас', 'Станет'] : ['Услуга', 'Кол-во', 'Сумма']}
          numeric={preview ? [1, 2, 3] : [1, 2]}
          desktop={[1]}
          testId="rates-preview-lines"
        >
          {keys.map((key) => {
            const now = lineOf(current, key);
            const next = preview ? lineOf(preview, key) : null;
            const any = now ?? next;
            if (any === null) return null;
            const quantity =
              key === 'turnover'
                ? `от ${formatRub(current.turnoverBaseKop)}`
                : `${any.quantity} ${any.unit}`;
            return (
              <tr key={key} className="border-b border-line last:border-0" data-op={key}>
                <Td>
                  {key === 'turnover' ? 'Процент с оборота' : any.title}
                  <PhoneLine>{quantity}</PhoneLine>
                </Td>
                <Td numeric desktop>
                  {quantity}
                </Td>
                <Td numeric>{now ? formatRub(now.sumKop) : '—'}</Td>
                {preview ? <Td numeric>{next ? formatRub(next.sumKop) : '—'}</Td> : null}
              </tr>
            );
          })}
          <tr className="border-t-2 border-line-strong font-semibold">
            <Td>Итого</Td>
            <Td numeric desktop />
            <Td numeric>
              <span data-testid="rates-total-now">{formatRub(current.totalKop)}</span>
            </Td>
            {preview ? (
              <Td numeric>
                <span data-testid="rates-total-draft">{formatRub(preview.totalKop)}</span>
              </Td>
            ) : null}
          </tr>
        </DataTable>
        {preview && draft?.rates ? (
          changed ? (
            <form
              method="post"
              action="/api/admin/month"
              className="mt-4 flex flex-wrap items-center gap-3"
              data-testid="rates-save"
            >
              <input type="hidden" name="action" value="rates" />
              <input type="hidden" name="month" value={month} />
              <input type="hidden" name="version" value={data.version} />
              {draft.storage ? <input type="hidden" name={STORAGE_FIELD} value="on" /> : null}
              {ACT_OPERATIONS.map((operation) => {
                const rate = rateOf(draft.rates!, operation);
                return rate === null ? null : (
                  <input
                    key={operation}
                    type="hidden"
                    name={kopField(operation)}
                    value={String(rate)}
                  />
                );
              })}
              <input
                type="hidden"
                name={TURNOVER_BP_FIELD}
                value={String(draft.rates.turnoverBp)}
              />
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" name={CONFIRM_FIELD} value={CONFIRM_VALUE} required />
                подтверждаю: акты всех месяцев пересчитаются по новым ставкам
              </label>
              <button type="submit" className={BUTTON}>
                Сохранить ставки
              </button>
            </form>
          ) : (
            <p className="mt-3 text-sm text-muted" data-testid="rates-no-changes">
              Изменений нет — это текущие ставки
              {draft.rates.turnoverBp > 0
                ? ` (с оборота ${formatBpPercent(draft.rates.turnoverBp)})`
                : ''}
              .
            </p>
          )
        ) : null}
      </Section>
    </div>
  );
}
