/**
 * The printable act of the pickup point's services for a month (/admin/month/act, step 7,
 * docs/month-close.md): A4, «Акт № MM/YYYY от <last day>», the contract and the parties from env
 * (CONTRACT_*, SELLER_REQUISITES_*, CONTRACTOR_REQUISITES_*), a table of services with quantity,
 * price and sum, the total in figures and the signature lines. Services and quantities only: the
 * act never names a split of the seller's money. Missing requisites print as blank lines to fill
 * in by hand; the warnings about them stay on the screen (data-print-hide).
 */
import {
  actNumber,
  formatLongDate,
  formatRub,
  type ActSummary,
  type MonthBounds,
} from '@detaly/domain';
import type { ActContract, ActParty } from '@/server/admin/month';

const BLANK = '____________________';

/** A cell of the act's table: ruled on screen and on paper. */
const CELL = 'border border-ink px-2 py-1 align-top';
/** Columns a phone hides (their values go under the service name); shown from `sm` and printed. */
const WIDE_ONLY = 'hidden sm:table-cell print:table-cell';

const ACT_COLUMNS: { title: string; numeric?: boolean; phone?: boolean }[] = [
  { title: '№', phone: true },
  { title: 'Наименование услуги', phone: true },
  { title: 'Кол-во', numeric: true },
  { title: 'Ед.' },
  { title: 'Цена, ₽', numeric: true },
  { title: 'Сумма, ₽', numeric: true, phone: true },
];

/** Rubles with kopecks for the columns «Цена, ₽» and «Сумма, ₽»: 192000 -> «1 920,00». */
function amount(kop: number): string {
  const rest = kop % 100;
  const rub = String((kop - rest) / 100).replace(/\B(?=(\d{3})+(?!\d))/gu, '\u00a0');
  return `${rub},${String(rest).padStart(2, '0')}`;
}

function partyLine(party: ActParty): string {
  const parts = [
    party.name ?? BLANK,
    `ИНН ${party.inn ?? '____________'}`,
    party.ogrn ? `${party.ogrn.label} ${party.ogrn.value}` : null,
    party.address,
  ].filter((part): part is string => part !== null && part !== '');
  return parts.join(', ');
}

/** «Иванов И. И.» from a full name for the signature line; the name as is otherwise. */
function signatureName(party: ActParty): string {
  if (!party.name) return '____________';
  const words = party.name
    .replace(/^ИП\s+/u, '')
    .trim()
    .split(/\s+/u);
  if (words.length === 3 && words.every((word) => /^\p{Lu}/u.test(word))) {
    return `${words[0]} ${words[1]?.charAt(0)}. ${words[2]?.charAt(0)}.`;
  }
  return '____________';
}

export function AdminAct({
  month,
  bounds,
  act,
  contract,
}: {
  month: string;
  bounds: Pick<MonthBounds, 'firstDay' | 'lastDay'>;
  act: ActSummary;
  contract: ActContract;
}) {
  const contractText = contract.number
    ? `по договору № ${contract.number}${contract.date ? ` от ${formatLongDate(contract.date)}` : ''}`
    : 'по договору № ______ от «___» ____________ 20__ г.';
  const quantity = act.lines.reduce(
    (sum, line) => sum + (line.key === 'turnover' ? 0 : line.quantity),
    0,
  );
  return (
    <>
      {/* The paper of the print dialog; inline styles are allowed by the CSP. */}
      <style>{'@page { size: A4 portrait; margin: 15mm; }'}</style>
      <article
        className="mx-auto w-full max-w-[210mm] rounded-card border border-line bg-white px-4 py-6 text-[13px] leading-snug text-ink sm:px-10 sm:py-10 print:max-w-none print:rounded-none print:border-0 print:p-0 print:text-[10.5pt]"
        data-testid="act-print"
        data-month={month}
      >
        <h1 className="text-center text-lg font-bold print:text-[14pt]" data-testid="act-title">
          Акт № {actNumber(month)} от {formatLongDate(bounds.lastDay)}
        </h1>
        <p className="mt-1 text-center">об оказании услуг {contractText}</p>
        <p className="mt-1 text-center text-muted print:text-ink">
          Период: с {formatLongDate(bounds.firstDay)} по {formatLongDate(bounds.lastDay)}
        </p>

        <dl className="mt-6 flex flex-col gap-2" data-testid="act-parties">
          <div>
            <dt className="inline font-semibold">Исполнитель: </dt>
            <dd className="inline wrap-anywhere">{partyLine(contract.contractor)}</dd>
          </div>
          <div>
            <dt className="inline font-semibold">Заказчик: </dt>
            <dd className="inline wrap-anywhere">{partyLine(contract.customer)}</dd>
          </div>
        </dl>

        <div className="mt-5">
          <table className="w-full border-collapse text-left" data-testid="act-table">
            <thead>
              <tr>
                {ACT_COLUMNS.map((column) => (
                  <th
                    key={column.title}
                    className={`${CELL} font-semibold ${column.numeric ? 'text-right whitespace-nowrap' : ''} ${column.phone ? '' : WIDE_ONLY}`}
                  >
                    {column.title}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {act.lines.map((line, index) => (
                <tr key={line.key} data-op={line.key}>
                  <td className={CELL}>{index + 1}</td>
                  <td className={CELL}>
                    {line.title}
                    {/* A phone shows the columns it hides under the name; paper never does. */}
                    {line.key === 'turnover' ? null : (
                      <span className="mt-0.5 block text-xs text-muted sm:hidden print:hidden">
                        {line.quantity} {line.unit} × {amount(line.rateKop)}
                      </span>
                    )}
                  </td>
                  <td className={`${CELL} text-right tabular-nums ${WIDE_ONLY}`}>
                    {line.quantity}
                  </td>
                  <td className={`${CELL} ${WIDE_ONLY}`}>{line.unit}</td>
                  <td className={`${CELL} text-right whitespace-nowrap tabular-nums ${WIDE_ONLY}`}>
                    {amount(line.rateKop)}
                  </td>
                  <td className={`${CELL} text-right whitespace-nowrap tabular-nums`}>
                    {amount(line.sumKop)}
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <td className={CELL} />
                <td className={`${CELL} text-right font-semibold`}>Итого:</td>
                <td className={`${CELL} ${WIDE_ONLY}`} />
                <td className={`${CELL} ${WIDE_ONLY}`} />
                <td className={`${CELL} ${WIDE_ONLY}`} />
                <td
                  className={`${CELL} text-right font-semibold whitespace-nowrap tabular-nums`}
                  data-testid="act-total"
                >
                  {amount(act.totalKop)}
                </td>
              </tr>
            </tfoot>
          </table>
        </div>

        <p className="mt-4" data-testid="act-summary">
          Всего оказано услуг на сумму {formatRub(act.totalKop)} (операций за месяц: {quantity}).
        </p>
        <p className="mt-2">
          Услуги оказаны полностью и в срок. Заказчик претензий по объёму, качеству и срокам
          оказания услуг не имеет.
        </p>

        <div
          className="mt-10 grid grid-cols-1 gap-8 sm:grid-cols-2 print:grid-cols-2"
          data-testid="act-signatures"
        >
          {(
            [
              ['Исполнитель', contract.contractor],
              ['Заказчик', contract.customer],
            ] as const
          ).map(([role, party]) => (
            <div key={role} className="flex flex-col gap-6">
              <p className="font-semibold">{role}</p>
              <p className="wrap-anywhere">{party.name ?? BLANK}</p>
              <p className="whitespace-nowrap">______________ / {signatureName(party)} /</p>
              <p className="text-xs text-muted print:text-ink">М. П. (при наличии)</p>
            </div>
          ))}
        </div>
      </article>
    </>
  );
}
