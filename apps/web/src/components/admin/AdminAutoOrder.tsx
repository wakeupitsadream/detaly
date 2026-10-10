/**
 * /admin/auto-order (step 8, docs/rossko-automation.md): the shadow auto-order. At every
 * «Проверить и заказать» the system decides what an automatic order would have done; here — for
 * the last 30 and 90 days — how many decisions, how often the master did the same, why the
 * shadow said «НЕТ», and one plain verdict line. No switch: the real auto-order is the founder's
 * decision (PLAN decision 7), this page only gives him the data.
 */
import {
  AUTO_ORDER_REASONS,
  AUTO_ORDER_VERDICT_MIN_AGREEMENT_PCT,
  AUTO_ORDER_VERDICT_MIN_DECISIONS,
  autoOrderReasonText,
  formatRub,
  sharePercent,
  type AutoOrderVerdictKind,
} from '@detaly/domain';
import Link from 'next/link';
import type { ReactNode } from 'react';
import type {
  AdminAutoOrderData,
  AutoOrderDecisionRow,
  AutoOrderPeriod,
} from '@/server/admin/auto-order';
import { DataTable, OrderLink, PhoneLine, Td } from './finance-ui';
import { dateTime } from './format';

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

const VERDICT_TONE: Record<AutoOrderVerdictKind, string> = {
  few: 'border-line-strong bg-paper-2 text-ink',
  early: 'border-warn bg-warn-soft text-warn',
  discuss: 'border-local bg-local-soft text-local',
};

/** «ДА» / «НЕТ — <причины>» of one decision, the limit as it was then. */
function decisionText(row: AutoOrderDecisionRow): string {
  if (row.decision === 'yes') return 'ДА';
  const reasons = row.reasons.map((reason) =>
    autoOrderReasonText(reason, { maxTotalKop: row.maxTotalKop }),
  );
  return reasons.length === 0 ? 'НЕТ' : `НЕТ — ${reasons.join(', ')}`;
}

/** «38% (5)»; «—» for an empty whole. */
function share(part: number, whole: number): string {
  const percent = sharePercent(part, whole);
  return percent === null ? '—' : `${percent}% (${part})`;
}

function PeriodBlock({ period, maxTotalKop }: { period: AutoOrderPeriod; maxTotalKop: number }) {
  const { stats } = period;
  return (
    <div className="flex min-w-0 flex-col gap-3" data-testid={`auto-order-${period.days}`}>
      <h3 className="font-semibold">За {period.days} дней</h3>
      <p
        className={`rounded-md border px-3 py-2 font-semibold ${VERDICT_TONE[period.verdict.kind]}`}
        data-testid={`auto-order-verdict-${period.days}`}
        data-kind={period.verdict.kind}
      >
        {period.verdict.text}
      </p>
      <dl className="grid min-w-0 grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
        <dt>Решений тени</dt>
        <dd className="tabular-nums" data-testid={`auto-order-decisions-${period.days}`}>
          {stats.decisions} (ДА {stats.yes}, НЕТ {stats.no})
        </dd>
        <dt>Мастер сделал так же</dt>
        <dd className="tabular-nums" data-testid={`auto-order-agreements-${period.days}`}>
          {share(stats.agreements, stats.decisions)}
        </dd>
        <dt>«ДА», а мастер не заказал</dt>
        <dd className="tabular-nums">{stats.yesNotOrdered}</dd>
        <dt>«НЕТ», а мастер заказал</dt>
        <dd className="tabular-nums">{stats.noButOrdered}</dd>
      </dl>
      <div className="min-w-0 overflow-x-auto">
        <table
          className="w-full text-left text-sm"
          data-testid={`auto-order-reasons-${period.days}`}
        >
          <thead>
            <tr className="border-b border-line-strong">
              <th className="py-2 pr-2 font-semibold">Почему «НЕТ»</th>
              <th className="py-2 text-right font-semibold whitespace-nowrap">Сколько раз</th>
            </tr>
          </thead>
          <tbody>
            {AUTO_ORDER_REASONS.map((reason) => (
              <tr key={reason} className="border-b border-line last:border-0">
                <td className="py-2 pr-2">{autoOrderReasonText(reason, { maxTotalKop })}</td>
                <td
                  className="py-2 text-right tabular-nums"
                  data-testid={`auto-order-reason-${reason}-${period.days}`}
                >
                  {stats.reasons[reason]}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function AdminAutoOrder({ data }: { data: AdminAutoOrderData }) {
  return (
    <div className="flex min-w-0 flex-col gap-4" data-testid="admin-auto-order">
      <Section title="Теневой автозаказ" testId="auto-order-intro">
        <p className="text-sm">
          При каждом «Проверить и заказать» после перепроверки система решает, заказал бы автозаказ
          сам или нет, и пишет это в карточку заказа строкой «Автозаказ бы: ДА / НЕТ — причина».
          Заказывает по-прежнему мастер. «Мастер сделал так же» — после «ДА» заказ ушёл поставщику
          (сразу или «Заказать всё равно»), после «НЕТ» — не ушёл как был. Обсуждать настоящий
          автозаказ можно от {AUTO_ORDER_VERDICT_MIN_DECISIONS} решений и{' '}
          {AUTO_ORDER_VERDICT_MIN_AGREEMENT_PCT}% совпадений; переключателя здесь нет — это решение
          фаундера. Порог суммы — {formatRub(data.maxTotalKop)} (
          <Link href="/admin/rossko" className="text-accent underline">
            настройки Rossko
          </Link>
          ).
        </p>
      </Section>

      <Section title="Статистика" testId="auto-order-stats">
        <div className="grid min-w-0 gap-6 md:grid-cols-2">
          {data.periods.map((period) => (
            <PeriodBlock key={period.days} period={period} maxTotalKop={data.maxTotalKop} />
          ))}
        </div>
      </Section>

      <Section title="Последние решения" testId="auto-order-recent">
        {data.recent.length === 0 ? (
          <p className="text-muted" data-testid="auto-order-empty">
            Решений пока не было: они появятся, когда мастер нажмёт «Проверить и заказать».
          </p>
        ) : (
          // A phone shows the order and the decision; the time and the master go under the number.
          <DataTable
            head={['Заказ', 'Когда', 'Автозаказ бы', 'Мастер']}
            desktop={[1, 3]}
            testId="auto-order-recent-table"
          >
            {data.recent.map((row) => {
              const master = row.masterOrdered ? 'заказал' : 'не заказал';
              return (
                <tr
                  key={row.eventId}
                  className="border-b border-line last:border-0"
                  data-testid="auto-order-row"
                >
                  <Td className="whitespace-nowrap">
                    <OrderLink orderId={row.orderId} number={row.orderNumber} />
                    <PhoneLine>{dateTime(row.at)}</PhoneLine>
                    <PhoneLine>мастер {master}</PhoneLine>
                  </Td>
                  <Td desktop className="whitespace-nowrap tabular-nums">
                    {dateTime(row.at)}
                  </Td>
                  <Td className="wrap-anywhere">{decisionText(row)}</Td>
                  <Td desktop className="whitespace-nowrap">
                    {master}
                  </Td>
                </tr>
              );
            })}
          </DataTable>
        )}
      </Section>
    </div>
  );
}
