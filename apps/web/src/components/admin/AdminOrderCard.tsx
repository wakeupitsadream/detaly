/**
 * The admin order card (docs/phase-1b-implementation.md 15.3): the client's full phone and
 * name (the only page that shows them), items with their states, payments, receipts,
 * refunds, Rossko orders, client approvals, supplier returns, stock, the full journal with
 * payloads and rule labels, and the action forms.
 */
import type { IsoDate } from '@detaly/domain';
import type { StaffActionView } from '@detaly/orders';
import Link from 'next/link';
import type { ReactNode } from 'react';
import type { AdminQr } from '@/server/admin/handover-qr';
import type { AdminOrderCard as AdminOrderCardData } from '@/server/admin/queries';
import { ActionForm, ADMIN_INPUT_CLASS, StaffActionForms } from './AdminActions';
import {
  adminStatusLabel,
  attentionLabel,
  dateTime,
  isoDate,
  ITEM_STATE_LABELS,
  payloadText,
  rub,
  SCHEME_LABELS,
} from './format';

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

function Table({ head, children }: { head: string[]; children: ReactNode }) {
  return (
    <div className="min-w-0 overflow-x-auto">
      <table className="w-full text-left text-sm">
        <thead className="border-b border-line text-muted">
          <tr>
            {head.map((title) => (
              <th key={title} className="px-2 py-1.5 font-medium whitespace-nowrap">
                {title}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

function Cell({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <td className={`px-2 py-1.5 align-top ${className}`}>{children}</td>;
}

function Empty({ text }: { text: string }) {
  return <p className="text-sm text-muted">{text}</p>;
}

function shortId(id: string | null | undefined): string {
  return id ? id.slice(-8) : '—';
}

export function AdminOrderCard({
  card,
  actions,
  done,
  qr,
  today,
}: {
  card: AdminOrderCardData;
  actions: StaffActionView[];
  done: string | null;
  qr: AdminQr | null;
  today: IsoDate;
}) {
  const { order, client } = card;
  const itemTitle = new Map(card.items.map((item) => [item.id, `${item.brand} ${item.article}`]));
  const pendingItems = card.items.filter((item) => item.state === 'pending');

  return (
    <div
      className="flex min-w-0 flex-col gap-4"
      data-testid="admin-order"
      data-order={order.number}
    >
      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
        <Link href="/admin" className="text-sm text-accent underline">
          ← Все заказы
        </Link>
        <h1 className="text-2xl font-bold">{order.number}</h1>
        <span
          className="rounded-full bg-order-soft px-3 py-1 text-sm font-semibold text-order"
          data-testid="admin-status"
          data-status={order.status}
        >
          {adminStatusLabel(order.status)}
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

      {order.attentionReason ? (
        <p className="rounded-card border border-warn bg-warn-soft px-4 py-2 text-warn">
          {attentionLabel(order.attentionReason)}
        </p>
      ) : null}

      <div className="grid min-w-0 gap-4 md:grid-cols-2">
        <Section title="Заказ">
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
            <dt className="text-muted">Схема</dt>
            <dd>{SCHEME_LABELS[order.paymentScheme]}</dd>
            <dt className="text-muted">Получение</dt>
            <dd>{order.fulfillment === 'courier' ? 'Курьер' : 'Самовывоз'}</dd>
            <dt className="text-muted">Сумма</dt>
            <dd>
              {rub(order.totalKop)}
              {order.courierFeeKop > 0 ? ` (доставка ${rub(order.courierFeeKop)})` : ''}
            </dd>
            <dt className="text-muted">Обещано к</dt>
            <dd>{isoDate(order.promisedDate)}</dd>
            <dt className="text-muted">Код выдачи</dt>
            <dd>{order.pickupCode ?? '—'}</dd>
            <dt className="text-muted">Создан</dt>
            <dd>{dateTime(order.createdAt)}</dd>
            <dt className="text-muted">Срок статуса</dt>
            <dd>{dateTime(order.expiresAt)}</dd>
            <dt className="text-muted">Клиент пришёл</dt>
            <dd>{dateTime(order.clientArrivedAt)}</dd>
            <dt className="text-muted">Вернуть Rossko до</dt>
            <dd>{dateTime(order.supplierReturnDeadlineAt)}</dd>
          </dl>
        </Section>

        <Section title="Клиент" testId="admin-client">
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
            <dt className="text-muted">Имя</dt>
            <dd data-testid="admin-client-name">{client.name ?? '—'}</dd>
            <dt className="text-muted">Телефон</dt>
            <dd>
              {client.anonymized ? (
                'обезличен'
              ) : (
                <a
                  href={`tel:${client.phone}`}
                  className="text-accent underline"
                  data-testid="admin-client-phone"
                >
                  {client.phone}
                </a>
              )}
            </dd>
            <dt className="text-muted">Неявок</dt>
            <dd>{client.noShowCount}</dd>
          </dl>
        </Section>
      </div>

      <Section title="Действия" testId="admin-actions-section">
        <StaffActionForms
          orderId={order.id}
          views={actions}
          alternatives={card.alternatives}
          today={today}
        />
        {order.status === 'needs_attention' && pendingItems.length > 0 ? (
          <div className="mt-4 border-t border-line pt-3">
            <ActionForm
              orderId={order.id}
              code="manual_supplier_order"
              label="Заказано вручную в ЛК Rossko"
            >
              <input
                type="text"
                name="rosskoOrderIds"
                required
                maxLength={500}
                placeholder="Номера заказов Rossko через запятую"
                className={`${ADMIN_INPUT_CLASS} w-72 max-w-full`}
              />
            </ActionForm>
          </div>
        ) : null}
      </Section>

      {qr ? (
        <Section title="QR на оплату" testId="admin-qr">
          <div className="flex flex-wrap items-start gap-4">
            {/* eslint-disable-next-line @next/next/no-img-element -- inline SVG data URI */}
            <img src={qr.dataUri} alt="QR-код оплаты" width={240} height={240} />
            <div className="text-sm">
              <p className="text-lg font-semibold">{rub(qr.amountKop)}</p>
              <p>Действует до {dateTime(qr.expiresAt)}</p>
              <p className="mt-2 text-muted">
                Покажите клиенту на экране. Ссылка клиенту не отправляется.
              </p>
            </div>
          </div>
        </Section>
      ) : null}

      <Section title="Позиции" testId="admin-items">
        <Table head={['Позиция', 'Кол-во', 'Клиенту', 'Закупка', 'Склад', 'Срок', 'Состояние']}>
          {card.items.map((item) => (
            <tr
              key={item.id}
              className="border-b border-line last:border-0"
              data-item={item.id}
              data-state={item.state}
            >
              <Cell className="wrap-anywhere">
                <span className="font-semibold">
                  {item.brand} {item.article}
                </span>
                <span className="block text-muted">{item.name}</span>
                {item.replacedByItemId ? (
                  <span className="block text-xs text-muted">
                    заменена на{' '}
                    {itemTitle.get(item.replacedByItemId) ?? shortId(item.replacedByItemId)}
                  </span>
                ) : null}
                {item.supplierItemError ? (
                  <span className="block text-xs text-warn">
                    Rossko: {payloadText(item.supplierItemError)}
                  </span>
                ) : null}
              </Cell>
              <Cell>{item.qty}</Cell>
              <Cell className="whitespace-nowrap">{rub(item.priceClientKop)}</Cell>
              <Cell className="whitespace-nowrap">{rub(item.priceSupplierAtOrderKop)}</Cell>
              <Cell>
                {item.stockId}
                {item.isLocal ? ' (город)' : ''}
              </Cell>
              <Cell className="whitespace-nowrap">{isoDate(item.etaDate)}</Cell>
              <Cell>
                <span data-testid="admin-item-state">{ITEM_STATE_LABELS[item.state]}</span>
                {item.arrivedAt ? (
                  <span className="block text-xs text-muted">{dateTime(item.arrivedAt)}</span>
                ) : null}
                {item.refundedAmountKop > 0 ? (
                  <span className="block text-xs text-muted">
                    возвращено {rub(item.refundedAmountKop)}
                  </span>
                ) : null}
              </Cell>
            </tr>
          ))}
        </Table>
      </Section>

      <Section title="Платежи" testId="admin-payments">
        {card.payments.length === 0 ? (
          <Empty text="Платежей нет." />
        ) : (
          <Table head={['Платёж', 'Вид', 'Статус', 'Сумма', 'Создан', 'Оплачен', '']}>
            {card.payments.map((payment) => (
              <tr key={payment.id} className="border-b border-line last:border-0">
                <Cell className="wrap-anywhere">
                  {payment.providerPaymentId ?? `без id (${shortId(payment.id)})`}
                  {payment.method ? (
                    <span className="block text-xs text-muted">{payment.method}</span>
                  ) : null}
                </Cell>
                <Cell>
                  {payment.kind === 'prepayment' ? 'предоплата' : 'полный'}
                  {payment.confirmationType === 'qr' ? ', QR' : ''}
                </Cell>
                <Cell>
                  {payment.status}
                  {payment.cancellationReason ? (
                    <span className="block text-xs text-muted">{payment.cancellationReason}</span>
                  ) : null}
                </Cell>
                <Cell className="whitespace-nowrap">{rub(payment.amountKop)}</Cell>
                <Cell className="whitespace-nowrap">{dateTime(payment.createdAt)}</Cell>
                <Cell className="whitespace-nowrap">{dateTime(payment.paidAt)}</Cell>
                <Cell>
                  {payment.status === 'succeeded' ? (
                    <ActionForm orderId={order.id} code="refund_payment" label="Вернуть платёж">
                      <input type="hidden" name="paymentId" value={payment.id} />
                      <input
                        type="text"
                        name="reason"
                        required
                        maxLength={500}
                        placeholder="Причина (без ПД)"
                        className={ADMIN_INPUT_CLASS}
                      />
                    </ActionForm>
                  ) : null}
                </Cell>
              </tr>
            ))}
          </Table>
        )}
      </Section>

      <Section title="Чеки" testId="admin-receipts">
        {card.receipts.length === 0 ? (
          <Empty text="Чеков нет." />
        ) : (
          <Table head={['Вид', 'Статус', 'ФД', 'Попыток', 'Ошибка', 'Создан']}>
            {card.receipts.map((receipt) => (
              <tr
                key={receipt.id}
                className="border-b border-line last:border-0"
                data-receipt={receipt.kind}
                data-status={receipt.status}
              >
                <Cell>{receipt.kind}</Cell>
                <Cell>
                  {receipt.status}
                  {receipt.alertedAt ? (
                    <span className="block text-xs text-warn">
                      алерт {dateTime(receipt.alertedAt)}
                    </span>
                  ) : null}
                </Cell>
                <Cell>{receipt.fiscalDocumentNumber ?? '—'}</Cell>
                <Cell>{receipt.attempts}</Cell>
                <Cell className="wrap-anywhere">{receipt.error ?? '—'}</Cell>
                <Cell className="whitespace-nowrap">{dateTime(receipt.createdAt)}</Cell>
              </tr>
            ))}
          </Table>
        )}
      </Section>

      <Section title="Возвраты денег" testId="admin-refunds">
        {card.refunds.length === 0 ? (
          <Empty text="Возвратов нет." />
        ) : (
          <Table head={['Сумма', 'Охват', 'Причина', 'Статус', 'Срок', 'Возвращено', 'Ошибка']}>
            {card.refunds.map((refund) => (
              <tr key={refund.id} className="border-b border-line last:border-0">
                <Cell className="whitespace-nowrap">{rub(refund.amountKop)}</Cell>
                <Cell>{refund.scope}</Cell>
                <Cell>{refund.reason}</Cell>
                <Cell>{refund.status}</Cell>
                <Cell className="whitespace-nowrap">{dateTime(refund.deadlineAt)}</Cell>
                <Cell className="whitespace-nowrap">{dateTime(refund.succeededAt)}</Cell>
                <Cell className="wrap-anywhere">{refund.error ?? '—'}</Cell>
              </tr>
            ))}
          </Table>
        )}
      </Section>

      <Section title="Заказы Rossko" testId="admin-supplier-orders">
        {card.supplierOrders.length === 0 ? (
          <Empty text="Заказов у Rossko нет." />
        ) : (
          <Table head={['Попытка', 'Статус', 'Номера Rossko', 'Позиции', 'Счёт', 'Ошибка']}>
            {card.supplierOrders.map((so) => (
              <tr key={so.id} className="border-b border-line last:border-0">
                <Cell>{so.attemptNo}</Cell>
                <Cell>{so.status}</Cell>
                <Cell className="wrap-anywhere">
                  {so.rosskoOrderIds.length > 0 ? so.rosskoOrderIds.join(', ') : '—'}
                </Cell>
                <Cell className="wrap-anywhere">
                  {so.itemIds.map((id) => itemTitle.get(id) ?? shortId(id)).join(', ') || '—'}
                </Cell>
                <Cell className="wrap-anywhere">
                  {so.invoiceNumber ? `№ ${so.invoiceNumber}` : '—'}
                  {so.invoiceAmountKop !== null ? `, ${rub(so.invoiceAmountKop)}` : ''}
                  {so.invoicePaymentRef ? (
                    <span className="block text-xs text-muted">
                      оплачен: {so.invoicePaymentRef}
                    </span>
                  ) : null}
                </Cell>
                <Cell className="wrap-anywhere">{so.error ?? '—'}</Cell>
              </tr>
            ))}
          </Table>
        )}
      </Section>

      <Section title="Согласования с клиентом" testId="admin-approvals">
        {card.approvals.length === 0 ? (
          <Empty text="Согласований нет." />
        ) : (
          <Table head={['Вид', 'Позиция', 'Предложение', 'Отправлено', 'Срок', 'Решение']}>
            {card.approvals.map((approval) => (
              <tr key={approval.id} className="border-b border-line last:border-0">
                <Cell>{approval.kind === 'alternative' ? 'аналог' : 'новый срок'}</Cell>
                <Cell>
                  {approval.orderItemId
                    ? (itemTitle.get(approval.orderItemId) ?? shortId(approval.orderItemId))
                    : 'весь заказ'}
                </Cell>
                <Cell className="wrap-anywhere">
                  {approval.proposal.kind === 'alternative'
                    ? `${approval.proposal.offer.brand} ${approval.proposal.offer.article}, ${rub(approval.proposal.priceClientKop)}${approval.proposal.etaDate ? `, к ${isoDate(approval.proposal.etaDate)}` : ''}`
                    : `к ${isoDate(approval.proposal.etaDate)}${approval.proposal.note ? ` (${approval.proposal.note})` : ''}`}
                </Cell>
                <Cell className="whitespace-nowrap">{dateTime(approval.notifiedAt)}</Cell>
                <Cell className="whitespace-nowrap">{dateTime(approval.expiresAt)}</Cell>
                <Cell>
                  {approval.decision ?? 'ждём'}
                  {approval.decidedAt ? (
                    <span className="block text-xs text-muted">{dateTime(approval.decidedAt)}</span>
                  ) : null}
                </Cell>
              </tr>
            ))}
          </Table>
        )}
      </Section>

      <Section title="Возвраты поставщику" testId="admin-supplier-returns">
        {card.supplierReturns.length === 0 ? (
          <Empty text="Возвратов поставщику нет." />
        ) : (
          <ul className="flex flex-col gap-3">
            {card.supplierReturns.map((ret) => (
              <li key={ret.id} className="border-b border-line pb-3 text-sm last:border-0">
                <p>
                  <span className="font-semibold">
                    {itemTitle.get(ret.orderItemId) ?? shortId(ret.orderItemId)}
                  </span>{' '}
                  — {ret.kind === 'claim' ? 'рекламация' : 'возврат'}, {ret.status}
                  {ret.amountExpectedKop !== null ? `, ждём ${rub(ret.amountExpectedKop)}` : ''}
                  {ret.amountReceivedKop !== null ? `, получено ${rub(ret.amountReceivedKop)}` : ''}
                </p>
                {ret.note ? <p className="text-muted">{ret.note}</p> : null}
                {ret.status === 'requested' ? (
                  <div className="mt-2 flex flex-col gap-2">
                    <ActionForm
                      orderId={order.id}
                      code="supplier_return_accept"
                      label="Rossko принял возврат"
                    >
                      <input type="hidden" name="supplierReturnId" value={ret.id} />
                      <input
                        type="text"
                        name="amountRub"
                        inputMode="decimal"
                        maxLength={20}
                        placeholder="Получено, ₽"
                        className={`${ADMIN_INPUT_CLASS} w-32`}
                      />
                    </ActionForm>
                    <ActionForm
                      orderId={order.id}
                      code="supplier_return_reject"
                      label="Rossko не принял: на склад"
                    >
                      <input type="hidden" name="supplierReturnId" value={ret.id} />
                      <input
                        type="text"
                        name="note"
                        maxLength={500}
                        placeholder="Комментарий"
                        className={ADMIN_INPUT_CLASS}
                      />
                    </ActionForm>
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </Section>

      {card.stockItems.length > 0 ? (
        <Section title="Склад" testId="admin-stock">
          <Table head={['Позиция', 'Себестоимость', 'Причина', 'Записано']}>
            {card.stockItems.map((stock) => (
              <tr key={stock.id} className="border-b border-line last:border-0">
                <Cell>{itemTitle.get(stock.orderItemId) ?? shortId(stock.orderItemId)}</Cell>
                <Cell className="whitespace-nowrap">{rub(stock.costKop)}</Cell>
                <Cell>{stock.reason}</Cell>
                <Cell className="whitespace-nowrap">{dateTime(stock.createdAt)}</Cell>
              </tr>
            ))}
          </Table>
        </Section>
      ) : null}

      <Section title="Журнал" testId="admin-timeline">
        <ol className="flex flex-col gap-3">
          {card.events.map((event) => {
            const rule =
              typeof event.payload.rule === 'string' ? (event.payload.rule as string) : null;
            return (
              <li
                key={event.id}
                className="border-b border-line pb-3 text-sm last:border-0"
                data-event={event.type}
              >
                <div className="flex flex-wrap gap-x-3 gap-y-1">
                  <time dateTime={event.createdAt.toISOString()} className="text-muted">
                    {dateTime(event.createdAt)}
                  </time>
                  <span className="font-mono font-semibold">{event.type}</span>
                  {event.fromStatus || event.toStatus ? (
                    <span>
                      {event.fromStatus ? adminStatusLabel(event.fromStatus) : '—'} →{' '}
                      {event.toStatus ? adminStatusLabel(event.toStatus) : '—'}
                    </span>
                  ) : null}
                  <span className="text-muted">
                    {event.actorType}
                    {event.actorId ? `:${shortId(event.actorId)}` : ''}
                  </span>
                </div>
                {rule ? <p className="mt-1 font-semibold">{rule}</p> : null}
                <pre className="mt-1 max-w-full overflow-x-auto rounded-md bg-paper p-2 font-mono text-xs">
                  {payloadText(event.payload)}
                </pre>
              </li>
            );
          })}
        </ol>
      </Section>
    </div>
  );
}
