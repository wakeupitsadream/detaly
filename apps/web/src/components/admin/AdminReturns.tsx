/**
 * /admin/returns and /admin/stock (step 7, docs/month-close.md).
 *
 * Returns: every part going back to Rossko that is still open — overdue first, then due soon,
 * the other waiting parts by deadline, then the ones handed to the driver waiting for the money
 * (the longest wait first) — and the ones closed in the last 30 days. Forms: «Сдал водителю»,
 * «Не берут» (the part stays in stock at the cost of the order), «Деньги вернулись» with the
 * amount from the Rossko statement.
 *
 * Stock: the parts Rossko did not take back, at the cost of the order, with the reason and the
 * date; «Списать» behind a «подтверждаю» tick. Selling from stock is a later phase.
 */
import { formatDayMonth, formatRub, localDate } from '@detaly/domain';
import {
  stockReasonLabel,
  SUPPLIER_RETURN_KIND_LABELS,
  SUPPLIER_RETURN_STATUS_LABELS,
  supplierReturnUrgency,
  type StockItemView,
  type SupplierReturnUrgency,
  type SupplierReturnView,
} from '@detaly/orders';
import Link from 'next/link';
import { CONFIRM_FIELD, CONFIRM_VALUE } from '@/server/admin/destructive';
import { BUTTON, Done, INPUT, Notice, OrderLink, Section, SECONDARY } from './finance-ui';
import { dateTime } from './format';

const DAY_MS = 24 * 60 * 60 * 1000;

const URGENCY_TITLES: Record<SupplierReturnUrgency, string> = {
  overdue: 'Просрочены — срок возврата Rossko прошёл',
  due_soon: 'Срок истекает в ближайшие 2 дня',
  open: 'Ждут сдачи водителю',
  waiting_money: 'Сданы — ждём деньги от Rossko',
  closed: 'Закрыты за 30 дней',
};

const URGENCY_ORDER: readonly SupplierReturnUrgency[] = [
  'overdue',
  'due_soon',
  'open',
  'waiting_money',
  'closed',
];

function daysBetween(from: Date, to: Date): number {
  return Math.max(0, Math.floor((to.getTime() - from.getTime()) / DAY_MS));
}

function deadlineText(ret: SupplierReturnView, now: Date): string | null {
  if (ret.deadlineAt === null) return null;
  const date = formatDayMonth(localDate(ret.deadlineAt));
  if (ret.deadlineAt.getTime() <= now.getTime()) {
    return `срок был ${date}, просрочен на ${daysBetween(ret.deadlineAt, now) || 1} дн.`;
  }
  return `вернуть до ${date}`;
}

/** «сдан водителю 28 сентября · ждём деньги 12 дн.» — what happened and since when. */
function stateText(ret: SupplierReturnView, now: Date): string {
  const shipped = ret.shippedAt ? ` ${formatDayMonth(localDate(ret.shippedAt))}` : '';
  switch (ret.status) {
    case 'requested': {
      const deadline = deadlineText(ret, now);
      return `${SUPPLIER_RETURN_STATUS_LABELS.requested}${deadline ? ` · ${deadline}` : ''}`;
    }
    case 'shipped':
      return `сдан водителю${shipped} · ждём деньги ${daysBetween(ret.shippedAt ?? ret.updatedAt, now)} дн.`;
    case 'accepted':
      return `${ret.shippedAt ? `сдан водителю${shipped}, ` : ''}принят поставщиком · ждём деньги ${daysBetween(ret.shippedAt ?? ret.updatedAt, now)} дн.`;
    case 'refunded':
      return `деньги вернулись${ret.refundedAt ? ` ${dateTime(ret.refundedAt)}` : ''}: ${formatRub(ret.amountReceivedKop ?? 0)}`;
    case 'rejected':
      return SUPPLIER_RETURN_STATUS_LABELS.rejected;
  }
}

function ReturnCard({ ret, now }: { ret: SupplierReturnView; now: Date }) {
  const urgency = supplierReturnUrgency(ret, now);
  const waiting = ret.status === 'shipped' || ret.status === 'accepted';
  return (
    <li
      className="flex min-w-0 flex-col gap-2 border-b border-line py-3 text-sm last:border-0"
      data-testid="return-row"
      data-status={ret.status}
      data-urgency={urgency}
    >
      <div className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="font-semibold wrap-anywhere">
          {ret.brand} {ret.article} × {ret.qty}
        </span>
        <OrderLink orderId={ret.orderId} number={ret.orderNumber} />
        <span className="text-muted">{SUPPLIER_RETURN_KIND_LABELS[ret.kind]}</span>
      </div>
      <p className="text-muted wrap-anywhere">{ret.name}</p>
      <p data-testid="return-state">
        <span className={urgency === 'overdue' ? 'font-semibold text-danger' : ''}>
          {stateText(ret, now)}
        </span>
        {ret.amountExpectedKop !== null && ret.status !== 'refunded'
          ? ` · к возврату ${formatRub(ret.amountExpectedKop)}`
          : ''}
      </p>
      {ret.status === 'requested' || waiting ? (
        <div className="flex min-w-0 flex-wrap items-start gap-2">
          {ret.status === 'requested' ? (
            <>
              <form method="post" action="/api/admin/returns">
                <input type="hidden" name="action" value="ship" />
                <input type="hidden" name="supplierReturnId" value={ret.id} />
                <input type="hidden" name="back" value="/admin/returns" />
                <button type="submit" className={BUTTON}>
                  Сдал водителю
                </button>
              </form>
              <form method="post" action="/api/admin/returns">
                <input type="hidden" name="action" value="reject" />
                <input type="hidden" name="supplierReturnId" value={ret.id} />
                <input type="hidden" name="back" value="/admin/returns" />
                <button type="submit" className={SECONDARY}>
                  Не берут
                </button>
              </form>
            </>
          ) : null}
          <form
            method="post"
            action="/api/admin/returns"
            className="flex min-w-0 flex-wrap items-center gap-2"
          >
            <input type="hidden" name="action" value="refunded" />
            <input type="hidden" name="supplierReturnId" value={ret.id} />
            <input type="hidden" name="back" value="/admin/returns" />
            <label className="sr-only" htmlFor={`amount-${ret.id}`}>
              Сколько вернулось, ₽
            </label>
            <input
              id={`amount-${ret.id}`}
              name="amountRub"
              inputMode="decimal"
              autoComplete="off"
              maxLength={20}
              required
              placeholder={
                ret.amountExpectedKop !== null
                  ? formatRub(ret.amountExpectedKop).replace(/\s?₽$/u, '')
                  : 'Сумма, ₽'
              }
              className={`${INPUT} w-32`}
            />
            <button type="submit" className={SECONDARY}>
              Деньги вернулись
            </button>
          </form>
        </div>
      ) : null}
    </li>
  );
}

export function AdminReturns({
  returns,
  now,
  done,
}: {
  returns: SupplierReturnView[];
  now: Date;
  done: string | null;
}) {
  const groups = URGENCY_ORDER.map((urgency) => ({
    urgency,
    rows: returns.filter((ret) => supplierReturnUrgency(ret, now) === urgency),
  })).filter((group) => group.rows.length > 0);
  return (
    <div className="flex min-w-0 flex-col gap-4" data-testid="admin-returns">
      <div className="flex min-w-0 flex-col gap-3">
        <h1 className="text-2xl font-bold">Возвраты поставщику</h1>
        <p className="text-sm text-muted">
          Запчасти, которые возвращаем Rossko. «Сдал водителю» — деталь уехала, ждём деньги; «Не
          берут» — деталь остаётся на{' '}
          <Link href="/admin/stock" className="text-accent underline">
            складе
          </Link>{' '}
          по закупочной цене; «Деньги вернулись» — сумма из выписки Rossko. Те же кнопки — в
          карточке заказа в боте продавцов.
        </p>
        <Done message={done} />
      </div>
      {groups.length === 0 ? (
        <Notice tone="ok" testId="returns-empty">
          Открытых возвратов нет.
        </Notice>
      ) : (
        groups.map((group) => (
          <Section
            key={group.urgency}
            title={`${URGENCY_TITLES[group.urgency]}: ${group.rows.length}`}
            testId={`returns-${group.urgency}`}
          >
            <ul className="flex min-w-0 flex-col">
              {group.rows.map((ret) => (
                <ReturnCard key={ret.id} ret={ret} now={now} />
              ))}
            </ul>
          </Section>
        ))
      )}
    </div>
  );
}

export function AdminStock({ items, done }: { items: StockItemView[]; done: string | null }) {
  const inStock = items.filter((item) => item.writtenOffAt === null);
  const totalKop = inStock.reduce((sum, item) => sum + item.costKop, 0);
  return (
    <div className="flex min-w-0 flex-col gap-4" data-testid="admin-stock">
      <div className="flex min-w-0 flex-col gap-3">
        <h1 className="text-2xl font-bold">Склад</h1>
        <p className="text-sm text-muted">
          Запчасти, которые Rossko не принял обратно, по закупочной цене заказа. «Списать» — деталь
          больше не числится на складе (продажа со склада — позже).
        </p>
        <Done message={done} />
        <p className="text-sm" data-testid="stock-total">
          На складе: {inStock.length} поз. на {formatRub(totalKop)}
        </p>
      </div>
      {items.length === 0 ? (
        <Notice tone="ok" testId="stock-empty">
          На складе пусто.
        </Notice>
      ) : (
        <Section title="Позиции" testId="stock-list">
          <ul className="flex min-w-0 flex-col">
            {items.map((item) => (
              <li
                key={item.id}
                className={`flex min-w-0 flex-col gap-2 border-b border-line py-3 text-sm last:border-0 ${item.writtenOffAt ? 'text-muted' : ''}`}
                data-testid="stock-row"
                data-written-off={item.writtenOffAt ? 'true' : 'false'}
              >
                <div className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1">
                  <span className="font-semibold wrap-anywhere">
                    {item.brand} {item.article} × {item.qty}
                  </span>
                  <OrderLink orderId={item.orderId} number={item.orderNumber} />
                  <span className="font-semibold whitespace-nowrap">{formatRub(item.costKop)}</span>
                </div>
                <p className="wrap-anywhere">
                  {item.name} · {stockReasonLabel(item.reason)} · записано{' '}
                  {dateTime(item.createdAt)}
                  {item.writtenOffAt ? ` · списано ${dateTime(item.writtenOffAt)}` : ''}
                </p>
                {item.writtenOffAt === null ? (
                  <form
                    method="post"
                    action="/api/admin/returns"
                    className="flex flex-wrap items-center gap-3"
                  >
                    <input type="hidden" name="action" value="write_off" />
                    <input type="hidden" name="stockItemId" value={item.id} />
                    <input type="hidden" name="back" value="/admin/stock" />
                    <label className="flex items-center gap-2">
                      <input type="checkbox" name={CONFIRM_FIELD} value={CONFIRM_VALUE} required />
                      подтверждаю
                    </label>
                    <button type="submit" className={SECONDARY}>
                      Списать
                    </button>
                  </form>
                ) : null}
              </li>
            ))}
          </ul>
        </Section>
      )}
    </div>
  );
}
