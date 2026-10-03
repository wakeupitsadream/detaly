/**
 * /admin/vin/<id> (docs/phase-1c-implementation.md decision С26): the request with the full
 * phone, VIN, texts and photos (only here, never in a messenger), the master's answer as lines
 * -> «Проверить» -> the preview with an error per line -> «Отправить клиенту» (only without
 * errors) or «Исправить» -> «Закрыть». Plain forms, no client JavaScript.
 */
import { formatPromise, formatRub, type EtaSettings, type VinPreviewLine } from '@detaly/domain';
import { isVinPreviewSendable, vinLinePromisedDate } from '@detaly/vin';
import Link from 'next/link';
import type { ReactNode } from 'react';
import type { AdminVinCard as AdminVinCardData } from '@/server/admin/vin';
import { VIN_STATUS_LABELS } from '@/server/admin/vin';
import { adminStatusLabel, dateTime } from './format';

const BUTTON =
  'rounded-md bg-accent px-3 py-2 text-sm font-semibold text-white hover:bg-accent-strong';
const SECONDARY =
  'rounded-md border border-line bg-card px-3 py-2 text-sm font-semibold hover:border-ink';
const INPUT = 'min-w-0 rounded-md border border-line px-2 py-1.5 text-sm';

const CHANNEL_LABELS: Record<string, string> = {
  telegram: 'Telegram',
  sms: 'SMS',
  max: 'MAX',
};

const ANSWER_EXAMPLE = `> Комментарий клиенту (необязательно)
MANN W914/2 1
TRW GDB1330 1 # передние`;

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

function actionUrl(id: string): string {
  return `/api/admin/vin/${id}/actions`;
}

function PreviewRow({ line, eta }: { line: VinPreviewLine; eta: EtaSettings | null }) {
  if (line.status === 'error') {
    return (
      <tr
        className="border-b border-line align-top last:border-0"
        data-testid="vin-preview-line"
        data-status="error"
        data-reason={line.reason}
      >
        <td className="px-2 py-1.5 text-muted">{line.line}</td>
        <td className="px-2 py-1.5 font-mono wrap-anywhere">{line.raw}</td>
        <td className="px-2 py-1.5 text-warn" colSpan={4}>
          ✗ {line.message}
          {line.brands && line.brands.length > 0 ? (
            <span className="block text-xs">Есть у брендов: {line.brands.join(', ')}</span>
          ) : null}
        </td>
      </tr>
    );
  }
  let promise: string | null = null;
  if (eta) {
    try {
      promise = formatPromise(vinLinePromisedDate(line, eta));
    } catch {
      promise = null;
    }
  }
  return (
    <tr
      className="border-b border-line align-top last:border-0"
      data-testid="vin-preview-line"
      data-status="ok"
    >
      <td className="px-2 py-1.5 text-muted">{line.line}</td>
      <td className="px-2 py-1.5 wrap-anywhere">
        <span className="font-semibold">
          ✓ {line.offer.brand} {line.offer.article}
        </span>
        <span className="block text-muted">{line.offer.name}</span>
        {line.note ? <span className="block text-xs text-muted"># {line.note}</span> : null}
      </td>
      <td className="px-2 py-1.5 whitespace-nowrap">× {line.qty}</td>
      <td className="px-2 py-1.5 whitespace-nowrap">
        {formatRub(line.priceClientKop)}
        <span className="block text-xs text-muted">закупка {formatRub(line.priceSupplierKop)}</span>
      </td>
      <td className="px-2 py-1.5 whitespace-nowrap">{promise ?? line.etaDate}</td>
      <td className="px-2 py-1.5">{line.isLocal ? 'в Оренбурге' : 'под заказ'}</td>
    </tr>
  );
}

export function AdminVinCard({
  card,
  done,
  edit,
  eta,
}: {
  card: AdminVinCardData;
  done: string | null;
  /** «Исправить»: show the answer form even when a preview exists. */
  edit: boolean;
  eta: EtaSettings | null;
}) {
  const { request } = card;
  const workable =
    request.status === 'new' || request.status === 'in_work' || request.status === 'offered';
  const preview = request.preview;
  const sendable = workable && isVinPreviewSendable(preview);
  const showAnswerForm = workable && (edit || preview === null || preview.errorCount > 0);
  const proposalOpen =
    request.proposalToken !== null &&
    request.proposalExpiresAt !== null &&
    request.proposalExpiresAt.getTime() > Date.now();

  return (
    <div
      className="flex min-w-0 flex-col gap-4"
      data-testid="admin-vin"
      data-status={request.status}
    >
      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
        <Link href="/admin/vin" className="text-sm text-accent underline">
          ← Все заявки
        </Link>
        <h1 className="text-2xl font-bold">Заявка VIN № {card.number}</h1>
        <span
          className="rounded-full bg-order-soft px-3 py-1 text-sm font-semibold text-order"
          data-testid="admin-vin-status"
        >
          {VIN_STATUS_LABELS[request.status]}
        </span>
      </div>

      {done ? (
        <p
          className="rounded-card border border-local bg-local-soft px-4 py-2 text-local"
          role="status"
          data-testid="admin-done"
        >
          {done}
        </p>
      ) : null}

      <div className="grid min-w-0 gap-4 md:grid-cols-2">
        <Section title="Заявка" testId="admin-vin-request">
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
            <dt className="text-muted">VIN</dt>
            <dd className="font-mono wrap-anywhere" data-testid="admin-vin-vin">
              {request.vin ?? '—'}
            </dd>
            <dt className="text-muted">Авто</dt>
            <dd className="wrap-anywhere">{request.carText ?? '—'}</dd>
            <dt className="text-muted">Что нужно</dt>
            <dd className="whitespace-pre-line wrap-anywhere" data-testid="admin-vin-need">
              {request.needText}
            </dd>
            <dt className="text-muted">Создана</dt>
            <dd>{dateTime(request.createdAt)}</dd>
            <dt className="text-muted">Ответ</dt>
            <dd>{dateTime(request.answeredAt)}</dd>
            {request.closedAt ? (
              <>
                <dt className="text-muted">Закрыта</dt>
                <dd>
                  {dateTime(request.closedAt)}
                  {request.closeReason ? ` — ${request.closeReason}` : ''}
                </dd>
              </>
            ) : null}
          </dl>
        </Section>

        <Section title="Клиент" testId="admin-vin-client">
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
            <dt className="text-muted">Телефон</dt>
            <dd>
              <a
                href={`tel:${request.phone}`}
                className="text-accent underline"
                data-testid="admin-vin-phone"
              >
                {request.phone}
              </a>
            </dd>
            <dt className="text-muted">Канал ответа</dt>
            <dd>{request.channel ? (CHANNEL_LABELS[request.channel] ?? request.channel) : '—'}</dd>
          </dl>
          {workable && request.status === 'new' ? (
            <form method="post" action={actionUrl(request.id)} className="mt-3">
              <input type="hidden" name="action" value="take" />
              <button type="submit" className={SECONDARY}>
                Взять в работу
              </button>
            </form>
          ) : null}
        </Section>
      </div>

      <Section title="Фото" testId="admin-vin-photos">
        {request.photosDeleted ? (
          <p className="text-sm text-muted">Фото удалены по сроку хранения (90 дней).</p>
        ) : request.photos.length === 0 ? (
          <p className="text-sm text-muted">Фото нет.</p>
        ) : (
          <ul className="flex flex-wrap gap-3">
            {request.photos.map((key, index) => (
              <li key={key}>
                <a href={`/api/admin/files/${key}`} target="_blank" rel="noopener">
                  {/* eslint-disable-next-line @next/next/no-img-element -- admin file route */}
                  <img
                    src={`/api/admin/files/${key}`}
                    alt={`Фото ${index + 1}`}
                    loading="lazy"
                    className="size-40 rounded-md border border-line object-cover"
                    data-testid="admin-vin-photo"
                  />
                </a>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title="Ответ строками" testId="admin-vin-answer">
        {preview ? (
          <div className="mb-4 min-w-0" data-testid="vin-preview">
            {preview.comment ? (
              <p className="mb-2 text-sm">
                <span className="text-muted">Комментарий клиенту:</span> {preview.comment}
              </p>
            ) : null}
            <div className="min-w-0 overflow-x-auto">
              <table className="w-full min-w-[40rem] text-left text-sm">
                <thead className="border-b border-line text-muted">
                  <tr>
                    <th className="px-2 py-1.5 font-medium">#</th>
                    <th className="px-2 py-1.5 font-medium">Позиция</th>
                    <th className="px-2 py-1.5 font-medium">Кол-во</th>
                    <th className="px-2 py-1.5 font-medium">Клиенту</th>
                    <th className="px-2 py-1.5 font-medium">Получение</th>
                    <th className="px-2 py-1.5 font-medium">Склад</th>
                  </tr>
                </thead>
                <tbody>
                  {preview.lines.map((line) => (
                    <PreviewRow key={`${line.line}:${line.raw}`} line={line} eta={eta} />
                  ))}
                </tbody>
              </table>
            </div>
            <p className="mt-2 text-sm">
              Итого клиенту:{' '}
              <span className="font-semibold" data-testid="vin-preview-total">
                {formatRub(preview.totalKop)}
              </span>
              {preview.errorCount > 0 ? (
                <span className="ml-2 text-warn" data-testid="vin-preview-errors">
                  ошибок: {preview.errorCount} — исправьте строки, иначе отправить нельзя
                </span>
              ) : null}
              <span className="ml-2 text-xs text-muted">
                проверено {dateTime(new Date(preview.checkedAt))}
              </span>
            </p>
            {workable ? (
              <div className="mt-3 flex flex-wrap items-center gap-3">
                {sendable ? (
                  <form method="post" action={actionUrl(request.id)}>
                    <input type="hidden" name="action" value="send" />
                    <button type="submit" className={BUTTON} data-testid="vin-send">
                      Отправить клиенту
                    </button>
                  </form>
                ) : null}
                {!showAnswerForm ? (
                  <Link
                    href={`/admin/vin/${request.id}?edit=1#answer`}
                    className={SECONDARY}
                    data-testid="vin-fix"
                  >
                    Исправить
                  </Link>
                ) : null}
              </div>
            ) : null}
          </div>
        ) : null}

        {showAnswerForm ? (
          <form
            method="post"
            action={actionUrl(request.id)}
            className="flex min-w-0 flex-col gap-2"
            id="answer"
          >
            <input type="hidden" name="action" value="preview" />
            <label htmlFor="vin-answer" className="text-sm text-muted">
              По строке на позицию: БРЕНД АРТИКУЛ КОЛ-ВО, после # — заметка. Строка с «&gt;» —
              комментарий клиенту (без телефонов и ФИО). Каждая строка проверится у поставщика.
            </label>
            <textarea
              id="vin-answer"
              name="answer"
              rows={6}
              required
              maxLength={8000}
              defaultValue={request.answerText ?? ''}
              placeholder={ANSWER_EXAMPLE}
              className={`${INPUT} font-mono`}
              data-testid="vin-answer"
            />
            <div>
              <button type="submit" className={BUTTON} data-testid="vin-check">
                Проверить
              </button>
            </div>
          </form>
        ) : null}
        {!workable ? (
          <p className="text-sm text-muted">
            Заявка {VIN_STATUS_LABELS[request.status].toLowerCase()}.
          </p>
        ) : null}
      </Section>

      <Section title="Подборка" testId="admin-vin-proposal">
        {request.proposalToken && request.proposalExpiresAt ? (
          <p className="text-sm">
            <a
              href={`/p/${request.proposalToken}`}
              className="text-accent underline"
              target="_blank"
              rel="noopener noreferrer"
              data-testid="vin-proposal-link"
            >
              Открыть подборку
            </a>{' '}
            <span className="text-muted">
              {proposalOpen ? 'действует до' : 'истекла'} {dateTime(request.proposalExpiresAt)},
              отправлено подборок: {request.proposalCount}
            </span>
          </p>
        ) : (
          <p className="text-sm text-muted">Подборка ещё не отправлена.</p>
        )}
        {card.orders.length > 0 ? (
          <ul className="mt-2 text-sm" data-testid="admin-vin-orders">
            {card.orders.map((order) => (
              <li key={order.id}>
                Заказ{' '}
                <Link href={`/admin/orders/${order.id}`} className="text-accent underline">
                  {order.number}
                </Link>{' '}
                — {adminStatusLabel(order.status)}
              </li>
            ))}
          </ul>
        ) : null}
      </Section>

      {workable ? (
        <Section title="Закрыть заявку" testId="admin-vin-close">
          <form
            method="post"
            action={actionUrl(request.id)}
            className="flex min-w-0 flex-wrap items-center gap-2"
          >
            <input type="hidden" name="action" value="close" />
            <input
              type="text"
              name="reason"
              maxLength={500}
              placeholder="Причина (для себя, без ПД)"
              className={`${INPUT} w-72 max-w-full`}
            />
            <button type="submit" className={SECONDARY}>
              Закрыть
            </button>
          </form>
          <p className="mt-2 text-xs text-muted">
            Клиенту ничего не отправляется; ссылка на подборку перестанет работать.
          </p>
        </Section>
      ) : null}
    </div>
  );
}
