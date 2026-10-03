/**
 * Order notification templates, one per id in ORDER_NOTIFY_TEMPLATES (@detaly/domain).
 * Client texts carry only the order number, status, brand and article; staff cards show the
 * client phone masked and link to the admin for details (PLAN section 4, PD minimisation).
 *
 * SMS allowlisted templates (confirm_request, decision_needed, arrived, money_sent) also set
 * `smsText`: SMS has no buttons, so it sends the client to /o/<token> (the URL button), and two
 * UCS-2 segments (134 characters) leave about 65 characters next to a 65-character link. The sender name carries the brand.
 *
 * Phase 1C (docs/phase-1c-implementation.md decision С2, section 7.1 item 2): every client
 * message links to /o/<token> (claims and installation at `#claim` / `#install`, where critical
 * actions are confirmed); besides the order number, status, brand and article a client message
 * may carry dates, the pickup point (the point's address and hours, not the client's), the pickup
 * code and the packaging photo. Claim decision texts and claim/VIN photos never go out.
 */
import { CLAIM_KIND_LABELS, type OrderNotifyTemplate } from '@detaly/domain';
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
/** The order page /o/<token>, optionally at a block (`#claim`, `#install`). */
const orderLink = (
  d: OrderTemplateData,
  text = 'Открыть заказ',
  anchor?: string,
): MessageButton => ({
  kind: 'url',
  text,
  url: anchor ? `${d.orderUrl}#${anchor}` : d.orderUrl,
});
/** «Претензия» opens the claim form of the order page (decision С5: confirmed there). */
const claimLink = (d: OrderTemplateData): MessageButton => orderLink(d, 'Претензия', 'claim');
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
/** At most one packaging photo; drivers without photos ignore it (decision С17). */
const withPhotos = (
  message: RenderedMessage,
  photos: readonly string[] | null | undefined,
): RenderedMessage =>
  photos && photos.length > 0 ? { ...message, photos: photos.slice(0, 1) } : message;

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
/**
 * Installation is the partner's service, paid at the service by its own receipt (decision С6,
 * PLAN risk 11: no agency, no price anywhere).
 */
const installPaid = (d: OrderTemplateData): string => {
  if (!d.installPartner) return 'Установка оплачивается в сервисе по его чеку.';
  const requisites = d.installPartnerRequisites ? ` (${d.installPartnerRequisites})` : '';
  return `Установка — услуга ${d.installPartner}${requisites}, оплачивается в сервисе по его чеку.`;
};
const partnerAt = (d: OrderTemplateData): string =>
  d.installPartner ? `, ${d.installPartner}` : '';
const slot = (d: OrderTemplateData): string => d.slotText ?? 'выбранное время';
const claimKind = (d: OrderTemplateData): string | null =>
  d.claim ? CLAIM_KIND_LABELS[d.claim.kind].toLowerCase() : null;
/** The pickup point: name, address and hours (the point's data, not the client's). */
const pickupLine = (d: OrderTemplateData): string | null =>
  d.pickup ? lines(`${d.pickup.name}, ${d.pickup.address}.`, d.pickup.hours || null) : null;
const pickupPlace = (d: OrderTemplateData): string =>
  d.pickup
    ? `${d.pickup.name}, ${d.pickup.address}${d.pickup.hours ? ` (${d.pickup.hours})` : ''}`
    : 'пункт выдачи';
/** Art. 22 ЗоЗПП: the answer within 10 days of the claim. */
const claimAnswer = (d: OrderTemplateData): string => {
  const date = d.claim?.deadlineDate ?? d.deadlineDate;
  return date ? `Ответим до ${deadline(date)}.` : 'Ответим в течение 10 дней.';
};
const claimMoney =
  'Если решение — возврат, деньги придут на ту же карту в течение 10 дней после решения.';

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
    msg(
      lines(head(d), what(d), `Сумма к оплате: ${rub(d.totalKop)}. Оплатите заказ по ссылке.`),
      [{ kind: 'url', text: 'Оплатить', url: d.paymentUrl ?? d.orderUrl }],
      d.paymentUrl ? [orderLink(d)] : [],
    ),
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
      [orderLink(d)],
    ),
  late_payment_refund: (d) =>
    msg(lines(head(d), `Оплата пришла после отмены заказа. ${refundPromise}`), [orderLink(d)]),
  confirmation_expired: (d) =>
    msg(lines(head(d), 'Заказ отменён: подтверждение не пришло за 24 часа.'), [orderLink(d)]),
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
  // PLAN section 3 «Приехало»: address, hours, pickup code, photo, «Записаться на установку».
  arrived: (d) =>
    withSms(
      withPhotos(
        msg(
          lines(
            head(d),
            what(d),
            typeof d.readyDays === 'number' && d.readyDays > 0
              ? `Заказ ждёт вас ${d.readyDays} дн.`
              : 'Заказ приехал.',
            storageEnding(d) ? storagePhrase(d) : null,
            d.pickupCode ? `Код выдачи: ${d.pickupCode}` : null,
            pickupLine(d),
            d.scheme === 'prepay' ? 'Заказ оплачен.' : 'Оплата при получении картой или по СБП.',
            d.installPartner ? `Можно записаться на установку. ${installPaid(d)}` : null,
          ),
          // Without INSTALL_PARTNER_NAME there is no booking (decision С6).
          d.installPartner ? [act(d, 'install', 'Записаться на установку')] : [],
          [orderLink(d)],
        ),
        d.photos,
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
      [claimLink(d)],
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
    msg(
      lines(head(d), 'Как деталь? Если что-то не так, оформите претензию на странице заказа.'),
      [claimLink(d)],
      [orderLink(d)],
    ),
  // PLAN section 3 «Претензия»: the client gets the order of actions.
  claim_received: (d) =>
    msg(
      d.claim?.kind === 'delay'
        ? lines(head(d), 'Претензия о просрочке принята.', claimAnswer(d), claimMoney)
        : lines(
            head(d),
            `Претензия принята${claimKind(d) ? ` (${claimKind(d)})` : ''}. Что дальше:`,
            `1. Принесите деталь в упаковке в ${pickupPlace(d)}. Без упаковки тоже примем — решим по состоянию детали.`,
            '2. Мастер примет деталь и сфотографирует её.',
            `3. ${claimAnswer(d)}`,
            `4. ${claimMoney}`,
          ),
      [orderLink(d, 'Претензия на странице заказа', 'claim')],
    ),
  money_sent: (d) =>
    withSms(
      msg(lines(head(d), 'Деньги отправлены. Срок зачисления зависит от банка.'), [orderLink(d)]),
      `Заказ ${d.orderNumber}: деньги отправлены, зачисление зависит от банка.`,
    ),

  // --- client, phase 1C --------------------------------------------------------------------
  // The decision text may contain PD: only a link to the order page (decision С2).
  claim_decided: (d) =>
    msg(lines(head(d), 'Ответ по претензии готов — он на странице заказа.'), [
      orderLink(d, 'Открыть ответ', 'claim'),
    ]),
  // Installation is the partner's service: no price anywhere (decision С6, PLAN risk 11).
  install_requested: (d) =>
    msg(
      lines(
        head(d),
        `Запись на установку: ${slot(d)}${partnerAt(d)}. Ждём подтверждения мастера.`,
        installPaid(d),
      ),
      [orderLink(d, 'Запись на странице заказа', 'install')],
    ),
  install_confirmed: (d) =>
    msg(
      lines(
        head(d),
        `Запись на установку подтверждена: ${slot(d)}${partnerAt(d)}.`,
        installPaid(d),
      ),
      [orderLink(d, 'Запись на странице заказа', 'install')],
    ),
  install_declined: (d) =>
    msg(
      lines(
        head(d),
        `Мастер не сможет принять машину: ${slot(d)}. Выберите другое время на странице заказа.`,
        installPaid(d),
      ),
      [orderLink(d, 'Выбрать другое время', 'install')],
    ),
  install_reminder: (d) =>
    msg(
      lines(
        head(d),
        `Напоминаем о записи на установку: ${slot(d)}${partnerAt(d)}.`,
        installPaid(d),
      ),
      [orderLink(d, 'Запись на странице заказа', 'install')],
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
      lines(
        `Претензия по заказу ${d.orderNumber}${claimKind(d) ? `: ${claimKind(d)}` : ''}.`,
        `Ответить до ${deadline(d.claim?.deadlineDate ?? d.deadlineDate)} (10 дней по закону).`,
      ),
      adminLink(d),
    ),
  staff_refund_failed: (d) =>
    msg(
      lines(
        `Заказ ${d.orderNumber}: возврат не прошёл.`,
        'Срок 10 дней продолжает идти. Проверьте причину в ЛК ЮKassa и нажмите «Повторить возврат» в карточке заказа.',
      ),
      adminLink(d),
    ),
  // --- staff, phase 1B (engine and workers, outside TRANSITIONS) ---------------------------
  staff_orphan_payment: (d) =>
    msg(
      lines(
        `Заказ ${d.orderNumber}: оплата после возврата`,
        `Оплачено ${rub(d.paidAmountKop)} по заказу, деньги за который уже возвращены или возвращаются.`,
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
  staff_payment_rejected: (d) =>
    msg(
      lines(
        `Заказ ${d.orderNumber}: ЮKassa не создала платёж`,
        d.note,
        `Платёж на ${rub(d.totalKop)} не создан, клиент не может оплатить. Проверьте настройки ЮKassa и чека; заказ отменится по сроку оплаты, QR на точке — выставите заново.`,
      ),
      adminLink(d),
    ),
  staff_refund_receipt_failed: (d) =>
    msg(
      lines(
        `Заказ ${d.orderNumber}: чек возврата не зарегистрирован`,
        d.note,
        'Деньги клиенту отправлены, но чека возврата нет (54-ФЗ). Проверьте чек в ЛК ЮKassa и при необходимости пробейте чек коррекции.',
      ),
      adminLink(d),
    ),
  // --- staff, phase 1C ----------------------------------------------------------------------
  // The client's text and photos stay in the admin (decision С2).
  staff_claim_opened: (d) =>
    msg(
      lines(
        `Претензия по заказу ${d.orderNumber}${claimKind(d) ? `: ${claimKind(d)}` : ''}.`,
        what(d),
        `Ответить до ${deadline(d.claim?.deadlineDate ?? d.deadlineDate)}.`,
        d.claim?.kind === 'delay'
          ? null
          : 'Деталь примите только с фото («Принял возврат»); текст и фото клиента — в админке.',
      ),
      adminLink(d),
    ),
  staff_install_request: (d) =>
    msg(
      lines(
        `Заказ ${d.orderNumber}: запись на установку ${slot(d)}.`,
        'Подтвердите или отклоните в карточке заказа.',
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
