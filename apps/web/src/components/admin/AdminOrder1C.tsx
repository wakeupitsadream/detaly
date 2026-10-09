/**
 * Phase 1C blocks of the admin order card (docs/phase-1c-implementation.md decision С26):
 * «Претензии» (the decision always with the answer text, «Принял возврат» only with a photo
 * upload, the owner's refund without the return only with a reason, compensation for a delay,
 * «Замена выдана», opening a claim for the client), «Запись на установку» (confirm, decline,
 * done, no-show), «Фото» (packaging upload, every kind shown) and the two print templates.
 * Plain forms (multipart where a photo is attached), no client JavaScript; photos come from
 * /api/admin/files/<key> under Basic auth.
 */
import {
  CLAIM_DECISION_LABELS,
  CLAIM_KIND_LABELS,
  CLAIM_KINDS,
  fitGuaranteeClaimLabel,
  type InstallBookingStatus,
  type PhotoKind,
} from '@detaly/domain';
import type { ClaimView, StaffActionView1C } from '@detaly/orders';
import type { ReactNode } from 'react';
import type { AdminOrder1C as AdminOrder1CData } from '@/server/admin/order-1c';
import { uuidV7 } from '@/server/checkout/uuid';
import { ADMIN_INPUT_CLASS } from './AdminActions';
import { dateTime, rub } from './format';

const BUTTON =
  'rounded-md bg-accent px-3 py-2 text-sm font-semibold text-white hover:bg-accent-strong disabled:cursor-not-allowed disabled:bg-line disabled:text-muted';
const TEXTAREA = `${ADMIN_INPUT_CLASS} w-full max-w-xl`;

const BOOKING_STATUS_LABELS: Record<InstallBookingStatus, string> = {
  requested: 'ждёт подтверждения',
  confirmed: 'подтверждена',
  done: 'выполнена',
  cancelled: 'отменена',
  no_show: 'клиент не приехал',
};

const PHOTO_KIND_LABELS: Record<PhotoKind, string> = {
  packaging: 'упаковка',
  handover: 'выдача',
  return: 'возврат',
};

/** Print templates (decision С23): static PDFs with blank requisites to fill in by hand. */
export const PRINT_TEMPLATES = [
  { href: '/print/pamyatka-vozvrat.pdf', label: 'Памятка о возврате (PDF)' },
  { href: '/print/akt-vydachi.pdf', label: 'Акт выдачи (PDF)' },
] as const;

function actionUrl(orderId: string): string {
  return `/api/admin/orders/${orderId}/actions`;
}

function Section({
  title,
  testId,
  children,
}: {
  title: string;
  testId: string;
  children: ReactNode;
}) {
  return (
    <section className="min-w-0 rounded-card border border-line bg-card p-4" data-testid={testId}>
      <h2 className="mb-3 text-lg font-semibold">{title}</h2>
      {children}
    </section>
  );
}

function Thumb({ fileKey, alt, testId }: { fileKey: string; alt: string; testId: string }) {
  const href = `/api/admin/files/${fileKey}`;
  return (
    <a href={href} target="_blank" rel="noopener">
      {/* eslint-disable-next-line @next/next/no-img-element -- admin file route */}
      <img
        src={href}
        alt={alt}
        loading="lazy"
        className="size-28 rounded-md border border-line object-cover"
        data-testid={testId}
      />
    </a>
  );
}

/** One form of the order's action endpoint; `photo` makes it multipart with a required file. */
function Form1C({
  orderId,
  code,
  label,
  hidden,
  photo = false,
  enabled = true,
  disabledReason,
  children,
}: {
  orderId: string;
  code: string;
  label: string;
  hidden?: Record<string, string>;
  photo?: boolean;
  enabled?: boolean;
  disabledReason?: string | null;
  children?: ReactNode;
}) {
  return (
    <form
      method="post"
      action={actionUrl(orderId)}
      encType={photo ? 'multipart/form-data' : undefined}
      className="flex min-w-0 flex-wrap items-start gap-2"
      data-action={code}
    >
      <input type="hidden" name="action" value={code} />
      {Object.entries(hidden ?? {}).map(([name, value]) => (
        <input key={name} type="hidden" name={name} value={value} />
      ))}
      {photo ? (
        <input
          type="file"
          name="photos"
          accept="image/*"
          required
          disabled={!enabled}
          className="max-w-full text-sm"
          aria-label="Фото"
        />
      ) : null}
      {children}
      <button type="submit" className={BUTTON} disabled={!enabled}>
        {label}
      </button>
      {!enabled && disabledReason ? (
        <span className="text-xs text-warn" data-testid="action-disabled-reason">
          {disabledReason}
        </span>
      ) : null}
    </form>
  );
}

function ClaimActions({
  orderId,
  claim,
  views,
}: {
  orderId: string;
  claim: ClaimView;
  views: StaffActionView1C[];
}) {
  const hidden = { claimId: claim.id };
  const forms: ReactNode[] = [];
  for (const view of views) {
    const common = {
      orderId,
      code: view.code,
      label: view.label,
      hidden,
      enabled: view.enabled || view.needsReason === true,
      disabledReason: view.disabledReason,
    };
    switch (view.code) {
      case 'cret':
        forms.push(<Form1C key={view.code} {...common} photo />);
        break;
      case 'cref':
        forms.push(
          <Form1C key={view.code} {...common}>
            <textarea
              name="text"
              required
              maxLength={2000}
              rows={2}
              placeholder="Ответ клиенту (увидит на странице заказа)"
              className={TEXTAREA}
            />
            {view.needsReason ? (
              <input
                type="text"
                name="reason"
                required
                maxLength={500}
                placeholder="Причина возврата без приёмки детали"
                className={`${ADMIN_INPUT_CLASS} w-72 max-w-full`}
              />
            ) : null}
            <label className="flex items-center gap-1 text-xs text-muted">
              <input type="checkbox" name="confirm" value="on" required /> подтверждаю
            </label>
          </Form1C>,
        );
        break;
      case 'crepl':
      case 'crej':
        forms.push(
          <Form1C key={view.code} {...common}>
            <textarea
              name="text"
              required
              maxLength={2000}
              rows={2}
              placeholder={
                view.code === 'crej'
                  ? 'Мотивированный ответ клиенту'
                  : 'Ответ клиенту: что и когда заменим'
              }
              className={TEXTAREA}
            />
          </Form1C>,
        );
        break;
      case 'cclose':
        forms.push(
          <Form1C key={view.code} {...common}>
            <input
              type="text"
              name="note"
              maxLength={500}
              placeholder="Комментарий (без ПД)"
              className={ADMIN_INPUT_CLASS}
            />
          </Form1C>,
        );
        break;
      case 'bconf':
      case 'bdecl':
      case 'bdone':
      case 'bnoshow':
      case 'pphoto':
        // Booking and photo buttons live in their own blocks.
        break;
    }
  }
  if (claim.decision === 'replace' && claim.open && claim.replacementOrderedAt === null) {
    // PLAN section 3: replace → a new order of the item, recorded with the Rossko numbers.
    forms.unshift(
      <Form1C
        key="claim_reorder"
        orderId={orderId}
        code="claim_reorder"
        label="Замена заказана"
        hidden={hidden}
      >
        <input
          type="text"
          name="rosskoOrderIds"
          required
          maxLength={500}
          placeholder="Номера заказов Rossko через запятую"
          className={`${ADMIN_INPUT_CLASS} w-72 max-w-full`}
        />
      </Form1C>,
    );
  }
  if (claim.kind === 'delay' && claim.compensationAmountKop === null && claim.open) {
    forms.push(
      <Form1C
        key="claim_comp"
        orderId={orderId}
        code="claim_comp"
        label="Записать компенсацию"
        hidden={hidden}
      >
        <input
          type="text"
          name="amountRub"
          inputMode="decimal"
          required
          maxLength={20}
          placeholder="Сумма, ₽ (ст. 23.1)"
          className={`${ADMIN_INPUT_CLASS} w-40`}
        />
      </Form1C>,
    );
  }
  if (forms.length === 0) return null;
  return <div className="mt-3 flex min-w-0 flex-col gap-3 border-t border-line pt-3">{forms}</div>;
}

export function AdminOrder1C({
  orderId,
  data,
  items,
  canOpenClaim,
}: {
  orderId: string;
  data: AdminOrder1CData;
  items: { id: string; title: string }[];
  /** The order is past checkout and not cancelled: a claim form makes sense. */
  canOpenClaim: boolean;
}) {
  const claimViews = (claimId: string) => data.actions.filter((view) => view.claimId === claimId);
  const bookingViews = (bookingId: string) =>
    data.actions.filter((view) => view.bookingId === bookingId);
  const photoAction = data.actions.find((view) => view.code === 'pphoto');
  const itemTitle = new Map(items.map((item) => [item.id, item.title]));

  return (
    <>
      <Section title="Претензии" testId="admin-claims">
        {data.claims.length === 0 ? (
          <p className="text-sm text-muted">Претензий нет.</p>
        ) : (
          <ul className="flex flex-col gap-4">
            {data.claims.map((claim) => (
              <li
                key={claim.id}
                className="border-b border-line pb-4 text-sm last:border-0"
                data-claim={claim.id}
                data-open={claim.open ? 'yes' : 'no'}
              >
                <p className="font-semibold">
                  {CLAIM_KIND_LABELS[claim.kind]} —{' '}
                  {claim.item ? `${claim.item.brand} ${claim.item.article}` : 'весь заказ'}
                  <span className="ml-2 font-normal text-muted">
                    {claim.open
                      ? `открыта, ответить до ${dateTime(claim.deadlineAt)}`
                      : `закрыта ${dateTime(claim.closedAt)}`}
                  </span>
                </p>
                {fitGuaranteeClaimLabel(claim.kind, claim.item) ? (
                  <p className="font-semibold text-ok" data-testid="admin-claim-fit-guarantee">
                    {fitGuaranteeClaimLabel(claim.kind, claim.item)}
                  </p>
                ) : null}
                <p className="text-muted">
                  Открыта {dateTime(claim.openedAt)}
                  {claim.openedVia ? ` (${claim.openedVia})` : ''}
                  {claim.returnAcceptedAt
                    ? `, возврат принят ${dateTime(claim.returnAcceptedAt)}`
                    : ''}
                </p>
                {claim.clientText ? (
                  <p
                    className="mt-1 whitespace-pre-line wrap-anywhere"
                    data-testid="admin-claim-text"
                  >
                    {claim.clientText}
                  </p>
                ) : null}
                {claim.photos.length > 0 || claim.returnPhotos.length > 0 ? (
                  <div className="mt-2 flex flex-wrap gap-2">
                    {claim.photos.map((key, index) => (
                      <Thumb
                        key={key}
                        fileKey={key}
                        alt={`Фото клиента ${index + 1}`}
                        testId="admin-claim-photo"
                      />
                    ))}
                    {claim.returnPhotos.map((photo) => (
                      <Thumb
                        key={photo.id}
                        fileKey={photo.key}
                        alt="Фото возвращённой детали"
                        testId="admin-return-photo"
                      />
                    ))}
                  </div>
                ) : null}
                {claim.decision ? (
                  <p className="mt-2" data-testid="admin-claim-decision">
                    Решение:{' '}
                    <span className="font-semibold">{CLAIM_DECISION_LABELS[claim.decision]}</span>
                    {claim.decidedAt ? ` (${dateTime(claim.decidedAt)})` : ''}
                    {claim.decisionText ? (
                      <span className="block whitespace-pre-line wrap-anywhere">
                        {claim.decisionText}
                      </span>
                    ) : null}
                    {claim.overrideReason ? (
                      <span className="block text-warn">
                        Без приёмки, причина: {claim.overrideReason}
                      </span>
                    ) : null}
                  </p>
                ) : null}
                {claim.compensationAmountKop !== null ? (
                  <p className="mt-1">Компенсация: {rub(claim.compensationAmountKop)}</p>
                ) : null}
                <ClaimActions orderId={orderId} claim={claim} views={claimViews(claim.id)} />
              </li>
            ))}
          </ul>
        )}
        {canOpenClaim ? (
          <details className="mt-4 border-t border-line pt-3 text-sm">
            <summary className="cursor-pointer font-semibold">Открыть претензию от клиента</summary>
            <div className="mt-3">
              <Form1C
                orderId={orderId}
                code="claim_open"
                label="Открыть претензию"
                hidden={{ requestKey: uuidV7() }}
              >
                <select name="kind" required defaultValue="" className={ADMIN_INPUT_CLASS}>
                  <option value="" disabled>
                    Вид претензии
                  </option>
                  {CLAIM_KINDS.map((kind) => (
                    <option key={kind} value={kind}>
                      {CLAIM_KIND_LABELS[kind]}
                    </option>
                  ))}
                </select>
                <select name="itemId" defaultValue="" className={ADMIN_INPUT_CLASS}>
                  <option value="">Весь заказ</option>
                  {items.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.title}
                    </option>
                  ))}
                </select>
                <textarea
                  name="text"
                  maxLength={1000}
                  rows={2}
                  placeholder="Что случилось, со слов клиента"
                  className={TEXTAREA}
                />
              </Form1C>
            </div>
          </details>
        ) : null}
      </Section>

      <Section title="Запись на установку" testId="admin-install">
        {data.bookings.length === 0 ? (
          <p className="text-sm text-muted">Записи нет.</p>
        ) : (
          <ul className="flex flex-col gap-3">
            {data.bookings.map((booking) => (
              <li
                key={booking.id}
                className="border-b border-line pb-3 text-sm last:border-0"
                data-booking={booking.id}
                data-status={booking.status}
              >
                <p>
                  <span className="font-semibold">
                    {booking.slot.dayText} {booking.slot.timeText}
                  </span>{' '}
                  — {BOOKING_STATUS_LABELS[booking.status]}
                  <span className="text-muted">
                    {booking.createdVia ? `, через ${booking.createdVia}` : ''}, создана{' '}
                    {dateTime(booking.createdAt)}
                  </span>
                </p>
                {booking.staffNote ? <p className="text-muted">{booking.staffNote}</p> : null}
                {bookingViews(booking.id).length > 0 ? (
                  <div className="mt-2 flex flex-col gap-2">
                    {bookingViews(booking.id).map((view) => (
                      <Form1C
                        key={view.code}
                        orderId={orderId}
                        code={view.code}
                        label={view.label}
                        hidden={{ bookingId: booking.id }}
                        enabled={view.enabled}
                        disabledReason={view.disabledReason}
                      >
                        {view.code === 'bdecl' ? (
                          <input
                            type="text"
                            name="note"
                            maxLength={500}
                            placeholder="Комментарий клиенту (без ПД)"
                            className={ADMIN_INPUT_CLASS}
                          />
                        ) : null}
                      </Form1C>
                    ))}
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        )}
        <p className="mt-2 text-xs text-muted">
          Установка — услуга сервиса, оплачивается в сервисе по его чеку; цены здесь нет.
        </p>
      </Section>

      <Section title="Фото" testId="admin-photos">
        {data.photos.length === 0 ? (
          <p className="text-sm text-muted">Фото нет.</p>
        ) : (
          <ul className="flex flex-wrap gap-3">
            {data.photos.map((photo) => (
              <li key={photo.id} className="text-xs text-muted" data-photo-kind={photo.kind}>
                <Thumb
                  fileKey={photo.key}
                  alt={`Фото: ${PHOTO_KIND_LABELS[photo.kind]}`}
                  testId="admin-order-photo"
                />
                <span className="mt-1 block">
                  {PHOTO_KIND_LABELS[photo.kind]}
                  {photo.orderItemId ? `, ${itemTitle.get(photo.orderItemId) ?? ''}` : ''},{' '}
                  {dateTime(photo.createdAt)}
                </span>
              </li>
            ))}
          </ul>
        )}
        {photoAction ? (
          <div className="mt-3 border-t border-line pt-3">
            <Form1C orderId={orderId} code="pphoto" label="Загрузить фото" photo>
              <select name="photoKind" defaultValue="packaging" className={ADMIN_INPUT_CLASS}>
                <option value="packaging">Упаковка</option>
                <option value="handover">Выдача</option>
              </select>
            </Form1C>
          </div>
        ) : null}
      </Section>

      <Section title="Печать" testId="admin-print">
        <ul className="flex flex-wrap gap-4 text-sm">
          {PRINT_TEMPLATES.map((doc) => (
            <li key={doc.href}>
              <a href={doc.href} target="_blank" rel="noopener" className="text-accent underline">
                {doc.label}
              </a>
            </li>
          ))}
        </ul>
      </Section>
    </>
  );
}
