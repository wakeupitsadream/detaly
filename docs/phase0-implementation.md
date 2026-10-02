# Фаза 0: детальная разбивка реализации

Дополнение к docs/PLAN.md, раздел «Текущий шаг». Написано архитектором 02.10.2026 по проверенному окружению. При расхождении приоритет у docs/PLAN.md; неоднозначность про отказ клиента при оплате на точке решена: такой заказ уходит в cancelled.


Ниже план, по которому агенты Opus 5.5 могут параллельно собрать каркас фазы 0 и ту часть 1A, что не требует сети. Он основан на `docs/PLAN.md` и на проверке окружения.

В окружении нашлись четыре вещи, которые меняют план:
1. `initdb` нельзя запускать от root. Пользователь `postgres` в системе есть, поэтому команды идут через `runuser`.
2. В `/opt/pw-browsers` лежит только chromium-1194, к нему подходит глобальный playwright 1.56.1. Скачивание браузеров запрещено (`PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1`).
3. rclone, shellcheck и caddy не установлены. Есть age, gpg, jq, yq и pg_dump 16.
4. В BullMQ 6 повторяющиеся задачи (repeatable jobs) удалены, вместо них Job Schedulers. ioredis стал необязательной peer-зависимостью. ioredis 6 по умолчанию работает по протоколу RESP3.

Поля Rossko взяты из открытого кода (mirikoff/rossko-api-manager, tamgdemaslo/vin_oil_mann):
1. Запрос GetSearch: `{KEY1, KEY2, text, delivery_id, address_id?}`.
2. Ответ: `*Result.success`, `message`, `PartsList.Part[]` с полями `brand, partnumber, name, stocks.stock[], crosses.Part[]`.
3. Поля склада: `id, price (строка), count, multiplicity, type, delivery, extra, description, deliveryStart, deliveryEnd`.
4. Ответ GetCheckout: `OrderIDS.id`, `DeliveryCost.cost`, `ItemsList.Item`, `ItemsErrorList.ItemError`.

## Сквозные решения

1. Turbo не ставим. Для двух приложений и семи пакетов хватает `pnpm -r` и `--filter`, а в Docker — `pnpm fetch` плюс `--filter`.
2. Внутренние пакеты не собираются. В `exports` указан `./src/index.ts`, режим `moduleResolution: Bundler`, относительные импорты без расширений. Next подключает пакеты через `transpilePackages`. Worker, миграции и скрипты запускаются через `node --import tsx`, в том числе в production.
3. Драйвер БД — `postgres` 3.4.9. `pg` не ставим.
4. TypeScript закрепляем на 6.0.3, Playwright — на 1.56.1.
5. Тесты с вводом-выводом идут против настоящих Postgres 16 и Redis 7, ioredis-mock не используем. Причины: лимитер на Lua и неизвестная совместимость ioredis-mock с ioredis 6.
6. Режим `ROSSKO_MODE=fixtures|live`. В режиме fixtures поиск работает до получения ключей и показывает плашку «демо-данные».
7. Юридические тексты лежат markdown-файлами в `content/legal/<kind>/<version>.md`. Сид кладёт их в `document_versions` с уже подставленными реквизитами из env и считает sha256 от итогового текста. Страницы читают только БД. Если текст уже опубликованной версии изменился, сид падает, и нужна новая версия. Так версионирование и consents в 1A не ломаются.
8. Бэкап шифруется age на публичный ключ, приватный ключ хранится у Максима офлайн. Запасной режим — `gpg --symmetric` с `BACKUP_PASSPHRASE` из PLAN.
9. Сторож за worker'ом — `healthwatch.sh` в backup-контейнере. Он не зависит ни от web, ни от worker.
10. Контракты определяются первыми. Шаг 0 объявляет все сторонние зависимости во всех `package.json`, пишет типизированные заглушки публичных API, один раз запускает `pnpm install` и коммитит lock.

## 1. Дерево файлов

| Путь | Назначение |
|---|---|
| `package.json` | `packageManager: pnpm@10.28.0`, `engines.node >=22.12`, `type: module`. Скрипты: `lint`, `format:check`, `typecheck` (`pnpm -r --parallel typecheck`), `test`, `test:unit` (`--exclude '**/*.int.test.ts'`), `build`, `db:migrate`, `db:seed`, `dev:web`, `dev:worker` |
| `pnpm-workspace.yaml`, `.npmrc` | `apps/*`, `packages/*`; `onlyBuiltDependencies: [esbuild]`, потому что pnpm 10 блокирует postinstall |
| `tsconfig.base.json` | ES2023, ESNext/Bundler, strict, noUncheckedIndexedAccess, verbatimModuleSyntax, noEmit, skipLibCheck, `types: ["node"]` |
| `eslint.config.js`, `prettier.config.js`, `.prettierignore`, `.editorconfig` | flat config: @eslint/js, typescript-eslint, eslint-config-prettier; для apps/web — @next/eslint-plugin-next |
| `.gitignore`, `.dockerignore` | node_modules, .next, .dev, test-results, `.env*` кроме `.env.example` |
| `.env.example` | все переменные PLAN с пометками фаз; переменные фазы 0 описаны в п. 6 |
| `vitest.config.ts` | `test.projects: ['packages/*','apps/*']` |
| `scripts/dev-db.sh` | `up/down/env/ensure-db/reset`; PG 16 на 127.0.0.1:55432, Redis на 56379, каталог `${DETALY_DEV_DIR:-/tmp/detaly-dev}`; под root команды через `runuser -u postgres` |
| `scripts/rossko-smoke.ts` | GetCheckoutDetails, GetSearch по `--articles`, GetOrders; пишет JSON и сырой XML (`client.lastResponse`) с замаскированными ключами; без ключей завершается с кодом 2 и текстом «ждём ключи» |
| `content/legal/{offer,privacy,consent_pd,consent_marketing,return_memo}/2026-10-d1.md` | черновики с frontmatter, плейсхолдерами `{{SELLER_NAME}}`, `{{SELLER_INN}}` и плашкой «черновик» |
| `packages/config/src/` | `env.ts` (zod), `redis.ts`, `rate-window.ts`, `heartbeat.ts`, `logger.ts` (pino), `queues.ts` |
| `packages/domain/src/` | `statuses.ts`, `types.ts`, `money.ts`, `pricing.ts`, `dates.ts`, `excluded.ts`, `offers.ts`, `state-machine/{transitions,guards,index}.ts` |
| `packages/db/` | `drizzle.config.ts`, `drizzle/` (SQL), `src/schema/*.ts`, `src/{client,migrate,seed,testing}.ts`, `src/seed/{settings,staff,excluded,legal}.ts` |
| `packages/rossko/` | `src/{client,soap-caller,fixture-caller,limiter,cache,mapper,normalize,errors}.ts`, `fixtures/`, `test/wsdl/GetSearch.wsdl` |
| `packages/payments/src/` | `types.ts`, `payment-provider.ts`, `receipt-provider.ts`, `testing/yookassa-handlers.ts` (msw) |
| `packages/notify/src/` | `notifier.ts`, `templates/{ping,order}.ts`, `drivers/telegram.ts` (заглушка и `buildCallbackData` с проверкой ≤64 байт) |
| `packages/vin/src/` | `types.ts`, `vin.ts` (`isValidVin`: 17 символов без I/O/Q), `manual-resolver.ts` |
| `apps/web`, `apps/worker` | содержимое описано в п. 6 и 7 |
| `infra/` | `docker-compose.yml`, `Caddyfile`, `docker/{web,worker}.Dockerfile`, `backup/{Dockerfile,crontab,backup.sh,restore.sh,healthwatch.sh}`, `deploy.sh`, `certs/README.md` |
| `.github/workflows/ci.yml` | jobs check, e2e, images |
| `docs/external.md`, `docs/budget.md`, `docs/runbook.md` | таблица заявок с датами и вопросами к Rossko и ЮKassa; бюджет и порог своей ККТ; деплой, откат, восстановление, «worker молчит», квота Rossko, инцидент с ПД (24/72 ч), проверка реального IP за Docker NAT |

## 2. Порядок работ и рабочие пакеты

Работа идёт волнами:
1. Шаг 0 выполняется последовательно в рабочей ветке.
2. Волна A — четыре пакета параллельно в отдельных worktree: П1, П2, П3, П4.
3. После слияния волны A — волна B, два пакета параллельно: П5 и П6.
4. Шаг И — последовательная интеграция и проверка.

Правила для параллельных агентов:
1. Агент правит только свои пути. Корень, lock, `packages/config` и контрактные файлы `statuses.ts` и `types.ts` после шага 0 доступны только на чтение.
2. Установка в worktree: `pnpm install --frozen-lockfile --prefer-offline`. Store общий, установка идёт быстро.
3. Если нужна новая зависимость, агент добавляет её только в свой `package.json`. Lock не коммитит (`git checkout pnpm-lock.yaml`), итоговый lock пересобирает шаг И.
4. Тестовая БД своя у каждого worktree: `dev-db.sh ensure-db` создаёт `detaly_test_<worktree>`. Redis общий, ключи с префиксом `test:<uuid>:`, `FLUSHDB` запрещён.
5. Новые переменные окружения агент перечисляет в отчёте, сам `env.ts` не правит.
6. Работа идёт в ветке `wp/<n>-<name>`. Коммит делается после зелёной команды проверки.

| Пакет | Файлы и ключевые экспорты | Тесты | Проверка и критерий готовности |
|---|---|---|---|
| Шаг 0. Каркас | Все корневые файлы, `dev-db.sh`, полный `packages/config`. Для каждого workspace: `package.json` со всеми зависимостями точными версиями, `tsconfig.json`, `vitest.config.ts`, `src/index.ts` с заглушками (`throw new Error('not implemented')`). Экспорты config: `parseEnv`, `getEnv` (ленивый), `createRedis(url,{protocol:2})`, `slidingWindowHit(redis,{key,limit,windowMs,now})` → `{allowed,count,retryAfterMs}`, `dailyCounterHit`, `mskDayKey(date)`, `HEARTBEAT_KEY`, `writeHeartbeat`, `readHeartbeatAgeSec`, `createLogger`, `QUEUE_NAMES` | Значения по умолчанию из PLAN; `REMINDER_DAYS "3,6,9"` → `[3,6,9]`; `z.stringbool`; `STAFF_SEED_JSON`; каждый ключ схемы есть в `.env.example` и наоборот; окно 20 запросов пропускает, 21-й отклоняет; граница суток МСК | `pnpm install && pnpm lint && pnpm typecheck && scripts/dev-db.sh up && eval "$(scripts/dev-db.sh env)" && pnpm test`. Готово, когда всё зелёное и lock закоммичен |
| П1. db | `packages/db/**`. Экспорты: `createDb(url)` (`casing: 'snake_case'`), `schema`, `migrateDb`, `seed(db,env)`, `prepareTestDb()` | Миграции на пустой БД; уникальности (23505): дубль webhook_events, два succeeded-платежа на заказ, дубль телефона; check `total = subtotal + courier_fee`; формат `DT-000001`; сид идемпотентен; правка текста опубликованной версии валит сид | `pnpm --filter @detaly/db test && pnpm --filter @detaly/db db:drift` (`drizzle-kit generate` плюс `git diff --exit-code drizzle`) |
| П2. domain и контракты | `packages/domain/**`, `packages/{payments,notify,vin}/**`. Сигнатуры в п. 4 | Кейсы из п. 4; msw-обработчики отвечают на POST /v3/payments и /v3/receipts; `buildCallbackData` ≤64 байт; `isValidVin` | `pnpm --filter "./packages/{domain,payments,notify,vin}" test` |
| П3. rossko | `packages/rossko/**`, `scripts/rossko-smoke.ts`. Описание в п. 5 | Описаны в п. 5 | `pnpm --filter @detaly/rossko test`; `tsx scripts/rossko-smoke.ts --articles OC90` без ключей завершается с кодом 2 |
| П4. infra, CI, docs | `infra/**`, `.github/**`, `docs/{external,budget,runbook}.md`, `content/legal/**` | `bash -n`; прогон бэкапа и восстановления в локальном режиме (п. 9) | `docker compose -f infra/docker-compose.yml --env-file .env.example config -q`, то же с `--profile stage`; `yq` по ci.yml |
| П5. web (волна B) | `apps/web/**`, описание в п. 6 | unit, int и e2e | `pnpm --filter @detaly/web typecheck test build e2e` |
| П6. worker (волна B) | `apps/worker/**`, описание в п. 7 | Бот и задачи без сети, shutdown | `pnpm --filter @detaly/worker test` |
| Шаг И | Слияние ветками A, затем B; `pnpm install` для итогового lock; добавление env из отчётов агентов; README | Весь набор | п. 9 |

## 3. Drizzle-схема

Общие правила схемы:
1. `id` колонка `uuid().primaryKey().$defaultFn(() => uuidv7())` из `uuid`.
2. Время — `timestamp({withTimezone:true})`, `created_at` с `defaultNow()`.
3. Деньги — `integer` с суффиксом `_kop` и `check(>=0)`. Это небольшое отклонение от имён в PLAN, оно защищает от путаницы рублей и копеек.
4. Наценка хранится в базисных пунктах (`markup_bp`, 2800 = 28%).
5. pgEnum строятся из массивов `as const` в `@detaly/domain/statuses`:
   1. `order_status` — 17 значений, `out_for_delivery` заводим сразу.
   2. `order_item_state` — 10 значений.
   3. `payment_scheme`, `fulfillment`, `actor_type`.
   4. `payment_kind`, `payment_status` (pending, waiting_for_capture, succeeded, canceled).
   5. `receipt_kind` (6 значений), `receipt_status`.
   6. `refund_reason`, `refund_status` (pending, succeeded, failed).
   7. `supplier_order_status`, `supplier_return_kind`, `supplier_return_status`.
   8. `claim_kind`, `claim_decision`, `vin_request_status`.
   9. `document_kind`, `consent_kind` (pd, marketing), `consent_channel`.
   10. `messenger_channel`, `notification_channel`, `notification_status` (queued, sent, failed, skipped).
   11. `staff_role`, `cart_status`, `install_booking_status`, `photo_kind`, `excluded_kind` (keyword, group), `webhook_source`.

| Таблица | Колонки | Индексы и ограничения |
|---|---|---|
| users | phone, name, email, no_show_count int 0, anonymized_at | unique(phone); при обезличивании phone = `anon:<id>` |
| document_versions | kind, version, title, body_md, sha256 char(64), source_path, published_at | unique(kind, version); index(kind, published_at) |
| consents | user_id, document_version_id, kind, given_at, channel, ip inet, user_agent, text_sha256, revoked_at | index(user_id, kind) |
| messenger_bindings | user_id, channel, external_user_id, chat_id, phone_confirmed_at, is_primary, blocked_at | unique(channel, external_user_id); unique(user_id) where is_primary |
| link_tokens | token text PK, user_id, order_id, expires_at, used_at | index(expires_at) |
| staff | name, role, tg_user_id bigint(number), max_user_id, is_active | unique(tg_user_id), unique(max_user_id) |
| settings | key PK, value jsonb, updated_by, updated_at | — |
| excluded_groups | kind, pattern, reason, active | unique(kind, pattern) |
| carts / cart_items | carts: user_id, anon_token, status, proposal_token, seller_note, vin_request_id. Позиции: brand, article, name, qty, stock_id, is_local, eta_date date, price_supplier_kop, price_client_kop, markup_bp, offer_snapshot, fetched_at | unique(anon_token), unique(proposal_token); qty>0; FK cart_id cascade |
| orders | number text default `'DT-'‖lpad(nextval('order_number_seq'),6,'0')`, user_id, access_token, status, payment_scheme, fulfillment, address jsonb, subtotal_kop, courier_fee_kop, total_kop, items_hash, promised_date date, pickup_code, offer_version_id, attention_reason, confirmed_at…cancelled_at, expires_at, supplier_return_deadline_at | unique(number), unique(access_token); index(status, expires_at); index(user_id); check total = subtotal + courier_fee |
| order_items | поля позиции, price_supplier_at_order_kop, state, replaced_by_item_id (self-FK), supplier_item_error jsonb, marking_code, refunded_amount_kop | index(order_id) |
| order_events | order_id, type, from_status, to_status, actor_type, actor_id, payload | index(order_id, created_at) |
| payments | order_id, provider, provider_payment_id, kind, status, amount_kop, method, idempotence_key, confirmation_url, expires_at, raw | unique(provider, provider_payment_id), unique(idempotence_key), unique(order_id) where status='succeeded' |
| receipts | order_id, payment_id, refund_id, kind, provider_receipt_id, idempotence_key, status, fiscal_document_number, request, response | unique(idempotence_key); index(order_id) |
| refunds | order_id, payment_id, provider_refund_id, amount_kop, items, reason, status, idempotence_key, requested_at, deadline_at, succeeded_at | unique(idempotence_key), unique(provider_refund_id); index(status, deadline_at) |
| supplier_orders / supplier_order_items | attempt_no, status, rossko_order_ids text[], request, response, item_errors, delivery_cost_kop, status_code, upd_s3_key; связующая таблица | unique(order_id, attempt_no); PK(supplier_order_id, order_item_id) |
| supplier_returns, stock_items | по PLAN, суммы в `_kop` | index(order_item_id) |
| claims | kind, opened_at, deadline_at, decision, decision_text, compensation_amount_kop, return_accepted_at, decided_by, photos jsonb, closed_at | index(deadline_at) where closed_at is null |
| vin_requests | user_id, phone, vin char(17), car_text, need_text, photos, status, assigned_staff_id, proposal_cart_id, resolver | index(status, created_at) |
| install_bookings, order_photos | слот и статус без цены; kind, s3_key, by_staff_id | index(slot_at); index(order_id) |
| notifications | user_id, staff_id, order_id, channel, template, payload, dedupe_key, status, fallback_reason, attempts, error, sent_at | unique(dedupe_key); check(user_id or staff_id) |
| webhook_events | source, external_id, event_type, payload, received_at, processed_at, result | unique(source, external_id, event_type) |
| api_calls, search_log | source, method, duration_ms, ok, error, cost_kop; query, brand, article, results_count, from_cache, latency_ms (IP не храним) | index(source, created_at); index(created_at) |

`vehicles` и `chat_messages` относятся к фазам 3 и 2 и добавятся отдельными миграциями. Ссылки `carts.vin_request_id` и `vin_requests.proposal_cart_id` образуют цикл, поэтому оформляются через `(): AnyPgColumn =>`.

Сиды пишут `ON CONFLICT DO NOTHING`, чтобы не затирать правки из админки:
1. `pricing.markup_rules`: `[{fromKop:0,toKop:100000},{100000,500000},{500000,null}]`, во всех диапазонах `localBp` и `orderBp` равны 2800 (из `PRICING_MARKUP_PCT`).
2. Допуски и сроки из env: `pricing.drift_tolerance_pct` 3, `margin_floor_pct` 10, `eta.buffer_days` 1, `eta.supplier_invoice_lag_days` 1, `order.payment_ttl_min` 120, `order.on_pickup_max_total_kop` 1500000, `on_pickup_confirm_ttl_h` 24, `pickup.window_prepaid_days` 10, `pickup.window_cod_days` 7, `supplier.return_days` 14, `handed.complete_days` 7, `handover.qr_ttl_min` 15, `no_show.limit` 2, `reminder.days` [3,6,9].
3. Без дефолта в PLAN (по умолчанию 0 с пометкой «уточнить»): `pricing.min_order_total_kop`, `pricing.min_margin_kop`, `courier.fee_kop`.
4. `rossko.local_stock_ids` и `rossko.prepay_invoice=false`.
5. staff — upsert по tg_user_id из `STAFF_SEED_JSON`.
6. excluded_groups — ключевые слова (грамматика описана в п. 4).
7. Юридические тексты — синхронизация из `content/legal`. Публикуется версия из `LEGAL_*_VERSION`; если версия не задана, страница показывает последний черновик с плашкой.

Миграции в тестах:
1. `dev-db.sh up`, затем `eval "$(dev-db.sh env)"`. Команда задаёт `DATABASE_URL`, `DATABASE_URL_TEST`, `REDIS_URL`, `REDIS_URL_TEST`.
2. vitest `globalSetup` в `packages/db/test` вызывает `prepareTestDb()`: создаёт базу при отсутствии, пересоздаёт схемы `public` и `drizzle`, выполняет `migrate()` из `drizzle-orm/postgres-js/migrator` и запускает сид.
3. web и worker переиспользуют `@detaly/db/testing`.
4. В CI те же переменные указывают на service-контейнеры.

## 4. packages/domain

Сигнатуры:
1. `price(rules, priceSupplierKop, isLocal) → {priceClientKop, markupBp}`. Целочисленная формула `Math.ceil(p*(10000+bp)/1_000_000)*100`.
2. `validateMarkupRules(rules)` — диапазоны без дыр и пересечений, от 0 до ∞.
3. `localDate(instant, tz='Asia/Yekaterinburg') → 'YYYY-MM-DD'` через Intl.
4. `etaDate(stock, now)`: берётся `deliveryEnd`, если он есть, иначе `now + delivery` дней. Строка без смещения считается московским временем, это допущение надо сверить.
5. `promisedDate(etaDates, {bufferDays, invoiceLagDays, prepayInvoice})`.
6. `formatPromise(date) → 'к чт 8 октября'` на собственных массивах дней недели и месяцев, без ICU.
7. `isExcluded(item, rules) → {excluded, reason}`. Нормализация: нижний регистр, ё→е. Токен без `*` означает точное слово, с `*` — префикс слова; все токены паттерна должны встретиться. Правило kind=group сравнивается с товарной группой.
8. `buildOfferViews(offers, ctx) → OfferView[]` — готовые строки для UI.
9. `TRANSITIONS: readonly TransitionRule[]` с полями `{from[], event, to, actors[], guard?, receipt?, notify[]}` и `resolveTransition(status, event, ctx) → {ok,rule} | {ok:false, reason:'no_rule'|'guard_failed'}`.

Тест-кейсы для цены и дат:
1. 100000 коп при 28% даёт 128000. 12345 даёт 15900. 100 даёт 200. 78125 даёт ровно 100000, а не 100100: это ловушка для плавающей точки. При ставке 2750 из 100000 получается 127500.
2. Граница диапазона: 99999 попадает в первое правило, 100000 — во второе. Ставки для местного склада и под заказ различаются. Значения 0, отрицательные, NaN и нецелые выбрасывают ошибку. Правила с дырой отклоняются валидатором.
3. При сроке поставки 0 дней момент `2026-10-01T18:59:59Z` даёт дату `2026-10-01`, а `20:30Z` — уже `2026-10-02`, потому что в Екатеринбурге UTC+5.
4. `deliveryEnd 2026-10-08T22:00+03:00` даёт `2026-10-09`.
5. Из `max(10-05, 10-08) + 1` получается `10-09`; с лагом по счёту Rossko — `10-10`. Дата `12-31 + 1` даёт `2027-01-01`.
6. `formatPromise('2026-10-08')` возвращает «к чт 8 октября». 1 октября 2026 года — четверг, поэтому пример «к чт 9 октября» из PLAN для 2026 года неверен.

Тест-кейсы для `isExcluded`:
1. Под исключение попадают: «Масло моторное 5W-40», «Шина зимняя», «Антифриз G12», «Жидкость тормозная DOT-4».
2. Не попадают: «Фильтр масляный», «Колпачок маслосъемный», «Колодки тормозные», «Машина…».
3. Ключевое слово «масл» из PLAN как префикс отсекло бы масляные фильтры. Поэтому в сиде стоят `масло`, `масла`, `шина`, `шины`, `антифриз*`, `тосол`, `жидкость тормозн*`. Лишнее исключение безопаснее, чем пропуск маркируемого товара.

Тест-спецификация машины состояний (`transitions.spec.ts`):
1. Отдельно, вручную, записан массив `EXPECTED` примерно из 45 строк `[from, event, ctx, to]` по таблице раздела 3 PLAN. Каждая строка должна разрешаться в ожидаемый статус.
2. Полный перебор «17 статусов × все события» за вычетом разрешённых пар проверяет, что остальные пары дают `no_rule`.
3. Охранные условия:
   1. Оформление: все позиции местные, сумма не больше 1 499 900 коп и меньше двух неявок — переход в `awaiting_confirmation`. Сумма 1 500 100, `no_show=2` или смешанная корзина — в `awaiting_payment`.
   2. Сумма платежа не равна total — переход в `needs_attention`.
   3. «Заказать всё равно» при марже 9,9% отклоняется.
   4. Для `ready` по предоплате запрос оплаты на точке запрещён, а для оплаты при получении запрещён чек зачёта.
   5. Поздняя оплата отменённого заказа переводит его в `refund_pending`.
4. Свойства графа:
   1. Все статусы достижимы из `draft`.
   2. Из `refunded` нет выходов.
   3. `out_for_delivery` возможен только при курьере и предоплате.
5. В PLAN нашлась неоднозначность. Отказ клиента до передачи и истечение хранения при оплате на точке должны вести в `cancelled`, а не в `refund_pending`, потому что денег ещё нет. В коде это охранное условие по схеме оплаты, Максиму нужно его подтвердить.
6. Побочные эффекты оформлены как `it.todo`: чек предоплаты в составе платежа, блокировка «Выдал» до чека зачёта, только commodity и не больше одной строки service, refund по claim только после `return_accepted_at`.

## 5. packages/rossko

Компоненты пакета:
1. `createSoapCaller({wsdlBase, timeoutMs})` хранит `Map<method, Promise<Client>>` и на первом вызове делает `soap.createClientAsync(`${base}/${m}?wsdl`)`. После ошибки запись сбрасывается. Импорт `import * as soap from 'soap'`.
2. `createFixtureCaller(dir)` читает `fixtures/<Method>.<arg>.json`.
3. `createRosskoClient({caller, key1, key2, deliveryId, addressId, localStockIds, limiter, cache, onCall, allowCheckout})` возвращает методы `search(text, {priority, bypassCache})`, `checkoutDetails()`, `orders(ids)` и `checkout()`. Последний бросает `CheckoutDisabledError`, если `allowCheckout=false`.
4. Хук `onCall` пишет в `api_calls` на стороне вызывающего, так что пакет не зависит от БД.
5. Маппер `mapSearchResult(raw, {localStockIds}) → Offer[]` устойчив к входным данным: `toArray` для одиночных объектов, `rubToKop('1234.50') = 123450` без float, `multiplicity` по умолчанию 1, отсутствующий `deliveryEnd` превращается в null, кроссы помечаются `isCross`. Нормализация `normalizeArticle('W 914/2') = 'W9142'`.
6. Лимитер `createRosskoLimiter(redis, {rpm:250, daily:90000, breakerPct:70, now, sleep})`:
   1. Скользящее окно — Lua: ZREMRANGEBYSCORE, ZCARD, ZADD.
   2. Суточный ключ `rossko:quota:<mskDayKey>` с INCR и TTL 26 ч.
   3. `acquire({priority:'search'|'critical', maxWaitMs})` ждёт освобождения окна. При достижении 70% квоты запросы `search` получают `QuotaBreakerError`, `critical` проходят до 100%.
7. Кэш `rossko:search:v1:<norm>:<deliveryId>` живёт 900 с. Пустые ответы тоже кэшируются. Одинаковые одновременные запросы схлопываются в один (single-flight).

Синтетические фикстуры с пометкой `_meta: {synthetic:true, note:'сверить с реальным ответом'}`:
1. `GetSearch.OC90.json` — местный и удалённый склад плюс кроссы.
2. `GetSearch.W9142.json` — одиночный объект вместо массива.
3. `GetSearch.GDB1330.json` — два бренда.
4. `GetSearch.EDGE5W40.json` — масло, должно исключаться.
5. `GetSearch.NOTFOUND.json` — `success:false`.
6. `GetCheckoutDetails.json`, `GetCheckout.ok.json`, `GetCheckout.itemErrors.json`, `GetOrders.json`.

Тесты:
1. Маппер на каждой фикстуре.
2. Лимитер (интеграционный):
   1. 250 запросов проходят. 251-й получает `waitMs ≈ 60000−Δ`, а после сдвига часов на 60001 мс проходит.
   2. На 70% квоты поиск отклоняется, критичные запросы проходят. На 100% отклоняется всё.
   3. Граница суток МСК: `20:59:59Z` и `21:00:00Z`.
3. Кэш: повторный запрос берётся из кэша, `bypassCache` идёт к поставщику, single-flight срабатывает.
4. SOAP-путь (интеграционный): `soap.listen` на `127.0.0.1:0` с локальным WSDL-стабом. WSDL загружается один раз на два вызова.
5. `maskSecrets` для smoke-скрипта.

Лимитер тестируется на локальном Redis, а не на ioredis-mock, по причинам из сквозного решения 5.

## 6. apps/web

Файлы:
1. `next.config.ts`: `output:'standalone'`, `outputFileTracingRoot` и `turbopack.root` указывают на корень репо, `transpilePackages: ['@detaly/*']`, `serverExternalPackages: ['soap','pino','ioredis']`, `poweredByHeader:false`, заголовки безопасности. При `NOINDEX_ALL=true` (stage) на все ответы ставится `X-Robots-Tag: noindex`, на `/api/*` — всегда.
2. `postcss.config.mjs` с `@tailwindcss/postcss`. `globals.css` содержит `@import "tailwindcss"` и `@theme`; файла `tailwind.config` нет.
3. `src/proxy.ts` (так в Next 16 называется бывший middleware, работает в Node runtime).
4. `src/app/(site)/layout.tsx` с `dynamic='force-dynamic'`, чтобы сборка не требовала env. Страницы: `page.tsx`, `search/page.tsx`, `about/page.tsx`, `docs/[slug]/page.tsx` (offer, privacy, consent), `returns/page.tsx`, `vin/page.tsx`.
5. `/vin` в фазе 0 показывает адрес и телефон сервиса без формы: формы сбора ПД появятся только после номера РКН.
6. `src/app/robots.ts` закрывает `/search`, `/api`, `/o/`, `/p/`, `/admin`.
7. API: `api/health/route.ts`, `api/health/live/route.ts`, `api/search/route.ts`.
8. Серверный слой `src/server/`:
   1. `env.ts`, `db.ts` и `redis.ts` — ленивые синглтоны через globalThis.
   2. `rossko.ts`.
   3. `search-service.ts`: `searchOffers({q, brand, localOnly, ip})` проверяет запрос, ищет через кэш и лимитер, строит `buildOfferViews` и пишет `search_log` (fire-and-forget).
   4. `rate-limit.ts`.
   5. `client-ip.ts`: `getClientIp(headers, TRUSTED_IP_HEADER)` берёт `X-Real-IP` только при `TRUSTED_IP_HEADER=x-real-ip`, иначе возвращает `local`.
   6. `health.ts`: `computeHealth`.
   7. `documents.ts`: `getPublishedDocument(kind)`.
   8. `brand.ts`.
9. Компоненты: `SearchBar` — обычный `<form method="get" action="/search">`, а не `next/form`, чтобы префетч не съедал лимит. Также `OfferRow`, `StockBadge` («В Оренбурге — оплата при получении» или «Под заказ — предоплата»), `EmptyState` со ссылкой на `/vin`, `VinCta`, `HowItWorks`, `TrustBlock` с плейсхолдером фото, `Footer` с реквизитами, `DemoDataBanner`.

Поведение proxy:
1. Работает только на `/api/search` и `/search`. Пропускает HEAD и запросы с заголовком `next-router-prefetch`.
2. Ключ лимита — `HMAC(SESSION_SECRET, ip)`, сам IP в Redis не хранится.
3. Окна 20 запросов за 60 с и 300 за 24 ч.
4. Ответ при превышении: JSON 429 с `Retry-After` для `/api/search` и короткий HTML с кодом 429 для `/search`.
5. Если Redis недоступен, лимит пропускает запросы (fail-open), но поиск в Rossko без лимитера закрыт и отвечает 503.

Поведение API:
1. `GET /api/search?q=&brand=&local=1` возвращает 200 с `{offers, fromCache, quota}`. Если после нормализации запрос короче 3 символов — 400. При сработавшем предохранителе квоты и пустом кэше — 503 «попробуйте позже».
2. `/api/health` проверяет `select 1` (таймаут 2 с), `PING` Redis и возраст heartbeat не больше `HEARTBEAT_STALE_SEC=300`. При любом сбое отвечает 503, всегда с `no-store`.
3. `/api/health/live` всегда отвечает 200 и используется только для Docker healthcheck, чтобы смерть worker'а не перезапускала web.

Бренд и реквизиты берутся из `BRAND_NAME`, `SELLER_REQUISITES_{NAME,INN,OGRNIP,ADDRESS,EMAIL,PHONE}` и `PICKUP_{POINT_NAME,ADDRESS,HOURS}`. Тест `no-hardcoded-brand` грепает `src` на название сервиса и ИНН.

Вёрстка без горизонтального скролла: на мобильном карточки, на `md` и шире сетка, `min-w-0`, `overflow-wrap:anywhere` для артикулов. Шрифты системные: `next/font/google` в сборке пошёл бы в сеть.

Playwright, файл `playwright.config.ts`:
1. Проекты `mobile` (375×812, isMobile) и `desktop` (1280×800).
2. `baseURL` из `E2E_BASE_URL`.
3. `screens.spec.ts` обходит `/`, `/search?q=OC90`, `/search?q=NOTFOUND`, `/about`, `/docs/offer`, `/docs/privacy`, `/docs/consent`, `/returns`, `/vin`. На каждой странице проверяет `scrollWidth − clientWidth ≤ 0`, наличие ИНН в футере и `noindex` на `/search`, затем снимает `test-results/screens/<project>-<slug>.png` (fullPage).
4. `limits.spec.ts` проверяет, что 21-й запрос получает 429.
5. Агент шага И открывает PNG через Read и смотрит их глазами.

## 7. apps/worker

Файлы:
1. `src/main.ts`.
2. `queues.ts`: `createQueues(conn)` на семь очередей и `registerSchedulers()` с вызовом `housekeeping.upsertJobScheduler('heartbeat', {every:30000}, {name:'heartbeat'})`.
3. `workers.ts`.
4. `jobs/housekeeping.ts`: `processHousekeeping(job, {redis, now})` для `heartbeat` вызывает `writeHeartbeat`, задача `SET … EX 600`.
5. `jobs/stub.ts` бросает `UnrecoverableError('phase 0')`.
6. `bots/seller/bot.ts`: `createSellerBot({token, isStaff, health, botInfo?})`.
7. `bots/seller/handlers.ts`:
   1. `staffOnly(isStaff)` не вызывает `next()` для чужих — это молчание.
   2. `pingHandler` отвечает «pong · heartbeat Ns · db ok · <GIT_SHA>».
8. `bots/seller/staff.ts` — кэш на 60 с.
9. `shutdown.ts`: `installShutdown()` на SIGTERM/SIGINT по порядку вызывает `bot.stop`, `worker.close`, `queue.close`, `redis.quit`, `sql.end`. Жёсткий выход через 25 с, второй сигнал завершает процесс с кодом 1.
10. `healthcheck.ts` для compose: код 0, если heartbeat младше 120 с.
11. Если `TG_SELLER_BOT_TOKEN` пуст, бот не стартует, worker пишет предупреждение.

Все ioredis-соединения создаются с `protocol:2`, у worker'ов дополнительно `maxRetriesPerRequest:null`.

Тесты без сети:
1. Бот создаётся как `new Bot('test:x', {botInfo: FAKE})`. Транспорт подменяется через `bot.api.config.use((prev, method, payload) => { calls.push(...); return {ok:true, result:…} })`, обновления подаются через `bot.handleUpdate(update)`.
2. `/ping` от staff в личке и в `TG_SELLER_CHAT_ID`, включая вариант `/ping@bot`, даёт ровно один `sendMessage`.
3. Не-staff, неизвестная команда и апдейт без `from` дают ноль вызовов API.
4. Интеграционный тест heartbeat: ключ появляется, TTL больше нуля.
5. Интеграционный тест shutdown: процесс запускается через `node --import tsx`, после появления heartbeat получает SIGTERM. Ожидается код 0 за 10 с и строка «shutdown complete» в логе.

## 8. infra и CI

| Сервис | Ключевое |
|---|---|
| caddy | `caddy:2-alpine`, порты 80 и 443, тома `caddy_data` и `caddy_config`, 128m |
| web | образ `ghcr.io/wakeupitsadream/detaly-web:${IMAGE_TAG}`, наружу порты не публикуются (`expose: 3000`), `TZ=Asia/Yekaterinburg`, `NODE_EXTRA_CA_CERTS=/certs/russian_trusted_root_ca.pem` (монтируется `./certs:ro`, не вшивается в образ), healthcheck `node -e fetch(.../api/health/live)`, 768m, `--max-old-space-size=512` |
| worker | образ `detaly-worker`, healthcheck `node --import tsx apps/worker/src/healthcheck.ts`, `stop_grace_period: 30s`, 512m |
| postgres | `postgres:16-alpine`, healthcheck `pg_isready`, `shared_buffers=128MB`, 768m |
| redis | `redis:7-alpine`, `--appendonly yes --maxmemory 256mb --maxmemory-policy noeviction` (без noeviction BullMQ работать не должен), 320m |
| backup | `alpine` + `postgresql16-client`, age, gpg, rclone, curl; cron `30 2 * * *` для `backup.sh` и `*/5` для `healthwatch.sh`; 128m |
| stage (`profiles: [stage]`) | `web-stage`, `worker-stage`, `postgres-stage`, `redis-stage` через якорь `x-app`, `.env.stage`, `ROSSKO_ALLOW_CHECKOUT=false`, `NOINDEX_ALL=true` |

Caddyfile:
1. Глобально `email {$ACME_EMAIL}`. В блоке `servers` строка `trusted_proxies` закомментирована: Caddy стоит на краю, и чужой `X-Forwarded-For` он переписывает.
2. Блок `{$SITE_DOMAIN}`: `encode`, `reverse_proxy web:3000 { header_up X-Real-IP {remote_host} }`, HSTS, JSON-логи.
3. Блок `{$STAGE_DOMAIN}`: `basic_auth` и прокси на `web-stage`.
4. rate_limit в Caddy нет.
5. Доверие к заголовку обеспечено сетью: web недоступен напрямую. В runbook описана проверка, что docker userland-proxy не подменяет клиентский IP на 172.x.

Dockerfile'ы:
1. Общая база `node:22.22-bookworm-slim` с `corepack` и pnpm 10.28.0, затем `pnpm fetch` по lock, `COPY . .` и `pnpm install --offline --frozen-lockfile --filter <app>...`.
2. Web: `pnpm --filter @detaly/web build`. Финальная стадия копирует `.next/standalone`, `.next/static` и `public`, запускает `node apps/web/server.js` от пользователя `node`.
3. Worker: `--prod`, `tsx` в зависимостях, `CMD node --import tsx apps/worker/src/main.ts`. В образе есть `packages/db/drizzle` и `content/legal`.

Бэкап:
1. `backup.sh` выполняет `pg_dump -Fc | age -r $BACKUP_AGE_RECIPIENT` (или gpg в режиме `--batch --symmetric --passphrase-fd`), отправляет результат через `rclone copyto` (настройка через `RCLONE_CONFIG_S3_*`) и удаляет старое `rclone delete --min-age 30d`. Дополнительно в бакете включается lifecycle-правило.
2. `STORAGE=local` нужен для локальной проверки.
3. При сбое — сообщение в Telegram.
4. `restore.sh <object|latest> <target_url>` расшифровывает и выполняет `pg_restore --clean --if-exists --no-owner`, затем печатает число строк в ключевых таблицах.

`deploy.sh <tag>|rollback`:
1. `set -euo pipefail`.
2. `docker compose pull`.
3. `docker compose run --rm worker node --import tsx packages/db/src/migrate.ts`, затем seed.
4. `up -d`.
5. Ожидание `/api/health` до 90 с.
6. При провале — `up -d` предыдущего тега из `.deploy/prev_tag`, выход с кодом 1. Миграции только по схеме expand/contract.
7. `DRY_RUN=1` печатает команды вместо выполнения.

CI в `ci.yml`:
1. Job `check`: services postgres:16 и redis:7, pnpm/action-setup, setup-node 22 с кэшем pnpm, `install --frozen-lockfile`, `lint`, `format:check`, `typecheck`, `db:drift`, `test`, `build`, `shellcheck infra/**/*.sh scripts/*.sh`, `docker compose config -q`.
2. Job `e2e`: `playwright install --with-deps chromium`, артефакт со скриншотами.
3. Job `images` на push в main и на теги `v*`: `permissions: packages: write`, login в ghcr, build-push для web, worker и backup с тегами `${{github.sha}}` и semver, `cache-from type=gha`.

## 9. Итоговая верификация в этой сессии

1. `pnpm install --frozen-lockfile`
2. `scripts/dev-db.sh up && eval "$(scripts/dev-db.sh env)"`
3. `pnpm lint && pnpm format:check && pnpm typecheck`
4. `pnpm test && pnpm --filter @detaly/db db:drift`
5. `pnpm db:migrate && pnpm db:seed`; повторный `pnpm db:seed` ничего не меняет.
6. `pnpm build && node apps/web/scripts/prepare-standalone.mjs`
7. `PORT=3100 ROSSKO_MODE=fixtures TRUSTED_IP_HEADER=x-real-ip node apps/web/.next/standalone/apps/web/server.js &` — тот же путь, что в CMD Dockerfile.
8. `TG_SELLER_BOT_TOKEN= node --import tsx apps/worker/src/main.ts &`
9. `curl -fsS localhost:3100/api/health | jq` → 200, `worker.ageSec < 60`.
10. `curl 'localhost:3100/api/search?q=OC90' | jq '.offers|length'` больше нуля, цены равны `ceil(опт×1,28)`; `psql "$DATABASE_URL" -c 'select count(*) from search_log'` растёт.
11. `for i in $(seq 21); do curl -s -o /dev/null -w '%{http_code}\n' -H 'X-Real-IP: 203.0.113.7' 'localhost:3100/api/search?q=OC90'; done | tail -1` → 429.
12. `kill -TERM <worker>` → код 0. Затем `redis-cli -p 56379 DEL detaly:heartbeat:worker` и `curl -s -o /dev/null -w '%{http_code}' localhost:3100/api/health` → 503.
13. `E2E_BASE_URL=http://127.0.0.1:3100 pnpm --filter @detaly/web e2e`, затем просмотр PNG.
14. `docker compose -f infra/docker-compose.yml --env-file .env.example config -q`, то же с `--profile stage`.
15. `bash -n infra/*.sh infra/backup/*.sh scripts/*.sh`; `yq '.jobs|keys' .github/workflows/ci.yml`.
16. Бэкап и восстановление: `age-keygen -o $SCRATCH/k`, `STORAGE=local … infra/backup/backup.sh`, `createdb detaly_restore`, `restore.sh latest postgres://…/detaly_restore`. Число строк в `settings` и `document_versions` должно совпасть.
17. `tsx scripts/rossko-smoke.ts --articles OC90` → код 2, «ждём ключи».

Успех — все команды завершились с кодом 0, ожидаемые коды 200, 503 и 429 получены, на 375 px нет горизонтального скролла, бэкап совпал после восстановления.

Остаётся Максиму:
1. VPS, DNS, `.env` с реальными секретами, сертификат Минцифры в `infra/certs`.
2. Доступ к ghcr на VPS: PAT с правом `read:packages`.
3. Первый `deploy.sh`, проверка TLS и `caddy validate` на сервере.
4. Бакет S3, восстановление на stage по runbook.
5. Ключи Rossko, прогон smoke и сверка маппера с реальным XML.
6. Спайк ЮKassa.
7. Токены BotFather, проверка `/ping` вживую со staff-аккаунта и с чужого.
8. Первый зелёный прогон CI на GitHub.
9. Юридическая вычитка текстов, заполнение `docs/external.md`.

## 10. Риски и обходы

| Риск | Обход | Как проверить при реализации |
|---|---|---|
| TS 7 (нативный) несовместим с JS API, на который опираются type-check Next и typescript-eslint | Закрепить 6.0.3. В TS 6 значение `types` по умолчанию пустое, поэтому `["node"]` указан явно. Если peer-диапазон typescript-eslint исключает 6.x — откат на 5.9.3 | `pnpm why typescript` показывает одну версию; предупреждения о peer-зависимостях при install |
| Next 16: `proxy.ts` вместо `middleware.ts`, Turbopack по умолчанию, асинхронные `params`/`searchParams`/`headers()`, команды `next lint` нет | Никакого webpack-конфига. Env не читается на верхнем уровне модулей. Если proxy с ioredis не соберётся, лимит переезжает в route handler и страницу с той же функцией. Фолбэк `next build --webpack` | `ls node_modules/next/dist/docs` и grep по `proxy`, `standalone`, `serverExternalPackages`, `version-16`; после сборки проверить `ls .next/standalone/apps/web/server.js` |
| Tailwind v4 | `@tailwindcss/postcss` и `@theme` в CSS. Если классы есть вне app — директива `@source` | На скриншоте видны стили; в CSS из `.next` есть нужные классы |
| drizzle-kit: casing, ESM-only `uuid`, импорт enum'ов из `@detaly/domain` | Один `createDb` с `casing`; Node 22.12+ умеет `require(esm)`; если упрётся — собственная функция uuidv7 на 15 строк | В П1 первым делом запустить `drizzle-kit generate` |
| soap в ESM и Next | `import * as soap`, `serverExternalPackages`; axios внутри soap учитывает `no_proxy` для localhost | Интеграционный тест с `soap.listen` |
| BullMQ 6 и ioredis 6 | ioredis — прямая зависимость worker'а; `upsertJobScheduler`; `protocol:2`, пока тест не подтвердит работу на RESP3 | Прочитать `node_modules/bullmq/README.md` и CHANGELOG (раздел про BackendFactory) |
| Playwright 1.63 ищет другую ревизию Chromium | Закрепить 1.56.1 или задать `launchOptions.executablePath` | `pnpm exec playwright --version`, запуск одного спека |
| pnpm 10 блокирует build-скрипты | `onlyBuiltDependencies` | Вывод «Ignored build scripts» при install |
| Параллельные агенты делят PG и Redis | Своя тестовая БД на worktree, префиксы ключей | Повторные прогоны тестов в двух worktree одновременно |
| Поля Rossko синтетические | Устойчивый маппер, `_meta.synthetic`, вопросы в `external.md` | Smoke на реальных ключах (делает Максим) |
| Vitest 5, msw 3, ESLint 10 | `test.projects`; если плагины не поддерживают ESLint 10 — откат на ESLint 9 | CHANGELOG пакетов после установки |

### Критичные файлы для реализации

1. /home/user/detaly/packages/config/src/env.ts
2. /home/user/detaly/packages/db/src/schema/orders.ts
3. /home/user/detaly/packages/domain/src/state-machine/transitions.ts
4. /home/user/detaly/packages/rossko/src/limiter.ts
5. /home/user/detaly/infra/docker-compose.yml