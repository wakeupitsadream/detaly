// Texts of the client bot (docs/phase-1c-implementation.md section 8, decisions С2–С6, С24).
// PD minimisation (PLAN section 4): no client phone, name or address in any text; the brand and
// the pickup point's phone come from env; links lead to /o/<token>.
import type { OrderStatus } from '@detaly/domain';

/**
 * Statuses in the client's words. The same wording as the order page
 * (apps/web/src/server/orders/status-labels.ts), which the worker cannot import; the staff
 * labels of @detaly/orders name the supplier and are not for clients.
 */
export const CLIENT_STATUS_LABELS: Readonly<Record<OrderStatus, string>> = {
  draft: 'Оформляется',
  awaiting_payment: 'Ждёт оплаты',
  awaiting_confirmation: 'Ждёт подтверждения',
  confirmed: 'Подтверждён',
  ordering: 'Заказываем у поставщика',
  awaiting_supplier_invoice: 'Заказываем у поставщика',
  ordered_at_supplier: 'Заказан у поставщика',
  needs_attention: 'Уточняем детали заказа',
  awaiting_client_approval: 'Нужно ваше решение',
  ready: 'Готов к выдаче',
  out_for_delivery: 'Передан курьеру',
  awaiting_handover_payment: 'Ждёт оплаты при получении',
  handed: 'Выдан',
  completed: 'Завершён',
  cancelled: 'Отменён',
  refund_pending: 'Возвращаем деньги',
  refunded: 'Деньги возвращены',
};

export const TEXTS = {
  staleLink: 'Ссылка устарела. Нажмите «Статусы в Telegram» на странице заказа ещё раз.',
  askContact: (orderNumber: string | null): string =>
    `Чтобы подключить статусы заказа${orderNumber ? ` ${orderNumber}` : ''}, подтвердите номер ` +
    'телефона кнопкой ниже. Номер нужен только для сверки с заказом.',
  contactButton: 'Подтвердить номер',
  notOwnContact: 'Отправьте свой номер кнопкой ниже.',
  noPendingBind:
    'Сначала откройте ссылку со страницы заказа: кнопка «Статусы в Telegram». ' +
    'Ссылка действует 10 минут после нажатия Start.',
  bound: 'Готово: статусы заказов будут приходить сюда. Отключить — /stop',
  phoneMismatch:
    'Номер не совпадает с номером заказа — уведомления не подключены. ' +
    'Чтобы попробовать снова, нажмите «Статусы в Telegram» на странице заказа.',
  howToConnect: (brand: string): string =>
    `Этот бот присылает статусы заказов ${brand}. Чтобы подключить уведомления, откройте ` +
    'страницу заказа и нажмите «Статусы в Telegram». Это подписка на статусы, а не вход в аккаунт.',
  unblocked: 'Уведомления снова включены.',
  stopped: 'Уведомления отключены. Включить — /start',
  notConnected: (brand: string): string =>
    `Уведомления не подключены. ${TEXTS.howToConnect(brand)}`,
  noOrders: 'Заказов пока нет.',
  ordersHead: 'Ваши заказы:',
  notYours: 'Это не ваш заказ',
  blocked: 'Уведомления отключены — включите их командой /start',
  staleButton: 'Кнопка устарела — откройте /orders',
  failed: 'Не получилось, попробуйте ещё раз',
  confirmed: 'Заказ подтверждён',
  approved: 'Готово',
  confirmedText: (orderNumber: string): string =>
    `Заказ ${orderNumber} подтверждён. Напишем, когда деталь приедет.`,
  approvedText: (orderNumber: string): string =>
    `Заказ ${orderNumber}: ответ принят, продолжаем заказ.`,
  notActual: (status: string): string => `Уже не актуально: заказ ${status.toLowerCase()}`,
  unavailable: 'Сейчас недоступно — откройте страницу заказа',
  confirmOnPage: 'Подтвердите на странице заказа',
  confirmOnPageText: (orderNumber: string, what: string): string =>
    `Заказ ${orderNumber}: ${what} подтверждается на странице заказа — там нужны последние ` +
    '4 цифры телефона. Статус заказа не изменился.',
  autoReply: (pickupPhone: string | null): string =>
    pickupPhone
      ? `Бот присылает статусы заказов. Вопрос мастеру — по телефону ${pickupPhone}.`
      : 'Бот присылает статусы заказов. Вопрос мастеру — на странице заказа.',
  // --- installation (decision С6: no price anywhere, paid at the service by its receipt) -----
  installPaid: (partner: string, requisites: string | null): string =>
    `Установка — услуга ${partner}${requisites ? ` (${requisites})` : ''}, ` +
    'оплачивается в сервисе по его чеку.',
  installOff: 'Запись на установку пока недоступна.',
  installChoose: (orderNumber: string): string => `Заказ ${orderNumber}: выберите время установки.`,
  installOther: 'Другое время — на странице заказа',
  installStatus: (status: string): string => `Запись недоступна: заказ ${status.toLowerCase()}.`,
  installBooked: 'У заказа уже есть запись на установку — подробности на странице заказа.',
  installNoDate:
    'Дата получения детали ещё не известна — запишитесь, когда заказ будет в пути или приедет.',
  installNoHours: 'Запись временно недоступна — выберите время на странице заказа.',
  installFull: 'В ближайшие две недели свободного времени нет — посмотрите на странице заказа.',
  installSlotStale: 'Время устарело — выберите заново',
  installSlotTaken: 'Это время уже заняли — выберите другое',
  installBadSlot: 'Это время больше недоступно — выберите другое',
  installDone: (orderNumber: string, slot: string): string =>
    `Заказ ${orderNumber}: записали на ${slot}, ждём подтверждения мастера.`,
  installDoneShort: 'Записали',
  installRequested: (slot: string): string => `Запись на установку: ${slot}`,
} as const;
