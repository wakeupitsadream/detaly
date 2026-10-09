// Texts of the client bot (docs/phase-1c-implementation.md section 8, decisions С2–С6, С24).
// PD minimisation (PLAN section 4): no client phone, name or address in any text; the brand and
// the pickup point's phone come from env; links lead to /o/<token>.
import { CLIENT_ORDER_STATUS_LABELS, type OrderStatus } from '@detaly/domain';

/** Statuses in the client's words: the same labels as the order page (@detaly/domain). */
export const CLIENT_STATUS_LABELS: Readonly<Record<OrderStatus, string>> =
  CLIENT_ORDER_STATUS_LABELS;

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
  // --- «Мои машины» (step 6, docs/garage.md): no VIN beyond its last 4 characters -----------
  garageButton: 'Мои машины',
  garageEmpty:
    'Машин пока нет. Укажите машину при оформлении заказа на сайте — блок «Моя машина», ' +
    'и здесь появятся её заказы и кнопка «Купить снова».',
  garageDetails: (vinTail: string | null, mileage: string | null): string | null => {
    const parts = [vinTail ? `VIN ${vinTail}` : null, mileage ? `пробег ${mileage}` : null].filter(
      (part): part is string => part !== null,
    );
    return parts.length > 0 ? parts.join(' · ') : null;
  },
  garageOrdersHead: 'Последние заказы:',
  garageOrderLine: (number: string, date: string, items: string): string =>
    items === '' ? `${number} от ${date}` : `${number} от ${date} — ${items}`,
  garageNoOrders: 'Заказов на эту машину пока нет.',
  rebuyButton: (orderNumber: string): string => `Купить снова ${orderNumber}`,
  deleteButton: 'Удалить машину',
  deleteAsk: (label: string): string =>
    `Удалить ${label} из «Моих машин»? Заказы останутся, но больше не будут привязаны к машине.`,
  deleteYes: 'Да, удалить',
  deleteNo: 'Не удалять',
  deleted: (label: string): string => `Машина ${label} удалена из «Моих машин».`,
  deletedShort: 'Удалено',
  vehicleGone: 'Этой машины уже нет — откройте /garage',
  rebuyChecking: 'Проверяю цены у поставщика…',
  rebuyHead: (orderNumber: string): string => `Заказ ${orderNumber} снова — по сегодняшним ценам:`,
  rebuyLine: (title: string, qty: number, price: string): string =>
    `• ${title} × ${qty} — ${price}`,
  rebuyTotal: (total: string, promise: string | null): string =>
    promise ? `Итого ${total}, получение ${promise}.` : `Итого ${total}.`,
  rebuySkipped: (list: string): string => `Не вошли: ${list}.`,
  rebuyExpires: (date: string): string =>
    `Оформить и оплатить — по ссылке, цены держим до ${date}.`,
  rebuyOpen: 'Оформить на сайте',
  rebuyNone: (orderNumber: string, list: string): string =>
    `Заказ ${orderNumber}: сейчас ни одной детали из него нельзя заказать (${list}). ` +
    'Попробуйте позже или спросите мастера.',
  rebuyEmpty: (orderNumber: string): string =>
    `В заказе ${orderNumber} не осталось деталей, которые можно повторить.`,
  rebuySupplier: 'Поставщик сейчас не отвечает — нажмите «Купить снова» через несколько минут.',
} as const;
