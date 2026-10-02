/**
 * Order notification templates, one per id in ORDER_NOTIFY_TEMPLATES (@detaly/domain).
 * Client texts carry only the order number, status, brand and article; staff cards show the
 * client phone masked and link to the admin for details (PLAN section 4, PD minimisation).
 *
 * SMS allowlisted templates (confirm_request, decision_needed, arrived, money_sent) also set
 * `smsText`: SMS has no buttons, so it sends the client to /o/<token> (the URL button), and two
 * UCS-2 segments (134 characters) leave about 65 characters next to a 65-character link. The sender name carries the brand.
 */
import type { OrderNotifyTemplate } from '@detaly/domain';
import type { CallbackAction } from '../actions';
import { deadline, formatReplyBy, itemsLine, lines, maskPhone, promise, rub } from '../format';
import type { MessageButton, OrderTemplateData, RenderedMessage } from '../types';

type Render = (d: OrderTemplateData) => RenderedMessage;

const act = (d: OrderTemplateData, action: CallbackAction, text: string): MessageButton => ({
  kind: 'action',
  text,
  action,
  orderId: d.orderId,
});
const orderLink = (d: OrderTemplateData, text = 'Открыть заказ'): MessageButton => ({
  kind: 'url',
  text,
  url: d.orderUrl,
});
const adminLink = (d: OrderTemplateData): MessageButton[] =>
  d.adminUrl ? [{ kind: 'url', text: 'Открыть в админке', url: d.adminUrl }] : [];

const msg = (text: string, ...rows: MessageButton[][]): RenderedMessage => ({
  text,
  buttons: rows.filter((row) => row.length > 0),
});
const withSms = (message: RenderedMessage, smsText: string): RenderedMessage => ({
  ...message,
  smsText,
});

const head = (d: OrderTemplateData): string => `${d.brandName} · заказ ${d.orderNumber}`;
const what = (d: OrderTemplateData): string | null => {
  const text = itemsLine(d.items);
  return text === '' ? null : text;
};
const refundPromise = 'Деньги вернутся в течение 10 дней.';
const until = (d: OrderTemplateData, compact = false): string => {
  const at = formatReplyBy(d.replyBy, { compact });
  return at === null ? '' : ` до ${at}`;
};
/** SMS deadline: '14:30 03.10', so it fits next to a long order link. */
const untilSms = (d: OrderTemplateData): string => until(d, true);

/**
 * The storage phrase goes into the last ready reminder: at most one day of the offer's storage
 * window left (day 9 of 10 for prepay, day 6 of 7 for pay on handover).
 */
const STORAGE_WARN_DAYS_LEFT = 1;
const storageEnding = (d: OrderTemplateData): boolean =>
  typeof d.readyDays === 'number' &&
  d.readyDays > 0 &&
  typeof d.storageDays === 'number' &&
  d.storageDays - d.readyDays <= STORAGE_WARN_DAYS_LEFT;
const storagePhrase = (d: OrderTemplateData): string =>
  d.scheme === 'prepay'
    ? `По оферте заказ хранится ${d.storageDays} дн., затем возврат денег.`
    : `По оферте заказ хранится ${d.storageDays} дн., затем заказ отменяется.`;

export const ORDER_TEMPLATES: Record<OrderNotifyTemplate, Render> = {
  // --- client ------------------------------------------------------------------------------
  confirm_request: (d) =>
    withSms(
      msg(
        lines(
          head(d),
          what(d),
          `Подтвердите заказ${until(d)}. Оплата при получении в пункте выдачи.`,
        ),
        [act(d, 'confirm', 'Подтверждаю')],
        [orderLink(d)],
      ),
      // The deadline goes before the filler: renderSmsText cuts from the end.
      `Подтвердите заказ ${d.orderNumber}${untilSms(d)} на странице.`,
    ),
  payment_link: (d) =>
    msg(lines(head(d), what(d), `Сумма к оплате: ${rub(d.totalKop)}. Оплатите заказ по ссылке.`), [
      { kind: 'url', text: 'Оплатить', url: d.paymentUrl ?? d.orderUrl },
    ]),
  paid: (d) =>
    msg(lines(head(d), `Заказ оплачен, чек отправлен. Ждём ${promise(d.promisedDate)}.`), [
      orderLink(d),
    ]),
  payment_expired: (d) =>
    msg(
      lines(
        head(d),
        'Срок оплаты истёк, заказ отменён. Если деталь ещё нужна, оформите заказ заново.',
      ),
    ),
  late_payment_refund: (d) =>
    msg(lines(head(d), `Оплата пришла после отмены заказа. ${refundPromise}`), [orderLink(d)]),
  confirmation_expired: (d) =>
    msg(lines(head(d), 'Заказ отменён: подтверждение не пришло за 24 часа.')),
  ordered: (d) =>
    msg(lines(head(d), what(d), `Деталь заказана, ждём ${promise(d.promisedDate)}.`), [
      orderLink(d),
    ]),
  decision_needed: (d) =>
    withSms(
      msg(
        lines(head(d), `Нужно ваше решение по заказу ${d.orderNumber}${until(d)}.`, d.note),
        [act(d, 'approve', 'Согласен'), act(d, 'refund', 'Вернуть деньги')],
        [orderLink(d, 'Подробнее')],
      ),
      `Нужно ваше решение по заказу ${d.orderNumber}${untilSms(d)}.`,
    ),
  refund_started: (d) => msg(lines(head(d), `Заказ отменён. ${refundPromise}`), [orderLink(d)]),
  order_cancelled: (d) =>
    msg(
      lines(
        head(d),
        d.scheme === 'prepay'
          ? `Заказ отменён. ${refundPromise}`
          : 'Заказ отменён. Оплаты не было, ничего делать не нужно.',
      ),
      [orderLink(d)],
    ),
  item_cancelled: (d) =>
    msg(
      lines(
        head(d),
        d.scheme === 'prepay'
          ? `Одна позиция отменена. Деньги за неё вернутся в течение 10 дней.`
          : 'Одна позиция отменена. Остальное в работе, оплата при получении.',
      ),
      [orderLink(d)],
    ),
  arrived: (d) =>
    withSms(
      msg(
        lines(
          head(d),
          typeof d.readyDays === 'number' && d.readyDays > 0
            ? `Заказ ждёт вас ${d.readyDays} дн.`
            : 'Заказ приехал.',
          storageEnding(d) ? storagePhrase(d) : null,
          d.pickupCode ? `Код выдачи: ${d.pickupCode}` : null,
          d.pickup ? `${d.pickup.name}, ${d.pickup.address}. ${d.pickup.hours}` : null,
          d.scheme === 'prepay' ? 'Заказ оплачен.' : 'Оплата при получении картой или по СБП.',
        ),
        [orderLink(d, 'Код выдачи и запись на установку')],
      ),
      storageEnding(d)
        ? `Заказ ${d.orderNumber}: хранение по оферте ${d.storageDays} дн., затем ${
            d.scheme === 'prepay' ? 'возврат денег' : 'отмена'
          }.`
        : lines(
            typeof d.readyDays === 'number' && d.readyDays > 0
              ? `Заказ ${d.orderNumber} ждёт вас ${d.readyDays} дн.`
              : `Заказ ${d.orderNumber} приехал.`,
            d.pickupCode ? `Код выдачи ${d.pickupCode}.` : null,
          ),
    ),
  partial_arrival: (d) =>
    msg(lines(head(d), `Часть заказа приехала, остальное ждём ${promise(d.promisedDate)}.`), [
      orderLink(d),
    ]),
  new_eta: (d) =>
    msg(
      lines(
        head(d),
        `Деталь пришла с повреждением, заказали замену. Новый срок: ${promise(d.promisedDate)}.`,
      ),
      [orderLink(d)],
    ),
  eta_changed: (d) =>
    msg(
      lines(head(d), `Срок сдвинулся: ждём ${promise(d.promisedDate)}.`, d.note),
      // The order stays ordered_at_supplier: giving up here is a refusal (ст. 26.1).
      [act(d, 'refused', d.scheme === 'prepay' ? 'Вернуть деньги' : 'Отказаться от заказа')],
      [orderLink(d)],
    ),
  handed: (d) =>
    msg(
      lines(head(d), 'Заказ выдан, чек отправлен. 7 дней на отказ — памятка на странице заказа.'),
      [orderLink(d)],
    ),
  courier_on_way: (d) => msg(lines(head(d), 'Заказ передан курьеру.', d.note), [orderLink(d)]),
  delivery_failed: (d) =>
    msg(lines(head(d), 'Курьер не смог передать заказ. Мы свяжемся с вами.'), [orderLink(d)]),
  storage_expired: (d) =>
    msg(
      lines(
        head(d),
        d.scheme === 'prepay'
          ? `Срок хранения истёк, заказ отменён. ${refundPromise}`
          : 'Срок хранения истёк, заказ отменён.',
      ),
      [orderLink(d)],
    ),
  how_is_it: (d) =>
    msg(lines(head(d), 'Как деталь? Если что-то не так, оформите претензию на странице заказа.'), [
      orderLink(d),
    ]),
  claim_received: (d) =>
    msg(lines(head(d), 'Претензия принята. Ответим в течение 10 дней.'), [orderLink(d)]),
  money_sent: (d) =>
    withSms(
      msg(lines(head(d), 'Деньги отправлены. Срок зачисления зависит от банка.'), [orderLink(d)]),
      `Заказ ${d.orderNumber}: деньги отправлены, зачисление зависит от банка.`,
    ),

  // --- staff -------------------------------------------------------------------------------
  staff_new_order: (d) =>
    msg(
      lines(
        `Новый заказ ${d.orderNumber} · ${d.scheme === 'prepay' ? 'предоплата' : 'оплата при получении'}`,
        what(d),
        `Сумма: ${rub(d.totalKop)} · клиент ${maskPhone(d.clientPhone)}`,
      ),
      [act(d, 'recheck', 'Проверить и заказать')],
      // A confirmed order is cancelled through the refusal rule (staff may press it).
      [
        act(
          d,
          'refused',
          d.scheme === 'prepay' ? 'Отказ клиента: вернуть деньги' : 'Отказ клиента',
        ),
      ],
      adminLink(d),
    ),
  staff_amount_mismatch: (d) =>
    msg(
      lines(
        `Заказ ${d.orderNumber}: сумма платежа не совпала`,
        `Оплачено ${rub(d.paidAmountKop)}, сумма заказа ${rub(d.totalKop)}.`,
      ),
      adminLink(d),
    ),
  staff_unexpected_payment: (d) =>
    msg(
      lines(
        `Заказ ${d.orderNumber}: неожиданный платёж`,
        `Оплачено ${rub(d.paidAmountKop)}, сумма заказа ${rub(d.totalKop)}.`,
        'Платёж прошёл, когда заказ не ждал оплаты (дубль или устаревшая ссылка). Проверьте и при необходимости верните деньги.',
      ),
      adminLink(d),
    ),
  staff_supplier_invoice_due: (d) =>
    msg(
      lines(
        `Заказ ${d.orderNumber}: оплатить счёт Rossko`,
        d.supplierInvoice
          ? `Счёт № ${d.supplierInvoice.number} на сумму ${rub(d.supplierInvoice.amountKop)}.`
          : null,
      ),
      [act(d, 'invpaid', 'Счёт оплачен')],
      adminLink(d),
    ),
  // Aliases and a new ETA are per item (ialt/ieta menus with item ids): the seller bot card
  // draws them from the database (decision Б17); the template keeps the order-level actions.
  staff_problem: (d) =>
    msg(
      lines(
        `Проблема по заказу ${d.orderNumber}`,
        what(d),
        d.note,
        `Клиент ${maskPhone(d.clientPhone)}`,
      ),
      [act(d, 'anyway', 'Заказать всё равно'), act(d, 'cancel', 'Отменить заказ')],
      adminLink(d),
    ),
  staff_client_approved: (d) => msg(`Заказ ${d.orderNumber}: клиент согласен.`, adminLink(d)),
  staff_delay_hint: (d) =>
    msg(
      lines(
        `Заказ ${d.orderNumber}: срок сдвинулся, ждём ${promise(d.promisedDate)}.`,
        d.scheme === 'prepay'
          ? 'Просрочка выдачи предоплаченного товара — неустойка 0,5% в день.'
          : null,
      ),
      adminLink(d),
    ),
  staff_delivery_failed: (d) =>
    msg(lines(`Заказ ${d.orderNumber}: курьер не передал заказ.`, d.note), adminLink(d)),
  staff_supplier_return_task: (d) =>
    msg(
      lines(
        `Заказ ${d.orderNumber} не выкуплен.`,
        `Вернуть Rossko до ${deadline(d.deadlineDate, 'срока возврата')}.`,
      ),
      adminLink(d),
    ),
  staff_cancel_at_supplier_task: (d) =>
    msg(
      lines(
        `Заказ ${d.orderNumber}: отказ клиента.`,
        'Отменить у Rossko через ЛК или менеджера до отгрузки, иначе — возврат поставщику.',
      ),
      adminLink(d),
    ),
  staff_claim_deadline: (d) =>
    msg(
      lines(`Претензия по заказу ${d.orderNumber}.`, `Ответить до ${deadline(d.deadlineDate)}.`),
      adminLink(d),
    ),
  staff_refund_failed: (d) =>
    msg(
      lines(
        `Заказ ${d.orderNumber}: возврат не прошёл.`,
        'Срок 10 дней продолжает идти, проверьте возврат в ЛК ЮKassa.',
      ),
      adminLink(d),
    ),
  // --- staff, phase 1B (engine and workers, outside TRANSITIONS) ---------------------------
  staff_orphan_payment: (d) =>
    msg(
      lines(
        `Заказ ${d.orderNumber}: оплата после возврата`,
        `Оплачено ${rub(d.paidAmountKop)} по заказу, деньги за который уже возвращены.`,
        'Платёж возвращается автоматически, статус заказа не меняется. Проверьте возврат в ЛК ЮKassa.',
      ),
      adminLink(d),
    ),
  staff_receipt_failed: (d) =>
    msg(
      lines(
        `Заказ ${d.orderNumber}: чек не прошёл`,
        d.note,
        'Выдача заблокирована до чека. Клиенту — «приходите позже»; проверьте настройки чеков и нажмите «Повторить чек» в карточке заказа.',
      ),
      adminLink(d),
    ),
  staff_approval_unreachable: (d) =>
    msg(
      lines(
        `Заказ ${d.orderNumber}: клиент не получил уведомление`,
        'Нужно решение клиента, но написать ему некуда. Таймер ответа не запущен: позвоните клиенту и попросите выбрать «Согласен» или «Вернуть деньги» на странице заказа (ссылка из подтверждения заказа).',
        `Клиент ${maskPhone(d.clientPhone)}`,
      ),
      adminLink(d),
    ),
  staff_refund_deadline: (d) =>
    msg(
      lines(
        `Заказ ${d.orderNumber}: срок возврата денег`,
        `Вернуть до ${deadline(d.deadlineDate)} (10 дней по закону). Возврат ещё не прошёл.`,
      ),
      adminLink(d),
    ),
};

export function renderOrderTemplate(
  template: OrderNotifyTemplate,
  data: OrderTemplateData,
): RenderedMessage {
  return ORDER_TEMPLATES[template](data);
}
