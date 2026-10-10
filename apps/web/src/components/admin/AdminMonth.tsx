/**
 * /admin/month (step 7, docs/month-close.md): the close of a month for the founder — revenue by
 * receipts, the margin, the act of the pickup point, the YooKassa reconciliation, the money that
 * is not income and the contract rates. Plain links and forms, no client JavaScript. Facts and
 * where to look only: no tax amount, no advice.
 */
import {
  ACT_OPERATIONS,
  ACT_OPERATION_TITLES,
  formatBpPercent,
  formatMarginBp,
  formatRub,
  monthTitle,
  PRICE_GROUP_LABELS,
  rateOf,
  type ReconDiff,
  type ReconDiffResult,
} from '@detaly/domain';
import type { ReconciliationSnapshot } from '@detaly/orders';
import Link from 'next/link';
import type { AdminMonthData } from '@/server/admin/month';
import {
  BUTTON,
  DataTable,
  Done,
  INPUT,
  Money,
  Notice,
  OrderLink,
  PhoneLine,
  Section,
  SECONDARY,
  shortDate,
  Td,
} from './finance-ui';
import { dateTime } from './format';

const LINK = 'text-accent underline';

/** Payment and refund statuses in the staff's words (as stored on both sides). */
const STATUS_WORDS: Record<string, string> = {
  pending: 'в ожидании',
  waiting_for_capture: 'ждёт подтверждения',
  succeeded: 'прошёл',
  canceled: 'отменён',
  failed: 'не прошёл',
};

function statusWord(status: string): string {
  return STATUS_WORDS[status] ?? status;
}

const DIFF_LABELS: Record<ReconDiff['kind'], string> = {
  missing_in_db: 'Есть в ЮKassa, нет в базе',
  missing_at_provider: 'Есть в базе, нет в ЮKassa',
  amount: 'Сумма не совпала',
  status: 'Статус не совпал',
};

function MonthSwitcher({ data }: { data: AdminMonthData }) {
  return (
    <nav
      className="flex flex-wrap items-center gap-x-4 gap-y-2"
      aria-label="Другой месяц"
      data-testid="month-switcher"
    >
      {data.prev ? (
        <Link href={`/admin/month?m=${data.prev}`} className={LINK}>
          ← {monthTitle(data.prev)}
        </Link>
      ) : null}
      {data.next ? (
        <Link href={`/admin/month?m=${data.next}`} className={LINK}>
          {monthTitle(data.next)} →
        </Link>
      ) : null}
      <form method="get" action="/admin/month" className="flex items-center gap-2">
        <label className="flex items-center gap-2 text-sm">
          <span className="text-muted">Месяц</span>
          <input
            type="month"
            name="m"
            defaultValue={data.month}
            className={`${INPUT} w-40`}
            aria-label="Месяц, ГГГГ-ММ"
          />
        </label>
        <button type="submit" className={SECONDARY}>
          Открыть
        </button>
      </form>
    </nav>
  );
}

function Revenue({ data }: { data: AdminMonthData }) {
  const { revenue } = data.report;
  const row = (label: string, count: number, kop: number, note?: string) => (
    <tr className="border-b border-line last:border-0">
      <Td>
        {label}
        {note ? <span className="block text-xs text-muted">{note}</span> : null}
      </Td>
      <Td numeric>{count}</Td>
      <Td numeric>
        <Money kop={kop} />
      </Td>
    </tr>
  );
  return (
    <Section title="Выручка по чекам" testId="month-revenue">
      <p className="mb-3 text-sm text-muted">
        Считаем по чекам: деньги предоплаты — в день чека предоплаты, оплата при получении — в день
        чека полного расчёта, возвраты уменьшают. Чек зачёта предоплаты при выдаче новых денег не
        приносит.
      </p>
      <DataTable head={['Чеки', 'Шт.', 'Сумма']} numeric={[1, 2]}>
        {row('Предоплата 100%', revenue.prepayment.count, revenue.prepayment.amountKop)}
        {row('Полный расчёт при получении', revenue.full.count, revenue.full.amountKop)}
        {row('Возвраты покупателям', revenue.refunds.count, -revenue.refunds.amountKop)}
        <tr className="border-t-2 border-line-strong font-semibold">
          <Td>Итого по чекам</Td>
          <Td numeric>{null}</Td>
          <Td numeric>
            <span data-testid="month-revenue-total">
              <Money kop={revenue.totalKop} strong />
            </span>
          </Td>
        </tr>
      </DataTable>
      <ul className="mt-3 flex flex-col gap-1 text-sm text-muted">
        <li>
          Зачёт предоплаты при выдаче: {revenue.offset.count} на{' '}
          {formatRub(revenue.offset.amountKop)} — не добавляется к итогу.
        </li>
        {revenue.corrections > 0 ? <li>Чеков коррекции: {revenue.corrections}.</li> : null}
        <li>
          Возвраты денег покупателям прошли: {revenue.refundsSucceeded.count} на{' '}
          {formatRub(revenue.refundsSucceeded.amountKop)}.
        </li>
        <li>Выдано заказов: {revenue.handedOrders}.</li>
      </ul>
    </Section>
  );
}

function Margin({ data }: { data: AdminMonthData }) {
  const { margin } = data.report;
  const { totals } = margin;
  const line = (label: string, kop: number, testId?: string) => (
    <div className="flex items-baseline justify-between gap-3 border-b border-line py-1.5 last:border-0">
      <dt>{label}</dt>
      <dd data-testid={testId}>
        <Money kop={kop} />
      </dd>
    </div>
  );
  return (
    <Section title="Маржа" testId="month-margin">
      <p className="mb-3 text-sm text-muted">
        По позициям заказов, выданных в месяце, по ценам заказа: цена покупателю − закупка у Rossko
        − эквайринг (оценка {formatBpPercent(margin.acquiringBp)}, точная комиссия — в реестре
        ЮKassa) − доставка Rossko.
      </p>
      {totals.items === 0 ? (
        <p className="text-sm text-muted" data-testid="month-margin-empty">
          В этом месяце выданных заказов нет.
        </p>
      ) : (
        <div className="grid min-w-0 gap-4 lg:grid-cols-2">
          <dl className="min-w-0 text-sm">
            {line('Продажи покупателям', totals.revenueKop)}
            {line('Закупка у Rossko', -totals.purchaseKop)}
            {line('Эквайринг (оценка)', -totals.acquiringKop)}
            {line('Доставка Rossko', -totals.deliveryKop)}
            <div className="flex items-baseline justify-between gap-3 pt-2 font-semibold">
              <dt>Маржа</dt>
              <dd data-testid="month-margin-total">
                <Money kop={totals.marginKop} strong /> ({formatMarginBp(totals.marginBp)})
              </dd>
            </div>
          </dl>
          <DataTable
            head={['Группа', 'Позиций', 'Продажи', 'Маржа', '%']}
            numeric={[1, 2, 3, 4]}
            desktop={[1, 4]}
            testId="month-margin-groups"
          >
            {margin.groups.map((group) => (
              <tr key={group.group} className="border-b border-line last:border-0">
                <Td>
                  {PRICE_GROUP_LABELS[group.group]}
                  <PhoneLine>
                    {group.items} поз. · {formatMarginBp(group.marginBp)}
                  </PhoneLine>
                </Td>
                <Td numeric desktop>
                  {group.items}
                </Td>
                <Td numeric>
                  <Money kop={group.revenueKop} />
                </Td>
                <Td numeric>
                  <Money kop={group.marginKop} />
                </Td>
                <Td numeric desktop>
                  {formatMarginBp(group.marginBp)}
                </Td>
              </tr>
            ))}
          </DataTable>
        </div>
      )}
      {margin.negativeOrders.length > 0 ? (
        <div className="mt-4" data-testid="month-negative">
          <h3 className="mb-2 font-semibold text-danger">Заказы в минус</h3>
          <ul className="flex flex-col gap-1 text-sm">
            {margin.negativeOrders.map((order) => (
              <li key={order.orderId}>
                <OrderLink orderId={order.orderId} number={order.orderNumber} />: продажи{' '}
                <Money kop={order.revenueKop} />, маржа <Money kop={order.marginKop} />
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </Section>
  );
}

function Act({ data, contractMissing }: { data: AdminMonthData; contractMissing: string[] }) {
  const { act, month } = data.report;
  const { summary } = act;
  return (
    <Section
      title="Акт для пункта выдачи"
      testId="month-act"
      aside={
        <span className="flex flex-wrap gap-x-4 gap-y-1">
          <Link href={`/admin/month/act?m=${month}`} className={LINK} data-testid="month-act-print">
            Печатная форма
          </Link>
          <a
            href={`/api/admin/month/csv?m=${month}`}
            className={LINK}
            download={`act-${month}.csv`}
            data-testid="month-act-csv"
          >
            Скачать CSV
          </a>
          <Link href={`/admin/month/rates?m=${month}`} className={LINK}>
            Ставки договора
          </Link>
        </span>
      }
    >
      {!summary.ratesSet ? (
        <div className="mb-3">
          <Notice tone="warn" testId="month-rates-unset">
            Ставки не заданы: операции посчитаны, но акт выйдет на 0 ₽.{' '}
            <Link href={`/admin/month/rates?m=${month}`} className="underline">
              Задать ставки договора
            </Link>
          </Notice>
        </div>
      ) : null}
      {contractMissing.length > 0 ? (
        <div className="mb-3">
          <Notice tone="info" testId="month-contract-missing">
            Реквизиты для акта не заданы в env: {contractMissing.join(', ')}. В печатной форме будут
            пустые строки.
          </Notice>
        </div>
      ) : null}
      <DataTable
        head={['Услуга', 'Кол-во', 'Ставка', 'Сумма']}
        numeric={[1, 2, 3]}
        desktop={[1, 2]}
        testId="month-act-lines"
      >
        {summary.lines.map((line) => (
          <tr key={line.key} className="border-b border-line last:border-0" data-op={line.key}>
            <Td>
              {line.title}
              {line.key === 'turnover' ? null : (
                <PhoneLine>
                  {line.quantity} {line.unit} × {formatRub(line.rateKop)}
                </PhoneLine>
              )}
            </Td>
            <Td numeric desktop>
              {line.quantity} {line.unit}
            </Td>
            <Td numeric desktop>
              {formatRub(line.rateKop)}
            </Td>
            <Td numeric>{formatRub(line.sumKop)}</Td>
          </tr>
        ))}
        <tr className="border-t-2 border-line-strong font-semibold">
          <Td>Итого по акту</Td>
          <Td numeric desktop />
          <Td numeric desktop />
          <Td numeric>
            <span data-testid="month-act-total">{formatRub(summary.totalKop)}</span>
          </Td>
        </tr>
      </DataTable>
      <details className="mt-3 text-sm text-muted">
        <summary className="cursor-pointer">Откуда цифры</summary>
        <ul className="mt-2 flex list-disc flex-col gap-1 pl-5">
          <li>Приёмка — отметки «Приехало» по позициям в журнале заказа.</li>
          <li>
            Хранение — сутки с приезда заказа до выдачи (или до отказа, неявки); заказ ещё в точке —
            до сегодняшнего дня.
          </li>
          <li>Выдача — «Выдал» в журнале заказа.</li>
          <li>Приём возврата — «Принял возврат» по претензии.</li>
          <li>Подбор по VIN — отправленные мастером предложения по заявкам.</li>
          <li>Проверка применимости — ответы мастера по проверкам подбора.</li>
          <li>Диагностика — решения по претензиям «брак» и «не подошло».</li>
          <li>Процент с оборота — от продаж выданных в месяце заказов.</li>
        </ul>
      </details>
    </Section>
  );
}

function DiffBlock({ title, diff }: { title: string; diff: ReconDiffResult | null }) {
  if (diff === null) {
    return (
      <p className="text-sm text-danger">
        {title}: список ЮKassa не получен, сравнение не сделано.
      </p>
    );
  }
  return (
    <div className="min-w-0">
      <p className="text-sm">
        <span className="font-semibold">{title}:</span> в базе {diff.dbCount}, в ЮKassa{' '}
        {diff.providerCount}, совпало {diff.matched}, расхождений{' '}
        <span className={diff.differences.length > 0 ? 'font-semibold text-danger' : ''}>
          {diff.differences.length}
        </span>
      </p>
      {diff.differences.length > 0 ? (
        <div className="mt-2">
          <DataTable
            head={['Что', 'Заказ', 'ID в ЮKassa', 'В базе', 'В ЮKassa']}
            numeric={[3, 4]}
            desktop={[1, 2]}
            testId="month-recon-diffs"
          >
            {diff.differences.map((item) => (
              <tr key={`${item.kind}:${item.id}`} className="border-b border-line last:border-0">
                <Td>
                  {DIFF_LABELS[item.kind] ?? item.kind}
                  <PhoneLine>
                    {item.label ? `${item.label} · ` : ''}
                    <span className="font-mono break-all">{item.id}</span>
                  </PhoneLine>
                </Td>
                <Td desktop>{item.label ?? '—'}</Td>
                <Td desktop className="font-mono text-xs break-all">
                  {item.id}
                </Td>
                <Td numeric>
                  {item.dbAmountKop !== null ? formatRub(item.dbAmountKop) : '—'}
                  {item.dbStatus ? (
                    <span className="block text-xs text-muted">{statusWord(item.dbStatus)}</span>
                  ) : null}
                </Td>
                <Td numeric>
                  {item.providerAmountKop !== null ? formatRub(item.providerAmountKop) : '—'}
                  {item.providerStatus ? (
                    <span className="block text-xs text-muted">
                      {statusWord(item.providerStatus)}
                    </span>
                  ) : null}
                </Td>
              </tr>
            ))}
          </DataTable>
        </div>
      ) : null}
    </div>
  );
}

function Reconciliation({ data }: { data: AdminMonthData }) {
  const snapshot: ReconciliationSnapshot | null = data.reconciliation;
  return (
    <Section title="Сверка с ЮKassa" testId="month-recon">
      <p className="mb-3 text-sm text-muted">
        Платежи и возвраты месяца из ЮKassa против базы: по ID, сумме и статусу. Результат каждой
        сверки сохраняется.
      </p>
      <form
        method="post"
        action="/api/admin/month"
        className="mb-3 flex flex-wrap items-center gap-3"
      >
        <input type="hidden" name="action" value="reconcile" />
        <input type="hidden" name="month" value={data.month} />
        <button
          type="submit"
          className={BUTTON}
          disabled={!data.paymentsConfigured}
          data-testid="month-reconcile"
        >
          Сверить
        </button>
        {!data.paymentsConfigured ? (
          <span className="text-sm text-muted">ЮKassa не подключена (YOOKASSA_*).</span>
        ) : null}
      </form>
      {snapshot === null ? (
        <p className="text-sm text-muted" data-testid="month-recon-none">
          Сверку за {monthTitle(data.month)} ещё не запускали.
        </p>
      ) : (
        <div className="flex min-w-0 flex-col gap-3" data-testid="month-recon-result">
          <p className="text-sm text-muted">
            Последняя сверка: {dateTime(snapshot.createdAt)} ({snapshot.createdBy})
          </p>
          {snapshot.result.errors.length > 0 ? (
            <Notice tone="danger" testId="month-recon-errors">
              <ul className="flex flex-col gap-1">
                {snapshot.result.errors.map((error) => (
                  <li key={error}>{error}</li>
                ))}
              </ul>
            </Notice>
          ) : null}
          <DiffBlock title="Платежи" diff={snapshot.result.payments} />
          <DiffBlock title="Возвраты" diff={snapshot.result.refunds} />
        </div>
      )}
    </Section>
  );
}

function NotIncome({ data }: { data: AdminMonthData }) {
  const { supplierRefunds } = data.report;
  return (
    <Section title="Не доход (сверить с банком)" testId="month-not-income">
      <p className="mb-3 text-sm text-muted">
        Деньги, которые Rossko вернул за возвращённые детали, — возврат оплаты поставщику, а не
        выручка. Найдите их в выписке и отметьте по правилам вашего банка.
      </p>
      {supplierRefunds.rows.length === 0 ? (
        <p className="text-sm text-muted" data-testid="month-not-income-empty">
          В этом месяце денег от Rossko за возвраты не отмечено.
        </p>
      ) : (
        <DataTable
          head={['Заказ', 'Дата', 'Деталь', 'Сумма']}
          numeric={[3]}
          desktop={[1]}
          testId="month-not-income-rows"
        >
          {supplierRefunds.rows.map((row) => (
            <tr key={row.id} className="border-b border-line last:border-0">
              <Td>
                <OrderLink orderId={row.orderId} number={row.orderNumber} />
                <PhoneLine>{dateTime(row.refundedAt)}</PhoneLine>
              </Td>
              <Td desktop className="whitespace-nowrap">
                {dateTime(row.refundedAt)}
              </Td>
              <Td className="wrap-anywhere">
                {row.brand} {row.article} × {row.qty}
              </Td>
              <Td numeric>{formatRub(row.amountReceivedKop ?? 0)}</Td>
            </tr>
          ))}
          <tr className="border-t-2 border-line-strong font-semibold">
            <Td>Итого</Td>
            <Td desktop />
            <Td />
            <Td numeric>{formatRub(supplierRefunds.totalKop)}</Td>
          </tr>
        </DataTable>
      )}
      <h3 className="mt-4 mb-2 font-semibold">Сверка с банком</h3>
      <ul className="flex flex-col gap-2 text-sm" data-testid="month-bank-checklist">
        {[
          'Поступления от ЮKassa за месяц совпадают с реестром выплат в личном кабинете ЮKassa.',
          'Возвраты от Rossko из списка выше отмечены в банке как возврат денег поставщиком, не как выручка — сверьте по правилам вашего банка.',
          'Оплаты Rossko за детали и оплата пункту выдачи по акту видны в выписке с понятным назначением платежа.',
          'Сроки отчётов и платежей сверьте с банком и ФНС; срок уплаты налога АУСН — до 25-го числа следующего месяца.',
        ].map((text) => (
          <li key={text} className="flex gap-2">
            <span
              aria-hidden
              className="mt-0.5 inline-block size-4 shrink-0 rounded border border-line-strong"
            />
            <span>{text}</span>
          </li>
        ))}
      </ul>
    </Section>
  );
}

function Rates({ data }: { data: AdminMonthData }) {
  const { settings } = data.report;
  const parts = ACT_OPERATIONS.flatMap((operation) => {
    const rate = rateOf(settings.rates, operation);
    if (rate === null) return [];
    const { title, unit } = ACT_OPERATION_TITLES[operation];
    return [{ title, value: `${formatRub(rate)}/${unit}` }];
  });
  parts.push({
    title: 'Процент с оборота',
    value: formatBpPercent(settings.rates.turnoverBp),
  });
  return (
    <Section
      title="Ставки договора"
      testId="month-rates"
      aside={
        <Link href={`/admin/month/rates?m=${data.month}`} className={LINK}>
          Изменить ставки
        </Link>
      }
    >
      <ul className="grid gap-x-8 gap-y-1 text-sm sm:grid-cols-2">
        {parts.map((part) => (
          <li
            key={part.title}
            className="flex items-baseline justify-between gap-3 border-b border-line py-1"
          >
            <span>{part.title}</span>
            <span className="whitespace-nowrap tabular-nums">{part.value}</span>
          </li>
        ))}
      </ul>
      <p className="mt-2 text-xs text-muted">
        {settings.ratesUpdatedAt
          ? `Изменено ${dateTime(settings.ratesUpdatedAt)} (${settings.ratesUpdatedBy ?? '—'}).`
          : 'Ставки ещё не задавали.'}{' '}
        Ставки одни для всех месяцев: распечатанный акт храните у себя.
      </p>
    </Section>
  );
}

export function AdminMonth({
  data,
  done,
  contractMissing,
}: {
  data: AdminMonthData;
  done: string | null;
  contractMissing: string[];
}) {
  return (
    <div className="flex min-w-0 flex-col gap-4" data-testid="admin-month" data-month={data.month}>
      <div className="flex min-w-0 flex-col gap-3">
        <h1 className="text-2xl font-bold">Закрытие месяца: {monthTitle(data.month)}</h1>
        <MonthSwitcher data={data} />
        {data.running ? (
          <Notice tone="info" testId="month-running">
            Месяц ещё идёт: цифры растут до {shortDate(data.report.bounds.lastDay)} включительно.
          </Notice>
        ) : null}
        <Done message={done} />
      </div>
      <Revenue data={data} />
      <Margin data={data} />
      <Act data={data} contractMissing={contractMissing} />
      <Reconciliation data={data} />
      <NotIncome data={data} />
      <Rates data={data} />
    </div>
  );
}
