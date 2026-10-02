# План: платформа перепродажи автозапчастей (Оренбург) — сайт, боты MAX/Telegram, платёжка

## Context

Максим (ИП на АУСН «доходы» 8%, соло-разработчик, код пишет Claude Code) и Лёша (ИП на УСН, автосервис «Сервис56», Оренбург) хотят заменить ручной процесс «собрать заявку → заказать на Rossko с наценкой → привезти в сервис → выдать/установить» на сайт и ботов. Клиент сам находит деталь (по артикулу или через подбор по VIN), оплачивает, продавцы получают готовую заявку, заказывают у Rossko на адрес Сервис56, выдают или устанавливают. Цены с наценкой 28%. Возвраты поставщику от своего имени. Платёжка на ИП Максима, прибыль делится с Лёшей.

Репозиторий `wakeupitsadream/detaly` пустой (только README), ветка `claude/auto-parts-resale-platform-5j8nfs`. Проект с нуля.

Как получен план: исследовательский воркфлоу (8 тем × исследователь + скептик, синтез), три раунда вопросов фаундеру (12 решений), панель проектирования (3 архитектора с линзами «скорость», «право», «доверие» → 3 судьи → синтез → критик полноты). Победил план «скорость» (107 баллов против 91 и 94), в него вплетены прививки из двух других и все блокеры/major-замечания критика.

Ограничение среды: сетевая политика контейнера закрывает все .ru-хосты (rossko.ru, api.rossko.ru, yookassa.ru, nalog.gov.ru, dev.max.ru → код 000). Структура API Rossko, ЮKassa и MAX подтверждена по открытому коду и официальным схемам на GitHub; тарифы, условия возврата Rossko, адреса точек, даты маркировки — **непроверены**, сверять вручную. Для реализации в этой среде нужно добавить в разрешённые домены: `api.rossko.ru`, `api.yookassa.ru`, `yookassa.ru`, `platform-api.max.ru`, `dev.max.ru`, `api.telegram.org`, выбранный SMS-шлюз, registry npm (если ещё не открыт).

Полные материалы: исследование `/tmp/claude-0/-home-user-detaly/dd5cbc3a-94bb-5045-84dc-386f1385df9d/tasks/wysirbo4i.output`, панель проектирования `/tmp/claude-0/-home-user-detaly/dd5cbc3a-94bb-5045-84dc-386f1385df9d/tasks/wg3eu94qk.output`.

## Ключевые факты, меняющие исходную идею

1. АУСН 8% берётся со всей выручки. На закупку 100 при цене 128 налог 10,24, чистая наценка 17,8% (13,9% выручки), а не 20%. Дальше эквайринг ≈2,8%, касса, возвраты. На детали за 10 000 ₽ по опту чистая маржа до раздела ≈1 240–1 310 ₽ (12–13% от закупки). Объект АУСН 20% при такой наценке почти вдвое дешевле (точка равенства ≈67% наценки), менять можно с 1 января.
2. API Rossko (SOAP v2.1, `https://api.rossko.ru/service/v2.1/{Method}?wsdl`, ключи KEY1/KEY2 из ЛК) отдаёт GetSearch (артикул/бренд → цена, остаток, срок по складам, кроссы), GetCheckoutDetails, GetCheckout (возвращает itemErrors — позиция может не заказаться уже после оплаты клиентом), GetOrders (≤20 за вызов, 16 статусов), GetSettlements. VIN-подбора, фото и описаний в API нет; каталог на сайте — лицензия Laximo. Парсить сайт нельзя. Лимиты по стороннему пересказу: 300/мин, 100 000/сутки.
3. 54-ФЗ: исключений для АУСН нет, СБП от физлица тоже требует ККТ. При предоплате два чека: «предоплата 100%» при оплате и «полный расчёт, зачёт аванса» при выдаче; оба пробивает ИП Максима.
4. Для Rossko вы оптовый контрагент без защиты потребителя (возврат по согласованию, 14 дней, электрика со следами установки не принимается — непроверено). Клиенту деньги обязаны вернуть за 10 дней независимо от Rossko (ст. 26.1 ЗоЗПП, отказ 7 дней, 3 месяца без письменной памятки; просрочка выдачи предоплаченного — 0,5%/день).
5. Простое товарищество на АУСН запрещено; агентирование в пользу Сервис56 (приём оплаты установки с передачей Лёше) ломает АУСН. Рабочая схема: договор услуг ИП↔ИП с актами; установку клиент оплачивает Сервис56 напрямую.
6. ОКВЭД 45.32.21 + 47.91.2 добавляются формой Р24001 (ЛК ИП / Госуслуги / МФЦ), пошлина 0, 5 рабочих дней; сделать до первого поступления. Уведомление в РКН — до публикации форм сбора ПД. ПД — только в БД в РФ (Vercel/Supabase/Neon исключены).
7. MAX Bot API: бот только ИП/юрлицам после верификации на business.max.ru; production — webhook на 443 с секретом в заголовке; платежей нет; схема меняется каждые 2–4 недели; официальный SDK `@maxhub/max-bot-api`. Telegram: grammY, long polling.
8. Маркировка «Честный знак»: шины обязательны, масла/антифризы/тормозные жидкости вводятся 2025–2026; фильтры/свечи/колодки/диски — эксперимент с датами 31.08/01.09/01.12.2026 (**непроверено, может уже действовать**).

## Решения фаундера (не пересматриваются)

| № | Решение |
|---|---|
| 1 | Аккаунт Rossko: новый оптовый на ИП Максима (у Лёши остаётся свой для сервиса); ключи API запросить у оренбургского менеджера |
| 2 | Оплата гибридная: позиции со склада Оренбурга — оплата при выдаче (один чек); под заказ — 100% предоплата (чек предоплаты + чек зачёта) |
| 3 | Лёша — ИП на УСН → договор возмездных услуг ИП↔ИП с ежемесячными актами |
| 4 | VIN-подбор обязателен: Laximo, если тариф и договор подъёмные, иначе acat.online / PartsAPI; ручной подбор по заявке — fallback в любом случае |
| 5 | Стек TypeScript: Next.js + grammY + @maxhub/max-bot-api + npm `soap`, PostgreSQL, Redis/BullMQ, docker compose на VPS в РФ |
| 6 | Клиенты: MAX основной, Telegram второй; бот продавца — в Telegram |
| 7 | Заказ у Rossko полуавтоматом: перепроверка → кнопка «Заказать» в боте продавца → GetCheckout; автозаказ после 1–2 месяцев статистики |
| 8 | География: самовывоз из Сервис56 + курьер по Оренбургу; без ТК |
| 9 | ЮKassa + «Чеки от ЮKassa»; в коде — интерфейсы `PaymentProvider` и `ReceiptProvider` (сменяемые) |
| 10 | Маркируемые группы исключены на старте; в БД поле под код маркировки |
| 11 | Новый независимый бренд; домен на ИП Максима (с 01.09.2026 — идентификация через ЕСИА) |
| 12 | Бюджет на сервисы 5–15 тыс ₽/мес |

Допущения (фаундер не подтверждал, можно поправить при утверждении): возврат клиенту строго по ЗоЗПП без удержаний при самовывозе; решение об АУСН 20% до 20.12.2026 по расчёту (точка равенства ≈67% наценки) и фактическим наценкам первых недель — трёх месяцев статистики к этой дате не будет; поток 50–200 заказов/мес; установка — запись через бот без оплаты на сайте.

Решения раунда 4 (02.10.2026): оплата при выдаче только при `total ≤ ON_PICKUP_MAX_TOTAL = 15 000 ₽` и `no_show_count < NO_SHOW_LIMIT = 2`, иначе предоплата — **санкционировано фаундером**; рабочее название бренда «Детали», название и реквизиты только из env (`BRAND_NAME`, `SELLER_REQUISITES_*`), без хардкода; в текущей сессии реализуется вся кодовая часть фазы 0 (см. раздел «Текущий шаг» в конце).

## 1. Архитектура и стек

Один VPS в РФ (Timeweb Cloud или Beget, 2 vCPU / 4 ГБ, swap 2 ГБ), один `docker compose`, два Node-процесса. Бизнес-логика — чистые функции в `packages/domain` (без I/O) и воркеры; Next.js только рендерит и принимает HTTP. Все внешние вызовы с побочным эффектом (GetCheckout, чеки, возвраты, мессенджеры, SMS) — из воркера через очереди; синхронно только GetSearch через кэш и создание платежа при оформлении.

| Сервис compose | Образ | Роль |
|---|---|---|
| caddy | caddy:2 | TLS Let's Encrypt, единственный открытый порт 443, прокси на web, `trusted_proxies`; rate limit **не в Caddy** (образ без модуля), а в middleware приложения |
| web | `apps/web`, Next.js standalone, `NODE_EXTRA_CA_CERTS` с сертификатом Минцифры | сайт, route handlers, вебхуки ЮKassa и MAX, страница заказа, мини-админка |
| worker | `apps/worker`, node 22, тот же сертификат | BullMQ-воркеры, repeatable-задачи, оба Telegram-бота (long polling), отправка уведомлений, heartbeat в Redis |
| postgres | postgres:16, volume | единственное хранилище заказов, денег, ПД |
| redis | redis:7 appendonly | очереди, кэш GetSearch, лимитеры |
| backup | alpine + pg_dump + rclone по cron | ночной шифрованный дамп в S3 РФ, хранение 30 дней — с фазы 0 |

Деплой: образы собираются в GitHub Actions и публикуются в ghcr.io (при проблемах с доступом — `docker save` + scp); на VPS только `pull` + `up -d` по тегу, миграции Drizzle отдельным шагом; откат — `up` предыдущего тега без сборки. Лимиты памяти в compose, `healthcheck`, `restart: always` для web и worker; worker пишет heartbeat в Redis, `/api/health` его проверяет, тишина > 5 минут — алерт в чат продавцов (фаза 0). Stage — compose-профиль, поднимается по требованию только на время тестов ЮKassa, с `ROSSKO_ALLOW_CHECKOUT=false`. `TZ=Asia/Yekaterinburg` для дат и cron; суточный счётчик Rossko — по Europe/Moscow.

Монорепо (pnpm workspaces):

| Путь | Содержимое |
|---|---|
| `apps/web` | App Router: `app/(site)`, `app/admin`, `app/api`; middleware с лимитами |
| `apps/worker` | `queues/`, `jobs/`, `bots/seller`, `bots/client` |
| `packages/db` | Drizzle-схема, миграции, сиды `settings` и `staff`; id — uuid v7 из пакета `uuid` в `defaultFn` |
| `packages/domain` | `transition()`, расчёт цен/дат, сборка payload чеков, инварианты денег; только чистые функции и тесты |
| `packages/rossko` | SOAP-клиент, лимитер, кэш, маппинг, фикстуры |
| `packages/payments` | `PaymentProvider` (+ `YooKassaProvider`) и **отдельный** `ReceiptProvider` (`YooKassaReceipts`, запасной `CloudKktReceipts`) |
| `packages/notify` | `Notifier` с драйверами telegram, max, sms; allowlist SMS-шаблонов |
| `packages/vin` | `VinResolver`: `ManualResolver`, позже `LaximoResolver` / `AcatResolver` / `PartsApiResolver` |
| `infra/` | compose, Caddyfile, backup, deploy-скрипт |
| `scripts/rossko-smoke.ts` | прогон GetSearch/GetCheckoutDetails/GetOrders, запись фикстур с маскированием ключей |
| `docs/runbook.md`, `docs/external.md`, `docs/budget.md` | ручной режим, таблица внешних заявок с датами, бюджет |

Env (дефолты перекрываются `settings`):

| Группа | Переменные |
|---|---|
| Приложение | APP_BASE_URL, SESSION_SECRET, ADMIN_BASIC_AUTH, DATABASE_URL, REDIS_URL, S3_ENDPOINT/BUCKET/KEY/SECRET, BACKUP_PASSPHRASE, TZ |
| Rossko | ROSSKO_KEY1, ROSSKO_KEY2, ROSSKO_WSDL_BASE, ROSSKO_DELIVERY_ID, ROSSKO_ADDRESS_ID, ROSSKO_PAYMENT_ID, ROSSKO_LOCAL_STOCK_IDS, ROSSKO_RPM_LIMIT=250, ROSSKO_DAILY_LIMIT=90000, ROSSKO_QUOTA_BREAKER_PCT=70, ROSSKO_ALLOW_CHECKOUT |
| Цены и сроки | PRICING_MARKUP_PCT=28 (плюс таблица наценок по диапазонам в settings), PRICE_DRIFT_TOLERANCE_PCT=3, MARGIN_FLOOR_PCT=10, MIN_ORDER_TOTAL, MIN_MARGIN_RUB, ETA_BUFFER_DAYS=1, ORDER_PAYMENT_TTL_MIN=120, ON_PICKUP_MAX_TOTAL, ON_PICKUP_CONFIRM_TTL_H=24, PICKUP_WINDOW_PREPAID_DAYS=10, PICKUP_WINDOW_COD_DAYS=7, SUPPLIER_RETURN_DAYS=14, SUPPLIER_INVOICE_LAG_DAYS=1, HANDED_COMPLETE_DAYS=7, HANDOVER_QR_TTL_MIN=15, NO_SHOW_LIMIT=2, REMINDER_DAYS=3,6,9, COURIER_FEE_RUB |
| ЮKassa | YOOKASSA_SHOP_ID, YOOKASSA_SECRET_KEY, YOOKASSA_TAX_SYSTEM_CODE (код «УСН доход» — сверить), YOOKASSA_VAT_CODE (код «без НДС» — сверить), YOOKASSA_WEBHOOK_IP_ALLOWLIST, YOOKASSA_RETURN_URL |
| Боты и SMS | TG_SELLER_BOT_TOKEN, TG_SELLER_CHAT_ID, TG_CLIENT_BOT_TOKEN, TG_CLIENT_BOT_USERNAME, MAX_BOT_TOKEN, MAX_BOT_USERNAME, MAX_WEBHOOK_SECRET, SMS_PROVIDER, SMS_API_KEY, SMS_SENDER, SMS_MONTHLY_BUDGET_RUB, SMARTCAPTCHA_CLIENT_KEY, SMARTCAPTCHA_SERVER_KEY (ф2) |
| VIN (фаза 3) | VIN_PROVIDER=manual\|laximo\|acat\|partsapi, LAXIMO_LOGIN, LAXIMO_KEY, ACAT_TOKEN, PARTSAPI_KEY, VIN_MONTHLY_BUDGET_RUB |
| Юридическое | LEGAL_OFFER_VERSION, LEGAL_PRIVACY_VERSION, RKN_NOTICE_NUMBER, SELLER_REQUISITES_* |

Очереди BullMQ:

| Очередь | Задачи | Ретраи, идемпотентность |
|---|---|---|
| payments | обработка событий ЮKassa: перечитать объект GET /payments или /refunds, применить переход; сверка amount с orders.total | 5 попыток; jobId = `${event}:${object.id}` (у уведомлений ЮKassa нет id события) |
| receipts | чек зачёта POST /receipts по «Клиент пришёл», опрос до succeeded | тот же Idempotence-Key каждые 2 мин до 15 мин, затем алерт |
| rossko | recheck перед заказом, checkout (GetCheckout), orders-recovery (GetOrders после таймаута checkout), checkout-details (ежесуточно), poll-orders (ф2), settlements (ф4) | 3 попытки, пауза на 429; checkout — ровно один job на supplier_order |
| notify | отправка через адаптер, фолбэк SMS по allowlist | 5 попыток, backoff; jobId = `${order_event_id}:${channel}`, запись в notifications до отправки |
| reconciliation | каждые 10 мин: GET /payments по pending старше 10 мин, GET /refunds по незавершённым; ночью сверка за сутки | без ретраев |
| housekeeping | expire-unpaid (только после подтверждённого статуса), напоминания (оплата; подтверждение; выдача на 3/6/9 день; срок возврата поставщику за 3 дня; 10 дней на деньги; VIN-заявка без ответа 4 ч; needs_attention каждые 4 ч; awaiting_client_approval 24 ч; оплата счёта Rossko каждые 4 ч), утренний дайджест продавца (ф2), алерт при 80% SMS_MONTHLY_BUDGET_RUB, ретенция ПД (фото VIN 90 дней) | 1 попытка |
| dead-letter | упавшие задачи; алерт в чат продавцов; `/queues` в боте | ручной повтор |

Входящие точки: `POST /api/webhooks/yookassa` (allowlist IP из X-Forwarded-For только от Caddy, запись в webhook_events, 200 сразу, объект перечитывается по API), `POST /api/webhooks/max` (заголовок `X-Max-Bot-Api-Secret`, 200 сразу, дубли гасятся уникальностью update id), Telegram-боты в long polling из worker (без публичных эндпоинтов), `GET /o/<token>` — страница заказа по секретному токену ≥128 бит (noindex, `Referrer-Policy: no-referrer`; деструктивные действия подтверждаются последними 4 цифрами телефона или кодом в мессенджере), `GET /p/<token>` — подборка по VIN.

Защита (middleware через Redis, скользящее окно): поиск 20/мин и 300/сутки на IP, пустые и повторные запросы только из кэша; при 70% суточной квоты Rossko — ответы только из кэша и «попробуйте позже»; SMS не чаще 1 на номер за 10 мин и 3 в сутки, 5 на IP в сутки, повтор только кнопкой после паузы; honeypot и проверка Origin на всех формах; журнал превышений и алерт. Yandex SmartCaptcha (10 000/мес бесплатно) — второй рубеж при срабатывании порогов, внедряется в фазе 2 (чеклист п. 17). Мини-приложений и initData нет (зафиксировать в docs; при появлении — HMAC-SHA256 с ключом `WebAppData`).

## 2. Модель данных

Деньги — integer в копейках, время — timestamptz. Переходы статусов только через `transition()` в транзакции с блокировкой строки заказа.

| Таблица | Ключевые поля | Назначение |
|---|---|---|
| users | id, phone (unique E.164), name, email, no_show_count, created_at, anonymized_at | личность = телефон; аккаунта и пароля нет |
| document_versions | kind (offer, privacy, consent_pd, consent_marketing, return_memo), version, body_md, sha256, published_at | версии документов для заказов и согласий |
| consents | user_id, document_version_id, kind, given_at, channel, ip, user_agent, text_sha256, revoked_at | доказательство согласия по 152-ФЗ; заказ не создаётся без consent kind=pd |
| messenger_bindings | user_id, channel (telegram, max), external_user_id, chat_id, phone_confirmed_at, is_primary, blocked_at | куда слать; MAX-привязка из bot_started |
| link_tokens | token, user_id, order_id, expires_at, used_at | одноразовый payload deep link (≤64 символов TG, ≤128 MAX) |
| staff | name, role (owner, seller), tg_user_id, max_user_id, is_active | Максим и Лёша; права кнопок |
| settings | key, value jsonb, updated_by | наценки по диапазонам, допуск, склады Оренбурга, реквизиты Rossko, флаг rossko_prepay_invoice, часы, слоты, лимиты |
| excluded_groups | pattern, reason, active | фильтр маркируемых групп по товарной группе или названию |
| carts, cart_items | cart: user_id, anon_token, status, proposal_token, seller_note, vin_request_id; item: brand, article, name, qty, stock_id, is_local, eta_date, price_supplier, price_client, markup_pct, offer_snapshot, fetched_at | корзина клиента или подборка продавца; снимок предложения |
| orders | number (DT-000123), user_id, access_token, status, payment_scheme (prepay, pay_on_handover), fulfillment (pickup, courier), address jsonb, subtotal, courier_fee, total, items_hash, promised_date, pickup_code, offer_version_id, attention_reason, таймстемпы (confirmed/paid/ordered/received/handed/completed/cancelled), expires_at, supplier_return_deadline_at | заказ и таймеры |
| order_items | order_id, brand, article, name, qty, stock_id, is_local, price_supplier_at_order, price_client, markup_pct, eta_date, offer_snapshot, state (pending, ordered, failed, replaced, arrived, handed, return_requested, returned, refund_pending, refunded), replaced_by_item_id, supplier_item_error, marking_code (nullable), refunded_amount | состояние по позиции: частичные возвраты, частичный приезд, замены |
| order_events | order_id, type, from_status, to_status, actor_type (client, staff, system, webhook), actor_id, payload, created_at | полный журнал: таймлайн клиента, споры, акт Лёше |
| payments | order_id, provider, provider_payment_id (unique), kind (prepayment, full), status, amount, method, idempotence_key (unique), confirmation_url, expires_at, raw | один заказ — один успешный платёж |
| receipts | order_id, payment_id, refund_id, kind (prepayment, full, offset, refund_prepayment, refund_full, correction), provider_receipt_id, idempotence_key, status, fiscal_document_number, request, response | чеки 54-ФЗ |
| refunds | order_id, payment_id, provider_refund_id, amount, items jsonb, reason (refusal, not_fit, defect, supplier_fail, no_show, delay), status, idempotence_key (unique), requested_at, deadline_at (от даты требования клиента +10 дней), succeeded_at | полные и частичные возвраты |
| supplier_orders, supplier_order_items | attempt_no, status (sending, created, failed), rossko_order_ids, request, response, item_errors, delivery_cost, status_code, upd_s3_key (УПД из S3); связь с order_items через supplier_order_items | запись создаётся до GetCheckout — защита от двойной отправки; в ф4 — объединение заказов дня |
| supplier_returns | order_item_id, kind (return, claim), status (requested, accepted, rejected, refunded), amount_expected, amount_received, note | возврат/рекламация поставщику; на статус клиента не влияет |
| stock_items (минимум с 1B) | order_item_id, cost, reason, listed_price, written_off_at | детали, которые Rossko не принял обратно; «Продать со склада» — ф2 |
| claims | order_id, order_item_id, kind (refusal, not_fit, defect, delay), opened_at, deadline_at (+10 дней), decision (refund, replace, reject) + текст ответа, compensation_amount, return_accepted_at, decided_by, photos, closed_at | обращения, включая брак после completed |
| vin_requests | user_id, phone, vin, car_text, need_text, photos (S3, автоудаление 90 дней), status (new, in_work, offered, converted, closed), assigned_staff_id, proposal_cart_id, resolver | заявка на подбор + статистика для решения о каталоге |
| vehicles (ф3) | vin (unique), decoded jsonb, provider, decoded_at | кэш расшифровки VIN |
| install_bookings | order_id, user_id, slot_at, status | запись на установку; **без поля цены** |
| order_photos | order_id, kind (packaging, handover, return), s3_key, by_staff_id | фото (необязательные) |
| chat_messages (ф2) | user_id, order_id, direction, channel, text, staff_id | вопрос из бота и ответ |
| notifications | user_id/staff_id, channel, template, payload, status, fallback_reason, attempts, error, sent_at | судьба каждого сообщения |
| webhook_events | source, external_id (= object.id), event_type, payload, received_at, processed_at, result; unique(source, external_id, event_type) | идемпотентность входящих |
| api_calls | source, method, duration_ms, ok, error, cost_rub | лимиты Rossko, стоимость VIN |
| search_log | query, brand, article, results_count, from_cache, latency_ms | спрос и нагрузка |

Инварианты, закрытые тестами в `packages/domain`: handed только при receipts kind offset/full в статусе succeeded; сумма refunds ≤ payments.amount; у каждого refund есть чек возврата с признаком расчёта исходного чека; заказ не создаётся без consent pd; позиция из excluded_groups не попадает в корзину; orders.total = сумма позиций + courier_fee; в чеке позиции только `commodity` и не более одной строки `service` (доставка) — установка в чеках невозможна; `payment_mode=full_payment` только в чеках kind full/offset/refund_full, handed только после их succeeded; refund по claim (кроме kind=delay) создаётся только при claims.return_accepted_at ≠ null или override владельца с причиной в order_events; частичный возврат не меняет статус заказа; частичная выдача с несколькими чеками зачёта запрещена.

## 3. Машина состояний заказа и платежа

Статусы: draft, awaiting_payment (prepay), awaiting_confirmation (pay_on_handover), confirmed, ordering, awaiting_supplier_invoice (если Rossko отгружает только после оплаты счёта), ordered_at_supplier, needs_attention, awaiting_client_approval, ready, out_for_delivery (ф2), awaiting_handover_payment, handed, completed, cancelled, refund_pending, refunded. Позиции имеют собственный state; заказ в ready, когда все живые позиции arrived. Платёж: pending → succeeded | canceled. Возврат: pending → succeeded | failed (failed — алерт, 10-дневный срок не останавливается).

| Состояние | Событие | Новое | Кто | Чек | Уведомления |
|---|---|---|---|---|---|
| draft | оформление: все позиции is_local, total ≤ ON_PICKUP_MAX_TOTAL, no_show_count < 2 | awaiting_confirmation | клиент | — | «подтвердите заказ» кнопкой в мессенджере или SMS-ссылкой |
| draft | оформление: иначе (смешанную корзину можно разделить кнопкой) | awaiting_payment | клиент | — | ссылка на оплату, срок 120 мин |
| draft | POST /checkout: ожидаемый total и items_hash не совпали с пересчётом свежим GetSearch (мимо кэша) | draft, 409 + DiffBanner | система | — | — |
| awaiting_payment | payment.succeeded, подтверждён GET /payments, amount = orders.total | confirmed | вебхук / reconciliation | предоплата 100% (full_prepayment) в составе платежа | клиенту: «оплачено, чек отправлен, ждём к <дата>»; продавцу: карточка |
| awaiting_payment | payment.succeeded, но amount ≠ total | needs_attention (amount_mismatch) | система | — | Максиму |
| awaiting_payment | TTL истёк и GET /payments = canceled/expired, либо payment.canceled | cancelled | система | — | «ссылка истекла» |
| cancelled | payment.succeeded (поздняя оплата) | refund_pending | система | возврат full_prepayment | клиенту |
| awaiting_confirmation | «Подтверждаю» | confirmed | клиент | — | продавцу: карточка |
| awaiting_confirmation | 24 ч без ответа | cancelled | система | — | клиенту |
| confirmed | «Проверить и заказать»: recheck GetSearch мимо кэша, рост закупки ≤ допуска | ordering → ordered_at_supplier | продавец, воркер | — | «деталь заказана, ждём к <дата>» |
| ordering | GetCheckout успешен, но settings.rossko_prepay_invoice=true (отгрузка только после оплаты счёта — по ответу менеджера, п. 2 раздела 7) | awaiting_supplier_invoice | система | — | Максиму: «Оплатить счёт Rossko № … на сумму …», напоминание каждые 4 ч |
| awaiting_supplier_invoice | «Счёт оплачен» (номер и дата платёжного поручения в order_events) | ordered_at_supplier | Максим | — | клиенту: «деталь заказана, ждём к <дата>» |
| confirmed / ordering | recheck: рост выше допуска, нет наличия, itemErrors после GetCheckout | needs_attention | система | — | продавцу: карточка проблемы с альтернативами из кроссов и маржой |
| ordered_at_supplier | «Проблема с позицией» (отказ поставщика, приехало не то, повреждено, сдвиг срока); ф2 — статус отказа из GetOrders | needs_attention | продавец / система | — | продавцу |
| needs_attention | «Заказать всё равно» (маржа ≥ MARGIN_FLOOR_PCT) | ordered_at_supplier | продавец | — | — |
| needs_attention | «Аналог по цене клиента» или «Новый срок» | awaiting_client_approval | продавец | — | клиенту: кнопки «Согласен» / «Вернуть деньги» в мессенджере или на /o/<token> (SMS-шаблон «нужно ваше решение» в allowlist), таймаут 24 ч с напоминанием; если уведомление skipped (нет канала) — таймер не запускается, заказ остаётся в needs_attention для звонка продавца |
| awaiting_client_approval | «Согласен» | ordered_at_supplier (позиция replaced → новая) | клиент | — | продавцу |
| awaiting_client_approval | «Вернуть деньги» или молчание 24 ч | весь заказ → refund_pending; одна позиция → ordered_at_supplier по остальным, позиция refund_pending | клиент / система | возврат full_prepayment (весь или на строку) | клиенту |
| needs_attention | «Отменить позицию» (prepay) | ordered_at_supplier по остальным, позиция refund_pending → refunded по refund.succeeded | продавец | частичный возврат full_prepayment на строку | «деньги за позицию вернутся до 10 дней» |
| needs_attention | «Отменить заказ и вернуть деньги» | refund_pending | продавец | возврат full_prepayment | клиенту |
| ordered_at_supplier | «Приехало» по позиции (+ фото необязательно); при задержке части — клиенту «Жду до <дата>» / «Отменить позицию» | позиция arrived; заказ ready, когда все живые позиции arrived | продавец | — | адрес, часы, код выдачи, фото, «Записаться на установку»; напоминания 3/6/9 день (9-й — со ссылкой на пункт оферты о неявке) |
| ordered_at_supplier | повреждено при приёмке | supplier_returns kind=claim + повторный заказ позиции (replaced_by_item_id) | продавец | — | клиенту: новый срок |
| ready (prepay) | «Клиент пришёл» → POST /receipts (наименование фактически переданной позиции) → succeeded → только потом «Выдал» | handed | продавец, очередь receipts | полный расчёт с зачётом аванса (settlements prepayment) | чек и памятка «7 дней на отказ» |
| ready (pay_on_handover) | «Клиент пришёл» → «Выставить оплату» (QR с экрана продавца, TTL 15 мин, **ссылка в мессенджер не уходит**) → payment.succeeded → «Выдал» | awaiting_handover_payment → handed | продавец, вебхук | полный расчёт в составе платежа | чек |
| ready (pay_on_handover) | «Оплатить заранее» (клиент хочет удалённо) | переводится в схему prepay: awaiting_payment | клиент | далее как prepay | ссылка на оплату |
| awaiting_handover_payment | payment.canceled или TTL (HANDOVER_QR_TTL_MIN) | ready | система | — | — |
| ready (ф2, курьер; только prepay) | «Передал курьеру» | out_for_delivery | продавец | — | клиенту: «курьер едет», интервал |
| out_for_delivery | «Клиент получил» → POST /receipts → succeeded | handed | курьер или продавец с телефона, очередь receipts | полный расчёт с зачётом аванса | чек и памятка |
| out_for_delivery | клиент не принял / не открыл | ready | курьер или продавец | — | клиенту; продавцу |
| ready | хранение истекло: prepay 10 дней, pay_on_handover 7 дней | prepay → refund_pending (**обязательно**, удержание только фактического courier_fee, если прямо в оферте); pay_on_handover → cancelled | система | prepay: возврат full_prepayment | клиенту; no_show_count+1; продавцу: задача «вернуть Rossko до <supplier_return_deadline_at>» |
| handed | 7 дней без обращений | completed | система | — | «как деталь?» |
| handed, completed | «Претензия» (отказ 7 дней; брак — в пределах гарантии, ст. 18–19) | claims open; decision refund → refund_pending только после кнопки продавца «Принял возврат» (order_photos kind=return обязательно) либо override Максима с причиной в order_events; replace → новый заказ позиции; reject → мотивированный ответ в 10 дней | клиент, продавец, Максим | возврат full_payment (+ строка доставки при полном) | клиенту: порядок действий; Максиму: дедлайн 10 дней |
| любой после confirmed до handed | «Отказ клиента до передачи» (ст. 26.1): кнопка на /o/<token> с подтверждением или продавец | prepay → refund_pending, pay_on_handover (денег ещё нет) → cancelled; продавцу задача «отменить у Rossko через ЛК/менеджера до отгрузки», иначе supplier_returns / stock_items | клиент / продавец | возврат full_prepayment | клиенту |
| ordered_at_supplier | order.eta_changed (сдвиг срока) | без смены статуса; claims kind=delay при превышении | система | — | клиенту: «Жду до <дата>» / «Вернуть деньги»; продавцу подсказка о 0,5%/день |
| refund_pending | refund.succeeded, подтверждён GET /refunds | refunded | вебхук / reconciliation | чек возврата формирует ЮKassa | «деньги отправлены» |

Правила денег: доплата не запрашивается никогда (рост в допуске поглощается, падение остаётся у продавца, выше допуска — альтернативы или возврат); цена фиксируется в orders/order_items в момент успешного POST /checkout, сумма платежа берётся только из orders.total; наличные на точке не принимаются; выдача без чека невозможна (при недоступности ЮKassa > 15 мин — «приходите позже»; исключение только с записью в order_events и чеком коррекции, если он доступен в «Чеках от ЮKassa», иначе без исключений); чек возврата повторяет позиции и признак расчёта исходного чека; неустойка по ст. 23.1 и компенсация убытков по ст. 18 — платёжным поручением с РС без чека (позицию ФНС сверить), событие в order_events. Сроки: promised_date = max(eta_date) + ETA_BUFFER_DAYS (+ SUPPLIER_INVOICE_LAG_DAYS при rossko_prepay_invoice=true), показывается датой («к чт 9 октября»); supplier_return_deadline_at = received_at + SUPPLIER_RETURN_DAYS (у менеджера Rossko письменно уточнить, от какой даты идут 14 дней), напоминание за 3 дня. Клиент, пришедший после возврата денег, оформляет новый заказ. Частичный возврат не меняет статус заказа (он остаётся ordered_at_supplier/ready по живым позициям), refund_pending/refunded — только для возврата всего заказа; позиция переходит в refunded только по refund.succeeded. Курьерская доставка (ф2) доступна только по схеме prepay: при выборе курьера заказ pay_on_handover переводится в предоплату, чек зачёта пробивается по кнопке «Клиент получил» с телефона курьера или продавца.

## 4. Интеграции

### Rossko SOAP v2.1

Клиент на npm `soap`, WSDL `${ROSSKO_WSDL_BASE}/${Method}?wsdl`, кэш при старте. Все вызовы через лимитер в Redis (скользящее окно ROSSKO_RPM_LIMIT, суточный счётчик по МСК с предохранителем на 70%), таймаут 15 с, запись в api_calls. До маппинга — `scripts/rossko-smoke.ts` на ключах Максима по 5–10 артикулам Лёши, сырые ответы как фикстуры.

| Метод | Когда | Кэш | Сверить по документации и фикстурам |
|---|---|---|---|
| GetSearch | поиск; пересчёт корзины при открытии и в POST /checkout (мимо кэша); recheck перед GetCheckout; подборка по VIN | Redis 15 мин по brand+article | имена полей склада/срока/остатка/кратности/типа предложения, где кроссы и как помечен точный артикул, товарная группа, обязательность delivery_id/address_id, признак склада Оренбурга |
| GetCheckoutDetails | при настройке и раз в сутки | settings | id доставки на адрес Сервис56, id оплаты, порог бесплатной доставки, стоимость |
| GetCheckout | только из воркера после кнопки; supplier_orders status=sending до вызова; при таймауте — сначала GetOrders | — | состав полей позиции, комментарий с нашим номером, структура orderIds/items/itemErrors, тестовый режим (спросить менеджера), отмена заказа через API, нужна ли оплата счёта до отгрузки (от ответа зависит статус awaiting_supplier_invoice) |
| GetOrders | 1B: разовый вызов для восстановления после таймаута GetCheckout; ф2: polling каждые 20 мин по открытым заказам, ≤20 за вызов | supplier_orders | 16 кодов: «готов к выдаче», «отказ поставщика», цепочка возврата 32→36 |
| GetSettlements (ф4) | утром | — | баланс, кредитный лимит |

Цена: `price(markupRules, priceSupplier, isLocal)` — таблица наценок по диапазонам закупочной цены и признаку локальный/под заказ (дефолт 28%), `ceil` до рубля, тесты; MIN_ORDER_TOTAL и MIN_MARGIN_RUB с отказом оформления ниже порога («добавьте позицию»); delivery_cost из GetCheckout учитывается в отчёте фактической маржи. Маркировка: фильтр по товарной группе из ответа, иначе по ключевым словам (шин, масл, антифриз, тормозн жидк) + ручной blocklist; такие позиции показываются с пометкой «не продаём онлайн, спросите в сервисе».

### ЮKassa (API v3, Basic auth) и чеки

`PaymentProvider`: createPayment, getPayment, createRefund, getRefund, parseWebhook. `ReceiptProvider`: createOffsetReceipt, getReceipt, (createCorrectionReceipt). Первая реализация обоих — ЮKassa; запасная для чеков — облачная ККТ (АТОЛ Онлайн / Ferma, ориентир 2–3 тыс ₽/мес).

1. Платёж: POST /payments, Idempotence-Key = payments.idempotence_key (новый ключ только при явном новом платеже), capture=true, confirmation redirect на /o/<token> (на точке — type qr, если доступен), description «Заказ DT-000123», metadata.order_id, receipt: customer.phone, items («Бренд Артикул Название» ≤128 символов, quantity, amount за единицу с проверкой сумма строк = amount, vat_code «без НДС», payment_subject commodity; доставка отдельной строкой service), payment_mode full_prepayment (prepay) или full_payment (на точке), tax_system_code «УСН доход». Сверить: коды vat_code/tax_system_code, confirmation qr и СБП, срок жизни платежа, формат phone, лимит metadata.
2. Вебхуки payment.succeeded, payment.canceled, refund.succeeded → запись, 200, воркер перечитывает объект и доверяет только ему. Сверить: список IP, срок ретраев, доставка уведомлений тестового магазина.
3. Чек зачёта: POST /receipts {type payment, payment_id, send true, customer, items с payment_mode full_payment, settlements [{type prepayment, amount}], tax_system_code} → GET /receipts/{id} до succeeded. **Гейт фазы 0:** письменный ответ ЮKassa, доступен ли POST /receipts с settlements prepayment в «Чеках от ЮKassa», как тарифицируется второй чек, оформлена ли касса на ИНН ИП (не агентская модель — от этого зависит, попадает ли доход в АУСН через ОФД). Если недоступно или дорого — план Б: ЮKassa только платёжка (receipt в платёж не передаётся) + своя облачная ККТ за `ReceiptProvider`; порог оборота, с которого своя ККТ дешевле, — в `docs/budget.md`.
4. Возврат: POST /refunds {payment_id, amount, receipt с возвращаемыми позициями и тем же payment_mode, что в исходном чеке}; частичный по строкам; при полном — включая строку доставки. Сверить: чек в теле возврата, срок зачисления, возвраты по СБП.
5. Reconciliation: GET /payments/{id} и /refunds/{id} по pending старше 10 мин; expire-unpaid только после подтверждённого canceled.

### Уведомления MAX + Telegram + SMS

`Notifier.send(recipient, template, data)`: канал по messenger_bindings (MAX, если привязан, иначе Telegram, иначе SMS по allowlist шаблонов: подтверждение pay_on_handover, ссылка на подборку, «нужно ваше решение по заказу» (ссылка на /o/<token>), «приехало», «деньги отправлены»; остальные без мессенджера — status=skipped с fallback_reason, и ожидающие ответа клиента переходы при skipped не запускают таймер). Шаблоны — функции в `packages/notify/templates`, возвращают текст и абстрактные кнопки; драйверы переводят в формат канала. **Минимизация ПД в мессенджерах** (Telegram — иностранный сервис): в сообщениях только номер заказа, статус, бренд, артикул; в карточке продавца телефон и адрес маскируются (последние 4 цифры) с кнопкой «Открыть в админке»; политика ПД перечисляет Telegram и MAX как получателей; в уведомлении РКН — трансграничная передача либо письменное подтверждение юриста, что при такой минимизации передачи ПД нет. Привязка описывается как подписка на уведомления, не авторизация; критичные действия (отмена, претензия) дублируются через /o/<token> с подтверждением.

Привязка: /o/<token> создаёт link_token и показывает «Статусы в MAX» / «в Telegram» с deep link `?start=<token>`; бот связывает external_user_id с заказом и просит request_contact, телефон сверяется с users.phone. Telegram — grammY, long polling, callback_data `a:<action>:<order_id>:<nonce>` ≤64 байт, карточка редактируется после нажатия, команды только для staff. MAX — `@maxhub/max-bot-api` с пином версии, webhook на 443 через Caddy, user_id из bot_started, inline-кнопки, идемпотентность по update id; сверить формат deep link/payload, request_contact, лимиты (429 → backoff), версию схемы. SMS — SMS Aero или smsc.ru (договор на ИП и регистрация имени отправителя — фаза 0, занимает дни), SMS_MONTHLY_BUDGET_RUB с алертом на 80%.

### VIN-слой

`VinResolver.resolve(vin, need) → {vehicle, candidates[]}`. Фаза 1C — `ManualResolver`: форма (VIN 17 символов без I/O/Q, описание, до 3 фото, телефон, канал) → vin_request и карточка в боте продавца; Лёша отвечает строками «БРЕНД АРТИКУЛ КОЛ-ВО», система проверяет каждую через GetSearch и показывает превью с ценами и датами; клиент получает /p/<token> в свой канал или SMS и оплачивает как обычный заказ; без ответа 4 ч — напоминание. Фаза 3 — `LaximoResolver` (REST Guayaquil v3 или Laximo.Search «<деталь> <VIN>») или `AcatResolver`: VIN → автомобиль → категория → OEM → GetSearch с кроссами; кэш vehicles, стоимость в api_calls, при исчерпании VIN_MONTHLY_BUDGET_RUB — автоматически ручной подбор. Правило бюджета: Laximo только при тарифе до ~5 тыс ₽/мес, иначе acat или PartsAPI.

## 5. UX сайта и ботов

| Страница | Ключевые компоненты |
|---|---|
| / | SearchBar (артикул, бренд — честно, без поиска по названию), VinCta «Не знаете артикул? Пришлите VIN — подберём бесплатно», HowItWorks с датами, TrustBlock (фото точки Сервис56, адрес, часы, реквизиты ИП) |
| /search | OfferRow: бренд, артикул, название, цена, бейдж «В Оренбурге — оплата при получении» / «Под заказ — предоплата», срок датой, фильтр «только в городе», EmptyState → VIN-подбор |
| /cart | пересчёт при открытии, DiffBanner «цена изменилась на +120 ₽», PaymentModeNotice с «Разделить на два заказа» |
| /checkout | один экран: телефон, имя, канал статусов, самовывоз (ф2 — курьер с адресом), способ оплаты определяется автоматически и объясняется словами, отдельные чекбоксы оферты и согласия на ПД, honeypot |
| /o/<token> | таймлайн из order_events человеческими фразами, дата/адрес/код выдачи, фото упаковки, кнопки «Статусы в MAX/Telegram», «Записаться на установку» (с текстом «Установка — услуга Сервис56 (ИП …), оплачивается в сервисе по его чеку»), «Претензия/возврат», «Отменить» (с подтверждением) |
| /vin, /p/<token> | форма заявки; подборка с комментарием мастера и «Оформить и оплатить» |
| /docs/offer, /docs/privacy, /docs/consent, /returns, /about | реквизиты, документы с версиями, правила возврата человеческим языком |
| /admin (Basic auth) | список заказов и заявок, карточка с теми же кнопками, что в боте, settings, обезличивание клиента одной командой; конструктор подборки и экспорт CSV — ф2 |

Сценарий клиента: ищет артикул или присылает VIN → видит дату и способ оплаты → оформляет за один экран → оплачивает или подтверждает → привязывает мессенджер одной кнопкой → получает «заказано», «приехало» с фото и кодом, «выдано, чек отправлен», «как деталь?» → при проблеме жмёт «Претензия». Сценарий продавца в Telegram-боте: карточка нового заказа («Проверить и заказать», «Отменить и вернуть деньги»); карточка проблемы с кнопками по позиции («Аналог», «Новый срок», «Отменить позицию», «Связаться»); «Проблема с позицией»; «Приехало» по позициям; «Клиент пришёл» → чек → «Выдал»; «Выставить оплату»; «Клиент не пришёл»; VIN-заявки строками; утренний дайджест и `/queues`.

Позиционирование против Rossko-розницы, Emex, Autodoc: не ассортимент и не цена, а «запчасти от людей, которые их же и поставят». Отличия, дешёвые в реализации: продавец — ИП с реквизитами в футере; дата прибытия вместо «3–5 дней»; оплата при получении для местного склада; возврат 7 дней без удержаний при самовывозе с печатной памяткой; фото упаковки; бесплатный подбор живым мастером с правилом «подобрали мы и не подошло — вернём деньги»; запись на установку в тот же день.

## 6. Этапы реализации

Оценки — рабочие дни одного разработчика с Claude Code, впервые на TypeScript/Drizzle/BullMQ. Первый реальный оплаченный заказ — конец фазы 1C: 8 + 5 + 14 + 7 = 34-й рабочий день (ориентир — конец ноября 2026), если ЮKassa и Rossko не задержат.

### Фаза 0. Внешние действия, каркас, фикстуры, учебный спайк (8 дней)

Цель: запустить все длинные внешние процессы, поднять задеплоенный каркас с документами (для модерации ЮKassa), пройти спайк «платёж → вебхук → чек зачёта» на тестовом магазине. Код: монорепо pnpm, compose с шестью сервисами, Caddy с TLS, CI (typecheck, vitest, сборка образов в ghcr.io), deploy-скрипт, Drizzle-схема всех таблиц фазы 1 с миграциями и сидами, сайт-заглушка с реквизитами/офертой/политикой/согласием (без форм сбора ПД до номера РКН), бот продавца с `/ping`, `/api/health` + heartbeat worker, бэкап pg_dump в S3 с проверкой восстановления, `scripts/rossko-smoke.ts`, `packages/rossko` на фикстурах (клиент, лимитер, кэш), `price()` по диапазонам и фильтр групп в domain, страницы / и /search с middleware-лимитами и search_log, спайк: тестовый платёж, вебхук на stage, POST /receipts с settlements на реальном API (3–5 дней). Руками: чеклист раздела 7, п. 1–9. **Гейты окончания фазы:** письменный ответ ЮKassa по чеку зачёта и модели кассы (иначе план Б с облачной ККТ); результат проверки маркировки по группам ядра ассортимента зафиксирован в `docs/external.md`. Приёмка: HTTPS, health 200, бэкап восстановлен, все заявки поданы с датами, фикстуры Rossko записаны или помечены «ждём ключи», поиск работает на фикстурах или живых ключах, спайк пройден.

### Фаза 1A. Корзина, оформление, согласия (5 дней)

Код: маппинг складов и excluded_groups в `packages/rossko`, eta_date в domain, honeypot на формах, страницы /cart и /checkout с проверкой total+items_hash и 409, document_versions и consents, разделение смешанной корзины, draft → awaiting_payment/awaiting_confirmation без платежа, /o/<token>. Руками: сравнение 20–30 позиций между аккаунтами Максима и Лёши и розницей Rossko/Emex/Autodoc; ответы менеджера Rossko в docs. Приёмка: по 10 реальным артикулам цена = ceil(опт × наценка), бейдж склада и дата верны, стоп-группа не добавляется, заказ без consent невозможен, 21-й поиск за минуту с одного IP получает 429, страницы на телефоне без горизонтального скролла.

### Фаза 1B. Деньги, чеки, машина состояний, бот продавца (14 дней)

Код: `YooKassaProvider` + `YooKassaReceipts` за интерфейсами, очереди payments/receipts/rossko/notify/reconciliation/housekeeping/dead-letter, минимальный `packages/notify` с драйвером sms (allowlist: подтверждение pay_on_handover, «нужно ваше решение», ссылка на подборку), кнопки «Согласен» / «Вернуть деньги» на /o/<token>, `transition()` с полной таблицей переходов и юнит-тестами (включая awaiting_client_approval, частичный приезд, invariants чеков), подтверждение pay_on_handover по SMS-ссылке, recheck и GetCheckout с защитой от двойной отправки, needs_attention с кнопками по позициям и частичными возвратами, «Проблема с позицией», «Клиент пришёл» → чек → «Выдал», «Выставить оплату» только после «Клиент пришёл», stock_items минимально, awaiting_supplier_invoice (если флаг включён), мини-админка (список, карточка). Claims — в 1C, экспорт CSV — в фазе 2. Руками: вебхуки на stage, получить ответы банка и SMS-провайдера по заявкам фазы 0. Приёмка: на stage prepay-заказ даёт два чека, pay_on_handover — один, частичный возврат по строке — чек только на строку, дубль вебхука не создаёт второго перехода, пропуск вебхука закрывает reconciliation, «Выдал» недоступна без чека succeeded, остановка worker на 10 минут не теряет и не дублирует задачи, оплата уже отменённого заказа уходит в refund_pending.

### Фаза 1C. Уведомления, ручной VIN, выдача, претензии, первый заказ (7 дней)

Код: драйвер telegram в `packages/notify` и шаблоны на все переходы, клиентский Telegram-бот (deep link, request_contact, статусы, «Записаться на установку», «Претензия»), шаблоны на все переходы с минимизацией ПД, фото упаковки и код выдачи, vin_requests с ответом строками и превью, /p/<token>, install_bookings, напоминания 3/6/9, claims с decision и дедлайнами. Памятка и акт выдачи — два статических PDF-шаблона в репозитории (без генерации). Руками: договор с Лёшей подписан, доверенность на приёмку выдана, памятки распечатаны, уголок потребителя на точке, боевой магазин ЮKassa, первый боевой заказ — Лёша покупает реальную дешёвую позицию **как обычный клиент через сайт** (а не покупка на ИП Максима для нужд сервиса), затем знакомый клиент. Приёмка: заказ оплачен, деталь выдана, оба чека у клиента и в ЛК ЮKassa, чек проверен в приложении ФНС, VIN-заявка прошла до оплаты, клиент без Telegram получил SMS.

### Фаза 2. Первые 20–30 заказов без ручных дыр (10 дней)

Код: MAX-драйвер (webhook, bot_started, deep link, request_contact, идемпотентность по update id, сертификат Минцифры), GetOrders polling с маппингом статусов и подтверждением продавца, order.eta_changed с кнопками клиенту, курьер по Оренбургу (адрес, строка service в чеке, ready → out_for_delivery → handed, чек зачёта по «Клиент получил» с телефона курьера; при выборе курьера pay_on_handover недоступен — заказ переводится в prepay), Yandex SmartCaptcha как второй рубеж, supplier_returns с таймером, «Продать со склада», chat_messages, утренний дайджест, обезличивание ПД по запросу и ретенция фото, конструктор подборки и экспорт CSV для акта и сверки АУСН, Uptime Kuma. Руками: верификация MAX завершена, бот MAX создан, первый акт с Лёшей, первая сверка чеков с ЛК АУСН до 7-го. Приёмка: клиент с MAX получает уведомления в MAX, повтор вебхука не дублирует сообщения, статусы Rossko видны без ручного ввода, курьерский заказ проходит до handed с чеком, акт совпадает с order_events, восстановление из бэкапа < 30 минут.

### Фаза 3. VIN-каталог как второй резолвер (10 дней)

Код: `LaximoResolver` или `AcatResolver`, vehicles-кэш, страницы подбора с выбором категории (noindex), кнопка «Не нашли — подберём вручную», бюджетный лимит, статистика конверсии заявок. Руками: договор и ключи каталога, сверка тарифа с фактическим числом заявок за фазы 1–2. Приёмка: для 20 реальных VIN каталог даёт верные OEM минимум по трём ходовым категориям, расхождения разобраны с Лёшей, стоимость в бюджете.

### Фаза 4. Автоматизация и устойчивость (8 дней)

Код: автозаказ без кнопки для позиций без VIN-подбора и с ценой в допуске (флаг в settings, причина в order_events), объединение заказов дня через supplier_order_items, GetSettlements и алерт по балансу, бот продавца в MAX, отчёт фактической наценки за квартал, GlitchTip по желанию, резервный поставщик за `SupplierClient` (Berg или Autoeuro) только если itemErrors заметны. Руками: ежеквартальный пересмотр маркируемых групп (решение об АУСН 20% — п. 15 чеклиста, к фазе не привязано). Приёмка: автозаказ отработал 10 заказов подряд без вмешательства, отчёт сходится с ЛК ЮKassa и ЛК АУСН.

## 7. Внешние и юридические шаги вне кода

| № | Действие | Фаза | Кто |
|---|---|---|---|
| 1 | Р24001 на ОКВЭД 45.32.21 и 47.91.2 (+45.31.1 при опте); проверить банк РС в реестре АУСН; спросить банк о разметке выплат ЮKassa | 0, день 1 | Максим |
| 2 | Оптовый аккаунт Rossko на ИП Максима; письменно менеджеру: ключи API, условия возврата и рекламаций (от какой даты 14 дней), доставка на Сервис56 и порог бесплатной, id складов Оренбурга, тестовый режим и отмена через API, оплата по счёту (до или после отгрузки, депозит, кредитный лимит, минимальная сумма), формат первички (УПД, ЭДО Диадок/СБИС) | 0, день 1 | Максим и Лёша |
| 3 | Бренд, домен .ru на ИП Максима с ЕСИА, VPS в РФ, S3, DNS | 0, день 1 | Максим |
| 4 | Два бота в @BotFather, закрытый чат продавцов; заявка на верификацию в business.max.ru (нужна к фазе 2); после одобрения — создание бота MAX через MasterBot (ф2) | 0, день 1 | Максим |
| 5 | **Проверка маркировки** на честныйзнак.рф и в актуальной редакции постановления об эксперименте по группам: фильтры, свечи, колодки, диски, стёкла, аккумуляторы; результат с датой в `docs/external.md`; если обязательна — в excluded_groups до запуска или передача кодов в чеке (ФФД 1.2, тег 1163) + ЭДО с Rossko; повтор ежеквартально | 0, день 1 | Максим |
| 6 | Договор с SMS-провайдером на ИП, регистрация имени отправителя, тестовый баланс | 0, день 1–2 | Максим |
| 7 | Уведомление в РКН через Госуслуги (цели, категории ПД, сервер в РФ, меры, получатели: ЮKassa, хостинг, Лёша по поручению, VIN-провайдер, мессенджеры; трансграничная передача через Telegram или подтверждение юриста); пакет внутренних документов оператора (приказ об ответственном, положение, перечень ПД, модель угроз); проверить применимость запрета авторизации через иностранные сервисы | 0, день 2–3 | Максим |
| 8 | Документы: оферта (цена фиксируется в заказе, доплаты нет, срок — дата, самовывоз/курьер, отказ 7 дней без удержаний при самовывозе, удержание только фактической доставки, хранение 10 дней и неявка как отказ по ст. 496 ГК, гарантия производителя / ст. 19, претензии через бот, возврат денег 10 дней), политика ПД со сроками хранения (users/consents — 5 лет с последнего заказа, orders/receipts/refunds — 5 лет, фото VIN — 90 дней) и получателями, отдельные согласия на ПД (с упоминанием фото) и маркетинг, памятка о возврате, акт выдачи; юристу на 1–2 часа; runbook «инцидент с ПД» (РКН 24/72 ч) | 0, день 2–5 | Максим |
| 9 | Заявка в ЮKassa на ИП: карты, СБП, «Чеки от ЮKassa», «УСН доходы», «без НДС»; письменно: POST /receipts с settlements prepayment, тариф второго чека, касса на ИНН ИП или агентская модель, IP вебхуков, чек коррекции, промо-ставка, поддержка ФФД 1.2 и тега 1163 (коды маркировки, разрешительный режим) на случай обязательной маркировки по п. 5 | 0, после п. 3 и 8 — **гейт** | Максим |
| 10 | Сравнение цен 20–30 ходовых позиций: аккаунт Максима, Лёши, розница Rossko, Emex, Autodoc; при разрыве — прайс-колонка или наценки по группам | 1A | Лёша |
| 11 | Договор возмездных услуг ИП↔ИП с Лёшей: ставки за операции (приёмка, хранение, выдача, приём возврата, подбор, диагностика по претензии) + плата с базой «стоимость обработанных заказов», откалиброванная под ~50% маржи, **без слов «доля прибыли»**; запрет принимать деньги за товар; поручение на обработку ПД; приёмка ТМЦ по доверенности; акт ежемесячно из системы; оплата безналом «по договору № и акту №». Доверенность от ИП Максима на Лёшу на получение ТМЦ от Rossko (срок год, копия у Лёши) | до 1C | оба |
| 12 | Боевой магазин ЮKassa, вебхуки на домен, первый боевой заказ (Лёша как клиент через сайт), чеки в приложении ФНС; УПД от Rossko хранить в S3 с привязкой к supplier_orders | 1C | Максим |
| 13 | Памятки и акты распечатаны, уголок потребителя (реквизиты ИП, часы, памятка), место хранения, фотофиксация | 1C | Лёша |
| 14 | Ежемесячно: акт с Лёшей до 3-го, до 5-го доходы мимо ККТ (если есть), до 7-го разметка выплат ЮKassa и возвратов Rossko «не учитывать», сверка чеков минус возвраты с ЛК АУСН; уплата до 25-го | с фазы 2 | Максим |
| 15 | Решение об АУСН 20%: до 20.12.2026 по расчёту из «Ключевых фактов» (точка равенства ≈67% наценки) и фактическим наценкам первых недель; уведомление в ФНС до 31.12.2026. Не зависит от хода этапов | декабрь 2026 | Максим |
| 16 | Договор и ключи VIN-каталога на ИП (Laximo / acat / PartsAPI), условия кэширования и запрет индексации | 3 | Максим |
| 17 | Аккаунт Yandex SmartCaptcha, ключи в env; включается как второй рубеж при срабатывании порогов | 2 | Максим |

## 8. Риски и как план их закрывает

1. Модерация ЮKassa и ключи Rossko задерживаются — заявки в день 1, заглушка с документами к дню 5, код на фикстурах и тестовом магазине.
2. «Чеки от ЮKassa» не умеют чек зачёта или тарифицируют процентом — гейт фазы 0, `ReceiptProvider` отдельно, план Б с облачной ККТ.
3. Маркировка уже действует для фильтров/свечей/колодок — проверка в день 1, excluded_groups или коды в чеке до запуска.
4. У Rossko нет тестового режима — `ROSSKO_ALLOW_CHECKOUT`, supplier_orders до вызова, первый заказ — реальная дешёвая позиция.
5. itemErrors, отказ поставщика после оплаты, дрейф цены — recheck, допуск, needs_attention и awaiting_client_approval с таймаутом, частичный возврат, запрет доплаты, проверка total на checkout и на вебхуке.
6. Ошибка в чеках 54-ФЗ — чеки чистой функцией со снапшот-тестами, выдача заблокирована до succeeded, признак расчёта зеркалится, первые 10 боевых чеков проверяются в приложении ФНС.
7. Потерянный/дублированный вебхук — webhook_events unique, reconciliation каждые 10 минут, отмена только после подтверждённого статуса.
8. Невыкуп prepay при 14-дневном сроке возврата Rossko — окно 10 дней с напоминаниями 3/6/9, возврат денег обязателен, задача продавцу вернуть Rossko.
9. Задвоение дохода АУСН по выплатам ЮKassa / агентская касса — вопросы до договора, ежемесячная сверка.
10. Шуточный заказ при оплате на точке — подтверждение, лимит суммы, счётчик неявок, 7 дней.
11. Переквалификация договора с Лёшей в товарищество или агентирование — ставки за операции, акты, без «доли прибыли», установка оплачивается в сервисе, инвариант «в чеке нет услуг кроме доставки».
12. 152-ФЗ — consents с хэшем текста, минимизация ПД в мессенджерах, РКН до публикации форм, ПД в Postgres в РФ, шифрованные бэкапы, сроки хранения в политике, обезличивание вместо удаления.
13. Боты и квота Rossko — лимиты в middleware, предохранитель на 70% квоты, SMS-лимиты, honeypot, SmartCaptcha как второй рубеж.
14. MAX меняет API и требует верификации — только драйвер адаптера, пин версии, Telegram и SMS с первого дня.
15. Rossko — конкурент, +28% может быть выше его розницы — сравнение до написания корзины, наценки по диапазонам в settings, отличия сервисом.
16. OOM на VPS при сборке — образы собираются в CI, stage по требованию, swap и лимиты памяти, heartbeat worker с алертом.
17. Фаза 1 переоценена — 1B на 14 дней, спайк в фазе 0, первый заказ на 34-й день.

## 9. Что не делаем на MVP и почему

1. Личный кабинет, вход по SMS-коду, гараж — секретная ссылка и deep link бота покрывают потребность.
2. Поиск по названию и подсказки — GetSearch, вероятно, только по артикулу и бренду; не обещать неподтверждённое.
3. Доплата при росте цены — противоречит фиксированной цене и ломает чек зачёта на один payment_id.
4. Двухстадийный платёж (холд) — возврат за 10 дней уже штатная ветка.
5. Ledger и бухгалтерия внутри приложения, генерация PDF — акт = экспорт из order_events; памятка и акт — статические PDF.
6. Отзывы с модерацией, DaData, e-mail-рассылки, GlitchTip — каждый сервис это аккаунт и точка отказа.
7. Транспортные компании и иногородние заказы — возвраты из других городов съедают маржу.
8. Автозаказ без кнопки, резервный поставщик, бот продавца в MAX — после статистики 1–2 месяцев.
9. Хранение сканов подписанных памяток — расширяет состав ПД.
10. Приём наличных — нет своей ККТ, деньги только через ЮKassa.
11. Продажа масел, шин, антифризов, тормозных жидкостей — маркировка требует ЭДО и кодов в чеке; поле marking_code заложено.
12. Частичная выдача с несколькими чеками зачёта — запрещена инвариантом; отдельные заказы.

## 10. Бюджет (ориентир, `docs/budget.md`)

| Статья | ₽/мес | Статус |
|---|---|---|
| VPS 2 vCPU/4 ГБ + IPv4 + бэкап | ≈1 300 | по снимку цен 09.2026 |
| S3 100 ГБ | ≈350 | по снимку |
| Домен .ru | ≈35 (399/год) | по снимку |
| SMS (фолбэк, allowlist) | 500–1 500 | оценка |
| Чеки ЮKassa | после ответа поддержки | **непроверено**; при > 3 000 ₽/мес или обороте > 500 тыс — пересчёт в пользу своей ККТ |
| VIN-слой (фазы 1–2 / 3) | 0 / до 5 000 | Laximo только при тарифе ≤ 5 тыс, иначе acat/PartsAPI |
| Эквайринг | ≈2,8% по картам (промо для новых ИП до 01.12.2026, вторичный источник; базовый тариф сверить), СБП 0,4–0,7% | **непроверено** |

## Verification

**Автотесты (CI на каждый push).** `packages/domain`: таблица переходов (каждая пара состояние/событие, включая запрещённые); инварианты денег; `price()` по диапазонам и округление; eta_date/promised_date; снапшоты payload чеков prepayment, full, offset, refund_prepayment, refund_full с проверкой сумма строк = amount; инвариант «только commodity + ≤1 service». `packages/rossko`: фикстуры из smoke-скрипта, маппинг локального склада, фильтр групп, лимитер (251-й запрос за минуту ждёт), предохранитель квоты. `packages/payments`: msw-моки на платёж/перечитывание/чек/возврат, стабильность Idempotence-Key, один вебхук дважды — один переход. Интеграционный тест на compose: оплата → заказ у поставщика (мок) → приёмка → чек → выдача через очереди с проверкой order_events и notifications. Middleware: лимиты поиска и SMS.

**Фаза 0.** HTTPS с валидным сертификатом, `/api/health` 200 и падает при тишине heartbeat; бот отвечает на `/ping` только staff; дамп в S3 и восстановлен на stage по runbook; smoke-скрипт записал фикстуры или задача помечена «ждём ключи»; `docs/external.md` заполнен; спайк: тестовый платёж → вебхук на stage → POST /receipts с settlements succeeded (или зафиксирован переход на план Б).

**Фаза 1A.** Поиск по 10 артикулам Лёши: цена = ceil(опт × наценка диапазона), бейдж склада совпадает с мнением Лёши о сроке, дата как «к чт 9 октября»; стоп-группа не добавляется; смешанная корзина предлагает разделение; POST /checkout с устаревшим total отвечает 409 и показывает DiffBanner; оформление без согласия невозможно, в consents запись с sha256; 21-й поиск за минуту — 429; телефон без горизонтального скролла.

**Фаза 1B** (stage, тестовый магазин ЮKassa, вебхуки через публичный поддомен или туннель):

| Шаг | Действие | Ожидание |
|---|---|---|
| 1 | prepay-заказ, тестовая карта успеха | confirmed, чек предоплаты с признаком «предоплата 100%», order_events заполнены |
| 2 | карта отказа и 3-D Secure | cancelled / confirmed, статус из GET /payments |
| 3 | повтор того же вебхука curl | второго перехода, чека, уведомления нет |
| 4 | отключить вебхук в ЛК, оплатить | reconciliation → confirmed в течение 10 мин; TTL не отменяет оплаченный |
| 5 | «Проверить и заказать» на моке Rossko с ценой +1% и +10% | +1% — ordered_at_supplier; +10% — needs_attention с альтернативами |
| 6 | фикстура GetCheckout с itemErrors по одной из двух позиций | кнопки по позиции; «Отменить позицию» → частичный возврат с чеком на строку; остаток выдаётся чеком зачёта на остаток |
| 7 | «Аналог» → клиент «Согласен» на /o/<token> / «Вернуть деньги» / молчит 24 ч / уведомление skipped | ordered_at_supplier с replaced_by_item_id / refund_pending с чеком возврата full_prepayment succeeded / refund_pending / остаётся needs_attention без таймера |
| 8 | «Приехало» по одной позиции из двух | заказ не ready; клиенту «Жду до <дата>» / «Отменить позицию» |
| 9 | «Приехало» всё → «Клиент пришёл» | чек зачёта succeeded, только потом активна «Выдал», в ЛК два чека |
| 10 | pay_on_handover: оформление → «Подтверждаю» по SMS → «Клиент пришёл» → «Выставить оплату» → QR | один чек полного расчёта, handed только после payment.succeeded; «Выставить оплату» недоступна до «Клиент пришёл» |
| 11 | «Отменить заказ и вернуть деньги» и «Отказ клиента до передачи» | refund_pending → refunded, чек возврата full_prepayment succeeded |
| 12 | остановить worker на 10 мин, нажать кнопки, прислать вебхук, включить | задачи выполнены ровно один раз в порядке |
| 13 | ошибка POST /receipts (неверный tax code) | ретраи 15 мин, алерт, «Выдал» заблокирована |
| 14 | оплата заказа, отменённого по TTL | refund_pending автоматически |
| 15 | невыкуп prepay на 10-й день | refund_pending без выбора, чек возврата full_prepayment succeeded, no_show_count+1, задача продавцу про Rossko |
| 16 | вебхук payment.succeeded с amount ≠ orders.total | needs_attention (amount_mismatch), алерт Максиму |
| 17 | «Проблема с позицией» из ordered_at_supplier → «Заказать всё равно» | needs_attention → ordered_at_supplier, причина в order_events |
| 18 | «Оплатить заранее» для pay_on_handover | awaiting_payment, далее два чека как prepay |
| 19 | TTL QR 15 мин без оплаты | awaiting_handover_payment → ready |
| 20 | невыкуп pay_on_handover на 7-й день | cancelled без возврата, no_show_count+1 |
| 21 | awaiting_confirmation без ответа 24 ч; handed без обращений 7 дней | cancelled; completed (housekeeping) |
| 22 | «Повреждено при приёмке» | supplier_returns kind=claim, повторный заказ позиции через replaced_by_item_id |
| 23 | settings.rossko_prepay_invoice=true → GetCheckout → «Счёт оплачен» | awaiting_supplier_invoice → ordered_at_supplier, promised_date с лагом |

**Фаза 1C.** Привязка по deep link в Telegram с двух аккаунтов (телефон совпадает / нет); блокировка бота → SMS с fallback_reason; шаблон вне allowlist без мессенджера → skipped; VIN-заявка с фото → ответ строками с опечаткой → превью показывает ошибку → /p/<token> → оплата; «приехало» содержит фото, код выдачи, кнопку записи; в сообщениях Telegram нет телефона и адреса клиента; «Претензия» по выданному заказу → «Принял возврат» с фото → decision refund → refund succeeded, чек возврата full_payment, deadline_at = +10 дней от обращения; refund без «Принял возврат» заблокирован инвариантом; первый боевой заказ Лёши как клиента: два чека на телефоне, проверка в приложении ФНС, возврат и чек возврата; ревизия order_events вручную.

**Фаза 2.** MAX после модерации: привязка и уведомления, повтор апдейта не дублирует, 429 → backoff; GetOrders переводит статусы с подтверждением; курьерский заказ (только prepay; выбор курьера переводит pay_on_handover в предоплату) с отдельной строкой доставки, out_for_delivery → handed с чеком зачёта по «Клиент получил»; таймер возврата поставщику напоминает за 3 дня; акт за месяц = экспорт order_events; сумма чеков минус возвраты = доход в ЛК АУСН; обезличивание клиента без SQL; восстановление бэкапа < 30 минут.

**Фазы 3–4.** 20 реальных VIN: OEM по трём категориям находятся в GetSearch; при исчерпании бюджета резолвер переключается на ручной; автозаказ пишет причину и срабатывает только при цене в допуске; отчёт за квартал сходится с ЛК ЮKassa.

**Сверить по документации .ru-сайтов при реализации.** Rossko: поля GetSearch, признак склада Оренбурга, delivery_id/address_id, itemErrors и комментарий GetCheckout, коды GetOrders, тестовый режим, отмена, лимиты, условия возврата. ЮKassa: коды vat/tax_system, POST /receipts с settlements в «Чеках от ЮKassa», тариф, модель кассы, confirmation qr/СБП, срок жизни платежа, IP вебхуков и ретраи, чек в теле возврата, частичные возвраты, чек коррекции, ФФД 1.2 и тег 1163, тестовые карты. MAX: deep link и bot_started с payload, request_contact, лимиты, версия схемы, сертификат и вебхук. Laximo/acat: тариф, договор с ИП, методы, запрет индексации, кэширование. SMS-провайдер: тариф, имя отправителя. Госорганы: Р24001, РКН через Госуслуги, реестр банков АУСН, разметка операций в ЛК АУСН, позиция ФНС по неустойке без чека, честныйзнак.рф по группам.

## Первая неделя по дням

1. **День 1.** Максим руками: Р24001; банк (реестр АУСН, разметка выплат); аккаунт Rossko и письмо менеджеру с полным списком вопросов из п. 2 раздела 7; бренд, домен с ЕСИА, VPS, S3; боты в @BotFather и чат продавцов; заявка в business.max.ru; проверка маркировки по группам; договор с SMS-провайдером. Claude Code: монорепо pnpm, `apps/web`, `apps/worker`, `packages/db`, `packages/domain`, compose, Caddyfile, `.env.example`, CI (typecheck, vitest, сборка в ghcr.io), `docs/external.md`, `docs/budget.md`.
2. **День 2.** Claude Code: Drizzle-схема всех таблиц фазы 1, миграции, сиды; черновики документов в `document_versions`; страницы /docs/*, /about. Максим: уведомление в РКН, внутренние документы оператора, вычитка, юрист.
3. **День 3.** Claude Code: deploy-скрипт (pull + up по тегу), backup-контейнер с шифрованием, runbook восстановления и «инцидент с ПД», бот продавца с `/ping`, `/api/health` + heartbeat, stage-профиль. Максим: DNS, первый деплой, восстановление дампа на stage, заявка в ЮKassa с письменными вопросами (п. 9).
4. **День 4.** Claude Code: `packages/rossko` (SOAP-клиент, лимитер, кэш, api_calls), `scripts/rossko-smoke.ts`; если ключи выданы — фикстуры по 5–10 артикулам, иначе заглушки с пометкой; `packages/domain`: `price()` по диапазонам, eta_date, фильтр групп с тестами. Лёша: 20–30 ходовых артикулов и сроки по складам.
5. **День 5.** Claude Code: страницы / и /search с бейджами и датой, GET /api/search с лимитами в middleware, search_log, EmptyState → VIN; таблица переходов как тестовая спецификация в `packages/domain`. Максим и Лёша: сравнение цен, вывод о наценках в settings.
6. **Дни 6–8.** Спайк ЮKassa на тестовом магазине: платёж → вебхук на stage → POST /receipts с settlements; фиксация результата гейта.

Критерий конца недели: сайт по HTTPS с документами, бэкап восстановлен, бот отвечает staff, поиск работает на фикстурах или живых ключах, все внешние заявки поданы с датами, сравнение цен начато, статус маркировки по группам записан.


## Текущий шаг: реализация кодовой части фазы 0 в этой сессии

Окружение проверено 02.10.2026: Node 22.22, pnpm 10.28, бинарники PostgreSQL 16 и Redis 7 (демоны не запущены, поднимаются локально без Docker; `initdb` только через `runuser -u postgres`), dockerd не запущен (compose проверяется `docker compose config`), npm доступен, Chromium для Playwright в `/opt/pw-browsers` (ревизия под Playwright 1.56.1). Rossko, ЮKassa, MAX, Telegram недоступны: работаем на синтетических фикстурах и msw-моках. Не установлены rclone, shellcheck, caddy; есть age, gpg, jq, yq, pg_dump 16.

### Сквозные решения

| № | Решение |
|---|---|
| 1 | Без turbo: `pnpm -r` и `--filter`; в Docker `pnpm fetch` + `--filter` |
| 2 | Внутренние пакеты не собираются: `exports` → `./src/index.ts`, `moduleResolution: Bundler`; Next через `transpilePackages`; worker, миграции, скрипты через `node --import tsx` (и в production) |
| 3 | Драйвер БД `postgres` (porsager) 3.4.9; `pg` не ставим |
| 4 | Версии: next 16.3.8, react 19.3.0, **typescript 6.0.3** (fallback 5.9.3; TS 7 нативный — несовместим с JS API тулинга), drizzle-orm 0.45.3, drizzle-kit 0.31.11, bullmq 6.3.11 (Job Schedulers вместо repeatable), ioredis 6.0.0 (`protocol: 2`, `maxRetriesPerRequest: null` у воркеров), grammy 1.46.0, @maxhub/max-bot-api 1.0.1, soap 1.13.1, vitest 5.0.3, msw 3.0.1, zod 4.6.5, tailwindcss 4.3.3, uuid 14.0.2, pino 10.3.1, tsx 4.23.15, eslint 10 (fallback 9), **@playwright/test 1.56.1** |
| 5 | Тесты с I/O — против настоящих PG 16 и Redis 7 (`scripts/dev-db.sh`: PG на 127.0.0.1:55432, Redis на 56379); ioredis-mock не используем (Lua-лимитер) |
| 6 | `ROSSKO_MODE=fixtures\|live`; в fixtures поиск работает до ключей и показывает плашку «демо-данные» |
| 7 | Юридические тексты — markdown в `content/legal/<kind>/<version>.md` с плейсхолдерами реквизитов; сид кладёт в `document_versions` с подставленными реквизитами и sha256; правка текста опубликованной версии валит сид (нужна новая версия) |
| 8 | Бэкап: `pg_dump -Fc \| age -r <публичный ключ>` (приватный у Максима офлайн), fallback `gpg --symmetric`; `STORAGE=local` для локальной проверки |
| 9 | Сторож worker — `healthwatch.sh` в backup-контейнере (не зависит от web и worker); `/api/health` (503 при сбое БД/Redis/heartbeat > 300 с) и `/api/health/live` (всегда 200, только для Docker healthcheck web) |
| 10 | Next 16: `src/proxy.ts` вместо middleware (лимит 20/мин и 300/сутки на HMAC(SESSION_SECRET, ip), IP только из `X-Real-IP`, который ставит Caddy); при проблемах со сборкой — лимит в route handler; Tailwind v4 через `@tailwindcss/postcss` и `@theme`; системные шрифты |
| 11 | Деньги в БД — integer с суффиксом `_kop`, наценка в базисных пунктах (`markup_bp`, 2800 = 28%); формула `ceil(p·(10000+bp)/1 000 000)·100` без float |
| 12 | Фильтр маркировки — слова, а не префиксы: `масло`, `масла`, `шина`, `шины`, `антифриз*`, `тосол`, `жидкость тормозн*` (префикс «масл» отсёк бы масляные фильтры); ё→е |
| 13 | Бренд и реквизиты только из env (`BRAND_NAME=Детали`, `SELLER_REQUISITES_*`, `PICKUP_*`); тест грепает `src` на хардкод |
| 14 | `/vin` в фазе 0 без формы (адрес и телефон сервиса) — формы сбора ПД только после номера РКН |

### Порядок работ (Workflow, ultracode)

1. **Шаг 0, последовательно.** Корневые файлы (package.json, pnpm-workspace.yaml, .npmrc с `onlyBuiltDependencies`, tsconfig.base.json, eslint/prettier, .gitignore, .dockerignore, .env.example, vitest.config.ts), `scripts/dev-db.sh`, полный `packages/config` (env на zod, redis, скользящее окно, суточный счётчик по МСК, heartbeat, logger, имена очередей), во всех workspace — `package.json` со всеми зависимостями точными версиями и типизированные заглушки публичных API. Один `pnpm install`, lock коммитится. Приёмка: install, lint, typecheck, test зелёные.
2. **Волна A, параллельно в git worktree.** П1 `packages/db` (Drizzle-схема всех таблиц фазы 1, pgEnum из `@detaly/domain/statuses`, уникальности и check-ограничения, `DT-000001` через sequence, миграции, идемпотентные сиды settings/staff/excluded/legal, `prepareTestDb`); П2 `packages/domain` + контракты `payments`/`notify`/`vin` (price, validateMarkupRules, localDate/etaDate/promisedDate/formatPromise, isExcluded, buildOfferViews, декларативная таблица `TRANSITIONS` + `resolveTransition` + тест-спецификация ≈45 строк и полный перебор запрещённых пар; msw-обработчики ЮKassa; `buildCallbackData` ≤64 байт; `isValidVin`); П3 `packages/rossko` (ленивый SOAP-клиент, fixture-caller, устойчивый маппер, `rubToKop` без float, нормализация артикула, Lua-лимитер 250/мин + сутки по МСК + предохранитель 70%, кэш 15 мин с single-flight, `CheckoutDisabledError`, `scripts/rossko-smoke.ts` с кодом 2 без ключей, синтетические фикстуры с `_meta.synthetic`); П4 infra/CI/docs (compose с профилем stage и лимитами памяти, Caddyfile без rate_limit, Dockerfile web/worker/backup, backup.sh/restore.sh/healthwatch.sh, deploy.sh с откатом и `DRY_RUN`, `.github/workflows/ci.yml` с jobs check/e2e/images, `docs/external.md`, `docs/budget.md`, `docs/runbook.md`, черновики `content/legal`). Правила: агент правит только свои пути; корень, lock, `packages/config`, `statuses.ts`, `types.ts` — только чтение; своя тестовая БД `detaly_test_<worktree>`, Redis-ключи с префиксом `test:<uuid>:`, `FLUSHDB` запрещён; новые env перечисляются в отчёте.
3. **Ревью волны A.** На каждый пакет — независимый ревьюер: прогон тестов, сверка с PLAN.md и этим разделом, поиск багов (деньги, даты, уникальности, лимитер). Найденное чинится до слияния.
4. **Слияние A, затем волна B параллельно.** П5 `apps/web` (layout, /, /search, /about, /docs/[slug], /returns, /vin, robots, /api/health, /api/health/live, /api/search, proxy-лимиты, search-service с search_log, компоненты SearchBar/OfferRow/StockBadge/EmptyState/VinCta/HowItWorks/TrustBlock/Footer/DemoDataBanner, Playwright mobile 375 и desktop 1280 со скриншотами и проверкой горизонтального скролла, `limits.spec.ts`); П6 `apps/worker` (BullMQ, семь очередей, Job Scheduler heartbeat 30 с, заглушки с `UnrecoverableError`, seller-бот на grammY с `/ping` только для staff и молчанием для чужих, graceful shutdown ≤25 с, healthcheck, тесты без сети через подмену транспорта grammY).
5. **Ревью волны B** тем же способом.
6. **Шаг И, последовательно.** Слияние, итоговый `pnpm install` и lock, env из отчётов агентов, README, полный прогон проверки ниже, просмотр скриншотов, коммит и push в `claude/auto-parts-resale-platform-5j8nfs`. Рабочие ветки worktree наружу не пушатся.

### Проверка фазы 0 в этой сессии

1. `pnpm install --frozen-lockfile`; `scripts/dev-db.sh up && eval "$(scripts/dev-db.sh env)"`.
2. `pnpm lint && pnpm format:check && pnpm typecheck && pnpm test && pnpm --filter @detaly/db db:drift`.
3. `pnpm db:migrate && pnpm db:seed`, повторный сид ничего не меняет.
4. `pnpm build`; web из standalone на порту 3100 с `ROSSKO_MODE=fixtures`; worker без токена бота.
5. `curl /api/health` → 200 и возраст heartbeat < 60 с; `curl '/api/search?q=OC90'` → предложения с ценой `ceil(опт × 1,28)`, `search_log` растёт; 21-й запрос с одного `X-Real-IP` → 429.
6. SIGTERM worker → код 0; удаление ключа heartbeat → `/api/health` 503.
7. Playwright на 375 и 1280: все страницы без горизонтального скролла, ИНН в футере, `noindex` на /search; скриншоты просмотрены глазами.
8. `docker compose -f infra/docker-compose.yml --env-file .env.example config -q` (и с `--profile stage`); `bash -n` по всем скриптам; разбор ci.yml через yq.
9. Бэкап и восстановление в локальном режиме: число строк в `settings` и `document_versions` совпадает.
10. `tsx scripts/rossko-smoke.ts --articles OC90` без ключей → код 2 и «ждём ключи».

После сессии остаётся Максиму: VPS, DNS, `.env` с секретами, сертификат Минцифры в `infra/certs`, PAT `read:packages` для ghcr, первый `deploy.sh` и проверка TLS, бакет S3 и восстановление на stage, ключи Rossko и сверка маппера с реальным ответом, спайк ЮKassa, токены BotFather и живой `/ping`, первый прогон CI на GitHub, юридическая вычитка, заполнение `docs/external.md`.
