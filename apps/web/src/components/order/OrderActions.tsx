/**
 * Payment and client decision blocks of /o/<token> (docs/phase-1b-implementation.md 14.4).
 * Server components: what is shown comes from the read model (OrderView.actions is the state
 * machine's dry run); the buttons post to /api/orders/<token>/pay (a plain form) and
 * /api/orders/<token>/actions (ClientActionForm).
 */
import { formatRub } from '@detaly/domain';
import { IconAlert, IconCard, IconCheck, IconInfo, IconWallet } from '@/components/icons';
import { buttonClass } from '@/components/ui/Button';
import { cn } from '@/components/ui/cn';
import type { OrderView } from '@/server/orders/order-view';
import type { PayCheck, PayNotice } from '@/server/orders/pay-notice';
import { ClientActionForm } from './ClientActionForm';
import { Card } from './OrderSections';

const PRIMARY_BUTTON = cn(buttonClass({ variant: 'primary', size: 'lg' }), 'w-full sm:w-auto');

/** The payment way as the first line of the card: an icon and the scheme, 17 px bold. */
function SchemeLine({ prepay, children }: { prepay: boolean; children: string }) {
  const Icon = prepay ? IconCard : IconWallet;
  return (
    <p className="flex items-center gap-2.5 text-body font-bold">
      <Icon size={24} className="shrink-0 text-brand" />
      {children}
    </p>
  );
}

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
    tone === 'error'
      ? 'font-medium text-danger'
      : tone === 'success'
        ? 'font-semibold text-ok'
        : 'text-muted';
  const Icon = tone === 'error' ? IconAlert : tone === 'success' ? IconCheck : IconInfo;
  return (
    <p
      className={cn('mt-3 flex items-start gap-2 text-small', cls)}
      role={tone === 'error' ? 'alert' : 'status'}
      data-testid={testId}
    >
      <Icon size={20} className="mt-px shrink-0" />
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
        <SchemeLine prepay>Предоплата 100% онлайн</SchemeLine>
        {check?.kind === 'checking' ? (
          <>
            <meta httpEquiv="refresh" content={`${check.refreshSec};url=${check.refreshUrl}`} />
            <p className="mt-3 text-h3" role="status" data-testid="pay-checking">
              {PAY_TEXTS.checking}
            </p>
            <p className="mt-1 text-small font-normal text-muted">{PAY_TEXTS.checkingHint}</p>
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
              className="mt-4 inline-flex min-h-13 w-full cursor-not-allowed items-center justify-center rounded-control bg-surface-2 px-6 text-[1.0625rem] font-semibold text-muted sm:w-auto"
              data-testid="pay-button"
            >
              Оплатить {formatRub(totalKop)}
            </button>
            <p className="mt-2 text-small font-normal text-muted">{PAY_TEXTS.disabled}</p>
          </>
        ) : null}
      </Card>
    );
  }
  // Nothing to decide here: the head of the order says how it is paid already.
  if (!(status === 'awaiting_confirmation' || actions.prepayNow)) return null;
  return (
    <Card title="Оплата" testId="order-payment">
      <SchemeLine prepay={false}>Оплата при получении картой или по QR</SchemeLine>
      {status === 'awaiting_confirmation' && actions.confirm ? (
        <div className="mt-3 space-y-3">
          <p className="text-body">Подтвердите заказ — и мы отложим детали для вас.</p>
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
        <p className="mt-2 text-small font-normal text-muted">
          Подтверждение заказа подключается: мы свяжемся с вами.
        </p>
      ) : null}
      {actions.prepayNow ? (
        <div className="mt-3 space-y-3">
          <p className="text-small font-normal text-muted">
            Можно оплатить заранее и прийти только забрать детали.
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
    <Card
      title="Нужно ваше решение"
      icon={<IconAlert size={26} />}
      testId="order-approval"
      id="decision"
      attention
    >
      {approval.kind === 'alternative' && approval.alternative ? (
        <div className="space-y-1">
          <p className="wrap-anywhere">
            {itemTitle ? `Позицию ${itemTitle} поставщик привезти не может. ` : ''}
            Предлагаем замену по той же цене:
          </p>
          <p className="font-semibold wrap-anywhere" data-testid="approval-offer">
            {approval.alternative.brand}{' '}
            <span className="tabular-nums">{approval.alternative.article}</span> —{' '}
            {approval.alternative.name}
          </p>
          {approval.alternative.etaText ? (
            <p className="text-small text-muted">Приедет {approval.alternative.etaText}</p>
          ) : null}
        </div>
      ) : (
        <p className="wrap-anywhere" data-testid="approval-eta">
          Поставщик сдвинул срок{itemTitle ? ` по позиции ${itemTitle}` : ''}. Новый срок получения
          — <span className="font-semibold">{approval.etaText ?? 'уточняется'}</span>.
        </p>
      )}
      {approval.deadlineText ? (
        <p className="mt-2 text-small font-normal text-muted" data-testid="approval-deadline">
          Ответьте до {approval.deadlineText}. Если ответа не будет,{' '}
          {view.moneyHeld ? `вернём деньги ${target}` : 'отменим без оплаты'}.
        </p>
      ) : null}
      <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:flex-wrap">
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
      <p className="text-body font-bold" data-testid="order-wait-until">
        {until ? `Жду до ${until}` : 'Жду остальное'}
      </p>
      <p className="mt-1 text-small font-normal text-muted">
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
    <div id="refuse" className="min-w-0 scroll-mt-24 space-y-2" data-testid="order-refuse">
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
        block
      />
      <p className="text-small font-normal text-muted">{text}</p>
    </div>
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
