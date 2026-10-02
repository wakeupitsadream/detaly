/**
 * Payment and client decision blocks of /o/<token> (docs/phase-1b-implementation.md 14.4).
 * Server components: what is shown comes from the read model (OrderView.actions is the state
 * machine's dry run); the buttons post to /api/orders/<token>/pay (a plain form) and
 * /api/orders/<token>/actions (ClientActionForm).
 */
import { formatRub } from '@detaly/domain';
import { IconAlert, IconCheck, IconInfo } from '@/components/icons';
import { buttonClass } from '@/components/ui/Button';
import { cn } from '@/components/ui/cn';
import type { OrderView } from '@/server/orders/order-view';
import type { PayCheck, PayNotice } from '@/server/orders/pay-notice';
import { ClientActionForm } from './ClientActionForm';
import { Card } from './OrderSections';

const PRIMARY_BUTTON = cn(buttonClass({ variant: 'primary', size: 'lg' }), 'w-full sm:w-auto');

export const PAY_TEXTS = {
  checking: 'Проверяем оплату…',
  checkingHint: 'Страница обновится сама, это займёт до пары минут.',
  slow: 'Оплата ещё не подтвердилась. Если деньги списались, статус обновится в течение 10 минут — обновите страницу позже.',
  paid: 'Оплата получена, спасибо!',
  failed: 'Оплата не прошла. Попробуйте ещё раз.',
  error: 'Не удалось создать платёж, попробуйте ещё раз.',
  unavailable: 'Оплата онлайн пока не подключена — попробуйте позже или позвоните нам.',
  disabled: 'Оплата подключается — пришлём ссылку, как только она заработает.',
} as const;

function PayForm({ token, totalKop, label }: { token: string; totalKop: number; label?: string }) {
  return (
    <form method="post" action={`/api/orders/${token}/pay`} className="mt-4">
      <button type="submit" className={PRIMARY_BUTTON} data-testid="pay-button">
        {label ?? `Оплатить ${formatRub(totalKop)}`}
      </button>
    </form>
  );
}

function Notice({
  tone,
  children,
  testId,
}: {
  tone: 'info' | 'error' | 'success';
  children: string;
  testId: string;
}) {
  const cls =
    tone === 'error' ? 'text-danger' : tone === 'success' ? 'font-medium text-ok' : 'text-muted';
  const Icon = tone === 'error' ? IconAlert : tone === 'success' ? IconCheck : IconInfo;
  return (
    <p
      className={cn('mt-3 flex items-start gap-2 text-sm', cls)}
      role={tone === 'error' ? 'alert' : 'status'}
      data-testid={testId}
    >
      <Icon size={16} className="mt-0.5 shrink-0" />
      <span className="min-w-0">{children}</span>
    </p>
  );
}

/**
 * «Оплата» card. Prepay: «Оплатить N ₽» while awaiting_payment (decision Б6: an inactive button
 * and «Оплата подключается» without YooKassa); after the return from the payment page
 * «Проверяем оплату…» with a refresh every 5 s for up to two minutes. Pay on handover: the
 * confirmation («Подтверждаю») and, at `ready`, «Оплатить заранее».
 */
export function PaymentBlock({
  view,
  notice,
  check,
  contactPhone,
}: {
  view: OrderView;
  notice: PayNotice;
  check: PayCheck | null;
  contactPhone: string | null;
}) {
  const { scheme, status, totalKop, token, actions } = view;
  if (scheme === 'prepay') {
    const waiting = status === 'awaiting_payment';
    return (
      <Card title="Оплата" testId="order-payment">
        <p className="font-display text-lg font-semibold">Предоплата 100% онлайн</p>
        {check?.kind === 'checking' ? (
          <>
            <meta httpEquiv="refresh" content={`${check.refreshSec};url=${check.refreshUrl}`} />
            <p
              className="mt-3 font-display text-lg font-semibold"
              role="status"
              data-testid="pay-checking"
            >
              {PAY_TEXTS.checking}
            </p>
            <p className="mt-1 text-sm text-muted">{PAY_TEXTS.checkingHint}</p>
          </>
        ) : null}
        {check?.kind === 'slow' ? (
          <Notice tone="info" testId="pay-slow">
            {PAY_TEXTS.slow}
          </Notice>
        ) : null}
        {check?.kind === 'paid' ? (
          <Notice tone="success" testId="pay-paid">
            {PAY_TEXTS.paid}
          </Notice>
        ) : null}
        {waiting && check?.kind === 'failed' ? (
          <Notice tone="error" testId="pay-failed">
            {PAY_TEXTS.failed}
          </Notice>
        ) : null}
        {waiting && notice.payError ? (
          <Notice tone="error" testId="pay-error">
            {notice.payError === 'unavailable' ? PAY_TEXTS.unavailable : PAY_TEXTS.error}
          </Notice>
        ) : null}
        {waiting && actions.pay && check?.kind !== 'checking' ? (
          <PayForm token={token} totalKop={totalKop} />
        ) : null}
        {waiting && !view.paymentsEnabled ? (
          <>
            <button
              type="button"
              disabled
              aria-disabled="true"
              className="mt-4 inline-flex min-h-13 w-full cursor-not-allowed items-center justify-center rounded bg-paper-2 px-7 font-semibold text-faint sm:w-auto"
              data-testid="pay-button"
            >
              Оплатить {formatRub(totalKop)}
            </button>
            <p className="mt-2 text-sm text-muted">{PAY_TEXTS.disabled}</p>
          </>
        ) : null}
      </Card>
    );
  }
  return (
    <Card title="Оплата" testId="order-payment">
      <p className="font-display text-lg font-semibold">Оплата при получении картой или по QR</p>
      {status === 'awaiting_confirmation' && actions.confirm ? (
        <div className="mt-3 space-y-2">
          <p className="text-sm text-muted">
            Подтвердите заказ: после этого мы отложим детали для вас. Оплата — при получении.
          </p>
          <ClientActionForm
            token={token}
            action="confirm"
            digits={false}
            tone="primary"
            openLabel="Подтверждаю"
            confirmText="Подтверждаете заказ? Оплатите его при получении картой или по QR."
            submitLabel="Да, подтверждаю"
            pendingLabel="Подтверждаем…"
            doneText="Заказ подтверждён"
            testId="order-confirm"
            contactPhone={contactPhone}
          />
        </div>
      ) : null}
      {status === 'awaiting_confirmation' && !actions.confirm ? (
        <p className="mt-2 text-sm text-muted">
          Подтверждение заказа подключается: мы свяжемся с вами.
        </p>
      ) : null}
      {actions.prepayNow ? (
        <div className="mt-3 space-y-2">
          <p className="text-sm text-muted">
            Можно оплатить заказ заранее онлайн и прийти только забрать детали.
          </p>
          <ClientActionForm
            token={token}
            action="prepay_now"
            digits={false}
            openLabel="Оплатить заранее"
            confirmText={`Заказ перейдёт на предоплату: оплатите ${formatRub(totalKop)} онлайн на этой странице.`}
            submitLabel="Перейти к оплате"
            pendingLabel="Переводим…"
            doneText="Заказ переведён на предоплату"
            testId="order-prepay-now"
            contactPhone={contactPhone}
          />
        </div>
      ) : null}
    </Card>
  );
}

/** «Нужно ваше решение»: the proposal with «Согласен» / «Вернуть деньги» (4 digits). */
export function ApprovalBlock({
  view,
  contactPhone,
}: {
  view: OrderView;
  contactPhone: string | null;
}) {
  const approval = view.approval;
  if (approval === null || (!view.actions.approve && !view.actions.refundRequest)) return null;
  const itemTitle = approval.item ? `${approval.item.brand} ${approval.item.article}` : null;
  const target = approval.refundsWholeOrder ? 'за заказ' : 'за позицию';
  const refundLabel = view.moneyHeld
    ? 'Вернуть деньги'
    : approval.refundsWholeOrder
      ? 'Отменить заказ'
      : 'Отменить позицию';
  const refundText = view.moneyHeld
    ? `Вернём деньги ${target} в течение 10 дней.`
    : approval.refundsWholeOrder
      ? 'Заказ будет отменён. Оплаты не было — возвращать нечего.'
      : 'Позиция будет отменена, остальное привезём.';
  return (
    <Card title="Нужно ваше решение" testId="order-approval">
      {approval.kind === 'alternative' && approval.alternative ? (
        <div className="space-y-1">
          <p className="wrap-anywhere">
            {itemTitle ? `Позицию ${itemTitle} поставщик привезти не может. ` : ''}
            Предлагаем замену по той же цене:
          </p>
          <p className="font-semibold wrap-anywhere" data-testid="approval-offer">
            {approval.alternative.brand}{' '}
            <span className="font-mono">{approval.alternative.article}</span> —{' '}
            {approval.alternative.name}
          </p>
          {approval.alternative.etaText ? (
            <p className="text-sm text-muted">Приедет {approval.alternative.etaText}</p>
          ) : null}
        </div>
      ) : (
        <p className="wrap-anywhere" data-testid="approval-eta">
          Поставщик сдвинул срок{itemTitle ? ` по позиции ${itemTitle}` : ''}. Новый срок получения
          — <span className="font-semibold">{approval.etaText ?? 'уточняется'}</span>.
        </p>
      )}
      {approval.deadlineText ? (
        <p className="mt-2 text-sm text-muted" data-testid="approval-deadline">
          Ответьте до {approval.deadlineText}. Если ответа не будет,{' '}
          {view.moneyHeld ? `вернём деньги ${target}` : 'отменим без оплаты'}.
        </p>
      ) : null}
      <div className="mt-3 flex flex-col gap-3">
        {view.actions.approve ? (
          <ClientActionForm
            token={view.token}
            action="approve"
            digits={false}
            tone="primary"
            openLabel="Согласен"
            confirmText={
              approval.kind === 'alternative'
                ? 'Согласны на замену? Цена не меняется.'
                : 'Согласны подождать до нового срока?'
            }
            submitLabel="Да, согласен"
            pendingLabel="Сохраняем…"
            doneText="Спасибо, продолжаем выполнять заказ"
            testId="order-approve"
            contactPhone={contactPhone}
          />
        ) : null}
        {view.actions.refundRequest ? (
          <ClientActionForm
            token={view.token}
            action="refund_request"
            digits
            openLabel={refundLabel}
            confirmText={refundText}
            submitLabel={refundLabel}
            pendingLabel="Оформляем…"
            doneText={view.moneyHeld ? 'Оформили возврат денег' : 'Готово'}
            testId="order-refund-request"
            contactPhone={contactPhone}
          />
        ) : null}
      </div>
    </Card>
  );
}

/** Part of the order arrived: «Жду до <дата>» (nothing to do) or «Отменить позицию». */
export function PartialArrivalBlock({
  view,
  contactPhone,
}: {
  view: OrderView;
  contactPhone: string | null;
}) {
  if (view.partialArrival === null) return null;
  const waiting = view.items.filter((item) => item.waiting);
  const cancellable = waiting.filter((item) => item.canCancel);
  const until = view.partialArrival.waitUntilText;
  return (
    <Card title="Часть заказа уже приехала" testId="order-partial">
      <p className="font-medium" data-testid="order-wait-until">
        {until ? `Жду до ${until}` : 'Жду остальное'}
      </p>
      <p className="mt-1 text-sm text-muted">
        Если готовы подождать, ничего делать не нужно — сообщим, когда приедет всё.
        {view.moneyHeld && cancellable.length > 0
          ? ' Позицию, которая задерживается, можно отменить: деньги за неё вернём в течение 10 дней.'
          : ''}
      </p>
      {cancellable.length > 0 ? (
        <ul className="mt-3 space-y-3">
          {cancellable.map((item) => (
            <li key={item.id} className="min-w-0">
              <ClientActionForm
                token={view.token}
                action="item_cancel"
                itemId={item.id}
                digits
                openLabel={`Отменить позицию ${item.brand} ${item.article}`}
                confirmText={`Отменить ${item.brand} ${item.article} (${item.qty} шт.)? ${
                  view.moneyHeld
                    ? `Вернём ${formatRub(item.lineTotalKop)} в течение 10 дней.`
                    : 'Оплаты за неё не было.'
                }`}
                submitLabel="Отменить позицию"
                pendingLabel="Отменяем…"
                doneText="Позиция отменена"
                testId={`order-item-cancel-${item.id}`}
                contactPhone={contactPhone}
              />
            </li>
          ))}
        </ul>
      ) : null}
    </Card>
  );
}

/** «Отказаться от заказа» before handover (ст. 26.1 ЗоЗПП), 4 digits. */
export function RefuseBlock({
  view,
  contactPhone,
}: {
  view: OrderView;
  contactPhone: string | null;
}) {
  if (!view.actions.refuse) return null;
  const text = view.moneyHeld
    ? 'Отказаться от заказа можно до получения. Деньги вернём в течение 10 дней.'
    : 'Отказаться от заказа можно до получения. Оплаты не было — возвращать нечего.';
  return (
    <section
      className="min-w-0 rounded border border-line bg-card p-5 md:p-6"
      data-testid="order-refuse"
    >
      <p className="mb-4 text-sm text-muted">{text}</p>
      <ClientActionForm
        token={view.token}
        action="refuse"
        tone="danger"
        digits
        openLabel="Отказаться от заказа"
        confirmText={text}
        submitLabel="Отказаться от заказа"
        pendingLabel="Оформляем отказ…"
        doneText={view.moneyHeld ? 'Отказ оформлен, возвращаем деньги' : 'Заказ отменён'}
        testId="order-refuse-form"
        contactPhone={contactPhone}
      />
    </section>
  );
}

/** Money going back: the amount, the 10-day deadline, «Деньги отправлены». */
export function RefundBlock({ view }: { view: OrderView }) {
  const refund = view.refund;
  if (refund === null || (refund.pendingKop === 0 && refund.sentKop === 0)) return null;
  return (
    <Card title="Возврат денег" testId="order-refund">
      {refund.pendingKop > 0 ? (
        <p data-testid="refund-pending">
          Возвращаем <span className="font-semibold">{formatRub(refund.pendingKop)}</span>.
          {refund.deadlineText ? ` Деньги вернутся до ${refund.deadlineText}.` : ''}
        </p>
      ) : null}
      {refund.sentKop > 0 ? (
        <p className={refund.pendingKop > 0 ? 'mt-2' : ''} data-testid="refund-sent">
          Деньги отправлены: <span className="font-semibold">{formatRub(refund.sentKop)}</span>.
          Срок зачисления на карту зависит от банка.
        </p>
      ) : null}
    </Card>
  );
}
