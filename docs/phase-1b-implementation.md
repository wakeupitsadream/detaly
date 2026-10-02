# Фаза 1B: деньги, чеки, машина состояний, бот продавца — детальная разбивка

Дополнение к `docs/PLAN.md` (раздел 6 «Фаза 1B», разделы 1–5, Verification «Фаза 1B», шаги
1–23) и к `docs/phase-1a-implementation.md`. Написано архитектором 02.10.2026 по коду на HEAD
`23e3385` (фазы 0 и 1A приняты: 1067 тестов, e2e 44 passed). При расхождении приоритет у
`docs/PLAN.md`; решения фаундера не пересматриваются.

## Что уже есть и не переписывается

| Что | Где | Состояние |
|---|---|---|
| Таблица переходов (≈90 правил), охраны, `resolveTransition`, `availableEvents`, `effectsFor`, `receiptFor`, спецификация с полным перебором пар | `packages/domain/src/state-machine/*`, `packages/domain/test/transitions.spec.ts` | Полная; 1B дополняет точечно (раздел 3.4) |
| ЮKassa: `createPayment`, `getPayment`, `createRefund`, `getRefund`, `createOffsetReceipt`, `getReceipt`, `parseYooKassaWebhook`, `webhookJobId`, перевод копеек, инварианты строк чека; msw-эмуляция с хранилищем и идемпотентностью | `packages/payments/src/*`, `packages/payments/src/testing/yookassa-handlers.ts` | Работает на msw; дополняется в разделе 6 |
| `Notifier`, `selectChannel` с allowlist SMS, шаблоны на все `ORDER_NOTIFY_TEMPLATES`, драйвер Telegram, кодек `callback_data` ≤ 64 байт, `CALLBACK_ACTIONS` | `packages/notify/src/*` | Нет драйвера SMS, нет лимитов и бюджета (раздел 7) |
| Rossko: `checkout()` с `CheckoutDisabledError` при `ROSSKO_ALLOW_CHECKOUT=false`, `orders(ids)`, `checkoutMayHaveExecuted`, фикстуры `GetCheckout.ok/itemErrors`, `GetOrders` | `packages/rossko/src/*`, `packages/rossko/fixtures/*` | Нет сопоставления itemErrors с позициями, нет восстановления без id (раздел 8) |
| Таблицы `payments`, `receipts`, `refunds`, `supplier_orders`, `supplier_order_items`, `supplier_returns`, `stock_items`, `webhook_events`, `notifications`, `order_events` | `packages/db/src/schema/*` | Дополняются миграцией 0002 (раздел 1) |
| Очереди BullMQ (7 имён), Job Scheduler heartbeat, заглушки процессоров, graceful shutdown | `apps/worker/src/*` | Процессоры — заглушки `UnrecoverableError('phase 0')` |
| Бот продавца: grammY, long polling, `staffOnly`, `allowedChats`, `/ping`, тесты через подмену транспорта | `apps/worker/src/bots/seller/*` | Только `/ping` |
| Оформление: `draft → awaiting_payment | awaiting_confirmation`, `order_events.payload.deferredEffects: ['create_payment']`; отмена клиентом с `deferredEffects`/`deferredNotify` | `apps/web/src/server/checkout/checkout-service.ts`, `apps/web/src/server/orders/cancel.ts` | 1B переводит их на исполнение эффектов (разделы 5, 12.4) |

## 0. Решения по умолчанию, принятые в 1B

Ниже всё, что PLAN не фиксирует однозначно или что упирается в поведение библиотек. Каждое
решение можно поменять, не ломая остальное.

| № | Решение | Почему |
|---|---|---|
| Б1 | **Outbox.** Эффекты переходов (уведомления, платежи, возвраты, чеки, GetCheckout) пишутся строками таблицы `outbox` в той же транзакции, что и переход. Воркер забирает строки (`for update skip locked`) и кладёт задачи в BullMQ. Web после коммита делает `PUBLISH detaly:outbox` (best effort), воркер подписан и забирает сразу; без сигнала — проход раз в 2 с | Переход и его последствия атомарны; web не зависит от BullMQ; потеря Redis не теряет задач |
| Б2 | BullMQ 6.3 отвергает `jobId` с `:` (кроме ровно трёх частей; `classes/job.js`). Логический ключ задачи хранится в `outbox.job_id` в формате PLAN (`payment.succeeded:<object.id>`, `${order_event_id}:…`), а в BullMQ уходит `bullJobId(key) = key.replaceAll(':', '|')` | Иначе `queue.add` бросает `Custom Id cannot contain :` |
| Б3 | Идемпотентность держится на БД, а не на дедупликации BullMQ (`removeOnComplete` вытесняет старые jobId): каждый процессор сначала читает состояние строки (`payments.status`, `receipts.status`, `supplier_orders.status`, `notifications.dedupe_key`) и выходит, если работа сделана | Повтор задачи после рестарта или вытеснения не дублирует эффект |
| Б4 | Вебхук ЮKassa: IP берётся только из `X-Real-IP` и только при `TRUSTED_IP_HEADER=x-real-ip`; сверка с `YOOKASSA_WEBHOOK_IP_ALLOWLIST` (IP и CIDR, IPv4/IPv6) через `node:net` `BlockList`. Пустой список или `TRUSTED_IP_HEADER=none` → 403 на любой вебхук (fail closed) и предупреждение при старте | PLAN раздел 1; Caddy — единственный, кто ставит `X-Real-IP` |
| Б5 | Платёж создаётся **лениво**: кнопка «Оплатить N ₽» на `/o/<token>` → `POST /api/orders/<token>/pay` → строки `payments` и `receipts` (pending) в транзакции → `createPayment` вне транзакции → 303 на `confirmation_url`. Отложенный эффект 1A `create_payment` этим и закрыт. `orders.expires_at` для `awaiting_payment` = момент оформления + `order.payment_ttl_min` (у заказов 1A там `null` — housekeeping берёт `created_at + ttl`) | PLAN: «синхронно … создание платежа при оформлении»; без клика клиента платёж не нужен |
| Б6 | Оплата включена, только если заданы `YOOKASSA_SHOP_ID`, `YOOKASSA_SECRET_KEY`, `YOOKASSA_VAT_CODE`, `YOOKASSA_TAX_SYSTEM_CODE`. Иначе на `/o/<token>` остаётся текст 1A «Оплата подключается». Платёж без чека не создаётся никогда (план Б с облачной ККТ — после ответа ЮKassa, раздел 20) | 54-ФЗ: оплата без чека недопустима |
| Б7 | `metadata` платежа: `order_id`, `order_number`, `payment_row_id`. В `payments.request` хранится тело POST: reconciliation повторяет POST с тем же `Idempotence-Key` и тем же телом, если `provider_payment_id` не успели записать. То же для `refunds.request` | Восстановление после падения между ответом ЮKassa и записью в БД |
| Б8 | Уникальный индекс `payments_order_id_succeeded_unique` (фаза 0) **снимается** миграцией 0002: он противоречит правилу «неожиданный платёж → needs_attention», заложенному в TRANSITIONS (дубль оплаты из двух вкладок нельзя записать как succeeded). Инвариант «один принятый платёж» держит движок: второй succeeded → правило неожиданного платежа (владельцу) или автоматический возврат для `refunded` | Реальный двойной платёж должен быть виден в БД, а не падать на constraint |
| Б9 | TTL QR (15 мин): `payment_ttl_expired` из `awaiting_handover_payment` больше не требует подтверждения отмены от ЮKassa (отменить pending-платёж API не даёт); охрана — «текущий платёж и он не succeeded». Если старый QR всё же оплатят, новое правило `ready + payment_succeeded` (pay_on_handover, платёж kind `full`, сумма совпала) возвращает заказ в `awaiting_handover_payment` с оплатой, а не в «неожиданный платёж» | PLAN: «TTL → ready»; клиент, оплативший по старому QR, не должен попасть к владельцу на разбор |
| Б10 | «Клиент не пришёл» в боте = событие `storage_expired` от продавца; доступно только когда окно хранения истекло (`pickupWindowElapsed`). Housekeeping делает то же автоматически | Кнопка из PLAN без отдельной строки в таблице переходов; раньше срока неявка не фиксируется (иначе это отказ клиента) |
| Б11 | Частичные возвраты: новые события `partial_refund_succeeded` / `partial_refund_failed` (самопереходы, статус не меняется), колонка `refunds.scope` (`order`, `item`, `orphan`). `refund_succeeded` (→ `refunded`) — только для возврата `scope=order` | PLAN: «частичный возврат не меняет статус заказа», «позиция → refunded только по refund.succeeded» |
| Б12 | «Проверить и заказать» сам переход не делает: пишет событие журнала `recheck_requested` и задачу `rossko/recheck`. Задача делает GetSearch мимо кэша (priority `critical`) и применяет `supplier_order_requested` с фактами `priceDriftBp`, `allAvailable`. Дрейф — по заказу: `ceil((Σ свежая·qty − Σ старая·qty) · 10000 / Σ старая·qty)`; `allAvailable` — у каждой позиции есть предложение с тем же `offer_key` и остатком ≥ qty. Альтернативы — кроссы из того же ответа с маржой при цене клиента | Охрана `recheckPassed` требует данных, которых до GetSearch нет |
| Б13 | Эффект `supplier_checkout` в транзакции перехода создаёт строку `supplier_orders` (`status='sending'`, `attempt_no` = max+1) и `supplier_order_items` по непокрытым живым позициям, плюс задачу `rossko/checkout` с ключом `checkout:<supplier_order_id>` — ровно одна задача на попытку. Задача ставит `called_at` и **коммитит** до вызова GetCheckout. Задача, увидевшая `called_at` при `status='sending'`, не вызывает GetCheckout повторно, а идёт в восстановление. Частичный уникальный индекс: одна строка `sending` на заказ | PLAN: «запись создаётся до GetCheckout — защита от двойной отправки» |
| Б14 | Восстановление после таймаута: GetOrders без id (список недавних заказов, `VERIFY`), поиск по комментарию `DT-000123/<attempt_no>`. Найдено → как успешный GetCheckout. Не найдено или метод не поддерживает список → `supplier_checkout_failed` с `reason: 'unknown_after_timeout'`, карточка «Проверьте ЛК Rossko: заказ мог создаться». Автоповтора GetCheckout нет никогда. Ручной выход — действие админки «Заказано вручную в ЛК Rossko» | GetOrders требует id, которых после таймаута нет |
| Б15 | `ROSSKO_ALLOW_CHECKOUT=false` → `CheckoutDisabledError` → `supplier_orders.status='failed'`, `supplier_checkout_failed` с `reason: 'checkout_disabled'` → needs_attention с текстом «Автозаказ выключен — закажите в ЛК Rossko и отметьте в админке» | Технический запрет из PLAN, при этом заказ не теряется |
| Б16 | Решение клиента — таблица `client_approvals` (вид `alternative` / `new_eta`, охват `order` / `item`, предложение, срок). Охрана `clientReachable` считается заранее (`canReachClient`: незаблокированная привязка мессенджера, либо телефон + включённый SMS-провайдер + шаблон в allowlist). Таймер 24 ч стартует, когда `decision_needed` реально **отправлено** (`notified_at`, `expires_at`); если при отправке `skipped` — таймера нет, продавцам «Клиент не получил уведомление — позвоните». Напоминание клиенту через 12 ч | PLAN: «если уведомление skipped — таймер не запускается» |
| Б17 | Карточки продавца рисует бот из состояния БД (а не шаблоны notify): позиции с состояниями, маскированный телефон, доступные действия по `availableStaffActions`. Одна карточка — одно сообщение и один nonce (8 символов base64url) в таблице `seller_cards`. Нажатие редактирует эту карточку, старые открытые карточки заказа закрываются (клавиатура снимается). Устаревший nonce → `answerCallbackQuery('Карточка устарела, откройте свежую')` | PLAN: «карточка редактируется после нажатия»; защита от двойного нажатия и чужих кнопок |
| Б18 | `callback_data = a:<action>:<id>:<nonce>`; `<id>` — uuid заказа или позиции (зависит от действия, таблица 13.2). Максимум: `a:` + 7 (`recheck`, `icancel`, `invpaid`) + `:` + 36 + `:` + 8 = 55 байт ≤ 64 | PLAN раздел 4 |
| Б19 | Адресат `owner` — личный чат владельца (`staff.role='owner'`, `tg_user_id`); при ошибке 403 (бот не запущен владельцем) — чат продавцов. Пользователь Basic auth админки действует как владелец: `actor_type='staff'`, `actor_id='admin'`, роль `owner` | Одна учётка админки — у Максима |
| Б20 | `notifications.dedupe_key = ${order_event_id}:${template}:${channel ?? 'none'}` — формат PLAN `${order_event_id}:${channel}` плюс шаблон: одно событие уведомляет клиента и продавцов, возможно по одному каналу. Для сообщений в чат без `user_id`/`staff_id` — новая колонка `notifications.chat_id`, check ослабляется | Без шаблона клиентское и продавцовое сообщение одного события столкнулись бы |
| Б21 | SMS: лимит 1 на номер за 10 мин и 3 за сутки (Redis, ключ — HMAC(`SESSION_SECRET`, телефон), без ПД в ключах); превышение → `skipped` с `fallback_reason='sms_rate_limited'`. Бюджет: стоимость `SMS_PRICE_KOP` пишется в `api_calls.cost_kop` (source `sms`); 80% `SMS_MONTHLY_BUDGET_RUB` за календарный месяц (Asia/Yekaterinburg) — один алерт в месяц, 100% — `skipped` с `sms_budget_exhausted` | PLAN разделы 1 и 4; жёсткий стоп на 100% защищает от накрутки |
| Б22 | Чек зачёта: первая попытка по «Клиент пришёл», опрос `GET /receipts/{id}` каждые 2 мин до 15 мин от первой попытки, повтор POST — с тем же `Idempotence-Key`. Через 15 мин без `succeeded` — алерт, «Выдал» заблокирована. Кнопка «Повторить чек» (`offset_receipt_requested`) берёт **новый** ключ только если прошлая попытка окончательно отвергнута (4xx, чек не создан): старая строка → `canceled`, новая строка — новый ключ | PLAN раздел 1; после исправления `YOOKASSA_TAX_SYSTEM_CODE` тот же ключ с другим телом ЮKassa отвергнет |
| Б23 | Статус чека, отправленного в составе платежа (предоплата, полный расчёт на точке): `payment.receipt_registration` из GET /payments (`VERIFY`), а при `pending` — `GET /receipts?payment_id=` (`VERIFY`). Для pay_on_handover «Выдал» требует `receipts.kind='full'` в `succeeded` | Охрана `settlementReceiptSucceeded` |
| Б24 | Клиентские действия на `/o/<token>`: «Подтверждаю», «Согласен», «Оплатить заранее» — токен ссылки + подтверждение в интерфейсе; «Вернуть деньги», «Отказаться от заказа», «Отменить позицию» — дополнительно последние 4 цифры телефона (механика отмены 1A, тот же счётчик неудач) | PLAN: деструктивные действия подтверждаются 4 цифрами |
| Б25 | `/admin` и `/api/admin/*` — Basic auth в `src/proxy.ts`: сравнение `timingSafeEqual(sha256(given), sha256(expected))`, 401 с `WWW-Authenticate: Basic realm="admin", charset="UTF-8"`, без `ADMIN_BASIC_AUTH` — 404. Заголовки `X-Robots-Tag: noindex, nofollow`, `Cache-Control: no-store`, `Referrer-Policy: no-referrer`; `/admin` в `robots.txt` запрещён | PLAN разделы 5 и 6 |
| Б26 | Отложенное из 1A: задача housekeeping `deferred-1a` раз в 10 мин ищет `order_events` с `payload.deferredEffects`/`deferredNotify`, для которых нет строки outbox с ключом `deferred:<event_id>:<n>`, и ставит их (уведомления, задача продавцу). `create_payment` пропускается (Б5). Журнал не правится | Идемпотентно и без мутации журнала |
| Б27 | Таймеры: одна задача `timers` раз в минуту по `orders.expires_at` и статусу; напоминания — задача `reminders` раз в 15 мин, дедупликация ключом outbox (`reminder:<order_id>:<kind>:<n>`) | Таймеры переживают потерю Redis: источник правды — БД |
| Б28 | QR для оплаты на точке: пакет `qrcode` 1.5.4. Бот шлёт фото QR и ссылку в чат продавцов, админка рисует SVG. Клиенту ссылка и QR не уходят никогда | PLAN: «ссылка в мессенджер не уходит» |
| Б29 | Ночная сверка за сутки: `GET /payments?created_at.gte=…` (`VERIFY` формат списка) — платежи магазина, которых нет в БД или у которых другой статус, → алерт владельцу. Без автоматических переходов | PLAN раздел 1, очередь reconciliation |
| Б30 | Dead-letter: задача, исчерпавшая попытки (или `UnrecoverableError`), копируется в очередь `dead-letter` с ключом `${queue}|${job.id}`, исходной очередью, данными и ошибкой (без ПД); алерт в чат продавцов. `/queues` (владелец): счётчики очередей и последние 10 задач dead-letter с кнопкой «Повторить» | PLAN раздел 1 |

## 1. Изменения модели данных (волна 1)

Одна миграция `packages/db/drizzle/0002_phase_1b.sql`:
`pnpm --filter @detaly/db exec drizzle-kit generate --name phase_1b`. Правило expand/contract:
новые колонки nullable или с default, новые enum-значения только добавляются в конец кортежей
`statuses.ts` (`ALTER TYPE … ADD VALUE`). Тест миграций прогоняет 0002 на базе с данными 1A.

### 1.1. Новые таблицы

| Таблица | Колонки | Ограничения и индексы | Зачем |
|---|---|---|---|
| `outbox` | `id` uuid v7; `queue` text; `name` text; `job_id` text; `data` jsonb not null default `{}`; `available_at` tstz not null default now(); `dispatched_at` tstz; `attempts` int not null default 0; `last_error` text; `created_at` | `unique(job_id)` `outbox_job_id_unique`; check `queue` ∈ `QUEUE_NAMES` (без `dead-letter`); частичный индекс `outbox_pending_idx (available_at) where dispatched_at is null` | Б1–Б3 |
| `client_approvals` | `id`; `order_id` → orders; `order_item_id` → order_items (nullable); `kind` `approval_kind` (`alternative`, `new_eta`); `scope` text (`order` / `item`, check); `proposal` jsonb (`ApprovalProposal`, раздел 3.2); `created_by_staff_id` → staff (nullable); `notified_at`; `expires_at`; `reminded_at`; `decided_at`; `decision` `approval_decision` (`approved`, `refund`, `timeout`); `created_at`, `updated_at` | частичный unique `client_approvals_order_open_unique (order_id) where decided_at is null`; индекс `(expires_at) where decided_at is null`; check `scope='item' ⇔ order_item_id is not null` | Б16 |
| `seller_cards` | `id`; `order_id` → orders; `order_item_id` (nullable, для меню позиции); `chat_id` text; `message_id` int (nullable до ответа Telegram); `nonce` text; `kind` text (`order`, `qr`); `order_event_id` → order_events (nullable); `created_at`; `closed_at` | `unique(nonce)`; индекс `(order_id) where closed_at is null`; check `nonce ~ '^[A-Za-z0-9_-]{8}$'` | Б17 |

### 1.2. Изменения существующих таблиц

| Таблица | Изменение | Зачем |
|---|---|---|
| `orders` | `client_arrived_at` tstz | охрана `clientArrived`; «Выставить оплату» только после «Клиент пришёл» |
| `order_items` | `arrived_at` tstz | частичный приезд, напоминания |
| `payments` | `confirmation_type` text check (`redirect`, `qr`); `confirmation_data` text (QR-payload); `request` jsonb; `paid_at`, `canceled_at` tstz; `cancellation_reason` text; **drop** `payments_order_id_succeeded_unique`, вместо него обычный индекс `payments_order_id_status_idx (order_id, status)` | Б7, Б8, Б28 |
| `receipts` | `attempts` int not null default 0; `first_attempt_at`, `alerted_at` tstz; `error` text; частичный unique `receipts_order_offset_unique (order_id) where kind='offset' and status <> 'canceled'`; частичный unique `receipts_payment_kind_unique (payment_id, kind) where kind in ('prepayment','full')` | Б22; инвариант «частичная выдача с несколькими чеками зачёта запрещена» |
| `refunds` | `scope` `refund_scope` not null default `'order'`; `request` jsonb; `error` text; `alerted_at` tstz; индекс `(payment_id)` | Б7, Б11 |
| `supplier_orders` | `called_at`, `recovered_at` tstz; `error` text; `invoice_number` text; `invoice_amount_kop` (kop + check); `invoice_paid_at` tstz; `invoice_payment_ref` text (номер и дата платёжного поручения); частичный unique `supplier_orders_order_sending_unique (order_id) where status='sending'` | Б13, Б14, «Счёт оплачен» |
| `notifications` | `chat_id` text; check `recipient` → `user_id is not null or staff_id is not null or chat_id is not null` (drop + add) | Б20 |
| `webhook_events` | `ip` inet (как пришёл, для разбора); частичный индекс `(received_at) where processed_at is null` | разбор и reconciliation |

`relations.ts` (без SQL): `orders.items/events/payments/receipts/refunds/supplierOrders/approvals/sellerCards`,
`payments.receipts/refunds`, `refunds.receipts`, `supplierOrders.items` (через `supplier_order_items`),
`orderItems.supplierOrderItems`, `clientApprovals.order/item`, `sellerCards.order`, `notifications.order`.

Сиды: в `settings` добавляется ключ `approval.timeout_h` (24); остальные пороги 1B уже есть
(`order.payment_ttl_min`, `order.on_pickup_confirm_ttl_h`, `pickup.window_*_days`,
`handover.qr_ttl_min`, `handed.complete_days`, `supplier.return_days`, `reminder.days`,
`rossko.prepay_invoice`, `pricing.drift_tolerance_pct`, `pricing.margin_floor_pct`).

Тесты `packages/db/test/phase1b.int.test.ts`: 0002 на базе с заказом 1A проходит; дубль
`outbox.job_id` → 23505; второй открытый `client_approvals` заказа → 23505; два `sending` на заказ →
23505; второй offset-чек не `canceled` → 23505, после `canceled` первого — можно; два succeeded
платежа заказа теперь можно; `notifications` только с `chat_id` — можно, без адресата → 23514;
`seller_cards.nonce` не по маске → 23514.

## 2. Env (волна 1)

| Переменная | Схема | Значение |
|---|---|---|
| `SMS_LOGIN` [ф1B] | `optionalString` | логин SMS Aero (e-mail) или smsc.ru; пароль/ключ — существующий `SMS_API_KEY` |
| `SMS_API_URL` [ф1B] | `z.url().optional()` | переопределение адреса шлюза (тесты, stage); по умолчанию `https://gate.smsaero.ru/v2` или `https://smsc.ru/sys` по `SMS_PROVIDER` (`VERIFY`) |
| `SMS_PRICE_KOP` [ф1B] | `int().default(500)` | цена одного SMS в копейках для бюджета (`VERIFY` по тарифу провайдера) |

Остальное уже в схеме: `YOOKASSA_*`, `ADMIN_BASIC_AUTH`, `SMS_PROVIDER/SMS_API_KEY/SMS_SENDER/
SMS_MONTHLY_BUDGET_RUB`, `TG_SELLER_BOT_TOKEN`, `TG_SELLER_CHAT_ID`, `ROSSKO_ALLOW_CHECKOUT`,
`ROSSKO_DELIVERY_ID/ADDRESS_ID/PAYMENT_ID`. В `.env.example` комментарием к
`YOOKASSA_WEBHOOK_IP_ALLOWLIST` — опубликованные ЮKassa подсети (`185.71.76.0/27,
185.71.77.0/27, 77.75.153.0/25, 77.75.156.11, 77.75.156.35, 77.75.154.128/25, 2a02:5180::/32`,
`VERIFY` Ю5), к `YOOKASSA_VAT_CODE` — «1 = без НДС (VERIFY Ю4)», к `YOOKASSA_TAX_SYSTEM_CODE` —
«2 = УСН доходы (VERIFY Ю4)». Тест реестра env (`.env.example` ↔ схема) остаётся зелёным.

`packages/config/src/queues.ts`: `OUTBOX_CHANNEL = 'detaly:outbox'`, `bullJobId(key)`
(Б2), `HOUSEKEEPING_JOBS` += `timers`, `reminders`, `smsBudget`, `deferred1a`;
`RECONCILIATION_JOBS = { sweep, nightly }`.

## 3. packages/domain (волна 1)

Только чистые функции; `now`, настройки и коды ЮKassa передаются параметрами.

### 3.1. `statuses.ts` (добавления в конец кортежей или новые кортежи)

`PAYMENT_MODES = ['full_prepayment','full_payment']`, `PAYMENT_SUBJECTS = ['commodity','service']`
(переезжают из `packages/payments/src/types.ts`, payments реэкспортирует),
`CONFIRMATION_TYPES = ['redirect','qr']`, `REFUND_SCOPES = ['order','item','orphan']`,
`APPROVAL_KINDS = ['alternative','new_eta']`, `APPROVAL_DECISIONS = ['approved','refund','timeout']`,
`WEBHOOK_RESULTS = ['processed','duplicate','stale','pending','orphan_payment','amount_mismatch',
'ignored','error']` (значения text-колонки `webhook_events.result`).

### 3.2. `types.ts`

1. Типы чека (переезжают из payments): `ReceiptCustomer`, `ReceiptLine`, `ReceiptData`,
   `PaymentMode`, `PaymentSubject`.
2. `ApprovalProposal = { kind:'alternative'; offer: Offer; priceClientKop; priceSupplierKop;
   markupBp; etaDate; searchArticleNorm; offerKey; marginBp } | { kind:'new_eta'; etaDate;
   note: string|null }`.
3. `SettingsValues['approval.timeout_h']: number`; `settingsDefaultsFromEnv` даёт 24.

### 3.3. Новые модули

| Модуль | Экспорт | Поведение |
|---|---|---|
| `receipts.ts` | `RECEIPT_DESCRIPTION_MAX`, `ReceiptLinesError`, `lineDescription`, `linesTotalKop`, `assertReceiptLines` (переезд из payments без изменения поведения); `receiptCustomerPhone(e164)` → `'79123456789'` (`VERIFY` Ю11); `paymentModeFor(kind: ReceiptKind)` (`prepayment`, `refund_prepayment` → `full_prepayment`; `full`, `offset`, `refund_full` → `full_payment`; `correction` → ошибка); `buildPaymentReceipt({kind:'prepayment'|'full', items, courierFeeKop, phone, vatCode, taxSystemCode})`; `buildOffsetReceipt({items, courierFeeKop, phone, vatCode, taxSystemCode})` → `{ data, prepaymentKop }`; `buildRefundReceipt({kind:'refund_prepayment'|'refund_full', lines, phone, vatCode, taxSystemCode})` | Позиции «Бренд Артикул Название» ≤ 128, `quantity` = qty, цена за единицу, `vat_code`, `payment_subject: commodity`; доставка — одна строка `service` «Доставка» при `courierFeeKop > 0`; `assertReceiptLines` на выходе (сумма строк = amount, один `payment_mode`, только commodity + ≤ 1 service). Позиции в состоянии `failed`, `replaced`, `refund_pending`, `refunded` в чек оплаты/зачёта не входят |
| `refunds.ts` | `ReceiptItemInput` (`orderItemId, brand, article, name, qty, priceClientKop, refundedAmountKop, state`); `refundableKop(paymentKop, refunds[])`; `assertRefundWithinPayment(paymentKop, refunds[], newKop)` (pending + succeeded; failed не считается); `planOrderRefund({items, courierFeeKop, paymentKop, refunds})` → `{ amountKop, lines: RefundLine[] }` (все живые и `refund_pending` позиции без уже возвращённого + доставка); `planItemRefund({item})` → строка позиции на остаток; `planOrphanRefund({paymentKop, paymentKind, items})` (весь платёж, строки исходного чека); `refundReasonFor(event, facts)` (`client_refused`→`refusal`, `storage_expired`→`no_show`, `item_cancelled`/`order_cancelled`/`approval_*`/`client_refund_requested`→`supplier_fail`, поздняя оплата→`late_payment`, `amount_mismatch`→`amount_mismatch`) | Инварианты PLAN раздел 2: сумма refunds ≤ payments.amount; чек возврата зеркалит признак расчёта |
| `recheck-types.ts` | типы `RecheckItemResult`, `RecheckResult` (дрейф, наличие, альтернативы) | Используются rossko-ops и движком; реализация `recheckOrder` — пакет `rossko-ops` (раздел 8) |
| `timers.ts` | `TIMERS = { receiptPollEveryMs: 120_000, receiptGiveUpMs: 900_000, reconcilePendingAgeMs: 600_000, reconcileEveryMs: 600_000, invoiceReminderEveryMs: 4h, attentionReminderEveryMs: 4h, approvalReminderAfterMs: 12h, refundDeadlineWarnMs: 2 сут, outboxPollMs: 2_000 }` | Константы PLAN раздела 1 в одном месте |
| `journal.ts` | `JOURNAL_EVENTS` = `recheck_requested`, `recheck_result`, `payment_created`, `payment_status`, `receipt_succeeded`, `receipt_failed`, `refund_created`, `orphan_payment`, `approval_created`, `approval_notified`, `approval_unreachable`, `approval_reminder`, `reminder`, `supplier_order_manual`, `supplier_return_created`, `stock_item_created`, `webhook_stale`, `deferred_1a_processed`; `isJournalEvent` | Типы `order_events.type`, которые не меняют статус и пишутся вне TRANSITIONS (под той же блокировкой) |

Снапшот-тесты `test/receipts.test.ts` (`toMatchSnapshot`): payload prepayment (2 позиции), full
(pay_on_handover), offset (остаток после отменённой позиции), refund_prepayment на одну строку,
refund_full всего заказа с доставкой; в каждом — `linesTotalKop === amount`. Отрицательные:
описание 129 символов обрезается с «…», две строки service → ошибка, строка `payment_subject:
'service'` для установки невозможна по типам, сумма ≠ amount → `ReceiptLinesError`.
`test/refunds.test.ts`: сумма возвратов не превышает платёж (pending учитывается, failed — нет),
повторный частичный возврат той же позиции на остаток, возврат всего заказа после частичного =
платёж − уже возвращённое, `refund_full` после зачёта, `refund_prepayment` до него.

### 3.4. Машина состояний

`TransitionContext` += `pickupWindowElapsed?: boolean`, `eventPaymentKind?: PaymentKind | null`.
Охраны: `pickupWindowElapsed`, `eventPaymentIsHandover` (`eventPaymentKind === 'full'`),
`lateHandoverPayment = all(payOnHandover, eventPaymentIsHandover, amountMatches)`.
`ORDER_EVENTS` += `partial_refund_succeeded`, `partial_refund_failed`.
`ORDER_NOTIFY_TEMPLATES` += `staff_orphan_payment`, `staff_receipt_failed`,
`staff_approval_unreachable`, `staff_refund_deadline` (рендеры в `packages/notify/src/templates/order.ts`
пишет фундамент, иначе не соберётся `Record<OrderNotifyTemplate, Render>`).

| Правило | Было | Стало |
|---|---|---|
| `ready + storage_expired` (оба) | actors `system` | actors `system`, `staff`; охрана += `pickupWindowElapsed` (Б10) |
| `awaiting_handover_payment + payment_ttl_expired` | `eventPaymentIsCurrent & paymentConfirmedUnpaid & !paymentHeld` | `eventPaymentIsCurrent & !paymentSucceeded & !paymentHeld` (Б9) |
| `ready + payment_succeeded` (новое) | — | охрана `lateHandoverPayment` → `awaiting_handover_payment`, без уведомлений, label «Оплата по истёкшему QR прошла» |
| «Неожиданный платёж» для `ready` | `paymentSucceeded` | `paymentSucceeded & !lateHandoverPayment` (для прочих статусов списка — без изменений) |
| `partial_refund_succeeded` (новое) | — | самопереход из `confirmed`, `ordering`, `awaiting_supplier_invoice`, `ordered_at_supplier`, `needs_attention`, `awaiting_client_approval`, `ready`, `awaiting_handover_payment`, `out_for_delivery`, `handed`, `completed`, `refund_pending`; actors `webhook`, `system`; охрана `refundConfirmed`; notify `client('money_sent')` |
| `partial_refund_failed` (новое) | — | те же статусы, notify `owner('staff_refund_failed')` |
| `ordered_at_supplier + supplier_checkout_succeeded/failed` (новое, интеграция волны 2) | — | итог GetCheckout повторного заказа повреждённой позиции: `noItemErrors` → самопереход без уведомлений; `hasItemErrors` и `supplier_checkout_failed` → `needs_attention` с `sellers('staff_problem')`. При `prepay_invoice` счёт за повторную позицию оплачивается в ЛК Rossko (VERIFY R7) |
| `moneyHeld` / `noMoneyHeld` (интеграция волны 2) | prepay всегда «деньги у нас» | prepay с явным `paymentHeld: false` (платёж неверной суммы уже возвращён «Вернуть платёж») — денег нет: «Отменить заказ» → `cancelled` без возврата; «Заказать всё равно» требует охрану `prepayFunded` |

`transitions.spec.ts`: строки EXPECTED для новых правил, полный перебор запрещённых пар
подхватит события сам; кейсы: «Клиент не пришёл» продавцом до окна — `guard_failed`, после — как
housekeeping; QR TTL при `providerPaymentStatus: 'pending'` → ready, при `succeeded` — нет;
оплата по старому QR в ready → `awaiting_handover_payment`; prepay-платёж в ready → неожиданный;
`handed_over` из `awaiting_handover_payment` без `settlementReceiptSucceeded` → `guard_failed`;
`handover_payment_requested` без `clientArrived` → `guard_failed`.

## 4. Контракты пакетов и заглушки (волна 1)

1. **`packages/payments`**: `types.ts` реэкспортирует перенесённые типы и константы из
   `@detaly/domain`; `receipt-lines.ts` реэкспортирует функции из `@detaly/domain`. Публичный API
   пакета не меняется, тесты фазы 0 зелёные.
2. **`packages/orders` (новый пакет `@detaly/orders`)**: `package.json` (deps: `@detaly/config`,
   `@detaly/db`, `@detaly/domain`, `@detaly/notify`, `@detaly/payments` (типы), `uuid`; dev:
   vitest, msw не нужен), `tsconfig.json`, `vitest.config.ts` (`name: 'orders'`, globalSetup с
   базой `${DATABASE_URL_TEST}_orders`), `src/index.ts` с **типами и сигнатурами** раздела 5.1 и
   заглушками `throw new Error('not implemented: phase 1B wave 2')`. `apps/web/next.config.ts`:
   `transpilePackages` += `@detaly/orders`.
3. **`apps/worker/src/deps.ts`** (новый): `WorkerDeps` и порты:
   - `SellerCardPort { post({orderId, template, orderEventId, note?}); refresh(orderId);
     sendHandoverQr({orderId, paymentId, confirmationData, expiresAt}) }`;
   - `AlertPort { send({audience: 'sellers'|'owner', text, dedupeKey}) }`;
   - `QueueInspector { stats(); deadLetters(limit); retryDeadLetter(id) }`;
   - `WorkerDeps { db, redis, logger, env, now, keyPrefix, bullPrefix, queues, engine: EngineDeps,
     payments: PaymentProvider|null, receipts: ReceiptProvider|null, rossko: RosskoClient,
     smsDriver: ChannelDriver|null, telegram: TelegramSender|null, sellerCards, alerts, inspector }`.
4. **Заглушки процессоров** с окончательной сигнатурой `(job: Job, deps: WorkerDeps) => Promise<unknown>`:
   `apps/worker/src/jobs/{payments,receipts,rossko,notify,reconciliation}/index.ts`
   (`UnrecoverableError('not implemented')`); `jobs/housekeeping.ts` переводится на ту же
   сигнатуру (heartbeat берёт `deps.redis`, `deps.now`, ключ из `deps`), `workers.ts` и
   `test/jobs.test.ts` поправляются минимально. `apps/worker/src/bots/seller/cards.ts`:
   `createSellerCards(deps): SellerCardPort` — заглушка; `SellerBotOptions.deps?: WorkerDeps`.
5. **Зависимости**: `apps/web` += `@detaly/orders`, `@detaly/payments`, `@detaly/notify`, `qrcode`
   1.5.4, dev `@types/qrcode` 1.5.6; `apps/worker` += `@detaly/orders`, `qrcode`, dev
   `@types/qrcode`. Один `pnpm install`, lock коммитится. Dockerfile'ы не меняются
   (`--filter "@detaly/worker..."` подтянет новый пакет сам; проверить `docker compose config`).
6. **`apps/web/src/server/engine.ts`**: `getEngineDeps()` — синглтон `EngineDeps` (`getDb()`,
   `serverEnv()`, `nudge` = `getRedis().publish(OUTBOX_CHANNEL, '1')` с проглоченной ошибкой).
7. **`apps/worker/test/helpers/test-deps.ts`**: `createTestDeps(overrides)` — `WorkerDeps` на базе
   `_worker` и Redis с префиксом `test:<uuid>:`, очереди с `bullPrefix` теста, фейки
   `SellerCardPort`/`AlertPort`/`QueueInspector`, записывающие вызовы; `payments`/`receipts`/
   `rossko`/`smsDriver` — из переопределений (msw-провайдер, fixture-caller).
8. Тест фундамента: `pnpm typecheck` по всем пакетам с заглушками; `test/jobs.test.ts` (heartbeat на
   новой сигнатуре); `packages/payments` и `packages/notify` — тесты фазы 0 зелёные после переезда
   типов; тест-грep: в `packages/orders/src/index.ts` экспортированы все имена раздела 5.1.

## 5. Движок заказов `packages/orders` (волна 2, пакет `engine`)

Единственное место, где меняется `orders.status`. Все функции принимают `EngineDeps { db, env
(APP_BASE_URL, YOOKASSA_VAT_CODE, YOOKASSA_TAX_SYSTEM_CODE, SMS_PROVIDER), now?, nudge?: () =>
void }` и необязательный `tx`. Без сети: провайдеры вызывают воркер и web.

### 5.1. Публичный API

| Функция | Что делает |
|---|---|
| `loadOrderSettings(db, env) → OrderSettings` | `settings` + дефолты из env (`settingsDefaultsFromEnv`); мусор игнорируется, как в web |
| `loadOrderSnapshot(tx, orderId, {lock}) → OrderSnapshot \| null` | `select … for update` строки заказа (при `lock`), затем позиции, платежи, чеки, возвраты, supplier_orders с позициями, открытое согласование, `users.no_show_count`; телефон не загружается |
| `buildTransitionContext(snapshot, actor, facts, settings, now) → TransitionContext` | Чистая. `scheme`, `fulfillment`, `totalKop`, `paymentHeld` (есть succeeded-платёж, не возвращённый полностью), `providerPaymentStatus` (последний платёж, если факт не передан), `allLiveItemsArrived`/`liveItemsAfter`/`pendingSupplierItems` **после** изменений позиций (`planItemChanges`), `clientArrived`, `settlementReceiptSucceeded` (offset для prepay, full для pay_on_handover), `prepayInvoice`, `supplierInvoicePaid`, `marginBp`/`marginFloorBp`, `driftToleranceBp`, `pickupWindowElapsed`, `openClaims: 0` |
| `planItemChanges(event, snapshot, facts) → ItemChange[]` | Чистая. Таблица 5.3 |
| `applyTransition(deps, {orderId, event, actor, itemId?, facts?, payload?, tx?}) → ApplyResult` | Транзакция (или переданная): блокировка, контекст, `resolveTransition`; не `ok` → `{ok:false, reason, failed, status}` без записи; `ok` → позиции, заказ, `order_events`, эффекты (5.2), уведомления (outbox `notify`), чек (`receiptFor`) → `{ok:true, orderEventId, from, to, rule, effects}`; после коммита — `deps.nudge?.()` |
| `persistTransition(tx, snapshot, decision, input)` | Низкоуровневая часть `applyTransition` для оформления, которое уже держит транзакцию и вставило заказ |
| `recordJournalEvent(tx, {orderId, type, actor, payload})` | Событие журнала (`JOURNAL_EVENTS`) без смены статуса; вызывающий держит блокировку |
| `enqueueOutbox(tx, {queue, name, key, data, availableAt?}) → boolean` | `insert … on conflict (job_id) do nothing returning`; `false` — уже поставлено |
| `canReachClient(tx, orderId, {smsEnabled, template}) → boolean` | Привязки мессенджеров + телефон + `selectChannel` из notify |
| `availableStaffActions(snapshot, role, settings, now) → StaffActionView[]` | Для бота и админки: код (таблица 13.2), подпись, `itemId?`, `enabled`, `disabledReason` («Ждём чек», «Сначала „Клиент пришёл“») |
| `performStaffAction(deps, {staff: {id\|null, role, via: 'bot'\|'admin'}, action, targetId, input?})` → `{ok, message, orderId, menu?}` | Переводит код действия в событие и факты; не-переходные действия: `recheck` (журнал + `rossko/recheck`), `rcpt` (повтор чека, Б22), `manual_supplier_order` (строка `supplier_orders` `created` вручную + журнал), `supplier_return_accept/reject`, `stock_item` (строка `stock_items`), `refund_payment` (возврат платежа владельцем, `scope=orphan`, причина обязательна) |
| `performClientAction(deps, {orderId, userId, action: 'confirm'\|'approve'\|'refund_request'\|'refuse'\|'prepay_now'\|'item_cancel', itemId?})` | Клиентские события; проверка 4 цифр — в web (Б24) |
| `preparePayment(deps, {orderId, kind: 'prepayment'\|'full', confirmation: 'redirect'\|'qr', returnUrl})` → `{kind:'reuse', confirmationUrl} \| {kind:'create', paymentRowId, request} \| {kind:'unavailable', reason}` | Под блокировкой: статус должен быть `awaiting_payment` (prepayment) или `awaiting_handover_payment` (full); живой pending с `confirmation_url` и не истёкший → reuse; pending без `provider_payment_id` → его `request` (тот же ключ); иначе новые строки `payments` (`idempotence_key` = uuid v7, `amount_kop = orders.total_kop`, `request` с чеком `buildPaymentReceipt` и `metadata` Б7) и `receipts` (kind `prepayment`/`full`, ключ `${key}:receipt`) |
| `recordPaymentCreated(deps, paymentRowId, providerPayment)` | `provider_payment_id`, `confirmation_url/data/type`, `expires_at`, `raw`, статус; журнал `payment_created` |
| `applyPaymentObject(deps, providerPayment, {source, webhookEventId?})` → `{result: WebhookResult, transition?}` | Под блокировкой заказа (по `metadata.order_id` или `provider_payment_id`): обновить строку платежа (статус, `paid_at`, метод, `raw`); сумма и валюта против `orders.total_kop` → факты; `succeeded` → `payment_succeeded` (`paidAmountKop`, `eventPaymentIsCurrent`, `eventPaymentKind`); `canceled` → `payment_canceled`; заказ `refunded` + succeeded → `orphan_payment`: возврат `scope=orphan`, `reason=late_payment` + журнал + алерт владельцу (`staff_orphan_payment`), статус не меняется; pending → `pending`; `webhook_events.processed_at/result` — в той же транзакции |
| `applyRefundObject(deps, providerRefund, {source})` | `succeeded` → `refunds.succeeded_at`, позиции `refund_pending → refunded`, `refunded_amount_kop`; переход `refund_succeeded` (scope order) или `partial_refund_succeeded` (scope item) или только журнал (orphan); `canceled` → `refunds.status='failed'` + `refund_failed`/`partial_refund_failed` |
| `applyReceiptObject(deps, receiptRowId, providerReceipt \| {error})` | Статус чека; `succeeded` → журнал `receipt_succeeded`; окончательная ошибка → `receipt_failed` |
| `createRefund(tx, snapshot, {scope, paymentId, reason, itemIds?, requestedAt})` | Строки `refunds` (`deadline_at = requested_at + 10 дней`, `request`) и `receipts` (refund_*, `buildRefundReceipt`), проверка `assertRefundWithinPayment`, outbox `payments/refund-create` |

### 5.2. Эффекты переходов (в той же транзакции)

| Эффект | Исполнение |
|---|---|
| `set_scheme_prepay` / `set_scheme_pay_on_handover` | `orders.payment_scheme` |
| `create_payment` | `expires_at = now + payment_ttl`; сам платёж — ленивый (Б5) |
| `create_handover_payment` | `preparePayment(kind 'full', confirmation 'qr')` + outbox `payments/payment-create` (`payment-create:<payment_id>`); `expires_at = now + handover.qr_ttl_min` |
| `create_refund` | `createRefund` по `scope` события: заказ (`planOrderRefund`) или позиция (`planItemRefund`); позиции → `refund_pending` |
| `start_approval_timer` | строка `client_approvals` (без `expires_at` — ставит notify после отправки, Б16) |
| `start_pickup_window` | `received_at`, `expires_at = now + pickup.window_prepaid_days | window_cod_days`, `supplier_return_deadline_at = now + supplier.return_days` |
| `start_completion_timer` | `handed_at`, `expires_at = now + handed.complete_days`; живые позиции → `handed` |
| `mark_client_arrived` | `client_arrived_at`; для prepay — строка `receipts` kind `offset` (`buildOffsetReceipt` по живым позициям, если нет не-canceled) + outbox `receipts/offset` |
| `no_show_increment` | `users.no_show_count + 1` |
| `supplier_checkout` | Б13 |
| `supplier_claim_and_reorder` | `supplier_returns` kind `claim` по старой позиции; новая позиция-копия `pending`, старая `replaced` с `replaced_by_item_id`; Б13 для новой позиции |
| `supplier_return_task` | `supplier_returns` kind `return` по позициям `arrived` (`amount_expected = цена закупки × qty`) |
| `cancel_at_supplier_task` | только уведомление продавцам (уже в `notify`) + журнал |
| `open_claim` | 1C: эффект пишет журнал `claim_deferred` и не создаёт строк (в 1B кнопки нет) |
| Чек `receiptFor` = `prepayment`/`full` | статус ставит `applyPaymentObject`; `offset` — `mark_client_arrived`/`offset_receipt_requested`; `refund_*` — `createRefund` |
| `notify` правила | outbox `notify/order` с ключом `notify:<order_event_id>:<template>`, данные `{orderEventId, audience, template}` |
| Таймстемпы статуса | `confirmed_at`, `paid_at` (оплата), `ordered_at`, `handed_at`, `completed_at`, `cancelled_at`; `expires_at` по целевому статусу: `awaiting_confirmation` (+24 ч), `awaiting_payment` (+ttl), `awaiting_handover_payment` (+QR ttl), `ready` (окно хранения), `handed` (7 дней), прочие — `null` |
| `promised_date` | пересчёт `promisedDate` при `supplier_checkout_succeeded` (с `invoiceLagDays` при `prepayInvoice`), при согласии на новый срок и на аналог |
| `attention_reason` | ставится при входе в `needs_attention` из `facts.reason` (`price_drift`, `unavailable`, `item_errors`, `checkout_disabled`, `unknown_after_timeout`, `amount_mismatch`, `unexpected_payment`, `item_problem:<причина>`), очищается при выходе |

### 5.3. Состояния позиций (`planItemChanges`)

| Событие | Позиции |
|---|---|
| `supplier_checkout_succeeded` | покрытые заказом Rossko → `ordered`; из itemErrors остаются `pending` с `supplier_item_error` |
| `item_arrived` | позиция → `arrived`, `arrived_at` |
| `item_cancelled`, `client_refund_requested`/`approval_timeout` (scope item) | позиция → `refund_pending` (деньги есть) или `failed` (pay_on_handover без оплаты) |
| `client_approved` (alternative) | старая → `replaced`, новая из `proposal` → `pending`, `replaced_by_item_id` |
| `client_approved` (new_eta) | `eta_date` позиции(й) из предложения |
| `item_damaged_on_receipt` | старая → `replaced`, копия → `pending` |
| возврат всего заказа (`client_refused`, `order_cancelled`, `storage_expired`, scope order, поздняя оплата) | живые → `refund_pending`; без денег — без изменений |
| `handed_over` | живые → `handed` |
| `refund_succeeded` / `partial_refund_succeeded` | позиции возврата → `refunded`, `refunded_amount_kop += строка` |

### 5.4. Тесты (`packages/orders/test/*.int.test.ts`, база `_orders`)

Фабрика `seedOrder({scheme, status, items, payments…})`. Кейсы: каждый эффект таблицы 5.2 создаёт
ровно свои строки и outbox; повторный вызов с тем же событием после успеха — `no_rule`/`guard_failed`
без записей; две параллельные `applyTransition` одного заказа сериализуются блокировкой (одна
проходит, вторая видит новый статус); `pendingSupplierItems` после itemErrors, согласия на аналог,
отмены позиции; `clientReachable` false (нет привязок, `SMS_PROVIDER=none`) → «Аналог» `guard_failed`;
частичный возврат строки + зачёт на остаток (сумма `offset` = платёж − возврат); сумма возвратов
> платежа → ошибка, строк нет; `applyPaymentObject` дважды → второй раз `duplicate`/без перехода;
сумма ≠ total → `needs_attention` (`amount_mismatch`), алерт в outbox; оплата отменённого →
`refund_pending` + refund_prepayment; оплата `refunded` → `orphan_payment`, статус тот же, возврат
orphan; `performStaffAction('recheck')` на `confirmed` → журнал + outbox, статус тот же;
`availableStaffActions` — «Выдал» `enabled:false` до succeeded чека, «Выставить оплату» нет до
«Клиент пришёл»; `persistTransition` из оформления пишет `notify` и `expires_at`. Unit:
`buildTransitionContext`, `planItemChanges`, `availableStaffActions` на таблицах.

## 6. packages/payments (волна 2, пакет `payments`)

1. `ProviderPayment` += `receiptRegistration: 'pending'|'succeeded'|'canceled'|null`,
   `cancellationReason`, `currency` (не RUB → `PaymentProviderError('bad_response')`), `paidAt`.
2. `CreatePaymentRequest` += `metadata?: Record<string,string>` (≤ 16 ключей, значения ≤ 512,
   `VERIFY` Ю11), `confirmation: 'qr'` без `return_url`; `description` ≤ 128 символов.
3. `ReceiptProvider` += `listPaymentReceipts(paymentId)` (`GET /receipts?payment_id=`, `VERIFY`);
   `PaymentProvider` += `listPayments({createdGte, createdLt, cursor?})` для ночной сверки (`VERIFY`).
4. `isAllowedWebhookIp(ip, allowlist)` (Б4; разбор CIDR, IPv4-mapped IPv6, мусор → false) и
   `parseWebhookIpAllowlist(list)` с ошибкой на неверный элемент.
5. `createPaymentsFromEnv(env) → { payments, receipts } | null` (Б6: нужны 4 переменные).
6. msw-эмуляция: `receipt_registration` (`pending` → `succeeded` при успехе платежа, режим
   `receiptRegistration: 'canceled'`), `GET /receipts?payment_id=`, `GET /payments?…` со списком,
   чек в теле возврата (проверка суммы и `payment_mode` = исходного), отказ `POST /receipts` с
   400 `invalid_request` при заданном `rejectTaxSystemCode`, режим 202 `processing`, задержка
   ответа (`delayMs`) для таймаутов, `failNext(path, status)`, `notification(event, id)` с полями
   реального уведомления, `setPaymentStatus(id, 'succeeded', {amountKop})` для расхождения суммы,
   «3-D Secure»: `pending → waiting_for_capture → succeeded` не бывает при capture=true, поэтому
   эмулируется `pending` с `confirmation_url` и потом `succeeded`.
7. Тесты (`test/*.test.ts`, только msw): чек в платеже (`full_prepayment` / `full_payment`),
   стабильность `Idempotence-Key` при повторе после сетевой ошибки (одна запись в mock), возврат с
   чеком, отказ возврата сверх суммы, `listPaymentReceipts`, allowlist (IPv4, CIDR /27 границы,
   IPv6 /32, `::ffff:185.71.76.1`), `parseWebhook` на все 4 события и мусор.

## 7. packages/notify (волна 2, пакет `notify`)

1. Драйвер SMS `drivers/sms.ts`: `createSmsDriver({provider: 'smsaero'|'smsc', login, apiKey,
   sender, apiUrl?, fetch?, guard})` → `ChannelDriver` канала `sms`. SMS Aero v2: `GET
   {url}/sms/send?number=79…&text=…&sign=…`, Basic `login:apiKey`, ответ `{success, data:{id,
   cost}}`; smsc: `GET {url}/send.php?login&psw&phones&mes&sender&fmt=3&charset=utf-8`, ответ
   `{id, cnt, cost}` или `{error, error_code}` (оба формата `VERIFY`). Текст — `renderSmsText`,
   ≤ 2 сегментов (≤ 140 символов кириллицы, иначе обрезка без потери ссылки). Ошибки: 4xx →
   `UnrecoverableSmsError`, сеть/5xx → обычная ошибка (повтор очереди). В логи — только id
   сообщения и код ошибки.
2. `createSmsGuard({redis, secret, keyPrefix, limits = {perTenMin: 1, perDay: 3}})` →
   `check(phone) → {allowed, reason?}` (Б21, `slidingWindowHit` из `@detaly/config`);
   `smsBudgetState({spentKop, budgetRub}) → 'ok'|'alert'|'exhausted'` (чистая).
3. `CALLBACK_ACTIONS` дополняется кодами таблицы 13.2 и делится на `EVENT_ACTIONS` (код → событие)
   и `MENU_ACTIONS` (`ialt`, `ieta`, `iprob`, `back`, `alt1..alt3`, `eta2/eta5/eta7/eta14`,
   `pdecl/pwrong/pdmg/pdelay`); `eventForAction` сохраняет поведение.
4. Шаблоны: `confirm_request` — ссылка на `/o/<token>` с текстом «Подтвердите заказ на странице»
   (SMS не несёт кнопок); `decision_needed` — «Нужно ваше решение по заказу DT-… до <время>» +
   ссылка; новые `staff_*` из раздела 3.4; `arrived` на 9-й день — фраза «по оферте заказ хранится
   … дней, затем возврат денег» (без ПД). Клиентские тексты — только номер, статус, бренд,
   артикул; тест грепает рендеры всех клиентских шаблонов на `+7`, цифры телефона из данных и имя.
5. Тесты: оба драйвера на msw (успех, 4xx, 5xx, неверный JSON), лимиты (2-е SMS за 10 мин →
   `sms_rate_limited`, 4-е за сутки), бюджет 79/80/100%, `selectChannel` с SMS и без.

## 8. packages/rossko и перепроверка (волна 2, пакет `rossko-ops`)

1. `packages/domain/src/recheck.ts`: `recheckOrder({items, freshBySearch, markupRules,
   excludedRules, eta, now, marginFloorBp}) → RecheckResult`: по каждой позиции — свежее
   предложение по `offer_key` (нет → `unavailable`), остаток, `driftBp`; заказ — суммарный дрейф
   (Б12), `allAvailable`; альтернативы для проблемных позиций: кроссы и другие склады из того же
   ответа, не в стоп-группе, с остатком, цена клиента = цена исходной позиции, `marginBp` при этой
   цене ≥ `marginFloorBp`, до 3 самых дешёвых; экспорт из `domain/src/index.ts`.
2. `packages/rossko/src/checkout-match.ts`: `matchCheckoutResult(requested, result)` — какие
   позиции заказа покрыты `ItemsList`, какие в `ItemsErrorList` (сопоставление по
   нормализованному артикулу + бренду + складу + количеству; неоднозначность → ошибка);
   `checkoutComment(orderNumber, attemptNo)` → `'DT-000123/1'`.
3. `client.recentOrders({since})` — GetOrders без `order_ids` (`VERIFY`; при отказе API —
   `RosskoCallError` с `code: 'unsupported'`) и `findOrderByComment(orders, comment)`;
   фикстура `GetOrders.recent.json` (синтетическая, `_meta.synthetic`).
4. Fixture-caller: вариант `timeout` для GetCheckout (бросает ошибку таймаута после «выполнения»,
   чтобы тестировать восстановление), вариант цены `+1%`/`+10%` для GetSearch через опцию
   `priceFactorBp`.
5. Тесты: drift +1% при допуске 3% — проходит, +10% — нет и даёт альтернативы из кроссов OC90;
   исчезнувшее предложение → `allAvailable:false`; `matchCheckoutResult` на `itemErrors` фикстуре
   (OC 90 покрыта, W 914/2 — ошибка); восстановление по комментарию.

## 9. Ядро воркера (волна 3, пакет `worker-core`)

1. `create-deps.ts`: собирает `WorkerDeps` из env: `createDb`, Redis, очереди, `EngineDeps`
   (`nudge` — PUBLISH), `createPaymentsFromEnv` (или `null`), `createRosskoClient` с лимитером
   (как web `supplier.ts`, `allowCheckout = ROSSKO_ALLOW_CHECKOUT`), SMS-драйвер с guard (или
   `null` при `SMS_PROVIDER=none`), grammY `Api` по `TG_SELLER_BOT_TOKEN` (или `null`),
   `createSellerCards`, `AlertPort`, `QueueInspector`.
2. `outbox/dispatcher.ts`: цикл: `select … where dispatched_at is null and available_at <= now()
   order by created_at limit 100 for update skip locked` → `queues[queue].add(name, {...data,
   outboxKey: job_id}, {jobId: bullJobId(job_id), ...policy(queue, name)})` → `dispatched_at`.
   Ошибка Redis — `attempts+1`, `last_error`, строка остаётся. Подписка на `OUTBOX_CHANNEL`
   (отдельное соединение ioredis) + интервал `TIMERS.outboxPollMs`. Остановка — в `shutdown.ts`
   до закрытия очередей.
3. Политики (`queues.ts`): payments — 5 попыток, экспонента от 10 с; receipts — 3 (опрос — своими
   отложенными задачами); rossko — 3, `RosskoRateLimitError` → `DelayedError` с паузой
   `retryAfterMs`; checkout — **1 попытка** (повтор только через восстановление); notify — 5,
   экспонента от 30 с; reconciliation — 1; housekeeping — 1.
4. Schedulers: heartbeat (30 с), `timers` (60 с), `reminders` (15 мин), `smsBudget` (1 ч),
   `deferred1a` (10 мин), reconciliation `sweep` (10 мин), `nightly` (cron `15 3 * * *`, tz
   Asia/Yekaterinburg).
5. `dead-letter/*` (Б30): обработчик `failed` (финальная попытка или `UnrecoverableError`) →
   `deadLetter.add('dead', {queue, name, jobId, data, error: message без ПД, failedAt}, {jobId:
   `${queue}|${job.id}`})` + `alerts.send({audience:'sellers'})`; `QueueInspector.retryDeadLetter`
   кладёт задачу обратно в исходную очередь с исходным `jobId` (после удаления старой failed).
6. `alerts.ts`: `AlertPort` через `deps.telegram` (чат продавцов / личка владельца, Б19), строка
   `notifications` (`chat_id`, `dedupe_key = alert:<dedupeKey>`) до отправки; без токена —
   `skipped`.
7. `app.ts`/`workers.ts`: процессоры всех очередей из `jobs/*` с `deps`; бот получает `deps`;
   `WorkerEnv` расширяется.
8. Тесты: `outbox.int.test.ts` (строка → задача с верным `jobId`, повторный проход не дублирует,
   Redis недоступен → строка остаётся и уходит позже, nudge забирает < 1 с),
   `dead-letter.int.test.ts` (UnrecoverableError и исчерпание попыток → dead-letter + алерт;
   retry возвращает задачу), `process.int.test.ts` (старт/SIGTERM с новыми зависимостями без
   токенов и ключей ЮKassa — код 0).

## 10. Очереди payments, receipts, reconciliation (волна 3, пакет `worker-payments`)

| Задача | Поведение |
|---|---|
| `payments/webhook` `{webhookEventId}` | Строка `webhook_events`; уже `processed_at` → выход; `getPayment`/`getRefund` по `external_id` (доверяем только ответу); `applyPaymentObject`/`applyRefundObject` с `source:'webhook'`; ошибка провайдера → повтор очереди |
| `payments/payment-create` `{paymentId}` | QR на точке: `createPayment` по `payments.request` с тем же ключом → `recordPaymentCreated` → `sellerCards.sendHandoverQr`; заказ уже не `awaiting_handover_payment` → выход |
| `payments/payment-recheck` `{paymentId}` | `getPayment` → `applyPaymentObject` (`source:'housekeeping'`) |
| `payments/refund-create` `{refundId}` | `createRefund` по `refunds.request` с `refunds.idempotence_key` → `provider_refund_id`, статус; `succeeded` сразу → `applyRefundObject`; 4xx → `refunds.status='failed'`, `refund_failed`/`partial_refund_failed`, алерт |
| `receipts/offset` `{receiptId}` | Б22: нет `provider_receipt_id` → `createOffsetReceipt(request, key)`; потом `getReceipt`; `succeeded` → `applyReceiptObject` + `sellerCards.refresh`; `pending` → отложенная задача `offset-poll` через 2 мин; с `first_attempt_at` прошло ≥ 15 мин → `alerted_at`, `staff_receipt_failed` (продавцам и владельцу), задача завершается; 4xx → окончательная ошибка + тот же алерт |
| `receipts/payment-receipt` `{receiptId}` | Чек в составе платежа (Б23): `receipt_registration` → `listPaymentReceipts` → статус; опрос как у offset; для `full` после succeeded — `sellerCards.refresh` («Выдал» активна) |
| `reconciliation/sweep` | `payments` pending старше 10 мин (с `provider_payment_id`) → `getPayment` → `applyPaymentObject(source:'reconciliation')`; pending без id старше 10 мин → повтор POST по `request` с тем же ключом → `recordPaymentCreated`; `refunds` pending → `getRefund`/повтор POST; ошибки — в лог, без ретраев (следующий проход через 10 мин) |
| `reconciliation/nightly` | Б29 |

`webhook_events.result` пишет движок; `stale` — событие не про текущий платёж; `pending` — объект
ещё не финальный. Тесты (`test/payments-*.int.test.ts`, msw + база `_worker`): шаги Verification
1, 2, 3, 4, 13, 14, 16 и половина 10, 11, 15 (раздел 18); повтор задачи после «падения» между
ответом ЮKassa и записью (msw отдаёт тот же объект по ключу); дважды поставленный webhook →
один переход, один чек, одно уведомление.

## 11. Очередь rossko (волна 3, пакет `worker-supplier`)

| Задача | Поведение |
|---|---|
| `rossko/recheck` `{orderId, eventId, staffId}` | Заказ не `confirmed` → выход; GetSearch мимо кэша (`bypassCache`, `critical`) по уникальным `search_article_norm`; `recheckOrder`; журнал `recheck_result` (дрейф, альтернативы — без ПД); `applyTransition('supplier_order_requested', actor system, facts {priceDriftBp, allAvailable, reason})`. Ошибка поставщика/квоты — повтор (3), затем карточка «Rossko не ответил, нажмите ещё раз» (журнал) |
| `rossko/checkout` `{supplierOrderId}` | Б13–Б15: строка не `sending` → выход; `called_at` есть → `recover`; иначе `called_at = now` (коммит) → `rossko.checkout({items, comment: checkoutComment})` → `matchCheckoutResult` → `supplier_orders` (`created`/`failed`, `rossko_order_ids`, `response`, `item_errors`, `delivery_cost_kop`) → `supplier_checkout_succeeded` (`supplierItemErrors`) или `supplier_checkout_failed`; при `prepay_invoice` — `invoice_number` = id Rossko, `invoice_amount_kop` = Σ строк + доставка (`VERIFY`); `checkoutMayHaveExecuted(error)` → `recover`; ошибка до отправки (лимитер, конфиг) → `failed` + `supplier_checkout_failed` |
| `rossko/recover` `{supplierOrderId}` | Б14 |

Тесты (`test/rossko-*.int.test.ts`, fixture-caller с подменой): Verification 5 (+1%/+10%),
6 (itemErrors → needs_attention, позиция pending), 22 (повторный заказ одной позиции), 23
(`prepay_invoice` → `awaiting_supplier_invoice`, `promised_date` + лаг); `ROSSKO_ALLOW_CHECKOUT=false`
→ needs_attention, 0 вызовов GetCheckout; задача `checkout` дважды → один вызов GetCheckout;
`called_at` уже стоит → GetCheckout не вызывается, восстановление по комментарию находит заказ.

## 12. Очереди notify и housekeeping (волна 3, пакет `worker-ops`)

### 12.1. notify

`notify/order {orderEventId, audience, template}`: событие и заказ (номер, схема, позиции бренд +
артикул, сумма, дата, `orderUrl = APP_BASE_URL/o/<token>`, `adminUrl = APP_BASE_URL/admin/orders/<id>`,
точка выдачи из env); `sellers` → `sellerCards.post`; `owner` → телеграм владельца (Б19);
`client` → строка `notifications` (`dedupe_key` Б20, `queued`) **до** отправки, затем `Notifier`
с драйверами (`sms` при наличии; `telegram` клиента — 1C), итог `sent`/`skipped` (+
`fallback_reason`)/`failed` (+`attempts`, `error` без ПД). Строка уже `sent` → выход. После
`decision_needed`: `sent` → `client_approvals.notified_at`, `expires_at = now + approval.timeout_h`,
журнал `approval_notified`; `skipped` → журнал `approval_unreachable` + `staff_approval_unreachable`.
SMS: `api_calls` (`source 'sms'`, `cost_kop = SMS_PRICE_KOP`). `notify/alert` — через `AlertPort`.

### 12.2. housekeeping

| Задача | Что |
|---|---|
| `timers` (60 с) | `awaiting_payment` с истёкшим сроком: нет платежа → `payment_ttl_expired` (`providerPaymentStatus:null`); pending → outbox `payment-recheck` (отмена только после подтверждения, PLAN); `awaiting_confirmation` → `confirmation_timeout`; `awaiting_handover_payment` → `payment_ttl_expired` (Б9); `ready` → `storage_expired` (`pickupWindowElapsed: true`); `handed` → `completion_timeout`; `client_approvals` с истёкшим `expires_at` → `approval_timeout` (scope из строки) |
| `reminders` (15 мин) | `ready`: дни `reminder.days` (3/6/9) с `received_at` → `arrived` с `readyDays`; `awaiting_client_approval`: через 12 ч после `notified_at` — `decision_needed` повторно (`reminded_at`); `awaiting_supplier_invoice` каждые 4 ч → владельцу `staff_supplier_invoice_due`; `needs_attention` каждые 4 ч → продавцам карточка; `supplier_returns` requested за 3 дня до `supplier_return_deadline_at` → `staff_supplier_return_task`; `refunds` pending за 2 дня до `deadline_at` → `staff_refund_deadline`; `awaiting_payment` / `awaiting_confirmation` — одно напоминание на середине срока. Каждое — журнал `reminder` + outbox с ключом `reminder:<order_id>:<kind>:<n>` |
| `smsBudget` (1 ч) | Б21 |
| `deferred1a` (10 мин) | Б26 |
| `heartbeat` | как в фазе 0 |

Тесты (`test/housekeeping-*.int.test.ts`, `now` внедряется): Verification 7 (молчание 24 ч,
skipped), 15, 19, 20, 21; TTL не отменяет оплаченный (pending у провайдера → только
`payment-recheck`); напоминания 3/6/9 ровно по одному; бюджет 80% — один алерт за месяц;
`deferred1a` для отмены 1A из «Оплатить заранее» ставит два уведомления, повторный проход — ноль.
notify: dedupe (одна задача дважды → одно SMS), лимит SMS → `skipped`, клиент без телефона/провайдера
→ `skipped` с `fallback_reason`, `decision_needed` skipped → таймер не стартует.

## 13. Бот продавца (волна 4, пакет `seller-bot`)

### 13.1. Поведение

1. `createSellerBot` получает `deps`; `allowed_updates` += `callback_query`; middleware 0-й фазы
   (`allowedChats`, `staffOnly`) действуют и на нажатия (чужой — `answerCallbackQuery` без текста).
2. `cards.ts` (`SellerCardPort`): карточка = текст (номер, схема, сумма, дата, позиции «Бренд
   Артикул × qty — состояние», клиент `•••4567`, причина `attention_reason` по-русски) + кнопки из
   `availableStaffActions` + «Открыть в админке» (url). Отправка → строка `seller_cards` (nonce до
   отправки, `message_id` после). Новая карточка закрывает прежние открытые карточки заказа
   (`editMessageReplyMarkup` без клавиатуры, ошибки «message is not modified» глотаются).
   `refresh(orderId)` перерисовывает последнюю открытую карточку. `sendHandoverQr` — `sendPhoto`
   (PNG `qrcode.toBuffer`), подпись «QR на оплату DT-… N ₽, действует до HH:MM», кнопка-ссылка на
   `confirmation_data` — только в чат продавцов.
3. Нажатие: `parseCallbackData` → строка `seller_cards` по nonce (нет/закрыта → «Карточка
   устарела») → `targetId` относится к заказу карточки → роль (`invpaid`, `dlq` — только owner) →
   меню (редактирование клавиатуры: варианты аналогов из `recheck_result`, сроки +2/+5/+7/+14,
   причины проблемы, «Назад») или `performStaffAction` → `answerCallbackQuery(message)` →
   перерисовка карточки с новым nonce. Двойное нажатие: второе видит закрытый nonce.
4. «Счёт оплачен»: ForceReply «Номер и дата платёжного поручения»; ожидание ответа в Redis
   (`<prefix>seller:await:<chat>:<user>`, TTL 10 мин); ответ → `performStaffAction('invpaid',
   {paymentRef})`.
5. `/queues` (owner): `inspector.stats()` и `deadLetters(10)` с кнопками `a:dlq:<id>:<nonce>`
   (id dead-letter задачи вместо uuid; формат `[A-Za-z0-9-]`, ≤ 36).
6. Логи: номер заказа, действие, staff id; без телефонов и токенов.

### 13.2. Действия (коды `callback_data`)

| Код | Кнопка | Где | id | Что |
|---|---|---|---|---|
| `recheck` | Проверить и заказать | confirmed | заказ | журнал + rossko/recheck |
| `refused` | Отменить и вернуть деньги / Отказ клиента | REFUSABLE | заказ | `client_refused` (staff) |
| `cancel` | Отменить заказ и вернуть деньги | needs_attention | заказ | `order_cancelled` |
| `anyway` | Заказать всё равно | needs_attention | заказ | `order_anyway` (маржа) |
| `ialt` → `alt1..3` | Аналог | needs_attention | позиция | меню → `alternative_proposed` |
| `ieta` → `eta2/5/7/14` | Новый срок | needs_attention | позиция | меню → `new_eta_proposed` |
| `icancel` | Отменить позицию | needs_attention, ordered_at_supplier | позиция | `item_cancelled` |
| `iprob` → `pdecl/pwrong/pdmg/pdelay` | Проблема с позицией | ordered_at_supplier | позиция | `item_problem` (причина); `pdmg` → `item_damaged_on_receipt` |
| `iarr` | Приехало | ordered_at_supplier | позиция | `item_arrived` |
| `invpaid` | Счёт оплачен (владелец) | awaiting_supplier_invoice | заказ | `supplier_invoice_paid` |
| `came` | Клиент пришёл | ready | заказ | `client_arrived` |
| `rcpt` | Повторить чек | ready, чек не succeeded | заказ | `offset_receipt_requested` |
| `qr` | Выставить оплату | ready (pay_on_handover, клиент пришёл) | заказ | `handover_payment_requested` |
| `handed` | Выдал | ready / awaiting_handover_payment при succeeded чеке | заказ | `handed_over` |
| `noshow` | Клиент не пришёл | ready после окна | заказ | `storage_expired` (staff) |
| `back` | Назад | меню | заказ/позиция | вернуть основную клавиатуру |

Тесты (`test/seller-bot-*.test.ts`, подмена транспорта grammY, база `_worker`): карточка нового
заказа с двумя кнопками и `•••XXXX`, без полного телефона и адреса; нажатие → событие и
отредактированная карточка; устаревший nonce, чужой пользователь, продавец на `invpaid` — отказ
без изменений; меню аналога → `awaiting_client_approval`; «Выдал» отсутствует до succeeded чека;
«Выставить оплату» отсутствует до «Клиент пришёл»; QR уходит фото только в чат продавцов;
`callback_data` всех кнопок ≤ 64 байт; `/queues` для продавца — молчание.

## 14. Сайт: оплата, решения клиента, вебхук (волна 4, пакет `web-pay`)

1. `POST /api/orders/[token]/pay` (форма и JSON): Origin, токен, Б6 → `preparePayment` → `reuse` —
   303 на ссылку; `create` — `createPayment` (таймаут 15 с) → `recordPaymentCreated` → 303 на
   `confirmation_url`; ошибка провайдера → 303 `/o/<token>?pay=error` («Не удалось создать платёж,
   попробуйте ещё раз»), строка платежа остаётся pending без id (reconciliation или следующий клик
   повторят тот же ключ). `return_url = APP_BASE_URL/o/<token>?paid=1`.
2. `POST /api/orders/[token]/actions` `{action, itemId?, last4?}`: `confirm`, `approve`,
   `prepay_now` — токен; `refund_request`, `refuse`, `item_cancel` — 4 цифры (общий модуль с отменой
   1A: счётчик неудач, `timingSafeEqual`) → `performClientAction`; ответы 200/409
   `not_allowed`/422 `wrong_digits`/429.
3. `POST /api/webhooks/yookassa`: тело ≤ 64 КБ; Б4 → 403; `parseWebhook` → 400 на мусор;
   транзакция: `webhook_events` (`on conflict do nothing`, `ip`) + при вставке — outbox
   `payments/webhook` с ключом `webhookJobId` (`${event}:${object.id}`) → коммит → nudge → 200 сразу.
   Дубль → 200 без новой строки. В лог — событие и id объекта, без тела.
4. `/o/<token>`: блок оплаты активен (Б6) с «Оплатить N ₽» (форма POST); `?paid=1` и последний
   платёж pending → «Проверяем оплату…» с `<meta http-equiv="refresh" content="5">` до 2 мин;
   `awaiting_confirmation` → «Подтверждаю»; `awaiting_client_approval` → предложение (аналог:
   бренд, артикул, срок; новый срок — дата) и «Согласен» / «Вернуть деньги» (4 цифры), срок
   ответа; `ordered_at_supplier` с частичным приездом → «Жду до <дата>» (без действия, текст) и
   «Отменить позицию» у неприехавших (4 цифры); REFUSABLE → «Отказаться от заказа» (4 цифры,
   текст про возврат 10 дней или «оплаты не было»); `ready` pay_on_handover → «Оплатить заранее»;
   код выдачи с `ready`; блок возврата (сумма, «деньги вернутся до <дата>», «Деньги отправлены»);
   таймлайн — фразы для всех событий TRANSITIONS и `JOURNAL_EVENTS`, служебные (`reminder`,
   `webhook_stale`, `recheck_*`, `seller` действия без смысла для клиента) скрыты.
5. Оформление (`checkout-service.ts`): `persistTransition` вместо `deferredEffects` (уведомление
   `confirm_request`/`payment_link` через outbox, `expires_at` для prepay); отмена 1A (`cancel.ts`)
   — `applyTransition` вместо `deferredEffects`/`deferredNotify`.
6. `startup-checks.ts`: production + оплата включена + (`TRUSTED_IP_HEADER=none` или пустой
   allowlist) → предупреждение «вебхуки ЮKassa будут отвергаться».
7. Тесты (`test/pay-*.int.test.ts`, `webhook-*.int.test.ts`, обновлённые `order-*`,
   `checkout-api.int.test.ts`; msw ЮKassa): оплата создаёт ровно один платёж при двух кликах;
   повтор после 503 — тот же `Idempotence-Key`; без ключей — «Оплата подключается»; вебхук с чужого
   IP → 403, без `X-Real-IP` → 403, дубль → одна строка и одна запись outbox; «Подтверждаю»,
   «Согласен», «Вернуть деньги» с неверными цифрами; страница после `?paid=1`; в HTML нет полного
   телефона.

## 15. Мини-админка (волна 4, пакет `web-admin`)

1. Б25 в `proxy.ts` (+ `server/admin-auth.ts`); лимит неверных паролей 20/час на IP-бакет.
2. `/admin` — список: фильтр по статусу (все 17 + «требуют внимания»: needs_attention,
   awaiting_supplier_invoice, чек не прошёл, возврат failed), поиск по номеру `DT-…` и последним 4
   цифрам телефона, 50 на страницу по `created_at desc`; колонки: номер, статус, схема, сумма,
   дата, создан.
3. `/admin/orders/[id]` — карточка: полный телефон и имя (единственное место), позиции с
   состояниями, платежи, чеки, возвраты, заказы Rossko, согласования, возвраты поставщику,
   таймлайн полный (`order_events` с payload, метки правил), действия `availableStaffActions(role
   owner)` формами + админские: «Заказано вручную в ЛК Rossko» (номера), «Счёт оплачен» (номер и
   дата п/п), аналог из списка или вручную (бренд, артикул, склад — проверка через GetSearch не
   делается: только из `recheck_result`), новый срок датой, «Rossko принял/не принял возврат»
   (не принял → `stock_items`), «Вернуть платёж» (owner, причина), QR (SVG) при
   `awaiting_handover_payment`.
4. `POST /api/admin/orders/[id]/actions` — Origin, Basic auth, `performStaffAction(via 'admin')`
   → 303 обратно с flash-сообщением в query (`?done=…`).
5. `proxy.ts`/`request-limits.ts`/`rate-limit.ts`: новые виды лимитов для путей web-pay — `pay`
   (`POST /api/orders/<token>/pay`, 10/час), `order_action` (`POST /api/orders/<token>/actions`,
   20/час); вебхук не лимитируется (allowlist), но получает `Cache-Control: no-store`; `/admin` —
   noindex; `robots.ts` += `/admin`.
6. Тесты: без заголовка → 401 с `WWW-Authenticate`; неверный пароль → 401; без `ADMIN_BASIC_AUTH`
   → 404; верный → 200, `X-Robots-Tag`; список с фильтром; карточка показывает полный телефон, а
   `/o/<token>` — нет; действие «Приехало» через форму меняет позицию; «Выдал» без succeeded чека
   — 409 с текстом; классификатор лимитов на новые пути.

## 16. Сквозные тесты и e2e (волна 5, пакет `flow`)

1. `apps/worker/test/flow/full-cycle.int.test.ts`: настоящие PG/Redis, `runWorker`-подобная сборка с
   msw ЮKassa, fixture-caller Rossko (`ROSSKO_ALLOW_CHECKOUT=true`, delivery/payment id заданы),
   подменённый транспорт grammY, SMS на msw. Сценарий prepay: оформление (через
   `persistTransition`) → `preparePayment` + `createPayment` → msw `succeeded` → вебхук (функция
   обработчика web) → `confirmed`, чек предоплаты → нажатие «Проверить и заказать» в боте →
   recheck → checkout → `ordered_at_supplier` → «Приехало» по обеим позициям → `ready` → «Клиент
   пришёл» → offset (msw `pending` → `succeeded` через опрос) → «Выдал» → `handed`. Проверки:
   `order_events` по порядку, ровно 2 чека (prepayment, offset), 0 возвратов, notifications по
   dedupe_key, `callback_data` ≤ 64.
2. `worker-restart.int.test.ts`: workers закрыты, в это время — нажатия (движок пишет outbox),
   вебхуки (обработчик), housekeeping-таймеры; запуск → каждое событие ровно один раз, порядок
   переходов верный, повторный запуск ничего не добавляет; «падение» процессора после ответа
   ЮKassa до записи (исключение в тестовом хуке) → повтор задачи не создаёт второго платежа/чека.
3. Сквозной pay_on_handover: подтверждение → «Клиент пришёл» → «Выставить оплату» → QR фото в чат
   продавцов → `succeeded` → чек `full` → «Выдал». Частичный сценарий: itemErrors → «Отменить
   позицию» → частичный возврат с чеком на строку → остальное → зачёт на остаток.
4. Playwright (`apps/web/e2e/payments.spec.ts`, `admin.spec.ts`): `scripts/yookassa-mock-server.ts`
   (node http + `getResponse` из msw с `createYooKassaMock`; `confirmation_url` ведёт на страницу
   мока, которая отмечает платёж `succeeded`, шлёт вебхук на web с `X-Real-IP` из allowlist и
   редиректит на `return_url`); web standalone + worker процессом. Сценарии: оформление prepay →
   «Оплатить» → мок → `/o/<token>?paid=1` → «Оплачен» в течение 30 с; админка: карточка →
   «Проверить и заказать» → «Приехало» ×2 → «Клиент пришёл» → «Выдал» → «Выдан»; 375 и 1280 без
   горизонтального скролла; скриншоты. `scripts/e2e-1b.sh` поднимает всё и проверяет логи web и
   worker на `+79…` и токены заказов.
5. CI: job `e2e` запускает мок ЮKassa, worker и web; env раздела 23.

## 17. Документы (волна 5, пакет `docs`)

`docs/runbook.md` (раздел 12 «Фаза 1B»): включение оплаты (4 переменные, тестовый магазин,
вебхук в ЛК ЮKassa на `https://<домен>/api/webhooks/yookassa`, allowlist, `TRUSTED_IP_HEADER`),
прогон таблицы Verification на stage, `ROSSKO_ALLOW_CHECKOUT` и ручной режим, «Чек не прошёл»
(что делать, когда «Выдал» заблокирована), «Возврат не прошёл» (срок 10 дней), dead-letter и
`/queues`, поздняя оплата и orphan, SMS-бюджет, админка (Basic auth, где полный телефон).
`README.md`: эндпоинты и очереди 1B. `docs/external.md`, раздел 7 «Фаза 1B: VERIFY»: каждый
`VERIFY:` из кода 1B (grep) строкой с вопросом и файлом.

## 18. Тест-кейсы и строки Verification «Фаза 1B»

| Шаг | Действие PLAN | Чем закрыто в этой среде | Где |
|---|---|---|---|
| 1 | prepay, карта успеха | msw: платёж с чеком `full_prepayment`, `payment.succeeded` → GET → `confirmed`, чек `prepayment` succeeded по `receipt_registration`, `order_events` checkout/payment_succeeded | worker-payments int, flow, e2e |
| 2 | отказ и 3-D Secure | `canceled` → `cancelled`; вебхук «succeeded», а GET отдаёт `pending` → перехода нет; потом `succeeded` → `confirmed` | worker-payments int |
| 3 | повтор вебхука | вторая POST → без новой строки и outbox; задача дважды → один переход, один чек, одно уведомление | web-pay int, worker-payments int |
| 4 | вебхук не пришёл | reconciliation через 10 мин (`now`) → `confirmed`; истёкший TTL при pending у провайдера не отменяет | worker-payments int, worker-ops int |
| 5 | recheck +1% / +10% | fixture-caller `priceFactorBp` → `ordered_at_supplier` / `needs_attention` с альтернативами | worker-supplier int, rossko-ops unit |
| 6 | itemErrors одной из двух | позиция pending, карточка с кнопками позиции; «Отменить позицию» → возврат на строку с чеком `refund_prepayment` одной строки; зачёт на остаток | engine int, worker-supplier int, flow |
| 7 | «Аналог» → «Согласен» / «Вернуть деньги» / молчит / skipped | `replaced_by_item_id` и дозаказ / `refund_pending` с чеком возврата succeeded / `approval_timeout` → `refund_pending` / `guard_failed` → остаётся needs_attention | engine int, web-pay int, worker-ops int |
| 8 | «Приехало» одной из двух | заказ не `ready`, клиенту `partial_arrival`; на `/o` — «Жду до» и «Отменить позицию» | engine int, web-pay int |
| 9 | всё приехало → «Клиент пришёл» | offset succeeded, только потом «Выдал» есть в карточке; в msw два чека | flow, seller-bot, engine |
| 10 | pay_on_handover целиком | «Подтверждаю» (web) → «Клиент пришёл» → «Выставить оплату» → QR в чат продавцов → `succeeded` → чек `full` → «Выдал»; «Выставить оплату» нет до «Клиент пришёл» | flow, seller-bot, domain spec |
| 11 | «Отменить заказ и вернуть деньги», «Отказ клиента» | `refund_pending → refunded`, чек `refund_prepayment` succeeded | engine int, worker-payments int, web-pay int |
| 12 | worker остановлен 10 мин | события ровно один раз и по порядку | flow `worker-restart` |
| 13 | ошибка POST /receipts | msw `rejectTaxSystemCode` → алерт после 15 мин, «Выдал» заблокирована | worker-payments int, seller-bot |
| 14 | оплата заказа, отменённого по TTL | `refund_pending` автоматически, `late_payment_refund` | worker-payments int |
| 15 | невыкуп prepay, 10-й день | `refund_pending`, чек возврата succeeded, `no_show_count+1`, `supplier_returns` + задача продавцу | worker-ops int, worker-payments int |
| 16 | сумма ≠ total | `needs_attention (amount_mismatch)`, алерт владельцу | worker-payments int |
| 17 | «Проблема с позицией» → «Заказать всё равно» | `needs_attention → ordered_at_supplier`, причина в `order_events` | engine int, seller-bot |
| 18 | «Оплатить заранее» | `awaiting_payment`, затем два чека как prepay | web-pay int, engine int |
| 19 | TTL QR 15 мин | `awaiting_handover_payment → ready` | worker-ops int |
| 20 | невыкуп pay_on_handover, 7-й день | `cancelled`, без возврата, `no_show_count+1` | worker-ops int |
| 21 | 24 ч без подтверждения; 7 дней после выдачи | `cancelled`; `completed` | worker-ops int |
| 22 | «Повреждено при приёмке» | `supplier_returns` claim, новая позиция с `replaced_by_item_id`, GetCheckout на неё | engine int, worker-supplier int |
| 23 | `rossko.prepay_invoice=true` | `awaiting_supplier_invoice` → «Счёт оплачен» (владелец, номер п/п) → `ordered_at_supplier`, `promised_date` + лаг | worker-supplier int, seller-bot, engine |

Дополнительно: инварианты раздела 2 PLAN — domain unit (`receipts.test.ts`, `refunds.test.ts`,
`transitions.spec.ts`: handed только при succeeded offset/full; refund по claim только при
`returnAccepted` или override владельца — правило есть, кнопки в 1C); «в логах нет телефонов и
токенов» — e2e по логам web и worker; «в Telegram только номер, статус, бренд, артикул» — тест
рендера всех клиентских шаблонов и карточек продавца (телефон только маской).

## 19. Критерии приёмки фазы 1B (в этой среде)

1. `pnpm install --frozen-lockfile`, `pnpm lint`, `pnpm format:check`, `pnpm typecheck`, `pnpm test`,
   `pnpm --filter @detaly/db db:drift` — зелёные; миграция 0002 и двойной сид проходят на базе 1A.
2. Все переходы статуса заказа идут через `applyTransition`/`persistTransition` с `select … for
   update`; прямых `update orders set status` вне `packages/orders` нет (тест-grep).
3. Каждый шаг Verification 1–23 закрыт тестом из раздела 18 на msw и фикстурах.
4. Сквозной тест на очередях проходит prepay-цикл до `handed` с двумя чеками; pay_on_handover — с
   одним; частичный возврат — чек только на строку.
5. Остановка воркера и повтор задач: каждое событие исполнено ровно один раз.
6. Дубль вебхука не создаёт второго перехода; пропущенный вебхук закрывает reconciliation; TTL не
   отменяет оплаченный; оплата отменённого заказа → `refund_pending`; оплата `refunded` → orphan-возврат
   без смены статуса и алерт.
7. «Выдал» недоступна без succeeded чека (offset/full) — в домене, движке, боте и админке.
8. Бот продавца: карточки с действиями, маскированный телефон, `callback_data` ≤ 64 байт с nonce и
   ролью, редактирование после нажатия, `/queues`; QR только продавцу.
9. `/admin` под Basic auth (постоянное время, noindex); полный телефон только там.
10. `ROSSKO_ALLOW_CHECKOUT=false` технически исключает GetCheckout (0 вызовов в тесте).
11. E2E 1A (44) и новые e2e 1B зелёные на 375 и 1280; в логах web и worker нет телефонов и токенов.
12. Все неподтверждённые поля внешних API помечены `VERIFY:` в коде и перечислены в
    `docs/external.md`.

## 20. Заблокировано сетью и как закрыто

| Что | Почему недоступно | Чем закрыто |
|---|---|---|
| ЮKassa API (`api.yookassa.ru`): платежи, чеки в платеже, `POST /receipts` с settlements, `receipt_registration`, `GET /receipts?payment_id`, список платежей, возвраты с чеком, коды `vat_code`/`tax_system_code`, формат `customer.phone`, лимиты `metadata`, QR/СБП, срок жизни платежа, IP вебхуков, повторы уведомлений | `.ru` закрыт, тестового магазина нет | msw-эмуляция `@detaly/payments/testing` (раздел 6), `VERIFY:` в коде, Ю4, Ю5, Ю9–Ю11 + новые строки в `docs/external.md`; stage-прогон таблицы Verification — Максим |
| Rossko GetCheckout/GetOrders (`api.rossko.ru`): состав ответа, комментарий, список заказов без id, номер счёта и сумма, отгрузка до оплаты | закрыт, ключей нет | синтетические фикстуры, fixture-caller с вариантами (`timeout`, `priceFactorBp`), `VERIFY:`; R6, R7, R10, R11 + новые |
| Telegram (`api.telegram.org`): живой бот, фото QR, личка владельца, лимиты | закрыт | подмена транспорта grammY в тестах; живая проверка `/ping` и карточек — после деплоя |
| SMS Aero / smsc.ru: форматы API, имя отправителя, тариф | закрыт, договора нет | msw на оба формата, `SMS_PRICE_KOP` с `VERIFY` |
| MAX (`platform-api.max.ru`) | закрыт | в 1B не используется (фаза 2) |
| Проверка чеков в приложении ФНС, ЛК ЮKassa «два чека» | ручное, после боевого магазина | 1C, Максим |
| npm registry | открыт | `qrcode`, `@types/qrcode` ставятся в волне 1 |

## 21. Риски и обходы

| Риск | Обход | Проверка |
|---|---|---|
| «Чеки от ЮKassa» не умеют зачёт (гейт фазы 0 не закрыт) | `ReceiptProvider` отдельно; оплата не включается без кодов (Б6); план Б — облачная ККТ за тем же интерфейсом | runbook 1B, external Ю1–Ю3 |
| Расхождение реального API ЮKassa с эмуляцией (`receipt_registration`, список чеков) | парсер терпит отсутствие полей (`null`), статус чека в платеже опрашивается, «Выдал» при неизвестном статусе заблокирована | stage-прогон Verification |
| Двойной GetCheckout | Б13: строка до вызова, `called_at` с коммитом, частичный unique, 1 попытка, восстановление вместо повтора | worker-supplier int |
| Восстановление невозможно (нет списка GetOrders) | needs_attention «проверьте ЛК», ручная отметка в админке | worker-supplier int |
| Потеря задач при падении Redis | outbox в PG, диспетчер с повтором, таймеры из БД | worker-core int |
| Дубли задач после вытеснения jobId | идемпотентность по строкам БД (Б3) | flow `worker-restart` |
| Параллельные нажатия в боте и админке | блокировка строки заказа + nonce карточки | engine int, seller-bot |
| Утечка ПД в Telegram и логи | маска телефона, шаблоны без ПД, тест-grep рендеров и логов e2e | notify unit, e2e |
| Спам SMS чужому номеру через оформление | лимиты 1/10 мин и 3/сутки, бюджет со стопом, лимит оформлений 1A | notify unit, worker-ops int |
| Перебор 4 цифр на новых действиях | общий счётчик неудач 1A + лимит `order_action` 20/час | web-pay int, web-admin |
| Подмена `X-Real-IP` в обход Caddy | web недоступен снаружи кроме Caddy (фаза 0); allowlist fail closed | web-pay int, runbook |
| Параллельные пакеты волны в одной тестовой базе | своя база проекта (`_orders`, `_worker`, `_web`) и worktree (`detaly_test_<worktree>`), ключи Redis `test:<uuid>:`, `bullPrefix` на тест | повторный прогон |
| Next 16 и Basic auth | только в `proxy.ts` (layout не ставит 401); `/api/admin` тоже через proxy | web-admin int |
| BullMQ: `:` в jobId | `bullJobId` (Б2) | worker-core unit |

## 22. Волны и пакеты

Правила (как в 1A): пакет — отдельный worktree и ветка `wp/1b-<key>`; агент правит только свои
пути, остальное читает. После волны 1 схему, миграции, env, lock, `packages/config`,
`packages/domain/src/{statuses,types}.ts` и `state-machine/*` не трогает никто (нужна правка —
описать в отчёте, её делает интеграция). Установка `pnpm install --frozen-lockfile --prefer-offline`;
базы — `scripts/dev-db.sh up && eval "$(scripts/dev-db.sh env)"`; Redis — ключи `test:<uuid>:`,
`FLUSHDB` запрещён; сеть к внешним API не нужна. Коммит после зелёной проверки, без push.

| Волна | Пакеты | Зависит от |
|---|---|---|
| 1 | `foundation` | — |
| 2 | `engine`, `payments`, `notify`, `rossko-ops` | 1 |
| 3 | `worker-core`, `worker-payments`, `worker-supplier`, `worker-ops` | 2 |
| 4 | `seller-bot`, `web-pay`, `web-admin` | 2, 3 |
| 5 | `flow`, `docs` | 4 |

| Пакет | Пути (только эти пишет агент) | Разделы |
|---|---|---|
| `foundation` | `packages/db/src/schema/**`, `packages/db/drizzle/**`, `packages/db/test/{phase1b,migrations}.int.test.ts`; `packages/config/src/{env,queues,settings-defaults,index}.ts`, `packages/config/test/**`, `.env.example`; `packages/domain/src/{statuses,types,receipts,refunds,recheck-types,timers,journal,index}.ts`, `packages/domain/src/state-machine/**`, `packages/domain/test/{transitions.spec,receipts.test,refunds.test}.ts` (+ `__snapshots__`); `packages/payments/src/{types,receipt-lines,index}.ts`; `packages/notify/src/templates/order.ts`; `packages/orders/**` (каркас); `apps/worker/package.json`, `apps/worker/src/{deps,workers}.ts`, `apps/worker/src/jobs/**`, `apps/worker/src/bots/seller/{cards,bot}.ts`, `apps/worker/test/jobs.test.ts`, `apps/worker/test/helpers/test-deps.ts`; `apps/web/package.json`, `apps/web/next.config.ts`, `apps/web/src/server/engine.ts`; `pnpm-lock.yaml` | 1–4 |
| `engine` | `packages/orders/src/**`, `packages/orders/test/**` | 5 |
| `payments` | `packages/payments/src/**`, `packages/payments/test/**` | 6 |
| `notify` | `packages/notify/src/**`, `packages/notify/test/**` | 7 |
| `rossko-ops` | `packages/rossko/src/**`, `packages/rossko/fixtures/**`, `packages/rossko/test/**`, `packages/domain/src/recheck.ts`, `packages/domain/test/recheck.test.ts`, строка экспорта в `packages/domain/src/index.ts` | 8 |
| `worker-core` | `apps/worker/src/{app,main,queues,workers,shutdown,create-deps,alerts,inspector}.ts`, `apps/worker/src/outbox/**`, `apps/worker/src/dead-letter/**`, `apps/worker/test/{outbox,dead-letter,process,shutdown,heartbeat,queues}*.test.ts`, `apps/worker/test/fixtures/**` | 9 |
| `worker-payments` | `apps/worker/src/jobs/{payments,receipts,reconciliation}/**`, `apps/worker/test/{payments,receipts,reconciliation}-*.test.ts` | 10 |
| `worker-supplier` | `apps/worker/src/jobs/rossko/**`, `apps/worker/test/rossko-*.test.ts` | 11 |
| `worker-ops` | `apps/worker/src/jobs/notify/**`, `apps/worker/src/jobs/housekeeping.ts` (точка входа сохраняет имя `processHousekeeping`), `apps/worker/src/jobs/housekeeping/**`, `apps/worker/test/{notify,housekeeping}-*.test.ts`, `apps/worker/test/jobs.test.ts` | 12 |
| `seller-bot` | `apps/worker/src/bots/seller/**`, `apps/worker/test/{seller-bot,staff}*.test.ts`; в `apps/worker/src/app.ts` — только блок создания бота | 13 |
| `web-pay` | `apps/web/src/server/{orders,payments}/**`, `apps/web/src/server/checkout/checkout-service.ts`, `apps/web/src/server/startup-checks.ts`, `apps/web/src/app/(site)/o/**`, `apps/web/src/app/api/orders/**`, `apps/web/src/app/api/webhooks/**`, `apps/web/src/components/order/**`, `apps/web/test/{order-*,pay-*,webhook-*,checkout-api.int,startup-checks}.test.ts` | 14 |
| `web-admin` | `apps/web/src/app/admin/**`, `apps/web/src/app/api/admin/**`, `apps/web/src/server/admin/**`, `apps/web/src/server/{admin-auth,rate-limit,request-limits}.ts`, `apps/web/src/components/admin/**`, `apps/web/src/proxy.ts`, `apps/web/src/app/robots.ts`, `apps/web/test/{admin-*,proxy,request-limits,rate-limit.int}.test.ts` | 15 |
| `flow` | `apps/worker/test/flow/**`, `apps/web/e2e/**`, `apps/web/playwright.config.ts`, `scripts/yookassa-mock-server.ts`, `scripts/e2e-1b.sh`, `.github/workflows/ci.yml` | 16 |
| `docs` | `docs/runbook.md`, `docs/external.md`, `README.md` | 17 |

Общие файлы: `apps/web/src/server/engine.ts` (синглтон `EngineDeps` web с `nudge` через
`getRedis().publish(OUTBOX_CHANNEL)`) и `apps/worker/test/helpers/test-deps.ts`
(`createTestDeps(overrides)`: база `_worker`, Redis с префиксом, записывающие фейки портов) пишет
фундамент, остальные только импортируют. Корневой `app/layout.tsx` не трогает никто (у админки
свой `app/admin/layout.tsx`).

### Шаг И — интеграция (после каждой волны)

Слияние веток волны, `pnpm install --frozen-lockfile`, полный прогон раздела 23 в объёме уже
слитого, правки по ревью (независимый ревьюер на пакет: деньги, идемпотентность, блокировки, ПД
в логах). После волны 5 — скриншоты глазами и коммит без push.

## 23. Итоговая проверка фазы в этой сессии

```bash
cd /home/user/detaly
pnpm install --frozen-lockfile
scripts/dev-db.sh up && eval "$(scripts/dev-db.sh env)"
pnpm lint && pnpm format:check && pnpm typecheck
pnpm test && pnpm --filter @detaly/db db:drift
pnpm db:migrate && pnpm db:seed && pnpm db:seed
bash scripts/e2e-1b.sh   # web standalone :3100, worker, мок ЮKassa :3199, Playwright 1A+1B, grep логов
```

Env для e2e (дополнительно к разделу 15 документа 1A): `YOOKASSA_SHOP_ID=test-shop`,
`YOOKASSA_SECRET_KEY=test-secret`, `YOOKASSA_API_URL=http://127.0.0.1:3199/v3`,
`YOOKASSA_VAT_CODE=1`, `YOOKASSA_TAX_SYSTEM_CODE=2`, `YOOKASSA_WEBHOOK_IP_ALLOWLIST=127.0.0.1/32`,
`TRUSTED_IP_HEADER=x-real-ip`, `ADMIN_BASIC_AUTH=admin:e2e-admin-password`,
`ROSSKO_ALLOW_CHECKOUT=true`, `ROSSKO_DELIVERY_ID=fx-delivery`, `ROSSKO_PAYMENT_ID=fx-payment`,
`SMS_PROVIDER=none`. Ручная проверка: `curl -X POST -H 'X-Real-IP: 203.0.113.9' …/api/webhooks/yookassa`
→ 403; `curl -I …/admin` → 401 с `WWW-Authenticate`.

## 24. Что не входит в 1B (честно)

Клиентский Telegram-бот, привязка мессенджеров и `link_tokens`, драйвер MAX (1C/2: без привязок
клиентские уведомления в 1B идут только SMS по allowlist или `skipped`); претензии `claims` и
«Принял возврат» (1C; инвариант в домене уже есть); фото упаковки и `order_photos`; курьер и
`out_for_delivery` (ф2; правила есть, кнопок нет); GetOrders-polling статусов Rossko (ф2; в 1B —
только восстановление); «Продать со склада» (ф2; `stock_items` создаётся минимально); экспорт CSV и
акт (ф2); страница настроек в админке (`rossko.prepay_invoice` и пороги меняются SQL по runbook);
утренний дайджест; облачная ККТ (план Б — после ответа ЮKassa); чек коррекции. Живые ЮKassa,
Rossko, Telegram и SMS не проверялись: всё на msw, фикстурах и подменённом транспорте.
