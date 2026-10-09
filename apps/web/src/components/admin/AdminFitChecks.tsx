/**
 * /admin/fit-checks (step 4, docs/fit-check.md): the statistics of the last 7 and 30 days, the
 * SLA of the master (settings `fit_check.sla_minutes`, saved with an audit row) and the latest
 * requests with the status of every line, who answered and when. A line still waiting can be
 * answered here too (the fallback when Telegram is down). Plain forms, no client JavaScript. No
 * VIN and no comment: the master sees them in the bot card only.
 */
import {
  FIT_CHECK_SLA_MAX_MINUTES,
  FIT_CHECK_SLA_MIN_MINUTES,
  FIT_CHECK_STATUS_LABELS,
  sharePercent,
  type FitCheckStats,
  type FitCheckStatus,
} from '@detaly/domain';
import type { ReactNode } from 'react';
import type { AdminFitChecksData, AdminFitLine, AdminFitRequest } from '@/server/admin/fit-checks';
import { dateTime } from './format';

const BUTTON =
  'inline-flex min-h-11 items-center rounded-md bg-accent px-4 py-2 font-semibold text-white hover:bg-accent-strong';
const SECONDARY =
  'inline-flex min-h-11 items-center rounded-md border border-line-strong bg-card px-3 py-2 text-sm font-semibold hover:border-ink';
const INPUT =
  'w-full min-w-0 rounded-md border border-line-strong bg-card px-3 py-2 tabular-nums min-h-11';

const ACTION = '/api/admin/fit-checks';

const STATUS_TONE: Record<FitCheckStatus, string> = {
  pending: 'bg-warn-soft text-warn',
  fits: 'bg-local-soft text-local',
  analog: 'bg-order-soft text-order',
  not_fit: 'bg-accent-soft text-accent',
  call_needed: 'bg-warn-soft text-warn',
  expired: 'bg-paper-2 text-muted',
  cancelled: 'bg-paper-2 text-muted',
};

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

/** «38% (5)»; «—» for an empty whole. */
function share(part: number, whole: number): string {
  const percent = sharePercent(part, whole);
  return percent === null ? '—' : `${percent}% (${part})`;
}

function minutesText(minutes: number | null): string {
  if (minutes === null) return '—';
  if (minutes < 60) return `${minutes} мин`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours} ч` : `${hours} ч ${rest} мин`;
}

const STAT_ROWS: readonly {
  label: string;
  value: (stats: FitCheckStats) => string;
  testId: string;
}[] = [
  { label: 'Заявок', value: (s) => String(s.requests), testId: 'requests' },
  { label: 'Деталей', value: (s) => String(s.lines), testId: 'lines' },
  { label: 'Подходит', value: (s) => share(s.byStatus.fits, s.lines), testId: 'fits' },
  { label: 'Аналог', value: (s) => share(s.byStatus.analog, s.lines), testId: 'analog' },
  { label: 'Не подходит', value: (s) => share(s.byStatus.not_fit, s.lines), testId: 'not_fit' },
  {
    label: 'Нужен звонок',
    value: (s) => share(s.byStatus.call_needed, s.lines),
    testId: 'call_needed',
  },
  {
    label: 'Не успели ответить',
    value: (s) => share(s.byStatus.expired, s.lines),
    testId: 'expired',
  },
  {
    label: 'Медиана ответа (рабочее время)',
    value: (s) => minutesText(s.medianAnswerMinutes),
    testId: 'median',
  },
  { label: 'Ответили в срок', value: (s) => share(s.withinSla, s.answered), testId: 'sla' },
  {
    label: 'Проверенные детали в оплаченных заказах',
    value: (s) => share(s.checkedPaid, s.checked),
    testId: 'paid',
  },
];

function StatsTable({ data }: { data: AdminFitChecksData }) {
  return (
    <div className="min-w-0 overflow-x-auto">
      <table className="w-full text-left text-sm" data-testid="fit-stats">
        <thead>
          <tr className="border-b border-line-strong">
            <th className="py-2 pr-1 font-semibold">Показатель</th>
            {data.stats.map((block) => (
              <th key={block.days} className="py-2 pl-3 text-right font-semibold whitespace-nowrap">
                {block.days} дней
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {STAT_ROWS.map((row) => (
            <tr key={row.testId} className="border-b border-line last:border-0">
              <td className="py-2 pr-1">{row.label}</td>
              {data.stats.map((block) => (
                <td
                  key={block.days}
                  className="py-2 pl-3 text-right tabular-nums whitespace-nowrap"
                  data-testid={`fit-stat-${row.testId}-${block.days}`}
                >
                  {row.value(block.stats)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function AnswerButton({
  line,
  answer,
  label,
}: {
  line: AdminFitLine;
  answer: 'fits' | 'not_fit' | 'call_needed';
  label: string;
}) {
  return (
    <form method="post" action={ACTION}>
      <input type="hidden" name="action" value="answer" />
      <input type="hidden" name="id" value={line.id} />
      <input type="hidden" name="answer" value={answer} />
      <button type="submit" className={SECONDARY} data-testid={`fit-admin-${answer}`}>
        {label}
      </button>
    </form>
  );
}

function LineAnswers({ line }: { line: AdminFitLine }) {
  return (
    <div className="mt-2 flex min-w-0 flex-col gap-2" data-testid="fit-admin-answers">
      <div className="flex min-w-0 flex-wrap gap-2">
        <AnswerButton line={line} answer="fits" label="Подходит" />
        <AnswerButton line={line} answer="not_fit" label="Не подходит" />
        <AnswerButton line={line} answer="call_needed" label="Нужен звонок" />
      </div>
      <form method="post" action={ACTION} className="flex max-w-md min-w-0 flex-wrap gap-2">
        <input type="hidden" name="action" value="analog" />
        <input type="hidden" name="id" value={line.id} />
        <label className="sr-only" htmlFor={`fit-analog-${line.id}`}>
          Аналог: бренд и артикул
        </label>
        <input
          id={`fit-analog-${line.id}`}
          name="text"
          required
          maxLength={200}
          autoComplete="off"
          placeholder="БРЕНД АРТИКУЛ"
          className={`${INPUT} flex-1 basis-40`}
          data-testid="fit-admin-analog-text"
        />
        <button type="submit" className={SECONDARY} data-testid="fit-admin-analog">
          Аналог
        </button>
      </form>
    </div>
  );
}

function RequestCard({ request }: { request: AdminFitRequest }) {
  return (
    <li
      className="min-w-0 border-b border-line pb-4 last:border-0"
      data-testid="fit-admin-request"
      data-request={request.requestId}
      data-waiting={request.waiting ? 'yes' : 'no'}
    >
      <p className="font-semibold">
        № {request.number}{' '}
        <span className="font-normal text-muted">
          {dateTime(request.createdAt)}
          {request.waiting ? ` · ждёт ответа, до ${dateTime(request.expiresAt)}` : ''}
        </span>
      </p>
      <ol className="mt-2 flex min-w-0 flex-col gap-3">
        {request.lines.map((line) => (
          <li
            key={line.id}
            className="min-w-0 text-sm"
            data-testid="fit-admin-line"
            data-status={line.status}
          >
            <p className="wrap-anywhere">
              <span className="font-semibold">
                {line.n}. {line.brand} {line.article}
              </span>{' '}
              — {line.name}
            </p>
            <p className="mt-1 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
              <span
                className={`rounded-md px-2 py-0.5 text-xs font-semibold ${STATUS_TONE[line.status]}`}
              >
                {FIT_CHECK_STATUS_LABELS[line.status]}
              </span>
              {line.analog ? (
                <span className="wrap-anywhere">
                  → {line.analog.brand} {line.analog.article}
                </span>
              ) : null}
              {line.answeredAt ? (
                <span className="text-muted">
                  {line.answeredBy ?? '—'}, {dateTime(line.answeredAt)}
                </span>
              ) : null}
            </p>
            {line.status === 'pending' ? <LineAnswers line={line} /> : null}
          </li>
        ))}
      </ol>
    </li>
  );
}

export function AdminFitChecks({ data, done }: { data: AdminFitChecksData; done: string | null }) {
  return (
    <div className="flex min-w-0 flex-col gap-4" data-testid="admin-fit-checks">
      {done ? (
        <p
          className="rounded-card border border-local bg-local-soft px-4 py-2 text-local"
          role="status"
          data-testid="admin-done"
        >
          {done}
        </p>
      ) : null}

      <Section title="Статистика" testId="fit-stats-section">
        <StatsTable data={data} />
        <p className="mt-2 text-sm text-muted">
          Доли — от всех деталей за период; «в срок» — от отвеченных, не дольше {data.sla.minutes}{' '}
          мин рабочего времени; оплаченные — от деталей с ответом «подходит» или «аналог».
        </p>
      </Section>

      <Section title="Срок ответа мастера" testId="fit-sla">
        <form
          method="post"
          action={ACTION}
          className="flex min-w-0 flex-wrap items-end gap-3"
          data-testid="fit-sla-form"
        >
          <input type="hidden" name="action" value="sla" />
          <input type="hidden" name="version" value={data.sla.version} />
          <label className="flex max-w-48 min-w-0 flex-col gap-1 text-sm">
            Минут рабочего времени
            <input
              name="minutes"
              type="number"
              required
              min={FIT_CHECK_SLA_MIN_MINUTES}
              max={FIT_CHECK_SLA_MAX_MINUTES}
              step={1}
              defaultValue={data.sla.minutes}
              inputMode="numeric"
              className={INPUT}
              data-testid="fit-sla-minutes"
            />
          </label>
          <button type="submit" className={BUTTON}>
            Сохранить
          </button>
        </form>
        <p className="mt-2 text-sm text-muted">
          Через этот срок без ответа в чат продавцов уходит одно напоминание. Клиенту обещаем «в
          течение часа» в часы работы пункта, иначе — к открытию.{' '}
          {data.scheduleKnown
            ? 'Считаются только часы работы пункта (PICKUP_HOURS).'
            : 'Часы работы пункта не заданы или не распознаны: считаются все минуты.'}
          {data.sla.updatedAt
            ? ` Изменено ${dateTime(data.sla.updatedAt)}${data.sla.updatedBy ? ` (${data.sla.updatedBy})` : ''}.`
            : ''}
        </p>
      </Section>

      <Section title="Заявки" testId="fit-requests">
        {data.requests.length === 0 ? (
          <p className="text-muted" data-testid="fit-requests-empty">
            Заявок на проверку пока не было.
          </p>
        ) : (
          <ul className="flex min-w-0 flex-col gap-4">
            {data.requests.map((request) => (
              <RequestCard key={request.requestId} request={request} />
            ))}
          </ul>
        )}
      </Section>
    </div>
  );
}
