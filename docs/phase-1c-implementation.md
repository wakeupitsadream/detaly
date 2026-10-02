# Фаза 1C: уведомления клиенту, клиентский бот, ручной VIN, претензии, запись на установку — детальная разбивка

Дополнение к `docs/PLAN.md` (раздел 6 «Фаза 1C»; раздел 2 — таблицы `claims`, `vin_requests`,
`install_bookings`, `order_photos`, `link_tokens`, `messenger_bindings`; раздел 3 — строки
«Претензия» и «Приехало»; раздел 4 — «Уведомления MAX + Telegram + SMS» и «VIN-слой»; раздел 5 —
сценарий клиента; Verification «Фаза 1C») и к `docs/phase-1b-implementation.md`. Написано
архитектором 02.10.2026 по коду на HEAD `df56550` (фазы 0, 1A, 1B приняты; редизайн «Техкарта» и
`DEMO_MODE` слиты, демо на https://detaly-two.vercel.app). При расхождении приоритет у
`docs/PLAN.md`; решения фаундера не пересматриваются.

## Что уже есть и не переписывается

| Что | Где | Состояние на входе в 1C |
|---|---|---|
| Движок заказов: `applyTransition`/`persistTransition` под `select … for update`, outbox, `performStaffAction`/`performClientAction`, `availableStaffActions`, возвраты (`createRefund`, `retry_refund`), `canReachClient` | `packages/orders/src/*` | Эффект `open_claim` пишет журнал `claim_deferred` и строк не создаёт; `openClaims: 0` захардкожен в `buildTransitionContext` (`context.ts`) |
| Правила `claim_opened` (handed/completed, самопереход), `claim_refund_approved` (позиция — самопереход, заказ — `refund_pending`, чек `refund_full`), охрана `claimRefundAllowed` (delay, `returnAccepted` или override владельца с причиной), `completion_timeout` с охраной `noOpenClaims` | `packages/domain/src/state-machine/*` | Инвариант PLAN раздела 2 «refund по claim только после „Принял возврат“» закрыт в домене; кнопок нет |
| `Notifier`, `selectChannel` (MAX → Telegram → SMS по allowlist, иначе `skipped` с `fallback_reason`), `ChannelBlockedError` → следующий канал и `messenger_bindings.blocked_at`, драйвер Telegram `createTelegramDriver({api})` с кодеком `callback_data` ≤ 64 байт, шаблоны всех `ORDER_NOTIFY_TEMPLATES`, `vin_proposal`, SMS-драйвер с лимитами и бюджетом | `packages/notify/src/*` | Клиентских драйверов мессенджеров в воркере нет: `clientDrivers()` в `apps/worker/src/jobs/notify/order.ts` отдаёт только SMS |
| Очередь `notify/order`: строка `notifications` до отправки, dedupe `${order_event_id}:${template}:${channel}`, таймер решения клиента только после `sent` | `apps/worker/src/jobs/notify/*` | Работает для SMS и продавцов |
| Напоминания housekeeping: «приехало» на 3/6/9 день (`arrived` с `readyDays`, на последнем — фраза о сроке хранения по оферте), решение клиента 12 ч, счёт Rossko, needs_attention, возврат поставщику, срок возврата денег | `apps/worker/src/jobs/housekeeping/reminders.ts` | **Пункт (6) задачи уже сделан в 1B**; в 1C добавляется только фото упаковки и кнопка записи в само сообщение (раздел 8) |
| Бот продавца: карточки заказа с nonce (`seller_cards`), меню, ForceReply «Счёт оплачен» с ожиданием в Redis, `/queues` | `apps/worker/src/bots/seller/*` | Только заказы; VIN, претензий, записей и фото нет |
| Таблицы `claims`, `vin_requests`, `install_bookings`, `order_photos`, `link_tokens`, `messenger_bindings`, `carts.proposal_token`/`vin_request_id` | `packages/db/src/schema/*` (миграция 0000) | Созданы в фазе 0, не используются; дополняются миграцией 0004 (раздел 2) |
| `@detaly/vin`: `isValidVin`, `normalizeVin`, `maskVin`, `createManualResolver`, `parseManualAnswer` («БРЕНД АРТИКУЛ [КОЛ-ВО] [# заметка]») | `packages/vin/src/*` | Без БД и без проверки через GetSearch |
| Окно установки: `planInstallWindow`, `dayLoadStrip` (чистые); `LoadSource` `live` из `install_bookings` (`createBookingsLoadSource`, статусы `requested`/`confirmed` держат подъёмник) и `demo` | `packages/domain/src/install-window.ts`, `apps/web/src/server/install/*` | Считает **одно** ближайшее окно; списка слотов и записи нет |
| `/o/<token>`: таймлайн, оплата, решения клиента, отказ, отмена; карточка «Уведомления о статусе» с неактивными «Статусы в MAX/Telegram» (`MessengerStubs`), на `/o/demo` — `MessengerPreview`; код выдачи (`orders.pickup_code` создаётся при оформлении) | `apps/web/src/components/order/*`, `apps/web/src/server/orders/*` | Кнопки привязки — заглушки |
| `/vin` без формы (телефон, ссылка на чат точки), гейт оформления `getCheckoutGate` (РКН + документы + точка выдачи) | `apps/web/src/app/(site)/vin/page.tsx`, `apps/web/src/server/checkout-gate.ts` | Формы сбора ПД нет до номера РКН |
| Тексты согласия на ПД и политики уже перечисляют фото (VIN-табличка, документы, деталь, упаковка), Telegram/MAX как получателей, хранение фото VIN 90 дней | `content/legal/{consent_pd,privacy}/2026-10-d1.md` | Новая версия документов **не нужна** |
| Мини-админка под Basic auth, e2e 1B со скриптом `scripts/e2e-1b.sh` и моком ЮKassa | `apps/web/src/app/admin/*`, `scripts/*` | Только заказы |

## 0. Решения по умолчанию, принятые в 1C

Всё, что PLAN не фиксирует однозначно или что упирается в поведение библиотек. Любое решение
меняется, не ломая остальных.

| № | Решение | Почему |
|---|---|---|
| С1 | **Каналы.** Клиентские уведомления идут через бот с `TG_CLIENT_BOT_TOKEN` (`createTelegramDriver` поверх `deps.clientTelegram`), порядок прежний: MAX → Telegram → SMS по allowlist. Драйвер MAX — фаза 2: в `WorkerDeps` поле `maxDriver: ChannelDriver \| null` всегда `null`, `selectChannel` пропускает MAX, потому что его нет в `available`; привязки `channel='max'` в 1C не создаются. Предпочтение `orders.preferred_channel` из оформления не перекрывает привязку: подключённый мессенджер всегда выигрывает у SMS | PLAN раздел 4; интерфейс `ChannelDriver` уже рассчитан на MAX |
| С2 | **Минимизация ПД в Telegram.** Клиентские сообщения — только номер заказа, статус, бренд, артикул, даты, адрес и часы **точки выдачи** (это не ПД клиента), код выдачи и ссылки на `/o/<token>` или `/p/<token>`. Текст решения по претензии клиенту в мессенджер не уходит (он может содержать ПД) — только «ответ готов» и ссылка. Фото в Telegram — только фото упаковки (деталь, не человек). Фото VIN-заявок и претензий в Telegram **не отправляются никогда**, даже продавцам: карточка продавца показывает их число и кнопку «Открыть в админке». В тексте заявки и претензии перед отправкой в чат продавцов маскируются последовательности из 7+ цифр (`•••`), телефон клиента — `•••4567` | PLAN раздел 4: Telegram — иностранный сервис; фото СТС содержит ФИО владельца |
| С3 | **Привязка.** `link_tokens.token` — 24 случайных байта в base64url (32 символа, ≥ 128 бит, ≤ 64 по лимиту Telegram), срок 24 ч, одноразовый: `/start <token>` атомарно ставит `used_at` (`update … where used_at is null and expires_at > now() returning`). В deep link попадает только link token, **никогда** токен страницы заказа. После `/start` бот просит контакт кнопкой `request_contact`; ожидание — в Redis `<prefix>client:bind:<tg_user_id>` (TTL 10 мин, значение `{userId, orderId}`). Контакт принимается, только если `contact.user_id === from.id`; телефон нормализуется `normalizePhone` и сравнивается с `users.phone`. Совпал → `messenger_bindings` upsert по `(channel, external_user_id)`: `user_id`, `chat_id`, `phone_confirmed_at`, `is_primary=true` (прочие привязки пользователя — `false` в той же транзакции), `blocked_at=null`; журнал `messenger_bound` в заказе токена. Не совпал → привязки нет, ответ «Номер не совпадает с номером заказа — уведомления не подключены», ссылка сгорела (повтор — новой кнопкой на странице заказа) | PLAN раздел 4 «Привязка»; привязка — подписка, не авторизация |
| С4 | **Отписка.** `/stop`, кнопка «Отключить уведомления» и `my_chat_member` со статусом `kicked` ставят `blocked_at`. `/start` без параметра от пользователя с заблокированной привязкой снимает `blocked_at` (человек сам вернулся). Ответ Telegram 403 при отправке — как в 1B: `ChannelBlockedError` → `blocked_at` → SMS по allowlist | PLAN: `/stop` — отписка |
| С5 | **Нажатия клиента в боте.** Принадлежность проверяется привязкой: нажавший `from.id` имеет незаблокированную привязку `telegram`, чей `user_id` = `orders.user_id`. Nonce в клиентских кнопках случайный и не хранится (кроме выбора слота, С6). «Подтверждаю» (`confirm`) и «Согласен» (`approve`) применяются сразу через `performClientAction`. «Вернуть деньги» (`refund`), «Отказаться» (`refused`) и «Претензия» — критичные: бот отвечает кнопкой-ссылкой «Подтвердите на странице заказа» (`/o/<token>#…`), где действует проверка 4 цифр телефона (Б24). Статус заказа ботом не меняется в обход state machine | PLAN: «критичные действия (отмена, претензия) дублируются через /o/<token> с подтверждением» |
| С6 | **Запись на установку.** Слоты — `listInstallSlots` (новая чистая функция рядом с `planInstallWindow`): до 6 ближайших свободных стартов от `readyAt` заказа (дата получения `promised_date`, у `ready` — сейчас + lead) в горизонте 14 дней. Загрузка — общий загрузчик `loadInstallLoad(db, from, to)` в `packages/orders` (web-источник `createBookingsLoadSource` делегирует ему, второй копии логики нет). Запись — под блокировкой заказа **и** `pg_advisory_xact_lock(hashtext('install_bookings'))` с повторной проверкой загрузки (двое на один подъёмник не попадут). Одна активная запись на заказ (частичный unique по `requested`/`confirmed`). Статус `requested` уже держит подъёмник; продавец подтверждает или отклоняет в боте/админке. **Цены нет нигде**: текст «Установка — услуга <INSTALL_PARTNER_NAME> (<INSTALL_PARTNER_REQUISITES>), оплачивается в сервисе по его чеку». Без `INSTALL_PARTNER_NAME` блок записи не показывается. Записаться можно в статусах `INSTALL_BOOKABLE_STATUSES` (confirmed, ordering, awaiting_supplier_invoice, ordered_at_supplier, ready, awaiting_handover_payment, handed); клиент отменяет свою запись без 4 цифр не позже чем за 2 ч до слота | PLAN: install_bookings без цены, «установка оплачивается в сервисе»; риск 11 PLAN (переквалификация в агентирование) |
| С7 | **Претензия открывается** на `/o/<token>` (последние 4 цифры телефона, как Б24; до 3 фото; текст ≤ 1000) или продавцом/владельцем в админке. Виды по `claimKindsAvailable`: после выдачи — `refusal` и `not_fit` в течение 7 дней с `handed_at` (ст. 26.1), `defect` — всегда после выдачи, `delay` — если выдано позже `promised_date`; до выдачи — только `delay`, только при удерживаемых деньгах (prepay) и `promised_date` < сегодня. Одна открытая претензия на позицию/заказ (частичный unique), повтор формы гасится `request_key`. Строку `claims` пишет эффект `open_claim` в транзакции перехода `claim_opened` (`deadline_at = opened_at + 10 дней`, CHECK в БД). Уведомления: клиенту `claim_received` с порядком действий, владельцу `staff_claim_deadline`, продавцам — карточка заказа с претензией (`staff_claim_opened`) | PLAN раздел 3, строка «Претензия»; ст. 22 ЗоЗПП (10 дней) |
| С8 | **«Принял возврат»** — только с фото: бот (ForceReply «Пришлите фото возвращённой детали») или загрузка в админке. Строка `order_photos` (`kind='return'`, `claim_id`), `claims.return_accepted_at`, журнал `claim_return_accepted`. Для `delay` не требуется | PLAN раздел 2 инвариант; раздел 3 «order_photos kind=return обязательно» |
| С9 | **Решение** (`refund`/`replace`/`reject`) — всегда с текстом ответа (1..2000 символов, CHECK). `refund`: `claim_refund_approved` с фактами `claimKind`, `returnAccepted`, `scope` (позиция или заказ), `ownerOverrideReason` (только владелец; без «Принял возврат» это единственный путь); `refunds.deadline_at = claims.opened_at + 10 дней` (от даты требования клиента, Verification 1C), причина возврата = вид претензии; `claims.refund_id`, `closed_at` при решении (дальше живёт возврат со своим 10-дневным сроком и напоминанием). `replace`: `supplier_returns` kind `claim` по позиции + задача продавцам «Заказать замену» (через «Заказано вручную» в админке или ЛК Rossko), претензия открыта до «Замена выдана» (`cclose`); **чек не пробивается** (обмен на тот же товар, `VERIFY:` у бухгалтера). `reject`: мотивированный ответ, `closed_at`. Компенсация по ст. 23.1 (только `delay`, только владелец): `compensation_amount_kop` + журнал `claim_compensation`; выплата — платёжным поручением с РС без чека (позиция ФНС — `VERIFY`, PLAN раздел 3) | PLAN раздел 3 |
| С10 | `delay` до выдачи с решением `refund` = событие `client_refused` от продавца (правило уже есть: `refund_pending`, чек `refund_prepayment`), `payload.claimId`, причина возврата `delay` | Не плодить второе правило возврата до выдачи |
| С11 | `buildTransitionContext.openClaims` = число претензий заказа с `closed_at is null`: `completion_timeout` ждёт закрытия (претензия «замена» держит заказ в `handed`) | Охрана `noOpenClaims` уже в таблице |
| С12 | **VIN-форма** показывается, только когда `getCheckoutGate` открыт (номер РКН, опубликованные документы, точка выдачи); иначе страница 1B без формы. Поля: VIN (`normalizeVin`, 17 символов без I/O/Q — подсказка про O/0 и I/1), марка/модель (необязательно, ≤ 200), что нужно (3..1000), до 3 фото (необязательно), телефон (`normalizeMobilePhone`), канал ответа (`telegram` / `sms`; `max` — неактивная «скоро»), отдельный чекбокс согласия на ПД со ссылкой на документ `consent_pd` (текст уже упоминает фото), honeypot, Origin. Сервер: `users` upsert по телефону (без имени), `consents` (kind `pd`, канал `web`, `vin_request_id`, sha256 текста), `vin_requests` (`status='new'`, `request_key`), фото → `FileStore` (`vin/<id>/<uuid>.jpg`), outbox `notify/vin`: карточка продавцам и `vin_received` клиенту. Ответ — 303 на `/vin/sent/<link token>`, если выбран Telegram и бот настроен (кнопка «Подключить Telegram»; токен в пути, а не в query, чтобы его вырезал фильтр логов Caddy), иначе на `/vin/sent` («Пришлём SMS со ссылкой») | PLAN раздел 4 «VIN-слой», решение 14 фазы 0 (формы ПД только после РКН) |
| С13 | **Ответ продавца строками.** Формат: строки «БРЕНД АРТИКУЛ [КОЛ-ВО] [# заметка]» (`parseManualAnswer`), строка, начинающаяся с `>`, — комментарий мастера клиенту (без ПД). Каждая позиция проверяется GetSearch (через кэш 15 мин и общий лимитер, `priority: 'normal'`): точное совпадение бренда (без регистра) и нормализованного артикула среди предложений с остатком ≥ кол-ва, не из стоп-группы; из подходящих — местный склад, затем ближайшая дата, затем дешевле. Ошибки строки: `parse` (кол-во, слишком коротко), `not_found` (артикула нет), `brand_mismatch` (артикул есть у других брендов — показать их), `excluded` (маркировка), `no_stock`, `supplier_unavailable` (квота/ошибка Rossko). Превью: по строке бренд, артикул, название, кол-во, цена клиента (`price()`), «к чт 9 октября», бейдж местного склада; итог. Превью и сырой ответ хранятся в `vin_requests.preview`/`answer_text`. **«Отправить клиенту» недоступна, пока есть ошибки** (кнопка «Исправить» просит строки заново). Отправка: `carts` с `proposal_token` (32 символа base64url), `proposal_expires_at = now + 7 дней`, `seller_note`, `cart_items` из снимков предложений превью; `vin_requests.status='offered'`, `proposal_cart_id`, `answered_at`; outbox `notify/vin` → клиенту `vin_proposal` (в allowlist SMS) | PLAN раздел 4: «система проверяет каждую через GetSearch и показывает превью» |
| С14 | **`/p/<token>`** (noindex, `Referrer-Policy: no-referrer`): комментарий мастера, позиции с ценой и датой — переоценка из кэша при открытии, как корзина 1A; истёк срок — только просмотр и «Попросите мастера обновить подборку». «Оформить и оплатить» → `POST /api/proposals/<token>/take` → позиции копируются в корзину посетителя (кука `cart` 1A; нет корзины — создаётся; одинаковый `offer_key` — кол-во из подборки), `carts.vin_request_id` клиента = заявка → 303 `/checkout`. Оформление — существующее (свежий GetSearch, 409 + DiffBanner, согласия); при создании заказа из корзины с `vin_request_id` — `orders.vin_request_id` и `vin_requests.status='converted'` в той же транзакции | PLAN: «оплачивает как обычный заказ» |
| С15 | **VIN без ответа 4 ч** (`new`/`in_work`, подборка не отправлена): одно напоминание — карточка заявки заново в чат продавцов с пометкой «Без ответа 4 ч» (ключ outbox `reminder:vin:<id>:4h`). Вне часов `PICKUP_HOURS` (`parseWorkHours`) — `available_at` = ближайшее открытие | PLAN раздел 1, очередь housekeeping; ночью будить Лёшу незачем |
| С16 | **Ретенция фото VIN 90 дней**: ежедневная задача `housekeeping/retention` удаляет объекты из `FileStore` и очищает `vin_requests.photos`, ставит `photos_deleted_at`; идемпотентна; в лог — только счётчики. Фото претензий и возвратов хранятся вместе с заказом (как сам заказ), срок — `VERIFY:` у юриста (в политике строка «Возвраты и претензии» без срока) | PLAN раздел 7 п. 8 (фото VIN — 90 дней) |
| С17 | **Фото упаковки.** Продавец отвечает фотографией на карточку заказа (или жмёт «Фото упаковки» → ForceReply) → `order_photos` (`packaging`), журнал `photo_added`, карточка перерисовывается. Фото видно на `/o/<token>` (маршрут `/api/orders/<token>/photos/<photo_id>`, `Cache-Control: private, no-store`) и прикладывается к `arrived` в Telegram (`sendPhoto` с подписью и кнопками; без фото — `sendMessage`). Outbox-строка клиентского `arrived` при переходе в `ready` получает `available_at = now + 2 мин`: фото, присланное сразу после «Приехало», успевает | PLAN раздел 3: «Приехало» (+ фото необязательно), «адрес, часы, код выдачи, фото, „Записаться на установку“» |
| С18 | **Хранилище файлов** — новый пакет `@detaly/files`: интерфейс `FileStore { kind; put; get; delete }`, реализации `none` (по умолчанию: `put` бросает `FilesDisabledError`, формы прячут поле фото), `local` (каталог `FILES_LOCAL_DIR`, dev и e2e), `memory` (тесты), `s3` (S3-совместимое, подпись SigV4 через `aws4fetch` 1.0.20, path-style, `VERIFY:` у провайдера). Ключи только по маске `^(vin\|claim\|order)/<uuid>/<uuid>\.jpg$` (защита от обхода каталога). Каждое изображение перекодируется `sharp` 0.35.5 (уже в lock через Next): поворот по EXIF, вписывание в 2000 px, JPEG q82, **метаданные (GPS, модель телефона) удаляются**; не картинка, > 40 Мп или > `FILES_MAX_UPLOAD_MB` → `ImageRejectedError`. `sharp` и `aws4fetch` импортируются динамически внутри функций: демо-сборка их не исполняет | PLAN: «до 3 фото», S3 РФ; EXIF с координатами — лишние ПД |
| С19 | **Размер запросов с фото.** `proxyClientMaxBodySize` поднимается с `64kb` до `12mb` (иначе Next обрезает тело до вызова обработчика); обработчики загрузок читают тело ограниченно (≤ 12 МБ всего, ≤ 3 файла, каждый ≤ `FILES_MAX_UPLOAD_MB`=8), прочие обработчики сохраняют свои малые лимиты. На клиенте `PhotoInput` при включённом JS уменьшает снимки через canvas (≤ 1600 px, JPEG 0.85, ~300–600 КБ) до отправки; без JS уходят оригиналы. Ответ на превышение — 413 с текстом «Фото слишком большие — до 8 МБ каждое» | Next 16 буферизует тело для `proxy.ts` |
| С20 | **Уведомления вне заказа** (VIN): новая задача `notify/vin {vinRequestId, audience: 'client'\|'sellers', template, key}`; dedupe `vin:<vin_request_id>:<template>:<n>:<channel>` (`n` — номер отправки подборки); получатель — `vin_requests.user_id` (привязки) и телефон заявки; продавцам — `sellerCards.postVin`. Шаблоны `VIN_NOTIFY_TEMPLATES = ['vin_received','vin_proposal']`, в allowlist SMS только `vin_proposal` | Журнал заказа к заявке не относится |
| С21 | **DEMO_MODE**: ни одна новая форма не пишет ПД и не трогает файлы. `proxy.ts` в демо отвечает на `POST /api/vin` → 303 `/vin/sent?demo=1`, на `POST /api/orders/demo/{link,install,claims}` → 303 `/o/demo?demo=<что>` **без чтения тела**; `/p/demo` — подборка из фикстур, «Оформить» кладёт её позиции в демо-корзину (подписанная кука) и ведёт в `/cart`; прочие `/p/*`, `/api/proposals/*` кроме `demo` → 404. `FILES_STORAGE` в демо обязан быть `none` (refine env). Демо-сборка без БД остаётся зелёной | `docs/design.md` раздел 5 |
| С22 | Константы окна установки (подъёмники, длительность работы, приезд поставок, шаг, горизонт) переезжают в `@detaly/domain/install-params` (подмодуль без импортов); `apps/web/src/lib/install-params.ts` реэкспортирует числа и сохраняет формулировки. Воркер (бот) и сайт считают слоты из одних чисел | Иначе воркеру пришлось бы импортировать web |
| С23 | **Памятка и акт выдачи** — два статических PDF в `apps/web/public/print/` (`pamyatka-vozvrat.pdf`, `akt-vydachi.pdf`), собранных один раз скриптом `scripts/make-print-pdfs.ts` из HTML-шаблонов в `scripts/print-templates/` через Chromium Playwright (`page.pdf`) и закоммиченных. Реквизиты в PDF — пустые строки для заполнения от руки (бренд и реквизиты только из env, в статический файл их не впечь). Ссылки: на `/o/<token>` после выдачи («Памятка о возврате, PDF») и в админке (оба) | PLAN раздел 6: «два статических PDF-шаблона в репозитории (без генерации)» |
| С24 | Прочие сообщения клиента боту (текст, фото) — автоответ «Бот присылает статусы заказов. Вопрос мастеру — по телефону <PICKUP_PHONE>»; переписка (`chat_messages`) — фаза 2 | PLAN раздел 2: chat_messages — ф2 |
| С25 | Решения продавца с текстом в боте (ответ по претензии, причина override, строки VIN) — ForceReply и ожидание в Redis `<prefix>seller:await:<chat>:<user>` (TTL 10 мин), как «Счёт оплачен» 1B: обычное сообщение в чате продавцов ничего не делает | Защита от случайного действия |
| С26 | Админка: `/admin/vin` (список с фильтром по статусу), `/admin/vin/[id]` (полный телефон, VIN, текст, фото, ответ строками с превью, «Отправить клиенту», «Закрыть»), в карточке заказа — блоки «Претензии» (решение, «Принял возврат» с загрузкой фото, override владельца с причиной, компенсация), «Запись на установку» (подтвердить/отклонить/выполнено/не приехал), «Фото» (загрузка упаковки, просмотр). Файлы — `GET /api/admin/files/[...key]` за Basic auth в proxy. Фильтры списка заказов: «Претензии открыты», «Запись ждёт подтверждения» | PLAN раздел 5: /admin — «список заказов и заявок» |
| С27 | Новые лимиты (скользящее окно, `server/rate-limit.ts`): `link` — `POST /api/orders/<t>/link` 20/ч; `install` — `POST /api/orders/<t>/install` и `…/install/cancel` 20/ч; `claim` — `POST /api/orders/<t>/claims` 10/ч; `vin` — `POST /api/vin` 5/ч и 20/сутки; `proposal` — `POST /api/proposals/<t>/take` 30/ч. 4 цифры претензии — общий счётчик неудач 1A | PLAN раздел 1 «Защита» |
| С28 | Логи: VIN — только `maskVin`, номер заказа, id заявки; ни телефонов, ни токенов (`/o`, `/p`, link), ни текстов претензий и заявок, ни ключей S3. Тест e2e грепает логи web и worker, как в 1B | PLAN: «Логи без телефонов и токенов» |

## 1. Изменения модели данных (волна 1)

Одна миграция `packages/db/drizzle/0004_phase_1c.sql`:
`pnpm --filter @detaly/db exec drizzle-kit generate --name phase_1c`. Правило expand/contract
1B: новые колонки nullable или с default, enum-значения только в конец кортежей. Тест миграций
прогоняет 0004 на базе с данными 1B (заказ в `handed`, VIN-заявок нет).

### 1.1. Изменения таблиц

| Таблица | Изменение | Зачем |
|---|---|---|
| `claims` | `client_text` text (≤ 1000, CHECK); `opened_via` text CHECK (`web`, `admin`, `bot`); `request_key` uuid unique; `decided_at` tstz; `decided_via` text (`bot`, `admin`); `override_reason` text; `refund_id` uuid → refunds; `replacement_note` text; CHECK `deadline_at = opened_at + interval '10 days'`; CHECK `decision is null or (decided_at is not null and length(btrim(decision_text)) between 1 and 2000)`; CHECK `override_reason is null or decision = 'refund'`; частичный unique `claims_open_target_unique (order_id, coalesce(order_item_id, '00000000-0000-0000-0000-000000000000'::uuid)) where closed_at is null` | С7–С9 |
| `install_bookings` | `request_key` uuid unique; `confirmed_at`, `cancelled_at`, `reminded_at` tstz; `created_via` text (`web`, `bot`, `admin`); `staff_note` text (без ПД); частичный unique `install_bookings_order_active_unique (order_id) where status in ('requested','confirmed')` | С6 |
| `order_photos` | `claim_id` uuid → claims (nullable), индекс; `order_item_id` uuid → order_items (nullable); CHECK `kind <> 'return' or claim_id is not null`; CHECK `s3_key ~ '^(vin\|claim\|order)/…\.jpg$'` | С8, С17, С18 |
| `vin_requests` | `channel` notification_channel (выбор клиента); `request_key` uuid unique; `answer_text` text; `preview` jsonb (`VinPreview`, раздел 3.2); `answered_at`, `reminded_at`, `photos_deleted_at`, `closed_at` tstz; `close_reason` text; `proposal_count` int not null default 0; индекс `(created_at) where status in ('new','in_work')`; CHECK `jsonb_array_length(photos) <= 3` | С12–С16 |
| `carts` | `proposal_expires_at` tstz; CHECK `(proposal_token is null) = (proposal_expires_at is null)` | С13, С14 |
| `orders` | `vin_request_id` uuid → vin_requests (nullable, `on delete set null`), индекс | С14; претензия `not_fit` по подбору мастера («подобрали мы — вернём деньги») видна в админке |
| `consents` | `vin_request_id` uuid → vin_requests (nullable), индекс | Согласие на ПД без заказа (С12) |
| `link_tokens` | `channel` messenger_channel not null default `'telegram'`; `used_by_external_id` text; индекс `(user_id)` | С3 |
| `seller_cards` | `order_id` → **nullable**; `vin_request_id` uuid → vin_requests (nullable); CHECK `(order_id is null) <> (vin_request_id is null)`; CHECK `kind in ('order','qr','vin')` (drop + add); индекс `(vin_request_id) where closed_at is null` | Карточка VIN-заявки с nonce (раздел 9) |
| `notifications` | `vin_request_id` uuid → vin_requests (nullable), индекс; CHECK адресата не меняется | С20, разбор |

`relations.ts`: `claims.order/item/photos/refund`, `orders.claims/installBookings/photos/vinRequest`,
`vinRequests.user/proposalCart/photos?`, `installBookings.order`, `orderPhotos.order/claim`,
`sellerCards.vinRequest`, `linkTokens.user/order`, `messengerBindings.user`.

Сиды: новых строк нет (пороги 1C — константы домена, раздел 3.3); повторный сид идемпотентен.

Тесты `packages/db/test/phase1c.int.test.ts`: 0004 на базе 1B проходит; вторая открытая претензия
на ту же позицию → 23505, после `closed_at` — можно, на другую позицию — можно; решение без текста →
23514; `deadline_at` ≠ +10 дней → 23514; вторая активная запись заказа → 23505, после `cancelled` —
можно; `order_photos` `return` без `claim_id` → 23514, ключ `../etc` → 23514; `seller_cards` с
обоими id или ни одним → 23514, `kind='vin'` — можно; `vin_requests.photos` из 4 ключей → 23514;
`carts` с токеном без срока → 23514.

## 2. Env (волна 1)

| Переменная | Схема | Значение |
|---|---|---|
| `FILES_STORAGE` | `z.enum(['none','local','s3']).default('none')` | С18; `s3` требует `S3_ENDPOINT`, `S3_KEY`, `S3_SECRET` и бакет (refine); `DEMO_MODE=true` требует `none` |
| `FILES_LOCAL_DIR` | `z.string().default('var/files')` | каталог `local` (dev, e2e); в compose не используется (прод — `s3`) |
| `FILES_S3_BUCKET` | `optionalString` | бакет фото; по умолчанию `S3_BUCKET` (бэкапы лежат под `BACKUP_PREFIX`) |
| `FILES_S3_PREFIX` | `z.string().default('files/')` | префикс ключей в бакете |
| `FILES_MAX_UPLOAD_MB` | `int(1).max(12).default(8)` | С19 |
| `INSTALL_PARTNER_NAME` | `optionalString` | «Сервис56»; без неё запись на установку скрыта (С6) |
| `INSTALL_PARTNER_REQUISITES` | `optionalString` | «ИП …, ИНН …» в тексте про оплату установки в сервисе |

Уже в схеме: `TG_CLIENT_BOT_TOKEN`, `TG_CLIENT_BOT_USERNAME` (без них кнопка «Статусы в Telegram»
неактивна с текстом «скоро», бот не стартует), `S3_*`, `MAX_*` (ф2), `RKN_NOTICE_NUMBER`,
`PICKUP_*`. `.env.example` — новые строки с комментариями по-русски; тест реестра env
(`.env.example` ↔ схема) зелёный.

`packages/config/src/queues.ts`: `NOTIFY_JOBS.vin = 'vin'`; `HOUSEKEEPING_JOBS.retention =
'retention'` (Job Scheduler cron `40 4 * * *`, tz Asia/Yekaterinburg — регистрация в
`apps/worker/src/queues.ts` делается фундаментом).

## 3. packages/domain (волна 1)

### 3.1. `statuses.ts` (добавления)

`SELLER_CARD_KINDS` += `'vin'`; `CLAIM_OPENED_VIA = ['web','admin','bot']`;
`INSTALL_BOOKABLE_STATUSES` (С6, `satisfies readonly OrderStatus[]`);
`INSTALL_HOLDING_STATUSES = ['requested','confirmed']` (переезжает из web `install/config.ts`,
web реэкспортирует); `VIN_OPEN_STATUSES = ['new','in_work']`; `LINK_TOKEN_CHANNELS = MESSENGER_CHANNELS`.

### 3.2. `types.ts`

1. `VinPreviewLine = { line: number; raw: string; status: 'ok'; brand; article; name; qty;
   offer: Offer; searchArticleNorm; offerKey; priceClientKop; priceSupplierKop; markupBp; etaDate:
   IsoDate; isLocal: boolean; note: string|null } | { line; raw; status: 'error'; reason:
   'parse'|'not_found'|'brand_mismatch'|'excluded'|'no_stock'|'supplier_unavailable'; brands?:
   string[]; message: string }`.
2. `VinPreview = { lines: VinPreviewLine[]; comment: string|null; totalKop: Kop; okCount: number;
   errorCount: number; checkedAt: string }`.
3. `InstallSlot = { startAt: string /* ISO с зоной */; endAt: string; dayText; timeText }`.
4. `ClaimFacts = { claimId: string; claimKind: ClaimKind; returnAccepted: boolean;
   claimOpenedAt: string }` — факты, которые сервис претензий передаёт движку.

### 3.3. Новые модули и правки

| Модуль | Экспорт | Поведение |
|---|---|---|
| `claims.ts` (новый) | `CLAIM_ANSWER_DAYS = 10`, `REFUSAL_DAYS = 7`, `CLAIM_TEXT_MAX = 1000`, `CLAIM_DECISION_TEXT_MAX = 2000`, `CLAIM_PHOTOS_MAX = 3`; `claimDeadline(openedAt)`; `claimKindsAvailable({status, scheme, moneyHeld, handedAt, promisedDate, now})` (С7); `claimRefundReason(kind)` → `RefundReason`; `CLAIM_KIND_LABELS`, `CLAIM_DECISION_LABELS` (по-русски) | Чистые; тесты на границы 7 дней (часовой пояс клиента), `delay` до/после выдачи, pay_on_handover без денег |
| `install-params.ts` (новый, подпуть `@detaly/domain/install-params` в `package.json`) | `INSTALL_LIFTS`, `INSTALL_JOB_MIN`, `INSTALL_ARRIVAL_TIME`, `INSTALL_LEAD_MIN`, `INSTALL_STEP_MIN`, `INSTALL_HORIZON_DAYS`, `INSTALL_SLOTS_SHOWN = 6`, `INSTALL_CLIENT_CANCEL_BEFORE_MIN = 120` | С22; без импортов |
| `install-window.ts` (правка) | `listInstallSlots(input: InstallWindowInput & {limit})` → `InstallPlan[]` | Те же правила, что `planInstallWindow` (рабочие часы, загрузка каждого часа, шаг), но до `limit` стартов; `planInstallWindow` = первый элемент (тест на равенство) |
| `vin-requests.ts` (новый) | `VIN_PHOTOS_MAX = 3`, `VIN_NEED_TEXT_MAX = 1000`, `VIN_CAR_TEXT_MAX = 200`, `VIN_PHOTO_RETENTION_DAYS = 90`, `PROPOSAL_TTL_DAYS = 7`, `VIN_NOTIFY_TEMPLATES`, `LINK_TOKEN_TTL_MS = 24 ч`, `maskDigits(text)` (С2: 7+ цифр подряд, с пробелами/дефисами → `•••`) | Константы политики в одном месте |
| `timers.ts` (правка) | `TIMERS` += `vinAnswerReminderMs: 4 ч`, `claimDeadlineWarnMs: 2 сут`, `installReminderBeforeMs: 24 ч`, `arrivedPhotoGraceMs: 2 мин`, `retentionEveryMs: 24 ч` | |
| `journal.ts` (правка) | `JOURNAL_EVENTS` += `claim_return_accepted`, `claim_decided`, `claim_closed`, `claim_compensation`, `install_requested`, `install_confirmed`, `install_declined`, `install_cancelled`, `install_done`, `install_no_show`, `install_reminder`, `messenger_bound`, `messenger_unbound`, `photo_added`, `vin_order` | События журнала заказа вне TRANSITIONS |

### 3.4. Машина состояний

`TransitionContext` без новых полей (`claimKind`, `returnAccepted`, `ownerOverrideReason`,
`openClaims` уже есть). Новая охрана `claimIsDelay = guard('claim_is_delay', c => c.claimKind ===
'delay')`. `ORDER_NOTIFY_TEMPLATES` += клиент: `claim_decided`, `install_requested`,
`install_confirmed`, `install_declined`, `install_reminder`; продавцы: `staff_claim_opened`,
`staff_install_request`. Рендеры для новых id пишет фундамент в
`packages/notify/src/templates/order.ts` (иначе не соберётся `Record<OrderNotifyTemplate, Render>`),
тексты доводит пакет `notify-1c`.

| Правило | Было | Стало |
|---|---|---|
| `claim_opened` из `handed`/`completed` | notify `client('claim_received')`, `owner('staff_claim_deadline')` | += `sellers('staff_claim_opened')` |
| `claim_opened` из `REFUSABLE_STATUSES` (новое) | — | самопереход, actors `client`, `staff`, охрана `all(claimIsDelay, moneyHeld)`, notify как выше, effects `open_claim`, label «Претензия о просрочке» |
| остальное | | без изменений; `completion_timeout` и `claim_refund_approved` начинают работать по-настоящему, потому что движок 1C считает `openClaims` и передаёт факты претензии |

`transitions.spec.ts`: строки EXPECTED для новых правил (полный перебор пар подхватит их сам);
кейсы: `claim_opened` kind `refusal` в `ordered_at_supplier` → `guard_failed`, kind `delay` при
prepay → самопереход, при pay_on_handover без денег → `guard_failed`; `completion_timeout` при
`openClaims: 1` → `guard_failed`; `claim_refund_approved` без `returnAccepted` (не delay) у продавца
→ `guard_failed`, у владельца с причиной → проходит, у владельца с пустой причиной → `guard_failed`.

## 4. Контракты пакетов и заглушки (волна 1)

1. **`packages/files` (новый `@detaly/files`)**: `package.json` (deps: `@detaly/config`,
   `uuid` 14.0.2, `sharp` 0.35.5, `aws4fetch` 1.0.20; dev: vitest, msw 3.0.1), `tsconfig.json`,
   `vitest.config.ts` (`name: 'files'`), `src/index.ts`: `FileStore`, `FileObject`,
   `FilesDisabledError`, `ImageRejectedError`, `isFileKey`, `newFileKey(scope, ownerId)`,
   `createMemoryFileStore()`, `createLocalFileStore({dir})` (атомарная запись через временный файл и
   `rename`, `delete` идемпотентен), `createNoFileStore()`, `ingestImage(bytes, {maxBytes,
   maxSide=2000})` (динамический `import('sharp')`), `createFileStoreFromEnv(env)` (ветка `s3`
   вызывает `createS3FileStore` из `src/s3.ts` — **заглушка** `throw new Error('not implemented:
   phase 1C wave 2')`, реализует пакет `vin-core`). Тесты: memory/local (put/get/delete, ключ вне
   маски → ошибка, `..` не проходит), `ingestImage` (JPEG с EXIF GPS → на выходе нет EXIF; PNG →
   JPEG; текстовый файл → `not_image`; > maxBytes → `too_large`).
2. **`packages/vin`**: `package.json` += `@detaly/db`, `@detaly/config`, `@detaly/rossko`,
   `@detaly/orders`, `uuid`; `vitest.config.ts` с `globalSetup` и базой `${DATABASE_URL_TEST}_vin`
   (`test/global-setup.ts` по образцу `packages/orders`).
3. **`packages/notify`**: `src/types.ts` — `OrderTemplateData` += `slotText?: string|null`,
   `claim?: {kind: ClaimKind; decision: ClaimDecision|null; deadlineDate: IsoDate}|null`,
   `photos?: readonly string[]` (ключи `FileStore`, только упаковка); `RenderedMessage` += `photos?:
   readonly string[]`; `templates/order.ts` — простые рендеры новых шаблонов (раздел 3.4).
4. **`apps/worker`**: `package.json` += `@detaly/files`; `src/deps.ts`: `WorkerDeps` +=
   `clientTelegram: ClientTelegramApi | null` (grammY `Api` по `TG_CLIENT_BOT_TOKEN`), `maxDriver:
   ChannelDriver | null` (всегда `null` в 1C), `files: FileStore`, `fetch: typeof fetch` (скачивание
   файлов Telegram); `SellerCardPort` += `postVin({vinRequestId, note?})` и `refreshVin(vinRequestId)`;
   `src/create-deps.ts` строит новые поля (`createFileStoreFromEnv`); `src/bots/seller/cards.ts` —
   заглушки `postVin` → `{status:'skipped', fallbackReason:'not_implemented'}`, `refreshVin` → no-op;
   `src/queues.ts` — scheduler `retention`; `src/jobs/housekeeping.ts` — ветка `retention`,
   вызывающая `runRetention` из `src/jobs/housekeeping/retention.ts` (заглушка `{deleted: 0}`);
   `src/jobs/notify/index.ts` — ветка `vin` → `processNotifyVin` из `src/jobs/notify/vin.ts`
   (заглушка `UnrecoverableError('not implemented')`); `test/helpers/test-deps.ts` — memory
   `FileStore`, фейковый `clientTelegram` (записывает `sendMessage`/`sendPhoto`, умеет отвечать 403 и
   429), записывающие `postVin`/`refreshVin`; `test/queues.test.ts` — список schedulers.
5. **`apps/web`**: `package.json` += `@detaly/files`; `next.config.ts` — `transpilePackages` +=
   `@detaly/files`, `serverExternalPackages` += `sharp`, `proxyClientMaxBodySize: '12mb'` (С19);
   `src/server/files.ts` — синглтон `getFileStore()` (`DEMO_MODE` → `createNoFileStore()`);
   `src/server/uploads.ts` — `readPhotoForm(request, {maxFiles, maxFileBytes, maxTotalBytes})` →
   `{fields: Map<string,string>, photos: Uint8Array[]}` (ограниченное чтение `multipart/form-data`,
   `ingestImage` каждого файла, ошибки `UploadError('too_large'|'too_many'|'not_image'|'bad_form')`);
   `src/components/forms/PhotoInput.tsx` (клиентский компонент «Техкарта»: до N фото, превью,
   удаление, уменьшение через canvas, подписи по-русски, доступность) и `src/lib/downscale.ts`;
   `src/lib/install-params.ts` — реэкспорт чисел из `@detaly/domain/install-params`;
   `src/server/install/config.ts` — `HOLDING_BOOKING_STATUSES` из домена;
   `src/server/{request-limits,rate-limit}.ts` и `src/proxy.ts` — лимиты С27, заголовки
   (`/p/*`, `/api/proposals/*`, `/vin/sent/*` — noindex и no-referrer; `/api/admin/files/*` — `no-store`),
   демо-маршруты С21; тесты `test/{request-limits,proxy,demo-proxy,rate-limit.int}.test.ts`.
   `infra/Caddyfile`: фильтр логов вырезает токены и из `/api/proposals/<token>` и `/vin/sent/<token>`
   (`request>uri regexp ^/(o|p|api/orders|api/proposals|vin/sent)/[^/?]+`), удаляет
   `resp_headers>Location` (в нём `t.me/…?start=<link token>` и `/p/<token>`), `request_body max_size
   12MB` для `/api/*`; тест `apps/web/test/caddyfile.test.ts`.
6. **Зависимости**: один `pnpm install`, lock коммитится. `onlyBuiltDependencies` уже содержит
   `sharp`. Dockerfile'ы не меняются (`node:22.22-bookworm-slim`, glibc — у `sharp` готовая сборка;
   проверить `docker compose config` и что `prepare-standalone.mjs` переносит `sharp` в standalone).
7. Тест фундамента: `pnpm typecheck` по всем пакетам с заглушками; `pnpm test` целиком зелёный;
   демо-сборка `cd apps/web && env -u DATABASE_URL -u REDIS_URL DEMO_MODE=true ROSSKO_MODE=fixtures
   pnpm run build` зелёная.

## 5. packages/orders (волна 2, пакет `orders-1c`)

Всё под той же дисциплиной 1B: изменения заказа — в транзакции с `select … for update` строки
заказа, эффекты и уведомления — outbox в той же транзакции, `nudge` после коммита.

### 5.1. Публичный API (новое)

| Функция | Что делает |
|---|---|
| `createLinkToken(db, {userId, orderId?, channel, now?})` → `{token, expiresAt}` | С3; 24 байта base64url; без `TG_CLIENT_BOT_USERNAME` вызывающий кнопку не показывает |
| `consumeLinkToken(db, {token, externalUserId, now?})` → `{userId, orderId} \| null` | Атомарно, одноразово, с проверкой срока; `used_by_external_id` |
| `bindMessenger(db, {userId, orderId?, channel, externalUserId, chatId, now?})` | Upsert по `(channel, external_user_id)`, primary, `phone_confirmed_at`, снятие `blocked_at`; журнал `messenger_bound` в заказе (если есть) |
| `setMessengerBlocked(db, {channel, externalUserId, blocked, now?})` | С4; журнал не пишется (действие пользователя, не заказа) |
| `findBindingUser(db, {channel, externalUserId})` → `{userId, blocked} \| null` | Для клиентского бота (С5) |
| `messengerStatus(db, userId)` → `{telegram: 'none'\|'active'\|'blocked'; max: 'none'}` | Для `/o/<token>` |
| `loadInstallLoad(db, {from, to, capacity, jobMin})` → `LoadSnapshot` | С6; общий загрузчик (web делегирует) |
| `installSlotsForOrder(db, {orderId, now, schedule, limit?})` → `{slots: InstallSlot[]; reason?: 'status'\|'no_date'\|'no_hours'\|'booked'}` | `listInstallSlots` от даты заказа; `reason` — почему пусто |
| `bookInstall(deps, {orderId, slotAt, via, requestKey, actor})` → `{ok, bookingId} \| {ok:false, reason: 'slot_taken'\|'not_allowed'\|'already_booked'\|'bad_slot'}` | Блокировка заказа + advisory lock + повторная проверка слота по свежей загрузке; `install_bookings` `requested`; журнал `install_requested`; outbox: продавцам `staff_install_request` (карточка заказа), клиенту `install_requested` |
| `cancelInstall(deps, {bookingId, actor})` | Клиент — не позже чем за 2 ч; журнал `install_cancelled`, продавцам карточка |
| `decideInstall(deps, {bookingId, decision: 'confirm'\|'decline'\|'done'\|'no_show', note?, staff})` | Журнал `install_*`; клиенту `install_confirmed` / `install_declined` (со ссылкой выбрать другое время); `done`/`no_show` без уведомления |
| `openClaim(deps, {orderId, itemId?, kind, text, photoKeys, via, requestKey, actor})` | `claimKindsAvailable` → `applyTransition('claim_opened', facts {claimKind}, payload {claim: …})`; эффект `open_claim` вставляет строку `claims` (заменяет журнал `claim_deferred` 1B) |
| `acceptClaimReturn(deps, {claimId, photoKey, staff})` | С8: `order_photos` `return`, `return_accepted_at`, журнал, обновление карточки продавца (outbox `notify/order` sellers) |
| `decideClaim(deps, {claimId, decision, text, staff, overrideReason?, compensationKop?})` | С9, С10; `refund` → `claim_refund_approved` (после выдачи) или `client_refused` (delay до выдачи) с `facts {claimKind, returnAccepted, ownerOverrideReason, scope, claimOpenedAt}`; `guard_failed` → понятный текст («Сначала „Принял возврат“ с фото» / «Только владелец с причиной»); клиенту `claim_decided`; журнал `claim_decided` |
| `closeClaim(deps, {claimId, staff, note})` | «Замена выдана» для `replace`; журнал `claim_closed` |
| `recordClaimCompensation(deps, {claimId, amountKop, staff})` | Только владелец, только `delay`; журнал `claim_compensation` |
| `addOrderPhoto(deps, {orderId, kind: 'packaging'\|'handover', fileKey, staff, itemId?})` | `order_photos`, журнал `photo_added` |
| `loadClaimsView(db, orderId)`, `loadBookingsView(db, orderId)`, `loadOrderPhotos(db, orderId, kinds)` | Read-модели для `/o`, админки и бота (без ПД клиента, текст претензии — только для админки и `/o`) |

### 5.2. Правки существующего

1. `snapshot.ts`: `OrderSnapshot.claims` (открытые и закрытые, без текстов).
2. `context.ts`: `openClaims` = число `claims.closed_at is null` (С11).
3. `engine.ts`: эффект `open_claim` — строка `claims` из `payload.claim` (`kind`, `order_item_id`,
   `client_text`, `photos`, `opened_via`, `request_key`, `deadline_at = claimDeadline(at)`), дубль
   `request_key` → тот же результат без второй строки; `create_refund` для `claim_refund_approved` и
   `client_refused` с `facts.claimOpenedAt` — `requested_at = claimOpenedAt`, причина
   `claimRefundReason(kind)`, `claims.refund_id`; клиентский `arrived` при входе в `ready` — outbox
   с `available_at = at + TIMERS.arrivedPhotoGraceMs` (С17).
4. `actions.ts`: `StaffActionCode` += `cret`, `cref`, `crepl`, `crej`, `cclose`, `bconf`, `bdecl`,
   `bdone`, `bnoshow`, `pphoto`; `StaffActionView` += `claimId?`, `bookingId?`;
   `availableStaffActions` показывает их по открытым претензиям и записям (`cref` `enabled:false` с
   `disabledReason: 'Сначала «Принял возврат»'`, у владельца — активна с пометкой «нужна причина»);
   `performStaffAction` маршрутизирует коды в функции 5.1 (текст решения — `input.text`).
5. `index.ts`: экспорт всего 5.1.

### 5.3. Тесты (`packages/orders/test/*.int.test.ts`, база `_orders`)

Привязка: токен одноразовый (второй `consume` → `null`), просроченный → `null`, 64 символа предела
маски, повторная привязка того же TG к другому пользователю переносит её; `is_primary` один.
Запись: два параллельных `bookInstall` на последний свободный подъёмник часа — один `ok`, второй
`slot_taken`; вторая активная запись заказа → `already_booked`; статус `cancelled` заказа →
`not_allowed`; `cancelInstall` клиентом за 1 ч до слота → отказ; в строках нет цен (тест-grep
схемы: у `install_bookings` нет `*_kop`). Претензии: `refusal` на 8-й день после выдачи →
отказ; `openClaim` дважды с одним `request_key` → одна строка; **«Принял возврат» → `refund` →
`refund_pending` → `applyRefundObject(succeeded)` → `refunded`, чек `refund_full` (строки чека
зачёта), `refunds.deadline_at = claims.opened_at + 10 дней`** (Verification 1C); `refund` без
«Принял возврат» продавцом → `guard_failed`, строк возврата нет; владелец с причиной → проходит,
причина в `order_events`; претензия на одну позицию → частичный возврат, статус `handed`;
`replace` держит `completion_timeout` (`guard_failed`), после `closeClaim` — `completed`; `delay`
до выдачи → `client_refused` → `refund_prepayment`, причина `delay`; `arrived` в outbox с
`available_at` +2 мин. Unit: `availableStaffActions` для претензий и записей.

## 6. packages/vin и S3 (волна 2, пакет `vin-core`)

| Модуль | Экспорт | Поведение |
|---|---|---|
| `src/requests.ts` | `createVinRequest(db, {vin, carText, needText, phone, channel, photoKeys, consent: {documentVersionId, textSha256, ip, userAgent}, requestKey, now})` → `{vinRequestId, userId, duplicate}` | Транзакция: `users` upsert по телефону, `consents`, `vin_requests`, outbox `notify/vin` (продавцам карточка `key vin:<id>:card:0`, клиенту `vin_received`); дубль `request_key` → прежняя заявка |
| `src/preview.ts` | `previewVinAnswer({text, search: (article) => Promise<Offer[]>, markupRules, excludedRules, eta, now})` → `VinPreview` | С13; GetSearch по уникальным нормализованным артикулам (не больше 20 строк в ответе — иначе ошибка `parse` «не больше 20 позиций»), ошибки поставщика по одной строке не валят остальные |
| `src/workflow.ts` | `takeVinRequest(db, {id, staffId})` (`in_work`, `assigned_staff_id`); `saveVinPreview(db, {id, answerText, preview})`; `sendVinProposal(deps, {id, staffId})` → `{proposalToken}` \| ошибка `has_errors`/`empty`/`closed`; `closeVinRequest(db, {id, reason})`; `markVinConverted(tx, {vinRequestId, orderId})`; `loadVinRequestForStaff(db, id)` (телефон маской, фото — ключи), `loadProposal(db, token, now)` → `{lines, comment, expired, vinRequestId} \| null` | Отправка — транзакция: `carts` (`proposal_token`, `proposal_expires_at`, `seller_note`, `vin_request_id`), `cart_items` из `preview.lines` со статусом `ok`, `vin_requests` (`offered`, `proposal_cart_id`, `answered_at`, `proposal_count+1`), outbox `notify/vin` клиенту `vin_proposal` с `n = proposal_count`; повторная отправка после «Исправить» создаёт новую подборку, старая получает `status='abandoned'` |
| `src/proposal-cart.ts` | `copyProposalToCart(tx, {proposalCartId, targetCartId})` | С14; позиции копируются со снимками, `carts.vin_request_id` цели |
| `packages/files/src/s3.ts` | `createS3FileStore({endpoint, region, bucket, prefix, accessKeyId, secretAccessKey, fetch?})` | PUT/GET/DELETE объекта через `AwsClient` (`aws4fetch`), path-style `endpoint/bucket/prefix+key`, `Content-Type: image/jpeg`; 404 на GET → `null`, на DELETE — успех; таймаут 15 с; `VERIFY:` path-style vs virtual-host, регион (`ru-1`/`ru-central1`), подпись `UNSIGNED-PAYLOAD` |

Тесты: `test/preview.test.ts` на фикстурах Rossko (`fixture-caller`): «MANN W914/2 1» — ok с ценой
`ceil(опт × 1,28)` и датой; **опечатка «MANN W9142X 1» → `not_found`, «BOSH OC90 1» →
`brand_mismatch` с брендами из ответа**, «NOTFOUND 1» → `not_found`, «OC90 1» → `parse` (нет
артикула), «MAHLE OC90 0» → `parse`; стоп-группа → `excluded`; ошибка поставщика на одной строке →
`supplier_unavailable` только у неё. `test/workflow.int.test.ts` (база `_vin`): заявка с 2 фото →
строки и outbox; «Отправить» при ошибках → `has_errors`; без ошибок → `carts` с токеном 32 символа и
сроком 7 дней, outbox `vin_proposal`; `copyProposalToCart` в корзину с той же позицией — кол-во из
подборки; `markVinConverted`; повтор `request_key`. `packages/files/test/s3.test.ts` (msw): подпись
`Authorization: AWS4-HMAC-SHA256`, путь, GET 404 → `null`, 5xx → ошибка без ключей в тексте.

## 7. packages/notify и очереди notify/housekeeping (волна 2, пакет `notify-1c`)

### 7.1. packages/notify

1. Драйвер Telegram: `TelegramSender` += `sendPhoto(chatId, photo: InputFileLike, other?:
   {caption, reply_markup})`; `createTelegramDriver({api, loadPhoto?: (key) => Promise<Uint8Array|
   null>})`: при `message.photos` и `loadPhoto` — `sendPhoto` первого фото (подпись = текст ≤ 1024
   символов, иначе фото без подписи + `sendMessage`), иначе `sendMessage`. 403 → `ChannelBlockedError`;
   429 → ошибка с `retryAfterSec` (очередь повторит с backoff, `VERIFY:` лимиты Telegram);
   400 «chat not found» → `ChannelBlockedError`.
2. Шаблоны на **все** переходы с клиентским уведомлением (`ORDER_NOTIFY_TEMPLATES`, клиентская
   часть) — сверка текстов с PLAN разделом 3: `arrived` — фото (`photos`), код выдачи, точка, кнопки
   `act('install', 'Записаться на установку')` и ссылка на заказ; `handed` — «7 дней на отказ —
   памятка на странице заказа» + кнопка «Претензия» (ссылка `…#claim`); `how_is_it` — та же кнопка;
   `claim_received` — порядок действий (принести деталь в упаковке в точку `<адрес, часы>`, мастер
   примет и сфотографирует, ответ до `<дата>`, деньги — в течение 10 дней после решения);
   `claim_decided` — «Ответ по претензии готов» + ссылка (без текста ответа, С2); `install_*` — дата
   и время слота, имя партнёра, «оплачивается в сервисе по его чеку»; staff-шаблоны 1C. Новый
   `templates/vin.ts`: `vin_received` (не в allowlist SMS), `vin_proposal` (в allowlist).
3. `CALLBACK_ACTIONS`: клиентские `install` (меню слотов), `islot` (выбор слота, nonce → Redis),
   `orders`, `unsub`; продавца — коды 5.2 п. 4 и VIN `vtake`, `vans`, `vfix`, `vsend`, `vclose`;
   `actionTarget` += `'claim'`, `'booking'`, `'vin'`; все коды ≤ 7 символов (`callback_data` ≤ 55 байт).
4. `TemplateDataMap` += `vin_received`/`vin_proposal` с `VinTemplateData {brandName, proposalUrl?,
   requestNumber /* короткий id заявки */, comment?}`.
5. Тесты: **рендер каждого клиентского шаблона** с данными, где есть телефон и имя клиента в
   «лишних» полях, — в тексте и кнопках нет `+7`, цифр телефона и имени (grep по всем
   `ORDER_NOTIFY_TEMPLATES` клиента и VIN); каждый клиентский шаблон содержит ссылку на `/o/` или
   `/p/`; `arrived` с фото уходит `sendPhoto` с кодом выдачи и кнопкой записи; драйвер: 403 →
   blocked, 429 → повторяемая ошибка; `selectChannel` с привязкой MAX и без драйвера MAX →
   Telegram; без привязок и шаблон вне allowlist → `skipped` `no_messenger:not_in_sms_allowlist`.

### 7.2. Воркер: notify

1. `clientDrivers(deps)`: Telegram (`deps.clientTelegram`, `loadPhoto` = `deps.files.get`) перед SMS;
   `deps.maxDriver` при наличии (в 1C — `null`).
2. `template-data.ts`: `photos` для `arrived` (ключи `order_photos` `packaging` заказа, до 1),
   `slotText` для `install_*`, `claim` для `claim_*`, `deadlineDate` претензии для
   `staff_claim_deadline`.
3. `jobs/notify/vin.ts` — `processNotifyVin` (С20): строка `notifications` (`vin_request_id`,
   dedupe) до отправки; клиенту — `Notifier` с теми же драйверами; продавцам — `sellerCards.postVin`.
4. Тесты (`test/notify-1c.int.test.ts`, база `_worker`, фейковый `clientTelegram`): привязанный
   клиент получает `paid`/`ordered`/`arrived` в Telegram, SMS не уходит; **блокировка бота: фейк
   отвечает 403 → `messenger_bindings.blocked_at`, `arrived` уходит SMS, `fallback_reason =
   'blocked:telegram'`**; шаблон вне allowlist без мессенджера → `skipped`; `arrived` с фото
   упаковки → `sendPhoto`; `vin_proposal` без привязки → SMS со ссылкой `/p/`; `vin_received` без
   привязки → `skipped`; повтор задачи → одна отправка.

### 7.3. Воркер: housekeeping

| Задача | Что |
|---|---|
| `reminders` (+ виды) | `vin`: С15 (`reminder:vin:<id>:4h`, `sellerCards.postVin` с заметкой); `claim_deadline`: за 2 сут до `claims.deadline_at` открытой претензии без решения → владельцу `staff_claim_deadline` (`reminder:<order>:claim:<claim_id>`); `install`: за 24 ч до `confirmed` слота → клиенту `install_reminder` (`reminder:<order>:install:<booking_id>`), `reminded_at` |
| `retention` (ежедневно) | С16: пачками по 100, `files.delete` каждого ключа, затем `photos = '[]'`, `photos_deleted_at`; ошибка удаления одного ключа не мешает остальным, заявка остаётся на следующий проход |

Тесты (`test/housekeeping-1c.int.test.ts`, `now` внедряется): напоминание VIN ровно одно через 4 ч,
ночью — `available_at` утром; заявка с отправленной подборкой — без напоминания; дедлайн претензии
за 2 дня — одно; установка за 24 ч — одно; ретенция на 91-й день удаляет объекты из memory-store и
ключи, на 89-й — нет, повторный проход — ноль; **напоминания 3/6/9 из 1B не сломаны** (регрессия).

## 8. Клиентский Telegram-бот (волна 3, пакет `client-bot`)

`apps/worker/src/bots/client/*`, grammY 1.46, long polling, свой токен `TG_CLIENT_BOT_TOKEN`,
`allowed_updates: ['message', 'callback_query', 'my_chat_member']`, только личные чаты (группы —
молчание), `bot.catch` с `describeBotError` без токена (импорт из `bots/seller/errors.ts` только на
чтение), свой запуск polling с растущей паузой `bots/client/runner.ts` (по образцу `startSellerBot`;
файлы бота продавца этот пакет не меняет).

| Вход | Поведение |
|---|---|
| `/start <token>` | С3: `consumeLinkToken` → ожидание контакта в Redis → «Чтобы подключить статусы заказа DT-…, подтвердите номер» + клавиатура `request_contact` (одноразовая). Токен не найден/использован/истёк → «Ссылка устарела. Нажмите „Статусы в Telegram“ на странице заказа ещё раз» |
| контакт | `contact.user_id !== from.id` → «Отправьте свой номер кнопкой ниже»; нет ожидания → «Сначала откройте ссылку со страницы заказа»; номер совпал → `bindMessenger`, «Готово: статусы заказов будут приходить сюда. Отключить — /stop», убрать клавиатуру, показать заказы; не совпал → С3 |
| `/start` без параметра | Привязан → список заказов; привязка заблокирована → снять блокировку (С4); иначе — как подключить |
| `/orders`, кнопка «Мои заказы» | До 5 последних заказов пользователя: номер, статус (`ORDER_STATUS_LABELS`), позиции «Бренд Артикул», ближайшее действие; кнопки по статусу: «Подтверждаю», «Согласен», «Записаться на установку», «Претензия» (url), «Открыть заказ» (url) |
| `/stop`, кнопка `unsub` | `setMessengerBlocked(true)`; «Уведомления отключены. Включить — /start» |
| `my_chat_member` `kicked` | `setMessengerBlocked(true)` молча |
| `a:confirm\|approve:<order>:…` | С5: принадлежность → `performClientAction` → `answerCallbackQuery` («Заказ подтверждён» / «Готово») и обновление сообщения (кнопки сняты) |
| `a:refund\|refused:<order>:…` | Ответ кнопкой-ссылкой на `/o/<token>#decision` или `#refuse` (С5) |
| `a:install:<order>:…` | `installSlotsForOrder` → до 6 кнопок слотов `a:islot:<order>:<nonce>` (nonce → ISO слота в Redis `<prefix>client:slot:<nonce>`, TTL 15 мин) + «Другое время — на странице заказа» (url); пусто → причина словами |
| `a:islot:<order>:<nonce>` | Слот из Redis → `bookInstall(via 'bot')` → «Записали на чт 9 окт 14:00, ждём подтверждения мастера. Установка оплачивается в сервисе по его чеку»; `slot_taken` → свежий список |
| прочий текст/фото | С24 |

`app.ts`: блок клиентского бота (создание, старт после schedulers, остановка в shutdown);
`shutdown.ts`: ресурсы `bots: {stop}[]` вместо одного `bot`. Логи: id обновления, номер заказа,
действие; без телефона, контакта, токенов. Документы пакета: `docs/runbook.md` раздел «Фаза 1C»
(BotFather для клиентского бота: `/setcommands` start/orders/stop, `/setjoingroups` off, приватность;
`FILES_STORAGE=s3` и бакет; процедура претензии для Лёши; VIN-заявки; запись на установку; печать
PDF; ретенция), `README.md` (эндпоинты, очереди и боты 1C), `docs/external.md` раздел 8 «Фаза 1C:
VERIFY» — каркас таблицы (итоговый grep всех `VERIFY:` 1C — на интеграции).

Тесты (`apps/worker/test/client-bot*.test.ts`, подмена транспорта grammY, база `_worker`):
**привязка с двух аккаунтов**: аккаунт A по ссылке + свой контакт с номером заказа → привязка,
`phone_confirmed_at`, журнал; аккаунт B по той же ссылке → «устарела»; аккаунт C по новой ссылке с
чужим номером → привязки нет; контакт чужого пользователя (`user_id ≠ from.id`) → отказ; `/stop` →
`blocked_at`, следующий `arrived` уходит SMS; `/start` → блокировка снята; «Подтверждаю» от
непривязанного → «Это не ваш заказ», статус не меняется; «Подтверждаю» от привязанного →
`confirmed`; «Вернуть деньги» → только ссылка, статус не меняется; запись через слоты → строка
`install_bookings`, повтор нажатия → `already_booked`; в каждом исходящем тексте бота нет телефона
(grep `sendMessage` фейка); `process.int.test.ts` — старт и SIGTERM с двумя ботами без сети.

## 9. Бот продавца 1C (волна 3, пакет `seller-bot-1c`)

1. **Карточка заказа** (`card-view.ts`): блок «Претензия: брак · позиция MANN W 914/2 · ответить до
   12 окт · возврат принят ✓/нет · фото клиента: 2 (в админке)» и «Запись на установку: чт 9 окт
   14:00 — ждёт подтверждения»; кнопки из `availableStaffActions` (коды 5.2 п. 4) с id претензии или
   записи; «Фото упаковки» (`pphoto`) в `ordered_at_supplier`/`ready`. Подсказка в
   `ordered_at_supplier`: «Пришлите фото упаковки ответом на эту карточку, затем „Приехало“».
2. **Фото**: фото ответом на открытую карточку заказа или после `pphoto`/`cret` (ожидание в Redis)
   → `getFile` → скачивание `https://api.telegram.org/file/bot<token>/<path>` через `deps.fetch`
   (≤ 20 МБ, `VERIFY:`) → `ingestImage` → `files.put(order/<orderId>/<uuid>.jpg)` →
   `addOrderPhoto` или `acceptClaimReturn`; ответ «Фото сохранено», карточка обновлена. Без
   хранилища (`FILES_STORAGE=none`) — «Хранилище фото не настроено», ничего не меняется.
3. **Претензии**: `cret` → ForceReply «Пришлите фото возвращённой детали»; `cref`/`crepl`/`crej` →
   ForceReply «Текст ответа клиенту (он увидит его на странице заказа)» → `decideClaim`; владелец на
   неактивной `cref` → ForceReply «Причина возврата без приёмки детали» → затем текст ответа;
   `cclose` → «Замена выдана». Отказ охраны → `answerCallbackQuery(failureMessage)` без изменений.
4. **Записи**: `bconf`/`bdecl`/`bdone`/`bnoshow` → `decideInstall`.
5. **VIN-заявки**: `postVin` (реализация `SellerCardPort`): карточка `seller_cards` `kind='vin'`:
   «Заявка VIN № <короткий id> · VIN XTA21099… (полностью — VIN не ПД сам по себе) · нужно:
   «<maskDigits(need)>» · авто: … · фото: N (в админке) · клиент •••4567 · канал ответа: Telegram/SMS»;
   кнопки «Взять в работу» (`vtake`), «Ответить строками» (`vans` → ForceReply с примером формата),
   «Закрыть заявку» (`vclose` → ForceReply причины), «Открыть в админке». Ответ строками →
   `previewVinAnswer` (поиск — `deps.rossko.search`) → `saveVinPreview` → карточка-превью: строка «✓
   MANN W 914/2 × 1 — 1 088 ₽, к чт 9 окт, в Оренбурге» / «✗ 2: BOSH OC90 — бренд не найден: MAHLE,
   KNECHT», итог; кнопки «Отправить клиенту» (`vsend`, только без ошибок) и «Исправить» (`vfix`).
   `vsend` → `sendVinProposal` → «Подборка отправлена клиенту (Telegram/SMS)». `refreshVin` и
   закрытие прежних VIN-карточек — как у заказов (новый nonce на каждое изменение).
6. Тесты (`apps/worker/test/seller-bot-1c*.test.ts` и `apps/worker/test/flow/phase-1c.int.test.ts`,
   подмена транспорта grammY, fixture-caller Rossko, msw ЮKassa, memory `FileStore`): **VIN с двумя
   фото → карточка без фото и без полного телефона → ответ строками с опечаткой → превью с ошибкой,
   «Отправить» отсутствует → «Исправить» → верные строки → «Отправить» → клиенту ушёл
   `vin_proposal` (фейк Telegram/SMS) со ссылкой `/p/`**; карточка заказа `handed` с претензией:
   `cref` продавцом недоступна до `cret`; `cret` + фото → `return_accepted_at`, фото в `order_photos`;
   `cref` + текст → `refund_pending` → msw `refund.succeeded` → `refunded`, чек `refund_full`
   succeeded; запись: `bconf` → клиенту `install_confirmed`; фото упаковки ответом на карточку →
   `order_photos`, `arrived` клиенту с фото; все `callback_data` ≤ 64 байт; чужой пользователь —
   молчание; ни одно исходящее сообщение продавцам не содержит полного телефона и VIN-фото.

## 10. Сайт: страница заказа (волна 3, пакет `web-order`)

Всё в дизайне «Техкарта» (`docs/design.md`, `components/ui`, иконки `components/icons`), 375 и
1280 без горизонтального скролла, `Card`/`Section` как у блоков 1B.

1. **Уведомления о статусе** (`MessengerStubs` → `MessengerBlock`): «Статусы в Telegram» — форма
   `POST /api/orders/<token>/link {channel:'telegram'}` → `createLinkToken` → 303 на
   `https://t.me/<TG_CLIENT_BOT_USERNAME>?start=<link token>` (без username — неактивна, «скоро»);
   подключено → «Статусы приходят в Telegram ✓» и как отключить (`/stop`); заблокировано →
   «Вы отключили уведомления — подключить снова»; «Статусы в MAX» — неактивная заглушка «после
   запуска MAX». Текст: подписка на уведомления, не вход в аккаунт.
2. **Запись на установку** (`InstallBookingBlock`, id `#install`): при `INSTALL_PARTNER_NAME` и
   статусе из `INSTALL_BOOKABLE_STATUSES` — до 6 слотов (радио-чипы `Chip`, «чт 9 окт · 14:00»),
   текст С6 про оплату в сервисе по его чеку, кнопка «Записаться»; `POST
   /api/orders/<token>/install {slotAt, requestKey}` → 303 с флеш-сообщением; есть запись →
   «Вы записаны на чт 9 окт 14:00 — ждём подтверждения мастера / подтверждено» и «Отменить запись»
   (`POST …/install/cancel`). Цены нет. Существующая строка «Подъёмник … машина готова» сохраняется.
3. **Претензия** (`ClaimBlock`, id `#claim`): после выдачи (и `delay` до выдачи по
   `claimKindsAvailable`) — «Претензия или возврат»: выбор позиции (или весь заказ), вид (радио с
   объяснением простыми словами и сроками), текст, `PhotoInput` до 3 фото, 4 цифры телефона, кнопка;
   `POST /api/orders/<token>/claims` (multipart, `readPhotoForm`, файлы → `claim/<orderId>/<uuid>.jpg`)
   → `openClaim`. Открытая претензия: статус («принята, ответим до 12 октября»), **порядок действий**
   (принести деталь в упаковке в точку, адрес и часы; без упаковки — тоже примем, решим по
   состоянию; деньги — в течение 10 дней после решения, на ту же карту), «возврат принят мастером ✓»,
   решение и текст ответа, состояние возврата денег (блок 1B `RefundBlock`). Ссылка «Памятка о
   возврате (PDF)» после выдачи.
4. **Фото упаковки**: галерея `order_photos` `packaging` (миниатюры, `loading="lazy"`), маршрут
   `GET /api/orders/<token>/photos/<photoId>` (токен заказа, фото этого заказа, `kind` из
   `packaging`/`handover`; `Cache-Control: private, no-store`; фото возврата и претензий клиенту не
   отдаются).
5. Таймлайн (`timeline.ts`): фразы для новых журнальных событий (`claim_*`, `install_*`,
   `messenger_bound`, `photo_added`); `messenger_unbound` скрыт.
6. `server/install/*`: `bookings-load-source.ts` делегирует `loadInstallLoad`; `slotsForOrder` для
   страницы; `/o/demo`: демо-слоты из demo-загрузки, формы ведут в демо-экраны (С21), фикстура
   `server/demo/order-fixture.ts` дополняется демо-претензией и фото-заглушкой без файлов.
7. Статические PDF (С23): `scripts/make-print-pdfs.ts`, `scripts/print-templates/{pamyatka,akt}.html`,
   `apps/web/public/print/*.pdf`.
8. Тесты: `test/order-1c-*.int.test.ts` (база `_web`): `link` создаёт токен и 303 на `t.me` без
   токена заказа в `Location`, без username → 409; запись: слот → строка, тот же `requestKey` → та же
   запись, занятый слот → 409 с текстом; претензия: неверные 4 цифры → 422, без фото и с 2 фото →
   строка `claims`, файлы в memory-store, 4 фото → 413/422, `refusal` через 8 дней → 409; фото
   упаковки чужого заказа → 404; HTML страницы не содержит телефона клиента и текста других
   претензий. E2E `apps/web/e2e/order-1c.spec.ts` (заказ доводится до `handed` через админку, как в
   1B): кнопка Telegram ведёт на `t.me/…?start=`, запись на слот, претензия с фото (файл-фикстура
   JPEG), скриншоты `/o/<token>` в состояниях `ready` (запись) и `handed` (претензия) и `/o/demo` на
   375 и 1280 без горизонтального скролла.

## 11. Сайт: VIN, подборка, оформление, админка, e2e (волна 3, пакет `web-staff`)

1. **`/vin`** (`app/(site)/vin/page.tsx`, `components/vin/*`): гейт открыт → форма С12 в дизайне
   «Техкарта» (`Field`, `Input`, `PhotoInput`, `Chip` выбора канала, `Button`, блок «Как это
   работает» и `VinPlate` 1B сохраняются, телефон точки — в боковой панели), honeypot, согласие
   отдельным чекбоксом со ссылкой на `/docs/consent`; гейт закрыт → текущая страница без формы.
   `POST /api/vin` (`server/vin/submit-handler.ts`): Origin, лимит `vin`, `readPhotoForm`,
   валидация с сообщениями по полям (303 обратно с кодами ошибок в query без значений полей —
   введённые значения сохраняет клиентский компонент), `createVinRequest`. `/vin/sent` и
   `/vin/sent/[link]`: «Заявка принята, мастер ответит в рабочее время, обычно в течение 4 часов» +
   «Подключить Telegram» (deep link из токена пути) или «Пришлём SMS». Демо — С21.
2. **`/p/<token>`** (`app/(site)/p/[token]/page.tsx`, noindex): шапка «Подборка мастера», комментарий,
   строки `PartTile`/`OfferRow`-стиль (бренд, артикул, название, кол-во, цена, «к чт 9 октября»,
   бейдж «В Оренбурге — оплата при получении» / «Под заказ — предоплата»), итог, «Оформить и
   оплатить» (`POST /api/proposals/<token>/take` → `copyProposalToCart` → 303 `/checkout`), правило
   «подобрали мы и не подошло — вернём деньги», `MobileCartBar`-подобная нижняя панель на 375;
   истёкшая — только просмотр. `/p/demo` — фикстура.
3. **Оформление** (`server/checkout/checkout-service.ts`): корзина с `vin_request_id` → заказ с
   `orders.vin_request_id`, `markVinConverted`, журнал `vin_order` — в той же транзакции.
4. **Админка** (Basic auth): навигация «Заказы · Заявки VIN · Требуют внимания · Претензии»;
   `/admin/vin`, `/admin/vin/[id]` (С26: ответ строками → «Проверить» → превью-таблица с ошибками
   по строкам → «Отправить клиенту» / «Исправить» → «Закрыть»); карточка заказа: «Претензии»
   (решение с обязательным текстом, «Принял возврат» с обязательной загрузкой фото, override
   владельца с причиной, компенсация для `delay`, «Замена выдана»), «Запись на установку», «Фото»
   (загрузка упаковки, просмотр всех видов, включая фото претензий и возврата); `GET
   /api/admin/files/[...key]`; формы через `POST /api/admin/{orders/[id]/actions, vin/[id]/actions}`
   (multipart там, где фото) → `performStaffAction`/функции `vin-core` → 303 с флешем. Ссылки на оба
   PDF.
5. **E2E** `apps/web/e2e/vin-flow.spec.ts` + `scripts/e2e-1c.sh` (как `e2e-1b.sh` плюс
   `FILES_STORAGE=local`, `FILES_LOCAL_DIR=$(mktemp -d)`, `INSTALL_PARTNER_NAME`,
   `INSTALL_PARTNER_REQUISITES`, `TG_CLIENT_BOT_USERNAME=detaly_test_bot` без токена; Playwright всех
   спеков 1A+1B+1C; grep логов на телефоны, токены `/o`, `/p`, link и VIN целиком): **/vin с двумя
   фото → админка: ответ «MANN W9142X 1» → превью с ошибкой, «Отправить» нет → «MANN W 914/2 1» →
   «Отправить клиенту» → `/p/<token>` (ссылка из админки/БД) → «Оформить и оплатить» → `/checkout` →
   оформление prepay → «Оплатить» → мок ЮKassa → `/o/<token>?paid=1` → «Оплачен»; в админке заявка
   «Оформлена»**. `screens.spec.ts`: `/vin` с формой, `/vin/sent`, `/p/demo`, `/p/<token>` на 375 и
   1280, скриншоты; `.github/workflows/ci.yml` — job `e2e` на `scripts/e2e-1c.sh`.
6. Тесты: `test/vin-*.int.test.ts`, `test/proposal-*.int.test.ts`, `test/admin-1c-*.int.test.ts`,
   обновлённый `checkout-api.int.test.ts`: гейт закрыт → формы нет и `POST /api/vin` → 403; VIN с `O` →
   422 с подсказкой; без согласия → 422, строк нет; 4 фото → 413; успех → строки, файлы, outbox,
   `consents.vin_request_id`; `take` с чужим Origin → 403, истёкшая подборка → 410; checkout из
   подборки → `orders.vin_request_id`, заявка `converted`; админка: превью с ошибкой не даёт
   «Отправить» (409), решение по претензии без текста → 422, «Принял возврат» без фото → 422,
   `cref` продавцом без приёмки → 409 с текстом; файлы админки без Basic auth → 401.

## 12. DEMO_MODE и витрина без БД

Демо-сборка (`cd apps/web && env -u DATABASE_URL -u REDIS_URL DEMO_MODE=true ROSSKO_MODE=fixtures
pnpm run build`) обязана оставаться зелёной после каждого пакета. Правила: ни одного обращения к
`getDb()`/`getRedis()`/`getFileStore().put` в демо-ветках; `sharp`/`aws4fetch` — только
динамические импорты; `/vin` в демо показывает форму с `DemoStrip` «Демо: заявка не отправляется»,
отправка → `/vin/sent?demo=1` («так выглядит ответ»); `/p/demo` и `/o/demo` — фикстуры с блоками
записи и претензии; `test/demo-*.test.ts` дополняются проверкой, что демо-маршруты не пишут и не
читают тело.

## 13. Тест-кейсы и строки Verification «Фаза 1C»

| Строка PLAN | Действие | Чем закрыто в этой среде | Где |
|---|---|---|---|
| V1 | Привязка по deep link с двух аккаунтов (телефон совпадает / нет) | Подмена транспорта grammY: аккаунт с совпавшим контактом → привязка; второй аккаунт по той же ссылке → «устарела»; чужой номер → привязки нет | client-bot int, orders-1c int |
| V2 | Блокировка бота → SMS с `fallback_reason` | Фейк Telegram отвечает 403 → `blocked_at`, SMS (msw), `fallback_reason='blocked:telegram'`; `/stop` → то же без попытки Telegram | notify-1c int, client-bot int |
| V3 | Шаблон вне allowlist без мессенджера → skipped | `ordered` клиенту без привязок и с телефоном → `skipped`, `no_messenger:not_in_sms_allowlist` | notify-1c unit/int |
| V4 | VIN-заявка с фото → ответ строками с опечаткой → превью показывает ошибку → `/p/<token>` → оплата | Бот: flow-тест воркера; сайт: e2e `vin-flow.spec.ts` через админку и мок ЮKassa; разбор строк — unit `preview.test.ts` на фикстурах Rossko | vin-core unit/int, seller-bot-1c flow, web-staff e2e |
| V5 | «Приехало» содержит фото, код выдачи, кнопку записи | Рендер `arrived` и `sendPhoto` фейка: фото упаковки, `Код выдачи`, кнопка `install`; SMS-вариант с кодом | notify-1c, seller-bot-1c |
| V6 | В сообщениях Telegram нет телефона и адреса клиента | Grep рендеров всех клиентских шаблонов и всех исходящих сообщений фейков обоих ботов; маска в карточках продавца | notify-1c, client-bot, seller-bot-1c |
| V7 | «Претензия» по выданному → «Принял возврат» с фото → decision refund → refund succeeded, чек возврата full_payment, `deadline_at = +10 дней от обращения` | Движок + msw ЮKassa: чек `refund_full` с признаком `full_payment` succeeded, `refunds.deadline_at = claims.opened_at + 10 дней`; тот же путь кнопками бота и формами админки | orders-1c int, seller-bot-1c flow, web-staff int |
| V8 | refund без «Принял возврат» заблокирован инвариантом | Домен (`claimRefundAllowed`), движок (`guard_failed`, строк нет), бот (кнопка неактивна, нажатие → текст), админка (409) | domain spec, orders-1c, seller-bot-1c, web-staff |
| V9 | Первый боевой заказ Лёши как клиента: два чека на телефоне, проверка в приложении ФНС, возврат и чек возврата | **Вручную** (Максим и Лёша, боевой магазин ЮKassa) — чек-лист в `docs/runbook.md` «Фаза 1C» | — |
| V10 | Ревизия `order_events` вручную | **Вручную** по первому заказу; помощь — полный таймлайн в админке | — |

Дополнительно (задача фазы): `/p/<token>` → оформление (web-staff int); запись на установку — слот,
гонка двух записей, отмена, подтверждение продавцом (orders-1c, client-bot, web-order, seller-bot-1c);
напоминания 3/6/9 (регрессия 1B, notify-1c); VIN без ответа 4 ч (notify-1c); ретенция фото 90 дней
(notify-1c); DEMO_MODE без записи ПД (web-order, web-staff, демо-сборка); Playwright-скриншоты новых
страниц на 375 и 1280 (web-order, web-staff); логи без телефонов и токенов (e2e-1c).

## 14. Критерии приёмки фазы 1C (в этой среде)

1. `pnpm install --frozen-lockfile`, `pnpm lint`, `pnpm format:check`, `pnpm typecheck`, `pnpm test`,
   `pnpm --filter @detaly/db db:drift` — зелёные; миграция 0004 и двойной сид проходят на базе 1B.
2. Клиентские уведомления на все переходы уходят в Telegram при привязке, иначе SMS только по
   allowlist, иначе `skipped` с `fallback_reason`; MAX учтён интерфейсом (фаза 2).
3. Клиентский бот: deep link с одноразовым токеном ≤ 64 символов и сроком, `request_contact` со
   сверкой номера, статусы заказов, «Записаться на установку», «Претензия» (через `/o`), `/stop`.
4. На `/o/<token>` «Статусы в Telegram» создаёт link token и ведёт в бота; «Статусы в MAX» —
   заглушка.
5. Ручной VIN: форма только при открытом гейте РКН, до 3 фото в `FileStore` без EXIF, карточка в
   боте продавца без фото и полного телефона, ответ строками с проверкой GetSearch и превью с
   ошибками, `/p/<token>` (noindex) → обычное оформление и оплата; напоминание через 4 ч; фото
   удаляются через 90 дней.
6. Запись на установку без цены, слоты из окна `install-window`, подтверждение продавцом; двойная
   запись на один подъёмник невозможна.
7. Претензии: виды и сроки, решение только с текстом, дедлайн +10 дней, «Принял возврат» только с
   фото; refund по претензии (кроме delay) невозможен без него или override владельца с причиной —
   в домене, движке, боте и админке; клиенту — порядок действий.
8. Фото упаковки и код выдачи в «приехало»; напоминания 3/6/9 работают.
9. Все новые страницы в «Техкарте», 375 и 1280 без горизонтального скролла, скриншоты просмотрены;
   демо-сборка без БД зелёная, демо-формы не пишут ПД.
10. E2E 1A + 1B + 1C зелёные через `scripts/e2e-1c.sh`; в логах web и worker нет телефонов, токенов
    и VIN целиком.
11. Все неподтверждённые поля внешних API (Telegram, S3, ЮKassa, Rossko) помечены `VERIFY:` в коде
    и перечислены в `docs/external.md` (раздел 8).
12. Ручные пункты (V9, V10, раздел 7 PLAN п. 11–13) перечислены в runbook и не выдаются за сделанные.

## 15. Заблокировано сетью и как закрыто

| Что | Почему недоступно | Чем закрыто |
|---|---|---|
| Telegram Bot API (`api.telegram.org`): живой клиентский бот, `request_contact`, deep link `?start=`, `sendPhoto`, скачивание файлов `getFile`, 403/429 | `api.telegram.org` закрыт | Подмена транспорта grammY (`client.fetch`/`buildUrl`) в тестах обоих ботов, фейк `clientTelegram` с 403/429; `VERIFY:` формат контакта (`+` в номере), лимит 20 МБ, `retry_after`; живая проверка — после деплоя (runbook) |
| S3 РФ (Timeweb / Yandex Object Storage): подпись, path-style, регион, коды ошибок | `.ru` закрыт, бакета нет | `@detaly/files` `s3` на msw, `local` в e2e; `VERIFY:` и строка в `docs/external.md` |
| Rossko GetSearch для превью VIN (реальные бренды и кроссы) | закрыт, ключей нет | Синтетические фикстуры `GetSearch.*.json`, fixture-caller; `VERIFY:` на правило выбора предложения |
| ЮKassa: возврат по претензии с чеком `refund_full` после чека зачёта | закрыт | msw-эмуляция `@detaly/payments/testing`; stage-прогон — Максим |
| SMS-провайдер (`vin_proposal`, `arrived`) | закрыт | msw, как в 1B |
| MAX (`platform-api.max.ru`) | закрыт | в 1C не реализуется (фаза 2); интерфейс `maxDriver` |
| Приложение ФНС, ЛК ЮKassa, первый боевой заказ | ручное | V9, runbook |
| npm registry | открыт | `aws4fetch`, `sharp` (уже в lock) ставятся в волне 1 |

## 16. Риски и обходы

| Риск | Обход | Проверка |
|---|---|---|
| ПД в Telegram: клиент пишет телефон в тексте заявки/претензии, присылает СТС | Маска 7+ цифр, фото VIN и претензий только в админке, текст решения — только на `/o` | grep-тесты рендеров и фейков |
| Утечка link token / токена подборки | В deep link только одноразовый 24-часовой link token; токены — 128+ бит, `no-referrer`, вырезаются из логов Caddy (путь и `Location`, фундамент) | client-bot int, e2e grep логов |
| EXIF с координатами в фото | Перекодирование `sharp` без метаданных | files unit |
| `sharp` в standalone и на Vercel | Динамический импорт, `serverExternalPackages`, проверка `prepare-standalone.mjs`; демо не вызывает | демо-сборка, e2e загрузки |
| Next обрезает тело до 64 КБ | `proxyClientMaxBodySize: '12mb'`, уменьшение на клиенте | e2e с фото |
| Двойная запись на подъёмник | Advisory lock + повторная проверка + unique активной записи | orders-1c int (гонка) |
| Спам заявками VIN и претензиями | Лимиты С27, honeypot, Origin, 4 цифры, `request_key` | web int |
| Переквалификация в агентирование (установка через нас) | Нигде нет цены установки, текст «оплачивается в сервисе по его чеку», в чеках только товар | тест-grep схемы и шаблонов |
| Решение «замена» без чеков — позиция ФНС | `VERIFY:` у бухгалтера; при необходимости — возврат + новый заказ вместо замены (решение `refund`) | runbook |
| Компенсация по ст. 23.1 без чека | `VERIFY:` (PLAN раздел 3), только запись в журнале, выплата вне системы | runbook |
| Неверная сверка номера (формат контакта Telegram без `+`) | `normalizePhone` на обе стороны, тест на `79…`, `+79…`, `89…` | client-bot int |
| Два бота в одном процессе | Отдельные `Bot`, раздельный перезапуск polling, общий shutdown | process int |
| Опечатка продавца уходит клиенту | «Отправить» недоступна при ошибках; превью с ценами перед отправкой | vin-core, seller-bot-1c, web-staff |
| Подборка устарела по ценам | Переоценка на `/p` и обязательный свежий GetSearch на оформлении (409 + DiffBanner) | web-staff int |
| Параллельные пакеты в одной тестовой базе | Свои базы (`_orders`, `_vin`, `_worker`, `_web`, `detaly_test_<worktree>`), Redis `test:<uuid>:` | повторный прогон |

## 17. Волны и пакеты

Правила (как в 1A/1B): пакет — отдельный worktree и ветка `wp/1c-<key>`; агент правит только свои
пути, остальное читает. **После волны 1 схему, миграции, env, lock, `packages/config`,
`packages/domain/src/{statuses,types,journal,timers,claims,vin-requests,install-params}.ts`,
`install-window.ts` и `state-machine/*` не трогает никто** (нужна правка — описать в отчёте, её
делает интеграция). Установка `pnpm install --frozen-lockfile --prefer-offline`; базы —
`scripts/dev-db.sh up && eval "$(scripts/dev-db.sh env)"`; Redis — ключи `test:<uuid>:`, `FLUSHDB`
запрещён; сеть к внешним API не нужна. Коммит после зелёной проверки, без push. Демо-сборка web
проверяется каждым пакетом, который трогает `apps/web` или пакеты, импортируемые web.

| Волна | Пакеты | Зависит от |
|---|---|---|
| 1 | `foundation` | — |
| 2 | `orders-1c`, `vin-core`, `notify-1c` | 1 |
| 3 | `client-bot`, `seller-bot-1c`, `web-order`, `web-staff` | 1, 2 |

| Пакет | Пути (только эти пишет агент) | Разделы |
|---|---|---|
| `foundation` | `packages/db/src/schema/**`, `packages/db/drizzle/**`, `packages/db/test/{phase1c,migrations}.int.test.ts`; `packages/config/src/{env,queues,index}.ts`, `packages/config/test/**`, `.env.example`; `packages/domain/package.json`, `packages/domain/src/{statuses,types,journal,timers,claims,vin-requests,install-params,install-window,index}.ts`, `packages/domain/src/state-machine/**`, `packages/domain/test/{transitions.spec,claims.test,install-window.test,vin-requests.test}.ts`; `packages/files/**` (кроме реализации `src/s3.ts`, где только заглушка); `packages/vin/{package.json,vitest.config.ts,test/global-setup.ts}`; `packages/notify/src/{types.ts,templates/order.ts}`; `apps/worker/package.json`, `apps/worker/src/{deps,create-deps,queues}.ts`, `apps/worker/src/jobs/housekeeping.ts` (только ветка `retention`), `apps/worker/src/jobs/housekeeping/retention.ts` (заглушка), `apps/worker/src/jobs/notify/{index,vin}.ts` (ветка и заглушка), `apps/worker/src/bots/seller/cards.ts` (заглушки `postVin`/`refreshVin`), `apps/worker/test/{helpers/test-deps,queues.test,jobs.test}.ts`; `apps/web/package.json`, `apps/web/next.config.ts`, `apps/web/src/server/{files,uploads,request-limits,rate-limit}.ts`, `apps/web/src/proxy.ts`, `apps/web/src/lib/{install-params,downscale}.ts`, `apps/web/src/server/install/config.ts`, `apps/web/src/components/forms/**`, `apps/web/test/{request-limits,proxy,demo-proxy,rate-limit.int,uploads,caddyfile}.test.ts`; `infra/Caddyfile`; `pnpm-lock.yaml` | 1–4 |
| `orders-1c` | `packages/orders/src/**`, `packages/orders/test/**` | 5 |
| `vin-core` | `packages/vin/src/**`, `packages/vin/test/**`, `packages/files/src/s3.ts`, `packages/files/test/s3.test.ts` | 6 |
| `notify-1c` | `packages/notify/src/**`, `packages/notify/test/**`, `apps/worker/src/jobs/notify/**`, `apps/worker/src/jobs/housekeeping.ts`, `apps/worker/src/jobs/housekeeping/**`, `apps/worker/test/{notify,housekeeping}-*.test.ts` | 7 |
| `client-bot` | `apps/worker/src/bots/client/**`, `apps/worker/src/{app,shutdown}.ts`, `apps/worker/test/client-bot*.test.ts`, `apps/worker/test/{process.int,shutdown}.test.ts`, `docs/runbook.md`, `docs/external.md`, `README.md` | 8 |
| `seller-bot-1c` | `apps/worker/src/bots/seller/**`, `apps/worker/test/seller-bot*.test.ts`, `apps/worker/test/staff*.test.ts`, `apps/worker/test/flow/phase-1c.int.test.ts` | 9 |
| `web-order` | `apps/web/src/app/(site)/o/**`, `apps/web/src/app/api/orders/**`, `apps/web/src/server/orders/**`, `apps/web/src/server/install/**` (кроме `config.ts`), `apps/web/src/components/order/**`, `apps/web/src/components/install/**`, `apps/web/src/server/demo/order-fixture.ts`, `apps/web/public/print/**`, `scripts/make-print-pdfs.ts`, `scripts/print-templates/**`, `apps/web/test/{order-*,install-*,demo-order}.test.ts`, `apps/web/test/order-1c-*.int.test.ts`, `apps/web/e2e/order-1c.spec.ts` | 10, 12 |
| `web-staff` | `apps/web/src/app/(site)/vin/**`, `apps/web/src/app/(site)/p/**`, `apps/web/src/app/api/vin/**`, `apps/web/src/app/api/proposals/**`, `apps/web/src/server/vin/**`, `apps/web/src/server/checkout/**`, `apps/web/src/components/vin/**`, `apps/web/src/server/demo/proposal-fixture.ts`, `apps/web/src/app/admin/**`, `apps/web/src/app/api/admin/**`, `apps/web/src/server/admin/**`, `apps/web/src/components/admin/**`, `apps/web/test/{vin-*,proposal-*,admin-*,checkout-*,demo-mode}.test.ts`, `apps/web/e2e/{vin-flow,screens}.spec.ts`, `scripts/e2e-1c.sh`, `.github/workflows/ci.yml` | 11, 12 |

Общие файлы: `apps/worker/test/helpers/test-deps.ts`, `apps/web/src/server/{files,uploads}.ts`,
`apps/web/src/components/forms/PhotoInput.tsx`, `apps/web/src/proxy.ts` и лимиты пишет фундамент,
остальные только импортируют. Корневой `app/layout.tsx` и `app/(site)/layout.tsx` не трогает
никто; `apps/web/e2e/helpers.ts`, `apps/web/playwright.config.ts` — только чтение (новые хелперы — в
своих spec-файлах). `infra/Caddyfile` правит фундамент.

### Шаг И — интеграция (после каждой волны)

Слияние веток волны, `pnpm install --frozen-lockfile`, полный прогон раздела 18 в объёме уже
слитого, независимый ревьюер на пакет (ПД в сообщениях и логах, деньги по претензиям, гонки записи,
одноразовость токенов, DEMO_MODE). После волны 3: `docs/external.md` — итоговый grep
`VERIFY:` 1C, скриншоты глазами, коммит без push.

## 18. Итоговая проверка фазы в этой сессии

```bash
cd /home/user/detaly
pnpm install --frozen-lockfile
scripts/dev-db.sh up && eval "$(scripts/dev-db.sh env)"
pnpm lint && pnpm format:check && pnpm typecheck
pnpm test && pnpm --filter @detaly/db db:drift
pnpm db:migrate && pnpm db:seed && pnpm db:seed
(cd apps/web && env -u DATABASE_URL -u REDIS_URL DEMO_MODE=true ROSSKO_MODE=fixtures pnpm run build)
bash scripts/e2e-1c.sh   # web standalone :3100, worker, мок ЮKassa :3199, Playwright 1A+1B+1C, grep логов
```

Env для e2e 1C (дополнительно к разделу 23 документа 1B): `FILES_STORAGE=local`,
`FILES_LOCAL_DIR=<временный каталог>`, `INSTALL_PARTNER_NAME=Тестовый сервис`,
`INSTALL_PARTNER_REQUISITES=ИП Тестов Т. Т., ИНН 561234567890`, `TG_CLIENT_BOT_USERNAME=detaly_test_bot`
(без `TG_CLIENT_BOT_TOKEN`: бот не стартует, сети нет). Ручная проверка: `curl -X POST …/api/vin`
с чужим `Origin` → 403; `curl -I …/p/<token>` → `X-Robots-Tag: noindex`, `Referrer-Policy:
no-referrer`.

## 19. Что не входит в 1C (честно)

Драйвер MAX, привязка и вебхук MAX (фаза 2: в 1C кнопка «Статусы в MAX» — заглушка);
переписка с мастером в боте (`chat_messages`, ф2) — автоответ с телефоном точки; утренний
дайджест; конструктор подборки в админке и экспорт CSV (ф2: ответ строками есть, произвольного
редактора позиций нет); каталожный VIN-резолвер (ф3); обезличивание по запросу и ретенция прочих ПД
(ф2: в 1C — только фото VIN 90 дней); генерация PDF (статические шаблоны с пустыми реквизитами);
чек коррекции; автоматическая выплата компенсации по ст. 23.1 (только запись суммы); курьер. Живые
Telegram, S3, ЮKassa, Rossko и SMS не проверялись: всё на подменённом транспорте grammY, msw и
фикстурах. Ручное — первый боевой заказ Лёши как клиента, два чека в приложении ФНС, возврат и чек
возврата, ревизия `order_events`, подписанный договор с Лёшей, доверенность, распечатанные памятки и
уголок потребителя (PLAN раздел 7, п. 11–13).
