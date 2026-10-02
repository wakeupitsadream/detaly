/**
 * Action forms of the admin order card: the owner's buttons from availableStaffActions (the
 * same as in the seller bot) plus the admin-only actions. Plain HTML forms posting to
 * /api/admin/orders/<id>/actions; no client JavaScript.
 */
import type { IsoDate, RecheckAlternative } from '@detaly/domain';
import type { StaffActionCode, StaffActionView } from '@detaly/orders';
import type { ReactNode } from 'react';
import {
  CONFIRM_FIELD,
  CONFIRM_VALUE,
  DESTRUCTIVE_ADMIN_ACTIONS,
} from '@/server/admin/destructive';
import { rub } from './format';

const BUTTON =
  'rounded-md bg-accent px-3 py-2 text-sm font-semibold text-white hover:bg-accent-strong disabled:cursor-not-allowed disabled:bg-line disabled:text-muted';
const INPUT = 'min-w-0 rounded-md border border-line px-2 py-1.5 text-sm';

export function actionUrl(orderId: string): string {
  return `/api/admin/orders/${orderId}/actions`;
}

export function ActionForm({
  orderId,
  code,
  label,
  itemId,
  enabled = true,
  disabledReason,
  children,
}: {
  orderId: string;
  code: StaffActionCode;
  label: string;
  itemId?: string;
  enabled?: boolean;
  disabledReason?: string | null;
  children?: ReactNode;
}) {
  return (
    <form
      method="post"
      action={actionUrl(orderId)}
      className="flex min-w-0 flex-wrap items-center gap-2"
      data-action={code}
      data-item={itemId}
    >
      <input type="hidden" name="action" value={code} />
      {itemId ? <input type="hidden" name="itemId" value={itemId} /> : null}
      {children}
      {DESTRUCTIVE_ADMIN_ACTIONS.has(code) && enabled ? (
        <label className="flex items-center gap-1 text-xs text-muted">
          <input type="checkbox" name={CONFIRM_FIELD} value={CONFIRM_VALUE} required /> подтверждаю
        </label>
      ) : null}
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

const PROBLEM_OPTIONS: [string, string][] = [
  ['declined', 'Отказ поставщика'],
  ['wrong', 'Приехало не то'],
  ['damaged', 'Повреждено при приёмке'],
  ['delay', 'Сдвиг срока'],
];

/** One button of availableStaffActions with the fields its action needs. */
function StaffAction({
  orderId,
  view,
  alternatives,
  today,
}: {
  orderId: string;
  view: StaffActionView;
  alternatives: RecheckAlternative[];
  today: IsoDate;
}) {
  const common = {
    orderId,
    code: view.code,
    label: view.label,
    itemId: view.itemId,
    enabled: view.enabled,
    disabledReason: view.disabledReason,
  };
  switch (view.code) {
    case 'ialt':
      if (alternatives.length === 0) {
        return (
          <ActionForm
            {...common}
            enabled={false}
            disabledReason="Аналогов в последней проверке цен нет"
          />
        );
      }
      return (
        <ActionForm {...common}>
          <fieldset className="flex min-w-0 flex-col gap-1 text-sm">
            {alternatives.map((alt, index) => (
              <label key={alt.offerKey} className="flex items-start gap-2">
                <input
                  type="radio"
                  name="offerKey"
                  value={alt.offerKey}
                  defaultChecked={index === 0}
                  required
                />
                <span className="wrap-anywhere">
                  {alt.offer.brand} {alt.offer.article} — {alt.offer.stock.stockId}, закупка{' '}
                  {rub(alt.priceSupplierKop)}, клиенту {rub(alt.priceClientKop)}
                  {alt.etaDate ? `, к ${alt.etaDate}` : ''}, наличие {alt.available}
                </span>
              </label>
            ))}
          </fieldset>
        </ActionForm>
      );
    case 'ieta':
      return (
        <ActionForm {...common}>
          <input type="date" name="etaDate" min={today} required className={INPUT} />
          <input
            type="text"
            name="note"
            maxLength={200}
            placeholder="Комментарий клиенту (без ПД)"
            className={INPUT}
          />
        </ActionForm>
      );
    case 'iprob':
      return (
        <ActionForm {...common}>
          <select name="problem" required className={INPUT} defaultValue="">
            <option value="" disabled>
              Что случилось?
            </option>
            {PROBLEM_OPTIONS.map(([value, text]) => (
              <option key={value} value={value}>
                {text}
              </option>
            ))}
          </select>
        </ActionForm>
      );
    case 'invpaid':
      return (
        <ActionForm {...common}>
          <input
            type="text"
            name="ppNumber"
            required
            maxLength={64}
            placeholder="№ платёжного поручения"
            className={INPUT}
          />
          <input type="date" name="ppDate" required max={today} className={INPUT} />
        </ActionForm>
      );
    case 'recheck':
    case 'refused':
    case 'cancel':
    case 'anyway':
    case 'icancel':
    case 'iarr':
    case 'came':
    case 'rcpt':
    case 'qr':
    case 'handed':
    case 'noshow':
    case 'manual_supplier_order':
    case 'supplier_return_accept':
    case 'supplier_return_reject':
    case 'stock_item':
    case 'refund_payment':
    case 'retry_refund':
      return <ActionForm {...common} />;
  }
}

export function StaffActionForms({
  orderId,
  views,
  alternatives,
  today,
}: {
  orderId: string;
  views: StaffActionView[];
  alternatives: Record<string, RecheckAlternative[]>;
  today: IsoDate;
}) {
  if (views.length === 0) {
    return <p className="text-sm text-muted">В этом статусе действий нет.</p>;
  }
  return (
    <ul className="flex min-w-0 flex-col gap-3" data-testid="admin-actions">
      {views.map((view) => (
        <li key={`${view.code}:${view.itemId ?? ''}`} className="min-w-0">
          <StaffAction
            orderId={orderId}
            view={view}
            alternatives={view.itemId ? (alternatives[view.itemId] ?? []) : []}
            today={today}
          />
        </li>
      ))}
    </ul>
  );
}

export { INPUT as ADMIN_INPUT_CLASS };
