# detaly

Платформа перепродажи автозапчастей для Оренбурга: сайт, боты MAX и Telegram, приём оплаты через ЮKassa, заказ у поставщика Rossko, выдача и установка в автосервисе «Сервис56». Бренд, реквизиты продавца и точка выдачи берутся только из переменных окружения (`BRAND_NAME`, `SELLER_REQUISITES_*`, `PICKUP_*`).

Статус: фаза 0 завершена (каркас, поиск на фикстурах Rossko, документы, бот продавца, инфраструктура). Фаза 1A — корзина, оформление с согласиями и страница заказа **без оплаты и без уведомлений**: оплата, подтверждение и уведомления появятся в фазе 1B. В проде оформление до 1B не включается (`docs/runbook.md`, раздел 11.1).

## С чего начать

1. `docs/PLAN.md` — утверждённый поэтапный план: архитектура, модель данных, машина состояний заказа, интеграции (Rossko SOAP, ЮKassa, MAX/Telegram, VIN), UX, фазы с приёмкой, внешние и юридические шаги, риски, бюджет, проверка, первая неделя.
2. `docs/phase0-implementation.md`, `docs/phase-1a-implementation.md` — разбивка фаз на пакеты, решения по умолчанию, тест-кейсы, критерии приёмки.
3. `docs/runbook.md` — эксплуатация: установка, деплой, откат, бэкапы, инциденты, оформление заказов 1A.
4. `docs/external.md` — журнал внешних заявок и вопросов (Rossko, ЮKassa, РКН), в том числе VERIFY-вопросы к живому API.
5. `docs/research/research-brief.md`, `docs/research/design-review.md` — исследование и итоги проектирования.

## Устройство репозитория

| Путь | Что |
|---|---|
| `apps/web` | Next.js 16: сайт, API, `src/proxy.ts` (лимиты и заголовки) |
| `apps/worker` | BullMQ и бот продавца (grammY) |
| `packages/config` | схема env (`getEnv`), логгер, Redis-утилиты; env читается только через этот пакет |
| `packages/db` | Drizzle-схема, миграции, сид, тестовые базы |
| `packages/domain` | чистая логика: цены, даты, корзина, оформление, машина состояний |
| `packages/rossko` | клиент Rossko (SOAP), лимитер, кэш, фикстуры `fx:` |
| `packages/payments`, `packages/notify`, `packages/vin` | ЮKassa, уведомления, VIN (фазы 1B и далее) |
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
| `/o/<token>` | страница заказа по секретной ссылке: статус, дата получения, точка выдачи, способ оплаты, позиции, лента событий, отмена по последним 4 цифрам телефона | noindex, `Referrer-Policy: no-referrer` |

### Эндпоинты

Все изменяющие запросы проверяют `Origin` (равен origin `APP_BASE_URL`, без `Origin` — только `Sec-Fetch-Site: same-origin`, иначе 403). Цену и наценку клиент не передаёт никогда: их считает сервер.

| Метод и путь | Тело | Ответ |
|---|---|---|
| `POST /api/cart/items` | форма или JSON: `q` (артикул запроса), `offerId`, `qty` (необязательно) | форма: 303 на `/cart?added=1`, ошибка — 303 на `/cart?error=<code>`; JSON: 200 `{count, totalKop}`. Без cookie создаёт корзину и ставит cookie `cart`. Ошибки: 400, 403, 404 `offer_not_found`, 422 `excluded` / `qty` / `cart_full` / `too_many_searches`, 503 `supplier_unavailable` |
| `PATCH /api/cart/items/<id>` (или `POST` с `_method=patch`) | `qty` | 303 на `/cart` / 200; 404 чужая строка; 422 `qty` |
| `DELETE /api/cart/items/<id>` (или `POST` с `_method=delete`) | — | 303 на `/cart` / 200; 404 |
| `POST /api/checkout` | JSON `{part, phone, name, channel, acceptOffer, consentPd, consentMarketing, expectedTotalKop, itemsHash, checkoutKey, website}` | 201 `{orderUrl, number}`; повтор с тем же `checkoutKey` — 200 с тем же заказом; 409 `stale` `{changes, totalKop, itemsHash}` — цены или наличие изменились, заказ не создан; 422 `validation` / `consent_required` / `below_minimum` / `cart_too_large`; 400 `bad_request` / `rejected`; 403 `forbidden_origin` / `checkout_closed`; 404 `cart_empty`; 503 `supplier_unavailable` |
| `POST /api/orders/<token>/cancel` | JSON `{last4}` | 200 `{status: 'cancelled'}`; 422 `wrong_digits` с `attemptsLeft`; 429 после 5 неверных попыток за час; 409 `not_cancellable`; 503, если недоступен счётчик попыток |

Перед созданием заказа `POST /api/checkout` заново проверяет цены у Rossko мимо кэша (priority `critical`, ожидание лимитера не больше 5 с). Заказ, пользователь, согласия (`pd` и при желании `marketing`, с версией и sha256 текста, IP и браузером) и событие `order_events` создаются в одной транзакции. Заказ получает статус `awaiting_payment` (предоплата) или `awaiting_confirmation` (оплата при получении) по правилу машины состояний.

Лимиты на IP-бакет (`apps/web/src/proxy.ts`): оформление 10 в час, отмена 5 в час, изменения корзины 120 в час; неверные цифры при отмене — 5 в час на заказ. Подробнее — `docs/runbook.md`, раздел 11.6.

### Переменные 1A

| Переменная | По умолчанию | Что |
|---|---|---|
| `CART_TTL_DAYS` | `30` | срок жизни cookie корзины `cart` в днях (`Max-Age`). Строки корзин в базе по нему не удаляются: очистка — housekeeping фазы 1B |
| `RKN_NOTICE_NUMBER` | пусто | номер записи в реестре операторов ПД; пока пусто, оформление закрыто. В проде до 1B не задавать |
| `LEGAL_OFFER_VERSION`, `LEGAL_PRIVACY_VERSION`, `LEGAL_CONSENT_PD_VERSION`, `LEGAL_CONSENT_MARKETING_VERSION` | пусто | опубликованные версии документов; при `NODE_ENV=production` без опубликованных оферты, политики и согласия ПД оформление закрыто |
| `APP_BASE_URL` | `http://localhost:3000` | публичный origin сайта: с ним сравнивается `Origin` изменяющих запросов |
| `TRUSTED_IP_HEADER` | `none` | `x-real-ip` за Caddy (в compose задан). При `none` все клиенты делят один бакет лимитов, а `consents.ip` пишется пустым |

### E2E фазы 1A

Сценарии лежат в `apps/web/e2e/` (`checkout.spec.ts`, `limits.spec.ts`, `screens.spec.ts`) и идут против собранного standalone-сервера на :3100 в двух проектах: `mobile` 375×812 и `desktop` 1280×800. Скриншоты сохраняются в `apps/web/test-results/screens/`. Env совпадает с job `e2e` в `.github/workflows/ci.yml` (и разделом 15 `docs/phase-1a-implementation.md`):

```sh
scripts/dev-db.sh up && eval "$(scripts/dev-db.sh env)"
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

Важно: standalone-сервер работает с `NODE_ENV=production`, поэтому оформление в e2e откроется только с опубликованными версиями документов (`LEGAL_*_VERSION` при сиде) и `APP_BASE_URL`, равным адресу сервера. `TRUSTED_IP_HEADER=x-real-ip` нужен, чтобы каждый прогон шёл со своим случайным `X-Real-IP` из `playwright.config.ts` и не упирался в лимиты прошлых прогонов. Для e2e используйте отдельную базу: сид публикует версии, а опубликованный текст потом нельзя изменить.

Фаза 0 начинается с внешних действий (ОКВЭД, аккаунт Rossko и ключи API, домен, РКН, ЮKassa, проверка маркировки) параллельно с кодом; их статус — в `docs/external.md`.
