# detaly

Платформа перепродажи автозапчастей для Оренбурга: сайт, боты MAX и Telegram, приём оплаты через ЮKassa, заказ у поставщика Rossko, выдача и установка в автосервисе «Сервис56». Бренд, реквизиты продавца и точка выдачи берутся только из переменных окружения (`BRAND_NAME`, `SELLER_REQUISITES_*`, `PICKUP_*`).

Статус: фазы 0 и 1A завершены (каркас, поиск на фикстурах Rossko, документы, бот продавца, инфраструктура; корзина, оформление с согласиями и страница заказа). Фаза 1B — оплата через ЮKassa с чеками, полная машина состояний заказа, карточки и кнопки в боте продавца, заказ у Rossko с защитой от двойной отправки, мини-админка, сверка платежей и dead-letter. Код 1B проверен на эмуляции ЮKassa (msw), фикстурах Rossko и подменённом транспорте Telegram; живой прогон — на stage по `docs/runbook.md`, раздел 12.3. Оформление в проде включается только при условиях раздела 12.11 runbook.

## С чего начать

1. `docs/PLAN.md` — утверждённый поэтапный план: архитектура, модель данных, машина состояний заказа, интеграции (Rossko SOAP, ЮKassa, MAX/Telegram, VIN), UX, фазы с приёмкой, внешние и юридические шаги, риски, бюджет, проверка, первая неделя.
2. `docs/phase0-implementation.md`, `docs/phase-1a-implementation.md`, `docs/phase-1b-implementation.md`, `docs/phase-1c-implementation.md` — разбивка фаз на пакеты, решения по умолчанию, тест-кейсы, критерии приёмки.
3. `docs/runbook.md` — эксплуатация: установка, деплой, откат, бэкапы, инциденты, оформление заказов 1A, оплата, чеки, возвраты, бот продавца и админка 1B (раздел 12), клиентский бот, фото, претензии, VIN и запись на установку 1C (раздел 14).
4. `docs/external.md` — журнал внешних заявок и вопросов (Rossko, ЮKassa, РКН), в том числе VERIFY-вопросы к живому API.
5. `docs/research/research-brief.md`, `docs/research/design-review.md` — исследование и итоги проектирования.

## Устройство репозитория

| Путь | Что |
|---|---|
| `apps/web` | Next.js 16: сайт, API, `src/proxy.ts` (лимиты и заголовки) |
| `apps/worker` | BullMQ (очереди 1B и 1C, outbox, dead-letter), бот продавца и клиентский бот (grammY) |
| `packages/config` | схема env (`getEnv`), логгер, Redis-утилиты; env читается только через этот пакет |
| `packages/db` | Drizzle-схема, миграции, сид, тестовые базы |
| `packages/domain` | чистая логика: цены, даты, корзина, оформление, машина состояний, чеки, возвраты, перепроверка |
| `packages/orders` | движок заказов: переходы под блокировкой строки, эффекты и `outbox`, действия продавца и клиента, применение ответов ЮKassa |
| `packages/rossko` | клиент Rossko (SOAP), лимитер, кэш, фикстуры `fx:` |
| `packages/payments` | ЮKassa: платежи, чеки, возвраты, разбор уведомлений, allowlist IP; msw-эмуляция для тестов (`@detaly/payments/testing`) |
| `packages/notify` | шаблоны уведомлений, Telegram и SMS (SMS Aero, smsc.ru), лимиты и бюджет SMS, кодек `callback_data` |
| `packages/vin` | VIN (фазы 1C и далее) |
| `content/legal` | тексты оферты, политики, согласий: `<kind>/<version>.md` |
| `infra` | compose, Caddyfile, `deploy.sh`, бэкап |

## Локальный запуск

Нужны Node 22 и pnpm 10. PostgreSQL 16 и Redis 7 без Docker поднимает `scripts/dev-db.sh`.

```sh
pnpm install --frozen-lockfile
scripts/dev-db.sh up && eval "$(scripts/dev-db.sh env)"   # DATABASE_URL, REDIS_URL и тестовые URL
export SESSION_SECRET=local-session-secret-0123456789abcdef0123   # не короче 32 символов
pnpm db:migrate && pnpm db:seed
pnpm dev:web                                                       # http://localhost:3000
```

Переменные окружения описаны в `.env.example`; приложение читает их из окружения процесса (например, `set -a; . ./.env; set +a`). Rossko по умолчанию работает на фикстурах (`ROSSKO_MODE=fixtures`). Чтобы локально открыть оформление, задайте любое тестовое `RKN_NOTICE_NUMBER` (вне production допускаются черновики документов) и оставьте `APP_BASE_URL` равным адресу, с которого открыт сайт, иначе проверка `Origin` отклонит корзину и оформление.

Проверки: `pnpm lint`, `pnpm format:check`, `pnpm typecheck`, `pnpm test` (интеграционные тесты `*.int.test.ts` используют `DATABASE_URL_TEST` и `REDIS_URL_TEST`).

## Фаза 1A: корзина, оформление, страница заказа

### Страницы

| Путь | Что | Индексация |
|---|---|---|
| `/cart` | корзина: позиции с ценой и датой, пересчёт цен через кэш при открытии (плашка изменений), способ оплаты, «Разделить на два заказа» для смешанной корзины. Работает без JavaScript | noindex |
| `/checkout?part=all\|local\|order` | оформление на одном экране: телефон, имя, канал статусов (MAX, Telegram, SMS), самовывоз, согласия (оферта и ПД обязательны, маркетинг по желанию). Требует JavaScript. Без `RKN_NOTICE_NUMBER` формы нет | noindex |
| `/o/<token>` | страница заказа по секретной ссылке: статус, дата получения, точка выдачи, способ оплаты, позиции, лента событий, отмена по последним 4 цифрам телефона (отмена требует JavaScript) | noindex, `Referrer-Policy: no-referrer` |

### Эндпоинты

Все изменяющие запросы проверяют `Origin` (равен origin `APP_BASE_URL`, без `Origin` — только `Sec-Fetch-Site: same-origin`, иначе 403). Цену и наценку клиент не передаёт никогда: их считает сервер.

| Метод и путь | Тело | Ответ |
|---|---|---|
| `POST /api/cart/items` | форма или JSON: `q` (артикул запроса), `offerId`, `qty` (необязательно) | форма: 303 на `/cart?added=1`, ошибка — 303 на `/cart?error=<code>`; JSON: 200 `{count, totalKop}`. Без cookie создаёт корзину и ставит cookie `cart`. Ошибки: 400, 403, 404 `offer_not_found`, 422 `excluded` / `qty` / `cart_full` / `too_many_searches`, 503 `supplier_unavailable` |
| `PATCH /api/cart/items/<id>` (или `POST` с `_method=patch`) | `qty` | 303 на `/cart` / 200; 404 чужая строка; 422 `qty` |
| `DELETE /api/cart/items/<id>` (или `POST` с `_method=delete`) | — | 303 на `/cart` / 200; 404 |
| `POST /api/checkout` | JSON `{part, phone, name, channel, acceptOffer, consentPd, consentMarketing, expectedTotalKop, itemsHash, checkoutKey, website}` | 201 `{orderUrl, number}`; повтор с тем же `checkoutKey` — 200 с тем же заказом (409 `checkout_key_conflict`, если ключ уже использован заказом из другой корзины); 409 `stale` `{changes, totalKop, itemsHash}` — цены или наличие изменились, заказ не создан; 422 `validation` / `consent_required` / `below_minimum` / `cart_too_large`; 400 `bad_request` / `rejected`; 403 `forbidden_origin` / `checkout_closed`; 404 `cart_empty`; 503 `supplier_unavailable` |
| `POST /api/orders/<token>/cancel` | JSON `{last4}` | 200 `{status: 'cancelled'}`; 422 `wrong_digits` с `attemptsLeft`, 422 `validation` (не 4 цифры); 429 `too_many_attempts` после 5 неверных попыток за час; 409 `not_cancellable`; 400 `bad_request` (не JSON); 403 `forbidden_origin`; 404 `not_found`; 503 `unavailable`, если недоступен счётчик попыток |

Перед созданием заказа `POST /api/checkout` заново проверяет цены у Rossko мимо кэша (priority `critical`, ожидание лимитера не больше 5 с). Заказ, пользователь, согласия (`pd` и при желании `marketing`, с версией и sha256 текста, IP и браузером) и событие `order_events` создаются в одной транзакции. Заказ получает статус `awaiting_payment` (предоплата) или `awaiting_confirmation` (оплата при получении) по правилу машины состояний.

Лимиты на IP-бакет (`apps/web/src/proxy.ts`): оформление 10 в час, отмена 5 в час, изменения корзины 120 в час; неверные цифры при отмене — 5 в час на заказ. Подробнее — `docs/runbook.md`, раздел 11.6.

### Переменные 1A

| Переменная | По умолчанию | Что |
|---|---|---|
| `CART_TTL_DAYS` | `30` | срок жизни cookie корзины `cart` в днях (`Max-Age`). Строки корзин в базе по нему не удаляются; очистки брошенных корзин нет и в 1B |
| `RKN_NOTICE_NUMBER` | пусто | номер записи в реестре операторов ПД; пока пусто, оформление закрыто. В проде задавать только при условиях `docs/runbook.md`, раздел 12.11 |
| `LEGAL_OFFER_VERSION`, `LEGAL_PRIVACY_VERSION`, `LEGAL_CONSENT_PD_VERSION`, `LEGAL_CONSENT_MARKETING_VERSION` | пусто | опубликованные версии документов; при `NODE_ENV=production` без опубликованных оферты, политики и согласия ПД оформление закрыто |
| `APP_BASE_URL` | `http://localhost:3000` | публичный origin сайта: с ним сравнивается `Origin` изменяющих запросов |
| `TRUSTED_IP_HEADER` | `none` | `x-real-ip` за Caddy (в compose задан). При `none` все клиенты делят один бакет лимитов, а `consents.ip` пишется пустым |

### E2E фазы 1A

Сценарии лежат в `apps/web/e2e/` (`checkout.spec.ts`, `limits.spec.ts`, `screens.spec.ts`) и идут против собранного standalone-сервера на :3100 в двух проектах: `mobile` 375×812 и `desktop` 1280×800. Скриншоты сохраняются в `apps/web/test-results/screens/`. Env совпадает с job `e2e` в `.github/workflows/ci.yml` (и разделом 15 `docs/phase-1a-implementation.md`):

```sh
scripts/dev-db.sh up && eval "$(scripts/dev-db.sh env)"
scripts/dev-db.sh ensure-db detaly_e2e && export DATABASE_URL="${DATABASE_URL%/*}/detaly_e2e"
export SESSION_SECRET=local-session-secret-0123456789abcdef0123 \
  APP_BASE_URL=http://127.0.0.1:3100 RKN_NOTICE_NUMBER=E2E-TEST ROSSKO_MODE=fixtures \
  LEGAL_OFFER_VERSION=2026-10-d1 LEGAL_PRIVACY_VERSION=2026-10-d1 \
  LEGAL_CONSENT_PD_VERSION=2026-10-d1 LEGAL_CONSENT_MARKETING_VERSION=2026-10-d1 \
  LEGAL_RETURN_MEMO_VERSION=2026-10-d1 \
  SELLER_REQUISITES_NAME='Тестов Тест Тестович' SELLER_REQUISITES_INN=561234567890 \
  SELLER_REQUISITES_OGRNIP=312565800012345 SELLER_REQUISITES_ADDRESS='г. Оренбург, ул. Тестовая, 1' \
  SELLER_REQUISITES_EMAIL=seller@example.test SELLER_REQUISITES_PHONE='+7 900 000-00-00' \
  PICKUP_POINT_NAME='Тестовый пункт выдачи' PICKUP_ADDRESS='г. Оренбург, ул. Тестовая, 1' \
  PICKUP_HOURS='Пн–Пт 10:00–19:00' PICKUP_PHONE='+7 900 000-00-01' E2E_EXPECT_INN=561234567890
pnpm db:migrate && pnpm db:seed      # сид публикует тестовые версии документов в этой базе
pnpm --filter @detaly/web build && node apps/web/scripts/prepare-standalone.mjs
PORT=3100 HOSTNAME=127.0.0.1 TRUSTED_IP_HEADER=x-real-ip \
  node apps/web/.next/standalone/apps/web/server.js > /tmp/web-1a.log 2>&1 &
E2E_BASE_URL=http://127.0.0.1:3100 PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers \
  pnpm --filter @detaly/web e2e
grep -cE '\+79[0-9]{9}' /tmp/web-1a.log   # 0: телефонов в логах нет
```

Важно: standalone-сервер работает с `NODE_ENV=production`, поэтому оформление в e2e откроется только с опубликованными версиями документов (`LEGAL_*_VERSION` при сиде) и `APP_BASE_URL`, равным адресу сервера. `TRUSTED_IP_HEADER=x-real-ip` нужен, чтобы каждый прогон шёл со своим случайным `X-Real-IP` из `playwright.config.ts` и не упирался в лимиты прошлых прогонов. Поэтому e2e идёт в отдельной базе `detaly_e2e` (вторая строка): сид публикует версии, а опубликованный текст потом нельзя изменить, и рабочую базу разработки публиковать не нужно.

## Фаза 1B: оплата, чеки, бот продавца, админка

Эксплуатация, включение оплаты и прогон проверки на stage — `docs/runbook.md`, раздел 12; разбивка и решения Б1–Б30 — `docs/phase-1b-implementation.md`; неподтверждённые поля внешних API — `docs/external.md`, раздел 7.

Как устроено: каждый переход заказа идёт через движок `packages/orders` (`select … for update` строки заказа, охраны таблицы переходов `packages/domain`). Переход, запись `order_events` и его последствия (уведомления, платежи, возвраты, чеки, заказ у Rossko) пишутся одной транзакцией: последствия — строками таблицы `outbox`. Web после коммита публикует сигнал в Redis-канал `detaly:outbox`, воркер забирает строки (`for update skip locked`, плюс проход раз в 2 с) и ставит задачи в BullMQ. Идемпотентность держится на строках базы: повтор задачи не создаёт второго платежа, чека, сообщения или GetCheckout.

### Страницы и эндпоинты

Изменяющие запросы сайта, как и в 1A, проверяют `Origin`. Ответы с `Cache-Control: no-store`.

| Метод и путь | Кто | Тело | Ответ |
|---|---|---|---|
| `POST /api/orders/<token>/pay` | клиент, кнопка «Оплатить N ₽» на `/o/<token>` | форма или JSON без полей | форма: 303 на страницу оплаты ЮKassa (`confirmation_url`), повторный клик ведёт на тот же платёж; ошибка — 303 на `/o/<token>?pay=error` или `?pay=unavailable`. JSON: 200 `{redirectUrl}`; 403 `forbidden_origin`; 404 `not_found`; 409 `not_payable` / `payment_unavailable`; 502 `payment_failed`; 503 `payments_disabled` (оплата не настроена); 500 `internal`. После оплаты ЮKassa возвращает клиента на `/o/<token>?paid=1` («Проверяем оплату…») |
| `POST /api/orders/<token>/actions` | клиент на `/o/<token>` | JSON `{action, itemId?, last4?}`; `action`: `confirm` («Подтверждаю»), `approve` («Согласен»), `prepay_now` («Оплатить заранее») — по ссылке; `refund_request` («Вернуть деньги»), `refuse` («Отказаться от заказа»), `item_cancel` («Отменить позицию», с `itemId`) — дополнительно последние 4 цифры телефона | 200 `{status}`; 400 `bad_request`; 422 `validation` / `wrong_digits` (с `attemptsLeft`); 429 `too_many_attempts` (общий с отменой 1A счётчик: 5 неверных за час на заказ); 409 `not_allowed`; 404 `not_found`; 403 `forbidden_origin`; 503 `unavailable` (нет Redis для счётчика) |
| `POST /api/webhooks/yookassa` | ЮKassa | уведомление ЮKassa (`payment.succeeded`, `payment.canceled`, `refund.succeeded`; `payment.waiting_for_capture` тоже принимается) | 200 `{}` (и на повтор); 403 — отправитель не прошёл проверку: нужен `TRUSTED_IP_HEADER=x-real-ip` и адрес из `YOOKASSA_WEBHOOK_IP_ALLOWLIST`, иначе отказ всем (fail closed); 413 — тело больше 64 КБ; 400 — не уведомление ЮKassa; 500 — ошибка записи (ЮKassa повторит). Уведомление только записывается (`webhook_events` + `outbox`); воркер перечитывает платёж или возврат через API |
| `GET /admin` | владелец, Basic auth `ADMIN_BASIC_AUTH` | — | список заказов: фильтр по статусу и «Требуют внимания», поиск по номеру `DT-…` и последним 4 цифрам телефона, 50 на страницу |
| `GET /admin/orders/<id>` | владелец | — | карточка: полный телефон и имя (единственное место), позиции, платежи, чеки, возвраты, заказы Rossko, согласования, возвраты поставщику, журнал, QR на оплату, формы действий |
| `POST /api/admin/orders/<id>/actions` | владелец, Basic auth | форма `application/x-www-form-urlencoded`: `action` (коды бота продавца `recheck`, `refused`, `cancel`, `anyway`, `ialt`, `ieta`, `icancel`, `iprob`, `iarr`, `invpaid`, `came`, `rcpt`, `qr`, `handed`, `noshow` и админские `manual_supplier_order`, `supplier_return_accept`, `supplier_return_reject`, `stock_item`, `refund_payment`) и поля действия (`itemId`, `offerKey`, `etaDate`, `problem`, `ppNumber` + `ppDate`, `rosskoOrderIds`, `supplierReturnId`, `amountRub`, `paymentId`, `reason`, `note`); необратимые действия требуют `confirm=on` | 303 обратно на карточку с `?done=<сообщение>`; 409 — страница с отказом движка (например, «Выдал» без чека — «Ждём чек»); 400 — форма не прочитана или поле неверно; 401 с `WWW-Authenticate`; 404 без `ADMIN_BASIC_AUTH`; 403 — чужой `Origin` |

`/admin` и `/api/admin/*` закрыты Basic auth в `apps/web/src/proxy.ts` (сравнение за постоянное время, 20 неверных паролей в час на IP-бакет — 429), отвечают `X-Robots-Tag: noindex, nofollow`, `Referrer-Policy: no-referrer`; `/admin` запрещён в `robots.txt`. Без `ADMIN_BASIC_AUTH` админки нет (404). Пользователь админки действует как владелец (`actor_id = 'admin'`).

Лимиты на IP-бакет (в дополнение к 1A): «Оплатить» — 10 в час, действия клиента — 20 в час. Вебхук не лимитируется (его закрывает allowlist).

На `/o/<token>` в 1B добавились: блок оплаты (без настроенной ЮKassa — «Оплата подключается»), «Подтверждаю», предложение аналога или нового срока с «Согласен» / «Вернуть деньги» и сроком ответа, «Жду до <дата>» и «Отменить позицию» при частичном приезде, «Отказаться от заказа», «Оплатить заранее», код выдачи с `ready`, блок возврата, фразы ленты для событий 1B. Ссылка на оплату и QR клиенту в мессенджер не уходят никогда.

### Бот продавца

Бот (`apps/worker/src/bots/seller`, long polling) рисует карточку заказа из базы: номер, схема оплаты, сумма, дата, позиции «Бренд Артикул × кол-во — состояние», клиент `•••4567`, причина проблемы и кнопки, которые сейчас разрешает машина состояний. Нажатие (`callback_data = a:<действие>:<id>:<nonce>`, не длиннее 64 байт) выполняет действие и перерисовывает карточку с новым nonce; устаревшая карточка отвечает «Карточка устарела, откройте свежую». Кнопки: «Проверить и заказать», «Заказать всё равно», «Аналог», «Новый срок», «Отменить позицию», «Проблема с позицией», «Приехало», «Счёт оплачен» (владелец), «Клиент пришёл», «Повторить чек», «Выставить оплату» (QR фото только в чат продавцов), «Выдал» (только при succeeded чеке), «Клиент не пришёл», «Отменить заказ и вернуть деньги», «Отказ клиента», «Открыть в админке». Команды: `/ping` (фаза 0), `/queues` (владелец: очереди и последние 10 задач dead-letter с кнопкой «Повторить»), `/kits` (шаг 5, `docs/kits.md`: ссылка на `/admin/kits`). Шаг 7 (`docs/month-close.md`): у детали, которую надо вернуть Rossko, строка «Вернуть Rossko до <дата>: БРЕНД АРТИКУЛ × кол-во» и кнопки «Сдал водителю» (статус `shipped`) и «Не берут» (деталь на склад по закупке) — любой сотрудник, повторное нажатие ничего не меняет. Шаг 8 (`docs/rossko-automation.md`): после «Проверить и заказать», пока заказ едет от поставщика, — строка «Автозаказ бы: ДА» или «Автозаказ бы: НЕТ — <причины>»; карточки сроков приходят с заголовками «Не заказано у поставщика», «Срок поставщика под угрозой», «Срок сорван», «Не забирают», опрос Rossko — «Отгружено Rossko» с кнопками «Приехало».

### Очереди и задачи

Очереди BullMQ с префиксом `detaly:bull`; логический ключ задачи хранится в `outbox.job_id`, в BullMQ уходит с `|` вместо `:`.

| Очередь | Задачи | Попытки | Что делают |
|---|---|---|---|
| `payments` | `webhook` `{webhookEventId}`, `payment-create` `{paymentId}` (QR на точке), `payment-recheck` `{paymentId}`, `refund-create` `{refundId}` | 5, экспонента от 10 с | перечитывают платёж или возврат у ЮKassa и применяют ответ; создают QR-платёж и возвраты с тем же `Idempotence-Key` |
| `receipts` | `offset` и `offset-poll` `{receiptId}`, `payment-receipt` `{receiptId}` | 3 | чек зачёта аванса по «Клиент пришёл» и статус чека в составе платежа; опрос раз в 2 мин, через 15 мин без `succeeded` — алерт, «Выдал» заблокирована |
| `rossko` | `recheck` `{orderId, eventId, staffId}`, `checkout` `{supplierOrderId}`, `recover` `{supplierOrderId}` | 3; `checkout` — ровно 1 | перепроверка цен мимо кэша; GetCheckout одной попыткой (строка `supplier_orders` пишется до вызова); после таймаута — поиск заказа через GetOrders по комментарию `DT-000123/<попытка>`, без повтора GetCheckout |
| `notify` | `order` `{orderEventId, audience, template}`, `alert` | 5, экспонента от 30 с | карточки продавцам, сообщения владельцу, SMS клиенту по allowlist (строка `notifications` с `dedupe_key` до отправки), алерты |
| `reconciliation` | `sweep` (каждые 10 мин), `nightly` (03:15 Asia/Yekaterinburg) | 1 | pending-платежи и возвраты с id ЮKassa — перечитать на каждом проходе, без id старше 10 мин — повторить POST с тем же ключом; ночная сверка платежей магазина за сутки — только алерты |
| `housekeeping` | `heartbeat` (30 с), `timers` (1 мин), `reminders` (15 мин), `sms-budget` (1 ч), `deferred-1a` (10 мин) | 1 | сроки по `orders.expires_at` и `client_approvals.expires_at` (оплата, подтверждение, QR, хранение, завершение, ответ клиента); напоминания; алерты SMS-бюджета 80 % и 100 %; отложенные эффекты заказов 1A |
| `dead-letter` | `dead` | — | задачи, исчерпавшие попытки: исходная очередь, данные, ошибка без ПД; алерт в чат продавцов; повтор — `/queues` |

### Переменные 1B

Полный список с комментариями — `.env.example`. Новые в 1B — `SMS_LOGIN`, `SMS_API_URL`, `SMS_PRICE_KOP`; остальные были в схеме с фазы 0 и с 1B используются.

| Переменная | По умолчанию | Что |
|---|---|---|
| `YOOKASSA_SHOP_ID`, `YOOKASSA_SECRET_KEY` | пусто | магазин ЮKassa (на stage — тестовый). Оплата включена, только когда заданы оба и оба кода ниже |
| `YOOKASSA_VAT_CODE` | пусто | код ставки НДС в чеке (ожидаем `1` — без НДС, VERIFY Ю4) |
| `YOOKASSA_TAX_SYSTEM_CODE` | пусто | код системы налогообложения (ожидаем `2` — УСН «доходы», VERIFY Ю4) |
| `YOOKASSA_WEBHOOK_IP_ALLOWLIST` | пусто | IP и подсети уведомлений ЮKassa через запятую; пусто — все уведомления получают 403 |
| `YOOKASSA_API_URL` | `https://api.yookassa.ru/v3` | адрес API (в e2e — мок) |
| `YOOKASSA_RETURN_URL` | пусто | в 1B не используется: возврат всегда на `APP_BASE_URL/o/<token>?paid=1` |
| `TRUSTED_IP_HEADER` | `none` | `x-real-ip` за Caddy; без него вебхуки ЮKassa получают 403 |
| `ADMIN_BASIC_AUTH` | пусто | `user:password` админки; пусто — `/admin` отвечает 404 |
| `ROSSKO_ALLOW_CHECKOUT` | `false` | `true` разрешает GetCheckout; при `false` заказ уходит в «требует внимания» для ручного заказа в ЛК Rossko |
| `ROSSKO_DELIVERY_ID`, `ROSSKO_PAYMENT_ID`, `ROSSKO_ADDRESS_ID` | пусто | id доставки, оплаты и адреса из GetCheckoutDetails; без первых двух GetCheckout не вызывается |
| `TG_SELLER_BOT_TOKEN`, `TG_SELLER_CHAT_ID` | пусто | бот продавца и чат продавцов (фаза 0); без них карточки не отправляются (в логе worker `seller card: … skipped`), карточки и алерты записываются в `notifications` как `skipped` |
| `SMS_PROVIDER` | `none` | `smsaero` или `smsc`; `none` — клиентские уведомления без мессенджера `skipped` |
| `SMS_LOGIN` [1B] | пусто | логин SMS Aero (e-mail) или smsc.ru |
| `SMS_API_KEY`, `SMS_SENDER` | пусто | ключ (пароль) и подпись отправителя (для SMS Aero обязательна) |
| `SMS_API_URL` [1B] | пусто | переопределение адреса шлюза; пусто — `https://gate.smsaero.ru/v2` или `https://smsc.ru/sys` |
| `SMS_PRICE_KOP` [1B] | `500` | цена одного SMS в копейках для бюджета (VERIFY: тариф) |
| `SMS_MONTHLY_BUDGET_RUB` | пусто | месячный бюджет SMS: 80 % — алерт, 100 % — SMS не отправляются; пусто — без ограничения |

Пороги сроков (`order.payment_ttl_min`, `order.on_pickup_confirm_ttl_h`, `pickup.window_*_days`, `handover.qr_ttl_min`, `handed.complete_days`, `approval.timeout_h`, `rossko.prepay_invoice` и другие) лежат в таблице `settings`; страницы настроек в админке в 1B нет, меняются SQL (`docs/runbook.md`, 12.4).

## Фаза 1C: клиентский бот, уведомления клиенту, ручной VIN, претензии, запись на установку

Разбивка и решения С1–С28 — `docs/phase-1c-implementation.md`; эксплуатация (BotFather
клиентского бота, хранилище фото, претензии, VIN-заявки, запись на установку, печать PDF,
ретенция, ручные пункты V9/V10) — `docs/runbook.md`, раздел 14; неподтверждённые поля Telegram и
S3 — `docs/external.md`, раздел 8. Живые Telegram, S3, ЮKassa и Rossko в 1C не проверялись: всё
на подменённом транспорте grammY, msw и фикстурах.

Сквозной прогон 1C — `bash scripts/e2e-1c.sh` после `scripts/dev-db.sh up` и
`eval "$(scripts/dev-db.sh env)"`: миграции и сид, standalone-сборка web, мок ЮKassa, worker без
токенов Telegram, все спеки Playwright 1A–1C (375 и 1280) и проверка логов на телефоны, VIN и
токены. Лучше на отдельной базе Redis: `E2E_REDIS_URL=redis://127.0.0.1:56379/7`.

Уведомления клиенту уходят через клиентский бот, если клиент его подключил (MAX — фаза 2),
иначе SMS по allowlist, иначе `skipped` с `fallback_reason`. В сообщениях Telegram только номер
заказа, статус, бренд и артикул, даты, адрес и часы точки выдачи, код выдачи, фото упаковки и
ссылки на `/o/<token>` или `/p/<token>`; телефона, имени и адреса клиента нет (решение С2).

### Боты

**Клиентский бот** (`apps/worker/src/bots/client`, grammY, long polling, `TG_CLIENT_BOT_TOKEN`,
только личные чаты, свой перезапуск опроса — `runner.ts`):

| Вход | Что делает |
|---|---|
| `/start <код>` (deep link со страницы заказа) | одноразовая ссылка (24 ч) → кнопка `request_contact`, ожидание 10 мин в Redis `client:bind:<id>`; свой контакт с номером заказа → привязка (`messenger_bindings`, журнал `messenger_bound`) и список заказов; чужой номер — привязки нет; использованная или просроченная ссылка — «Ссылка устарела» |
| `/start` | привязан — список заказов; отключал уведомления — включает снова; иначе — как подключить |
| `/orders`, «Мои заказы» | до 5 последних заказов: номер, статус, бренд и артикул, ближайший шаг; кнопки по статусу |
| `/garage`, «Мои машины» | шаг 6 (`docs/garage.md`), только при `GARAGE_ENABLED=true`: до 10 машин клиента, у каждой до 3 последних заказов; VIN — только последние 4 символа; «Купить снова» — новая подборка `/p/<token>` с теми же деталями по сегодняшним ценам (`priceOffer`, правило подборки по VIN), строки, которых нет или которые не продаём онлайн, пропускаются с пометкой; «Удалить машину» → «Да, удалить» — запись удаляется, у заказов пропадает ссылка на машину; при выключенном переключателе команды нет, старые кнопки отвечают «Кнопка устарела — откройте /orders» |
| `/stop`, «Отключить уведомления», блокировка бота | `messenger_bindings.blocked_at`, дальше SMS по allowlist |
| «Подтверждаю», «Согласен» | `performClientAction` от имени владельца заказа (привязка проверяется на каждое нажатие) |
| «Вернуть деньги», «Отказаться», «Претензия» | только кнопка-ссылка на `/o/<token>` (подтверждение 4 цифрами телефона там) |
| «Записаться на установку» | до 6 свободных окон кнопками (выбор — nonce в Redis `client:slot:<nonce>`, 15 мин) → `bookInstall` (via `bot`); занято — свежий список |
| прочий текст и фото | автоответ с `PICKUP_PHONE` (переписка — фаза 2) |

**Бот продавца** в 1C (пакет `seller-bot-1c`): в карточке заказа — претензия («Принял возврат»
с фото, решение с текстом ответа, «Замена выдана»), запись на установку (подтвердить, отклонить,
выполнено, не приехал), «Фото упаковки»; карточки VIN-заявок с ответом строками и превью.

Шаг 6 (`docs/garage.md`, только при `GARAGE_ENABLED=true`): после «Выдал», если у заказа есть машина, бот спрашивает «Пробег? (ответьте числом или нажмите «Пропустить»)» — ответ на это сообщение в течение 10 минут записывает пробег (источник `handover`); меньше записанного — переспрашивает, исправление ошибки — тем же числом ещё раз; отвечать может только сотрудник; выдачу вопрос не задерживает и не отменяет, ошибка отправки только пишется в лог.

Оба бота живут в процессе worker: стартуют после регистрации Job Schedulers, по SIGTERM
останавливаются параллельно до остановки dispatcher и очередей (`apps/worker/src/shutdown.ts`).

### Страницы и эндпоинты 1C

Контракты — `docs/phase-1c-implementation.md`, разделы 10–11; изменяющие запросы проверяют
`Origin`, лимиты — решение С27.

| Метод и путь | Что |
|---|---|
| `POST /api/orders/<token>/link` | «Статусы в Telegram»: одноразовый link token → 303 на `t.me/<TG_CLIENT_BOT_USERNAME>?start=<код>`; без username — кнопка неактивна; 20 в час |
| `POST /api/orders/<token>/install`, `…/install/cancel` | запись на установку `{slotAt, requestKey}` и её отмена клиентом (не позже чем за 2 ч); без цены; 20 в час |
| `POST /api/orders/<token>/claims` | претензия: вид, текст, до 3 фото, 4 цифры телефона (multipart); 10 в час |
| `GET /api/orders/<token>/photos/<photoId>` | фото упаковки и выдачи этого заказа, `Cache-Control: private, no-store` |
| `/vin`, `POST /api/vin`, `/vin/sent`, `/vin/sent/<код>` | форма VIN-заявки (только при открытом гейте РКН), до 3 фото; 5 в час и 20 в сутки |
| `/p/<token>`, `POST /api/proposals/<token>/take` | подборка мастера (noindex, `no-referrer`) и перенос её в корзину → `/checkout`; 30 в час |
| `/admin/vin`, `/admin/vin/<id>`, блоки «Претензии», «Запись на установку», «Фото» в карточке заказа, `GET /api/admin/files/<ключ>` | админка 1C за Basic auth |
| `/admin/prices`, `POST /api/admin/prices`, `/admin/pricing`, `POST /api/admin/pricing` | шаг 2 (`docs/pricing.md`): сравнение цен с конкурентами и отчёт по группам; поправки к наценке по группам с предпросмотром, «подтверждаю» и журналом `settings_audit`; Basic auth |
| `GET /o/<token>/review/<yandex\|2gis>` | шаг 3 (`docs/reviews.md`): кнопки отзывов из сообщений и со страницы заказа; первое открытие по площадке — журнал `review_link_opened` (статус не меняется), затем 302 на `REVIEW_URL_*`; `no-referrer`, `no-store`, noindex; неизвестная площадка, ссылка не задана, чужой токен — 404; в демо `/o/demo/review/*` без записи |
| `/review` | шаг 3: страница для QR-таблички — большие кнопки «Яндекс Карты» и «2ГИС» (прямые ссылки), телефон пункта выдачи; noindex, не в sitemap; без ссылок — 404 |
| `/admin/reviews`, `POST /api/admin/reviews`, `/admin/reviews/sign`, `GET /api/admin/reviews/qr` | шаг 3: ссылки на отзывы (заданы или нет), рейтинг с карточек (`reviews.snapshot` через писатель настроек с `settings_audit`), что видно на витрине, воронка за 30 и 90 дней, табличка A5/A4 с QR на `/review` и QR файлом SVG; Basic auth |
| `POST /api/fit-checks` | шаг 4 (`docs/fit-check.md`): «Отправить мастеру» из корзины — VIN, комментарий, строки своей корзины (чужие id — 422), honeypot; при закрытом гейте тело не читается и ничего не сохраняется; 20 в сутки на клиента и 10 на корзину (429 с понятным текстом); одна карточка в чат продавцов на отправку; в демо прокси отвечает 303 на `/cart?fit_demo=<строка>`, не читая тело |
| `POST /api/cart/items/<id>/fit` | шаг 4: «Заменить» (аналог мастера снова ищется у поставщика и ставится на место строки, цена через `priceOffer`) и «Оставить как есть»; только строка своей корзины |
| `POST /api/cart/items` с `then=check` | шаг 4: «Проверить под мою машину» на карточке поиска — кладёт предложение в корзину и открывает `/cart?check=<строка>` с формой |
| `/admin/fit-checks`, `POST /api/admin/fit-checks` | шаг 4: заявки на проверку (детали, ответы, кто и когда), статистика за 7 и 30 дней, ответы без Telegram, срок ответа `fit_check.sla_minutes` через писатель настроек с `settings_audit`; Basic auth, в демо 404 |
| `/to`, `/to/<марка>`, `/to/<марка>/<модель>` | шаг 5 (`docs/kits.md`): наборы для ТО — марки и модели с опубликованными наборами; на странице модели все её наборы (якорь `#<двигатель>`) с ценами на сейчас через `priceOffer`, выбором аналога, «Получение к …» и «Весь набор в корзину»; модель или марка без опубликованных наборов — 404; в sitemap только опубликованные (никогда в демо и на стейдже); в демо — два примера с пометкой «Пример набора» |
| `POST /api/cart/kits` | шаг 5: «Весь набор в корзину» — Origin, лимит записей корзины, тело до 8 КБ; выбранные строки по одной через сервис корзины (цена через `priceOffer`), строки, которых нет у поставщика, пропускаются → 303 на `/cart?kit=<N>&kit_skipped=<K>`; набор изменился, пока страница была открыта, — 303 обратно к набору; в демо — демо-корзина |
| `/admin/kits`, `/admin/kits/<id>`, `POST /api/admin/kits` | шаг 5: наборы — список, редактор (строки «БРЕНД АРТИКУЛ КОЛ-ВО — Название», аналоги «или …»), «Проверить» у поставщика правилом подборки по VIN, «Сохранить», «Опубликовать» (только когда все основные позиции есть у поставщика и нет маркируемых), «Снять с публикации», удаление черновика с «подтверждаю»; Basic auth, Origin, версия набора (409); в демо 404 |
| `/checkout`, `POST /api/checkout` с `vehicle` | шаг 6 (`docs/garage.md`): свёрнутый блок «Моя машина (необязательно)» — `vehicle {make, model, engine, year, vin, mileage}`; подстановка только из своей корзины (набор для ТО, заявка по VIN, «Купить снова»), никогда по телефону; машина сохраняется в транзакции заказа (`user_vehicles`, `orders.vehicle_id`), пустой блок ничего не сохраняет, неверные поля — 422 `validation` с полями `vehicle*`; при `GARAGE_ENABLED=false` поле не читается; в демо блок с примером, ничего не отправляется |
| `/o/<token>`, `/p/<token>` (повтор) | шаг 6: на странице заказа «Для: Lada Vesta 1.6, 2019» (без VIN и пробега); подборка «Купить снова» — «Повтор заказа N» по сегодняшним ценам с пометкой о пропущенных строках |
| `/admin/orders/<id>` (шаг 6) | машина заказа (полный VIN, пробег с датой, источник) и машины клиента в его блоке; отдельной страницы нет |
| `/admin/month?m=ГГГГ-ММ`, `POST /api/admin/month` | шаг 7 (`docs/month-close.md`): закрытие месяца (по умолчанию прошлый) — выручка по чекам, маржа (эквайринг — оценка `finance.acquiring_bp`), акт пункта выдачи (операции × `contract.rates`, «Ставки не заданы» при нулевых), «Сверить» с ЮKassa (`action=reconcile`: платежи и возвраты месяца, снимок в `finance_reconciliations`, ошибки ЮKassa показываются), «Не доход» (деньги Rossko за возвраты) и чек-лист банка; Basic auth, Origin; в демо 404 |
| `/admin/month/act?m=…`, `GET /api/admin/month/csv?m=…` | шаг 7: печатная форма акта A4 (стороны из env `CONTRACTOR_REQUISITES_*`, `CONTRACT_*`, `SELLER_REQUISITES_*`; предупреждения только на экране) и CSV операций «Дата;Заказ;Операция;Ставка, ₽» (UTF-8 с BOM) |
| `/admin/month/rates?m=…`, `POST /api/admin/month` (`action=rates`) | шаг 7: ставки договора с пунктом выдачи — предпросмотр итога акта «сейчас → станет», «подтверждаю», версия (409), журнал `settings_audit` |
| `/admin/returns`, `/admin/stock`, `POST /api/admin/returns` | шаг 7: возвраты Rossko (просроченные первыми) — «Сдал водителю», «Не берут», «Деньги вернулись» с суммой; склад — себестоимость, причина, «Списать» с «подтверждаю»; повтор отвечает «Уже отмечено» |
| `/admin/rossko`, `POST /api/admin/rossko` | шаг 8 (`docs/rossko-automation.md`): таблица кодов статусов GetOrders → действие (`action=map`, рядом увиденные опросом названия и счётчики), переключатель опроса (`action=poll`, с предупреждением без `ROSSKO_MODE=live`), срок «Не заказано у поставщика» (`action=within`), отсечки Rossko (`action=cutoffs`), порог теневого автозаказа (`action=max_total`) — каждое через писатель настроек с `settings_audit` и версией (409); Basic auth, Origin; в демо 404 |
| `/admin/auto-order` | шаг 8: теневой автозаказ за 30 и 90 дней — решения, совпадения с мастером, причины «НЕТ», вывод одной строкой («совпадений N из M — можно обсуждать автозаказ» только от 30 решений и 95%); только чтение, переключателя настоящего автозаказа нет; в демо 404 |
| `/print/pamyatka-vozvrat.pdf`, `/print/akt-vydachi.pdf` | статические памятка о возврате и акт выдачи (реквизиты от руки) |

### Очереди и задачи 1C

| Очередь | Задача | Что |
|---|---|---|
| `notify` | `order` (клиент) | клиентский Telegram (с фото упаковки к «Приехало») перед SMS; 403 → `blocked_at` и SMS по allowlist |
| `notify` | `vin` `{vinRequestId, audience, template, key}` | карточка заявки продавцам, `vin_received` и `vin_proposal` клиенту (в allowlist SMS только `vin_proposal`) |
| `housekeeping` | `reminders` (+ виды 1C) | VIN без ответа 4 ч (в рабочие часы), дедлайн претензии за 2 дня владельцу, установка за 24 ч клиенту; напоминания 3/6/9 «приехало» из 1B остаются |
| `housekeeping` | `retention` (04:40 Asia/Yekaterinburg) | удаление фото VIN-заявок старше 90 дней; в логе только счётчики |
| `housekeeping` | `price-check` (пн 10:00 Asia/Yekaterinburg) | шаг 2: «Пора сверить цены» в чат продавцов со ссылкой на `/admin/prices`, если за 7 дней меньше 20 сравнений |
| `housekeeping` | `reminders` (вид `review`) | шаг 3: одно напоминание об отзыве через `reviews.reminder_days` (3) после завершения, только в мессенджер и если ссылку не открывали, претензий после выдачи нет, ссылки заданы; ещё раз проверяется перед отправкой |
| `housekeeping` | `reviews-check` (пн 10:05 Asia/Yekaterinburg) | шаг 3: «Отзывы: обновите рейтинг в /admin/reviews…» в чат продавцов, если ссылки заданы и рейтинг не обновляли 7 дней |
| `notify` | `fit` `{requestId, kind, key, note?}` | шаг 4: карточка «Проверка применимости» в чат продавцов (`card`), одно напоминание по сроку (`reminder`), перерисовка после ответа из админки, истечения или отмены (`refresh`) |
| `housekeeping` | `fit-checks` (каждые 5 мин) | шаг 4: проверки без ответа до закрытия пункта в следующий рабочий день (не меньше 24 ч; без `PICKUP_HOURS` — 24 ч) → «не успели ответить» (карточка перерисовывается); одно напоминание по заявке, когда ожидание превысило `fit_check.sla_minutes` (60) минут рабочего времени пункта |
| `housekeeping` | `retention` (+ шаг 4) | VIN и комментарий проверок применимости стираются через 90 дней после заявки; в логе только счётчик |
| `housekeeping` | `reminders` (виды `supplier_return`, `supplier_return_1d`, `supplier_return_overdue`) | шаг 7: деталь ещё в точке — в чат продавцов за 3 дня, за 1 день до `orders.supplier_return_deadline_at` и после срока; по одному, после перерыва только последнее |
| `housekeeping` | `reminders` (алерт `supplier-refund-due:<id>`) | шаг 7: «Сдал водителю» 10 дней назад, а «Деньги вернулись» нет — одно сообщение владельцу (GetSettlements — фаза 4) |
| `housekeeping` | `month-close` (1-го в 09:00 Asia/Yekaterinburg) | шаг 7: «Закрытие <месяца>: выручка …, маржа …, операций для акта …, расхождений с ЮKassa: проверить» владельцу со ссылкой; без чата владельца — в чат продавцов без сумм; один раз за месяц |
| `housekeeping` | `finance-reminders` (ежедневно 09:10 Asia/Yekaterinburg) | шаг 7: акт (3-е), сверка с банком (5-е), срок налога АУСН (25-е) из `finance.reminder_days`, по одному за месяц; пропущенный день догоняется в течение 2 дней |
| `housekeeping` | `rossko-deadlines` (каждые 10 мин) | шаг 8 (`docs/rossko-automation.md`): карточка заказа в чат продавцов, по одной на заказ и вид (ключ `reminder:<заказ>:rossko_<вид>:1`) — «Не заказано у поставщика» (дольше `rossko.order_within_minutes` рабочих минут), «Срок поставщика под угрозой» (конец рабочего дня перед обещанной датой), «Срок сорван» (первый рабочий день после неё), «Не забирают» (больше 3 рабочих дней в пункте); часы пункта из `PICKUP_HOURS` |
| `housekeeping` | `rossko-cutoff` (каждые 5 мин по часам, Asia/Yekaterinburg) | шаг 8: за 25 минут до отсечки из `rossko.cutoff_times` в рабочий день, если есть незаказанные заказы, — «Через 25 минут отсечка Rossko (11:00): не заказано N заказов», один раз на отсечку (`alert:rossko-cutoff:<дата>:<время>`) |
| `rossko` | `poll-orders` (каждые 20 мин) | шаг 8: опрос GetOrders открытых заказов поставщику пачками до 20 номеров (приоритет `search`: стоп на предохранителе квоты); только с `ROSSKO_MODE=live` и `rossko.poll_enabled`, по умолчанию ничего не делает; по новому коду — действие из `rossko.order_status_map` («отгружен на точку» — карточка «проверьте приёмку», «отказ» — `item_problem` «отказ поставщика» не больше раза на позицию, незаданный код — одно сообщение на заказ и код) |
| `rossko` | `recheck` (+ шаг 8) | после перепроверки — теневой автозаказ `shouldAutoOrder`: событие `auto_order_shadow` (решение, причины, `masterOrdered`) и строка «Автозаказ бы: ДА / НЕТ — причина» в карточке продавца; ничего не заказывает |

### Настройки шага 8 (таблица `settings`)

Меняются на `/admin/rossko` (`docs/rossko-automation.md`, раздел 6): `rossko.order_status_map` — код статуса GetOrders → `shipped_to_point` / `refused` / `in_progress` / `ignore` (по умолчанию `{}`: коды неизвестны, ни один ничего не делает); `rossko.poll_enabled` (`false`); `rossko.order_within_minutes` (`120`); `rossko.auto_order_max_total_kop` (`1500000` = 15 000 ₽); `rossko.cutoff_times` (`[]`). У `supplier_orders` (миграция 0011) — `status_code`, `status_name`, `status_checked_at`, `status_changed_at` и `rossko_statuses` (последний статус каждого заказа Rossko попытки).

### Переменные 1C

| Переменная | По умолчанию | Что |
|---|---|---|
| `TG_CLIENT_BOT_TOKEN` | пусто | клиентский бот; без него бот не стартует, клиентам — SMS по allowlist |
| `TG_CLIENT_BOT_USERNAME` | пусто | username клиентского бота для deep link; без него «Статусы в Telegram» неактивна |
| `FILES_STORAGE` | `none` | `none` (фото выключены), `local` (каталог `FILES_LOCAL_DIR`, разработка и e2e), `s3` (нужны `S3_ENDPOINT`, `S3_KEY`, `S3_SECRET` и бакет); в `DEMO_MODE` только `none` |
| `FILES_LOCAL_DIR`, `FILES_S3_BUCKET`, `FILES_S3_PREFIX` | `var/files`, `S3_BUCKET`, `files/` | где лежат фото |
| `FILES_MAX_UPLOAD_MB` | `8` | предел одного фото (1–12) |
| `INSTALL_PARTNER_NAME`, `INSTALL_PARTNER_REQUISITES` | пусто | партнёр по установке для текста «оплачивается в сервисе по его чеку»; без имени запись скрыта |
| `PICKUP_PHONE` | пусто | телефон точки в автоответе клиентского бота |
| `FIT_GUARANTEE_ENABLED` | `false` | шаг 4 (`docs/fit-check.md`): гарантия подбора — строка «Не подойдёт по применимости — вернём деньги» под «Проверено мастером», раздел «Гарантия подбора» на `/returns`, `order_items.fit_guarantee`; включать после решения фаундера и текста юриста |
| `GARAGE_ENABLED` | `false` | шаг 6 (`docs/garage.md`): «Моя машина» — блок на оформлении, «Для: …» на странице заказа, `/garage` в боте покупателя, пробег при выдаче, машины в админке; выключенный ничего не собирает, не хранит и не показывает; включать после текста юриста (`docs/legal-drafts/garage.md`) и новых редакций политики и согласия |
| `CONTRACTOR_REQUISITES_NAME`, `CONTRACTOR_REQUISITES_INN`, `CONTRACTOR_REQUISITES_OGRNIP`, `CONTRACTOR_REQUISITES_ADDRESS` | пусто | шаг 7 (`docs/month-close.md`): пункт выдачи — исполнитель в акте за месяц (ИНН 10/12 цифр, ОГРНИП 15 или ОГРН 13); пусто — пустые строки в печатной форме и подсказка на экране |
| `CONTRACT_NUMBER`, `CONTRACT_DATE` | пусто | шаг 7: номер и дата (`ГГГГ-ММ-ДД`) договора с пунктом выдачи в заголовке акта |

Фаза 0 начинается с внешних действий (ОКВЭД, аккаунт Rossko и ключи API, домен, РКН, ЮKassa, проверка маркировки) параллельно с кодом; их статус — в `docs/external.md`.
