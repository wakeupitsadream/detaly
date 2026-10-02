# Фаза 1A: корзина, оформление, согласия, страница заказа — детальная разбивка

Дополнение к `docs/PLAN.md` (раздел 6 «Фаза 1A», Verification «Фаза 1A») и к
`docs/phase0-implementation.md`. Написано архитектором 02.10.2026 по коду на HEAD `f200646`
(фаза 0: 722 теста, проверка и аудит пройдены). При расхождении приоритет у `docs/PLAN.md`;
решения фаундера не пересматриваются.

Что из объёма 1A по PLAN уже сделано в фазе 0 и здесь не повторяется: маппинг складов
(`applyLocalStocks`, `rossko.local_stock_ids`), `excluded_groups` и `isExcluded`, `price()`,
`etaDate`/`promisedDate`/`formatPromise`, `/search` с бейджами и датами, лимиты поиска 20/мин и
300/сутки, `document_versions` с сидом и страницами `/docs/*`, таблицы `carts`, `cart_items`,
`orders`, `order_items`, `order_events`, `consents`, `users` (схема фазы 0).

Что делает 1A: корзина, оформление на одном экране с согласиями, создание заказа без платежа
(`draft → awaiting_payment | awaiting_confirmation`), страница заказа `/o/<token>` с отменой.
Платёж, чеки, подтверждение pay_on_handover, уведомления, привязка мессенджеров — фазы 1B/1C.

## 0. Решения по умолчанию, принятые в 1A

Ниже всё, что PLAN не фиксирует однозначно. Каждое решение можно поменять, не ломая остальное.

| № | Решение | Почему |
|---|---|---|
| Д1 | «POST /checkout» из PLAN реализуется как `POST /api/checkout` (JSON). Страница `/checkout` — серверная, форма — клиентский компонент с `fetch`. В App Router страница и route handler не живут на одном пути, а 409 с телом из Server Action не отдать | 409 + DiffBanner на месте, без перезагрузки |
| Д2 | «Разделить на два заказа» = оформление **части** корзины: `/checkout?part=local`, потом `/checkout?part=order`. Оформленные позиции уходят из корзины, остаток ждёт второго оформления. Второй корзины и второго cookie нет | Одна корзина на браузер, ноль новых таблиц |
| Д3 | Отмена клиентом из `awaiting_payment`/`awaiting_confirmation` — новое событие машины состояний `client_cancelled` (в PLAN таких строк нет; `client_refused` действует только с `confirmed`). Для `awaiting_payment` охрана `no_payment_succeeded`: статус последнего платежа `null`, `pending` или `canceled`; без поля — `guard_failed` | Отказ до оплаты денег не трогает; поздняя оплата уже покрыта правилом `cancelled → refund_pending` |
| Д4 | Оформление открыто, только если задан `RKN_NOTICE_NUMBER`. При `NODE_ENV=production` дополнительно нужны **опубликованные** версии `offer`, `privacy`, `consent_pd`; вне production допускаются черновики (в согласие пишется версия и sha256 черновика) | Int-тесты работают на сиде без публикации; прод не примет согласие на черновик |
| Д5 | Согласие `pd` (и `marketing`, если отмечено) пишется **на каждый заказ** отдельной строкой с новым полем `consents.order_id` | Доказательство привязано к конкретному оформлению |
| Д6 | Принятие оферты — `orders.offer_version_id` (отдельной строки consents нет: `consent_kind` = pd, marketing) | Схема фазы 0 |
| Д7 | IP в `consents.ip` хранится открыто: это доказательство согласия (ч. 3 ст. 9 152-ФЗ — обязанность доказать согласие на операторе). Цель и состав («дата, время, IP, браузер, версия и хэш текста») уже указаны в `content/legal/privacy` (п. 2) и `consent_pd` (п. 2). Срок — как у согласий: 5 лет с последнего заказа. Если IP недоверенный (`TRUSTED_IP_HEADER=none` → `local`), пишется `null`. В логах и Redis IP не появляется (лимиты — HMAC) | Вопрос из задачи; тексты документов менять не нужно |
| Д8 | `items_hash` = sha256 канонической строки `offerKey|qty|priceClientKop` по позициям, отсортированным по `offerKey`. Дата поставки в хэш не входит: сдвиг даты не даёт 409, на заказ ставится свежая дата | Иначе 409 случался бы на смене суток |
| Д9 | Позиция корзины идентифицируется `offer_key = offerViewId(offer)` = `${articleNorm}:${brand}:${stockId}` и хранит `search_article_norm` — артикул **запроса**, по которому её нашли. Пересчёт ищет по нему: кросс (W 712/75 из выдачи OC90) ищется запросом `OC90`, иначе в фикстурах он «пропал бы» | Фикстуры и, вероятно, живой Rossko (VERIFY) |
| Д10 | При пересчёте (открытие корзины, 409 оформления) исчезнувшие и попавшие в стоп-группу позиции удаляются из корзины, уменьшенный остаток уменьшает количество; всё это попадает в DiffBanner | Клиенту не нужно чинить корзину руками |
| Д11 | `expires_at`: для `awaiting_confirmation` = now + `order.on_pickup_confirm_ttl_h` (24 ч); для `awaiting_payment` в 1A — `null` (срок ставит создание платежа в 1B). В 1A сроки никто не обрабатывает | Совместимо с housekeeping 1B |
| Д12 | Эффект `create_payment` правила `checkout` в 1A не выполняется: в `order_events.payload` пишется `deferredEffects: ['create_payment']`. На странице заказа кнопка оплаты неактивна с текстом «Оплата подключается» | Платёж — 1B |
| Д13 | `pickup_code` (6 цифр, `crypto.randomInt`) генерируется при оформлении, а показывается на `/o/<token>` только со статуса `ready` (в 1A не наступает) | Код — для выдачи, PLAN отправляет его с «приехало» |
| Д14 | `users.name` перезаписывается именем из последнего оформления (upsert по телефону) | Продавцу на выдаче нужно актуальное имя |
| Д15 | Причина «предоплата из-за неявок» показывается нейтрально: «Для этого номера доступна только предоплата» — без слова «неявка» | Не раскрывать историю чужого номера |
| Д16 | Лимиты: POST `/api/checkout` 10/час, POST `/api/orders/<token>/cancel` 5/час на IP-бакет (PLAN-задача). Дополнительно: запись в корзину (POST/PATCH/DELETE `/api/cart/**`) 120/час — добавление может вызвать GetSearch при промахе кэша; неверные 4 цифры — 5 попыток в час на заказ (Redis, fail closed) | Перебор 4 цифр и квота Rossko |
| Д17 | Пределы корзины: до 20 строк, количество 1–99 и кратно `multiplicity`, не больше остатка; до 10 разных `search_article_norm` (столько GetSearch мимо кэша на одно оформление) | Квота Rossko и время ответа |
| Д18 | Web ждёт окно лимитера для `critical` не дольше 5 с (`WEB_CRITICAL_MAX_WAIT_MS`), потом 503 «не удалось проверить цены» | Воркерные 60 с недопустимы для HTTP |
| Д19 | Проверка Origin: `Origin` строго равен `new URL(APP_BASE_URL).origin`; без `Origin` запрос принимается только при `Sec-Fetch-Site: same-origin`; иначе 403. Применяется ко всем изменяющим запросам: корзина, оформление, отмена | PLAN: «проверка Origin на всех формах» |
| Д20 | Корзина работает без JS (обычные формы POST → 303 на `/cart`); оформление и отмена требуют JS (`<noscript>` с пояснением) | Минимум клиентского кода |
| Д21 | Cookie корзины `cart`: 32 случайных байта base64url (43 символа), `HttpOnly`, `SameSite=Lax`, `Path=/`, `Secure` при `APP_BASE_URL` на https, `Max-Age` = `CART_TTL_DAYS` (новая env, 30). `__Host-` не используется: e2e идёт по http://127.0.0.1 | Политика ПД: «только технически необходимые cookie» — баннер не нужен |

## 1. Изменения модели данных (волна 1)

Одна миграция `packages/db/drizzle/0001_phase_1a.sql`, сгенерированная
`pnpm --filter @detaly/db exec drizzle-kit generate --name phase_1a`. Все колонки добавляются
так, чтобы миграция прошла на базе с данными фазы 0 (в проде заказов и корзин ещё нет, но
правило expand/contract соблюдаем: новые колонки либо nullable, либо в таблицах без строк, что
проверяет тест миграций).

| Таблица | Изменение | Зачем |
|---|---|---|
| `cart_items` | `offer_key text not null`; `search_article_norm text not null`; `unique(cart_id, offer_key)` `cart_items_cart_id_offer_key_unique`; check `search_article_norm ~ '^[A-Z0-9]{1,64}$'` | Д9; повторное добавление увеличивает количество (upsert) |
| `order_items` | `offer_key text not null`; `search_article_norm text not null` (тот же check) | Recheck в 1B ищет тем же запросом |
| `orders` | `preferred_channel notification_channel` (nullable; значения telegram, max, sms); `checkout_key uuid` + `unique` `orders_checkout_key_unique`; `cart_id uuid references carts(id) on delete set null` + `index orders_cart_id_idx` | Канал статусов как предпочтение; идемпотентность двойной отправки; след корзины |
| `consents` | `order_id uuid references orders(id)` (nullable) + `index consents_order_id_idx` | Д5 |

Без миграции (не влияет на SQL, `db:drift` остаётся чистым):

1. `packages/db/src/schema/relations.ts` — `relations()` для `db.query … with`: `carts.items`,
   `cartItems.cart`, `orders.user`, `orders.items`, `orders.events`, `orders.offerVersion`,
   `orderItems.order`, `orderEvents.order`, `consents.user`, `consents.order`,
   `consents.documentVersion`, `payments.order`, `users.orders`. Экспорт из `schema/index.ts`
   (тогда `drizzle({ schema })` подхватит их сам).
2. `packages/db/src/index.ts` реэкспортирует операторы `drizzle-orm`: `sql`, `eq`, `and`, `or`,
   `inArray`, `isNull`, `isNotNull`, `desc`, `asc`, `gt`, `lt`. Web не получает прямой
   зависимости от `drizzle-orm`: у web нет `postgres`, и pnpm собрал бы второй экземпляр
   `drizzle-orm@0.45.3` без peer — смешение экземпляров в одном запросе опасно. Блокировка строк
   (`select … for update`) пишется через `db.select().from(orders).where(eq(…)).for('update')`
   с операторами из `@detaly/db`.
3. Сиды не меняются: новые настройки не нужны (все пороги уже в `settings` фазы 0:
   `pricing.min_order_total_kop`, `pricing.min_margin_kop`, `order.on_pickup_max_total_kop`,
   `order.on_pickup_confirm_ttl_h`, `no_show.limit`).

Тесты (`packages/db/test/phase1a.int.test.ts`): миграция 0001 применяется на базе после 0000 с
данными (вставить корзину без позиций и пользователя, потом мигрировать — проходит); дубль
`(cart_id, offer_key)` → 23505; дубль `orders.checkout_key` → 23505; два заказа с `checkout_key
null` — можно; неверный `search_article_norm` → 23514; `consents.order_id` на несуществующий
заказ → 23503.

## 2. Env (волна 1)

| Переменная | Схема | Где | Значение |
|---|---|---|---|
| `CART_TTL_DAYS` [ф1A] | `int(1).default(30)` | `packages/config/src/env.ts`, `.env.example` | Max-Age cookie корзины в днях |

`RKN_NOTICE_NUMBER` уже есть и служит флагом форм сбора ПД (Д4). Лимиты 1A — константы в коде,
как лимиты поиска. В `.github/workflows/ci.yml`, job `e2e`, добавляются: `APP_BASE_URL:
http://127.0.0.1:3100` (иначе проверка Origin отклонит e2e), `RKN_NOTICE_NUMBER: 'E2E-TEST'`,
`LEGAL_OFFER_VERSION`, `LEGAL_PRIVACY_VERSION`, `LEGAL_CONSENT_PD_VERSION`,
`LEGAL_CONSENT_MARKETING_VERSION`, `LEGAL_RETURN_MEMO_VERSION` = `2026-10-d1` (сид публикует
черновики в тестовой базе CI; standalone-сервер работает с `NODE_ENV=production`, а там нужны
опубликованные версии, Д4). Job `check` не меняется: int-тесты передают `RKN_NOTICE_NUMBER`
через `intEnv({...})`.

## 3. packages/domain (волна 1)

Только чистые функции, `now` и настройки передаются параметрами. Тексты для клиента — на
русском, как `formatPromise`.

### 3.1. `src/phone.ts`

1. `normalizePhone(input: string): string | null` — E.164 только для +7 (Россия и Казахстан —
   единый план нумерации). Убирает пробелы, `()`, `-`, `.`. Принимает `+7XXXXXXXXXX`,
   `8XXXXXXXXXX`, `7XXXXXXXXXX`, `XXXXXXXXXX` (10 цифр, первая 3, 4, 8 или 9 — коды ABC/DEF;
   коды 88x и 89x не выделены и отклоняются: `8912345678` — это «8 9xx…» с пропущенной цифрой).
   Остальное → `null`.
2. `phoneLast4(e164: string): string`.
3. `maskPhone(e164: string): string` → `+7 ••• •••-45-67` (для карточек и логов 1B, без ПД).

Тесты: `'8 (912) 345-67-89' → '+79123456789'`, `'+7 912 345 67 89'`, `'9123456789'`,
`'79123456789'`, `'3532123456'` (городской Оренбурга); отклоняются `'+1 202 555 0100'`,
`'12345'`, `'912345678'` (9 цифр), `'1234567890'` (10 цифр с 1), буквы, 12 цифр, пустая строка;
`phoneLast4('+79123456789') === '6789'`.

### 3.2. `src/cart.ts` и типы в `types.ts`

```ts
type CartPart = 'all' | 'local' | 'order';
interface CartLine {            // строка cart_items в доменном виде
  id: string; offerKey: string; searchArticleNorm: string; qty: number;
  priceSupplierKop: Kop; priceClientKop: Kop; markupBp: BasisPoints;
  isLocal: boolean; etaDate: IsoDate | null; offer: Offer;   // offer = offer_snapshot
}
type LineChange =
  | { kind: 'price'; lineId; offerKey; title; oldPriceKop; newPriceKop; deltaKop }
  | { kind: 'qty'; lineId; offerKey; title; oldQty; newQty }
  | { kind: 'unavailable'; lineId; offerKey; title }
  | { kind: 'excluded'; lineId; offerKey; title; reason: string };
interface RepricedLine extends CartLine { status: 'ok' | 'unavailable' | 'excluded';
  available: number; multiplicity: number }
interface RepriceContext { markupRules; excludedRules; eta: EtaSettings; now: Date; timeZone? }
```

Функции:

1. `lineTitle(offer)` → `'Knecht OC 90'` (бренд и артикул — то, что можно показывать везде).
2. `cartLineFromOffer(offer, searchArticleNorm, qty, ctx) → Omit<CartLine,'id'>` — цена через
   `price()`, дата через `etaDate()`, ошибка `CartError('excluded'|'qty'|'price')` для стоп-группы,
   неверного количества и неполной цены.
3. `validateQty(qty, {available, multiplicity})` → `{ok:true}` | `{ok:false, message}`: целое
   1–99 (`MAX_LINE_QTY`), кратно multiplicity, не больше остатка.
4. `repriceCartLines(lines, freshBySearch: ReadonlyMap<string, readonly Offer[] | null>, ctx)
   → { lines: RepricedLine[]; changes: LineChange[] }`. `null` в карте = поиск по этому артикулу
   не удался: строки остаются как есть со `status: 'ok'` и флагом `stale: true` (не изменение).
   Совпадение по `offerKey`; при дублях — самое дешёвое (как `buildOfferViews`). Нет предложения
   или цена не положительное целое или нет даты → `unavailable`; `isExcluded` → `excluded`;
   остаток меньше количества → количество уменьшается до наибольшего кратного multiplicity, при 0 —
   `unavailable`; новая цена ≠ старой → `price` (дельта за единицу).
5. `cartTotals(lines)` → `{ subtotalKop, supplierKop, marginKop, itemsCount }` через `safeMul`
   и `sumKop`; `marginKop` = Σ(client − supplier) × qty (может быть отрицательным — тогда
   `minMarginReached` не пройдёт).
6. `splitCartLines(lines)` → `{ local, toOrder, mixed }`; `selectCartPart(lines, part)`.
7. `itemsHashPayload(lines)` → каноническая строка Д8 (хэширует web).

### 3.3. `src/checkout.ts`

1. `choosePaymentScheme({ allItemsLocal, totalKop, noShowCount, noShowLimit,
   onPickupMaxTotalKop, fulfillment }) → { scheme: PaymentScheme; reasons: PrepayReason[] }`,
   где `PrepayReason = 'to_order' | 'over_limit' | 'no_show' | 'courier'`. Схема берётся из
   охраны `onPickupEligible.test(...)` машины состояний (один источник правды); причины
   перечисляются отдельно для текста.
2. `explainPaymentScheme(decision, { onPickupMaxTotalKop })` → массив предложений:
   - pay_on_handover: «Оплата при получении: все детали есть на складе в Оренбурге, а сумма не
     больше 15 000 ₽. Оплатить можно картой или по QR в пункте выдачи, наличные не принимаем.»;
   - `to_order`: «В заказе есть детали под заказ: мы выкупаем их у поставщика, поэтому нужна
     предоплата 100%.»;
   - `over_limit`: «Сумма заказа больше 15 000 ₽ — для таких заказов нужна предоплата.»;
   - `no_show`: «Для этого номера доступна только предоплата.» (Д15).
   Суммы — через `formatRub`, порог из настроек, не константой.
3. `splitAdvice(lines, ctx)` → `{ offerSplit: boolean; localTotalKop }`: разделение предлагается,
   только если корзина смешанная и **местная часть сама** проходит `choosePaymentScheme` в
   pay_on_handover (неявки на этапе корзины неизвестны — считаем 0, окончательно решает сервер).
4. `checkOrderMinimums({ subtotalKop, marginKop, minOrderTotalKop, minMarginKop })` →
   `{ ok: true }` | `{ ok: false; code: 'min_total' | 'min_margin'; message; missingKop: Kop | null }`.
   `min_total`: «Минимальная сумма заказа 1 000 ₽ — добавьте позиции ещё на 472 ₽».
   `min_margin`: «Заказ слишком маленький для оформления на сайте — добавьте ещё позицию»
   (маржа не раскрывается, `missingKop: null`). Пороги 0 = нет порога. Совпадает с охранами
   `minTotalReached`/`minMarginReached`.

### 3.4. Машина состояний

В `ORDER_EVENTS` добавляется `client_cancelled`; в `guards.ts` — охрана `noPaymentSucceeded`
(`providerPaymentStatus` ∈ {null, 'pending', 'canceled'}; `undefined` и `'succeeded'`,
`'waiting_for_capture'` не проходят). Правила:

| from | event | to | actors | guard | notify | effects |
|---|---|---|---|---|---|---|
| awaiting_payment | client_cancelled | cancelled | client | noPaymentSucceeded | — | — |
| awaiting_confirmation | client_cancelled | cancelled | client | — | — | — |

Уведомлений нет: продавцы о неподтверждённых и неоплаченных заказах ещё не знают, клиент сам
нажал кнопку. В `transitions.spec.ts` — две строки `EXPECTED`, тесты «succeeded-платёж не даёт
отменить», «без providerPaymentStatus — guard_failed», «из confirmed `client_cancelled` — no_rule»
(там действует `client_refused`). Полный перебор запрещённых пар подхватит новое событие сам.
`packages/notify` не меняется (шаблоны не добавляются), но его тесты прогоняются.

## 4. apps/web: общий серверный слой (волна 1)

Эти файлы нужны нескольким пакетам волны 2, поэтому пишутся в фундаменте и дальше только
читаются.

| Файл | Экспорты | Поведение |
|---|---|---|
| `src/server/supplier.ts` (новый) | `createSupplierDeps({env, db, redis, keyPrefix?, caller?, onError?}) → {rossko, limiter, settings}`, `getSupplier()` (ленивый синглтон), `WEB_CRITICAL_MAX_WAIT_MS = 5000` | Один Rossko-клиент и один `SettingsReader` на процесс; `search.ts` переводится на него без изменения сигнатуры `createSearchDeps` (тесты фазы 0 не трогаются) |
| `src/server/rossko.ts` | опция `criticalMaxWaitMs` в `createWebRossko` | Д18 |
| `src/server/settings.ts` | `SearchSettings` + блок `order: { minOrderTotalKop, minMarginKop, onPickupMaxTotalKop, onPickupConfirmTtlH, noShowLimit, paymentTtlMin, courierFeeKop }` | Те же правила: строка из БД, иначе env-дефолт `settingsDefaultsFromEnv`, мусор игнорируется |
| `src/server/documents.ts` | `LegalDocument.id` | Нужен для `consents.document_version_id` и `orders.offer_version_id` |
| `src/server/cart-store.ts` (новый) | `CART_COOKIE='cart'`, `newCartToken()`, `isCartToken(v)`, `cartCookieOptions(env)`, `readCartToken(cookieStore)`, `findActiveCart(db, token) → {cart, lines: CartLine[]} \| null`, `fetchFreshOffers(rossko, articleNorms, {priority, bypassCache}) → Map<string, Offer[] \| null>`, `persistRepricing(db, cartId, repriced)`, `removeCartLines(tx, cartId, lineIds)`, `MAX_CART_LINES=20`, `MAX_CART_SEARCHES=10` | Д9–Д10, Д17, Д21. `fetchFreshOffers` запрашивает артикулы параллельно, ошибку одного артикула превращает в `null` для `priority:'search'` и пробрасывает для `'critical'`. `persistRepricing` обновляет цену, наценку, снимок, дату, `fetched_at`, уменьшает количество и удаляет unavailable/excluded в одной транзакции |
| `src/server/request-guards.ts` (новый) | `isSameOrigin(headers, appBaseUrl)`, `isHoneypotTripped(value)`, `HONEYPOT_FIELD='website'`, `consentIp(ip) → string \| null`, `userAgentForConsent(headers)` (обрезка до 512) | Д19, Д7 |
| `src/server/checkout-gate.ts` (новый) | `getCheckoutGate({env, db}) → {open:true, docs:{offer, privacy, consentPd, consentMarketing \| null}} \| {open:false, reason:'rkn' \| 'documents', message}` | Д4. Тексты: «Онлайн-оформление откроется после регистрации оператора персональных данных. Пока заказать можно по телефону …» (`reason:'rkn'`); «Оформление временно недоступно» (`'documents'`, предупреждение в лог без ПД) |
| `src/components/DiffBanner.tsx` (новый) | `<DiffBanner changes={LineChange[]} />` | Презентационный компонент, `role="status"`: «Цена изменилась: Knecht OC 90 +53 ₽», «Осталось меньше: … теперь 2 шт.», «Больше нет в наличии: … — убрали из корзины», «Не продаём онлайн: … — убрали из корзины». Пустой массив + флаг `cartChanged` → «Корзина изменилась — проверьте состав и сумму» |

Тесты фундамента в web: `test/request-guards.test.ts` (Origin совпадает / чужой / нет Origin
и `Sec-Fetch-Site: same-origin` / нет обоих; honeypot; `consentIp('local') === null`),
`test/cart-store.int.test.ts` (cookie-токен 43 символа; `findActiveCart` чужого или
converted → null; `persistRepricing` обновляет цену, удаляет excluded; `fetchFreshOffers` с
`bypassCache` идёт мимо кэша — счётчик вызовов подменённого caller),
`test/checkout-gate.int.test.ts` (без RKN — `rkn`; с RKN вне production — открыто с черновиками;
`NODE_ENV=production` без публикации — `documents`), тест `settings` на новый блок `order`.

## 5. Корзина (волна 2, пакет `cart`)

### 5.1. API (route handlers, принимают форму `application/x-www-form-urlencoded` и JSON)

| Метод и путь | Тело | Успех | Ошибки |
|---|---|---|---|
| `POST /api/cart/items` | `q` (артикул запроса), `offerId`, `qty` (по умолчанию multiplicity) | форма: 303 → `/cart?added=1`; JSON: 200 `{count, totalKop}`. Без cookie создаётся корзина и ставится cookie | 403 Origin; 400 ввод; 404 `offer_not_found`; 422 `excluded` («Не продаём онлайн, спросите в сервисе»), `qty`, `cart_full`; 503 поставщик. Для формы ошибки — 303 на `/cart?error=<code>` |
| `POST /api/cart/items/<id>` с `_method=patch` или `PATCH` | `qty` | 303 → `/cart` / 200 | 404 чужая строка; 422 qty |
| `POST /api/cart/items/<id>` с `_method=delete` или `DELETE` | — | 303 → `/cart` / 200 | 404 |

Добавление: `supplier.rossko.search(q, {priority:'search'})` (кэш 15 мин — предложение только что
показано), поиск предложения по `offerId`, `cartLineFromOffer`, upsert по `(cart_id, offer_key)`
с суммированием количества и проверкой остатка. Цену и наценку клиент не передаёт никогда.

### 5.2. Страница `/cart` (`app/(site)/cart/page.tsx`, noindex)

1. Читает cookie, `findActiveCart`; пусто → EmptyState «Корзина пуста» со ссылкой на поиск.
2. Пересчёт «свежим GetSearch через кэш»: `fetchFreshOffers(…, {priority:'search'})` →
   `repriceCartLines` → `persistRepricing` → `DiffBanner` с изменениями (показываются один раз:
   следующий рендер уже без них). Сбой поставщика или квоты → плашка «Не удалось обновить цены,
   проверим при оформлении», цены из корзины.
3. Строки (`CartLineRow`): бренд, артикул, название, бейдж склада (`StockBadge`), дата
   `formatPromise`, цена, количество (форма), «Удалить».
4. `CartSummary`: сумма, дата получения заказа (`promisedDate` по датам строк), подсказка
   `checkOrderMinimums`, кнопка «Оформить заказ» → `/checkout` (при закрытом гейте — текст гейта
   вместо кнопки).
5. `PaymentModeNotice`: для однородной корзины — объяснение `explainPaymentScheme` (неявки = 0,
   с пометкой «окончательно — после ввода телефона»); для смешанной — «В корзине есть детали в
   Оренбурге и под заказ. Одним заказом — предоплата 100%.» и, если `splitAdvice.offerSplit`,
   кнопка «Разделить на два заказа» → `/checkout?part=local` с пояснением «Сначала оформим детали
   из Оренбурга с оплатой при получении, затем — под заказ»; иначе ссылка «Оформить одним заказом».

### 5.3. Встраивание

1. `OfferRow` получает `searchArticleNorm` и для непохожих на стоп-группу строк показывает форму
   «В корзину» (`AddToCartForm`, обычная `<form method="post" action="/api/cart/items">`, кнопка
   ≥ 44 px). Для excluded кнопки нет (как и раньше «Не продаём онлайн»).
2. `/search`: строка «Оформление заказа на сайте скоро откроется» заменяется на ссылку «Перейти в
   корзину» при непустой корзине.
3. `SiteHeader` получает `cartCount` и показывает «Корзина» (с числом позиций) — layout
   `(site)/layout.tsx` читает cookie и считает строки одним запросом (ошибка БД → 0, страница
   не падает).

## 6. Оформление (волна 2, пакет `checkout`)

### 6.1. Страница `/checkout?part=all|local|order` (noindex)

1. Гейт `getCheckoutGate`: закрыт → `CheckoutClosed` с текстом гейта и телефоном точки; формы
   нет вообще (ни одного поля ПД).
2. Нет корзины или выбранная часть пуста → редирект на `/cart`. Для однородной корзины `part`
   игнорируется.
3. Пересчёт через кэш (как `/cart`, через общий `cart-store`), DiffBanner при изменениях.
4. Сводка: позиции части, сумма, «Получение к чт 8 октября», точка выдачи (`PICKUP_*`: название,
   адрес, часы, телефон), способ оплаты (`PaymentSchemeNote` с `explainPaymentScheme`,
   неявки = 0, «окончательно определим по номеру телефона»). Курьер не показывается (ф2).
5. Пороги: `checkOrderMinimums` не прошёл → подсказка и неактивная кнопка.
6. `CheckoutForm` (`'use client'`): телефон (`type="tel"`, `autocomplete="tel"`, нормализация
   на сервере, подсказка формата), имя (`autocomplete="name"`, 1–60 символов), канал статусов —
   радиокнопки MAX / Telegram / SMS (обязательно, пояснение «как предпочтение; подключить
   уведомления можно будет на странице заказа»), блок «Самовывоз» (адрес и часы), чекбоксы
   отдельно: «Принимаю условия [оферты]» (обязательный), «Даю [согласие на обработку
   персональных данных]» (обязательный, ссылки на `/docs/offer` и `/docs/consent` в новом окне),
   «Хочу получать предложения и скидки» (необязательный, только если есть документ
   `consent_marketing`), honeypot `website` (вне экрана, `tabIndex=-1`, `autocomplete=off`,
   `aria-hidden`), скрытые `expectedTotalKop`, `itemsHash`, `part`, `checkoutKey` (uuid v7 при
   рендере). Кнопка «Оформить заказ» неактивна без обоих обязательных чекбоксов. Ответы: 201 →
   `location.assign(orderUrl)`; 409 → DiffBanner, новые `expectedTotalKop`/`itemsHash`, сумма
   и позиции обновляются (`router.refresh()`), заказ не создан; 422 → ошибки у полей; 429/503 —
   текст ответа. `<noscript>`: «Для оформления включите JavaScript или позвоните …».

### 6.2. `POST /api/checkout`

Тело JSON: `{ part, phone, name, channel: 'max'|'telegram'|'sms', acceptOffer, consentPd,
consentMarketing, expectedTotalKop, itemsHash, checkoutKey, website }` (zod, неизвестные поля
отбрасываются). Порядок (`server/checkout/checkout-service.ts`, зависимости внедряются, как в
`search-service.ts`: `db`, `supplier`, `loadSettings`, `now`, `gate`, `logger`):

1. `isSameOrigin` → иначе 403 `forbidden_origin`. Honeypot заполнен → 400 `rejected`, в лог
   только факт. Гейт закрыт → 403 `checkout_closed` с текстом.
2. Валидация: телефон через `normalizePhone` (422 `validation`, `fields.phone`), имя, канал,
   `acceptOffer === true` и `consentPd === true` (иначе 422 `consent_required` — заказ без
   согласия невозможен ещё до транзакции).
3. Идемпотентность: заказ с таким `checkout_key` уже есть → 200 с тем же `orderUrl`.
4. Корзина по cookie, `selectCartPart`; пусто → 404 `cart_empty`.
5. Свежий пересчёт мимо кэша: `fetchFreshOffers(…, {priority:'critical', bypassCache:true})` —
   через общий лимитер (`critical` проходит предохранитель 70% до 100% квоты), ожидание не
   дольше 5 с. Ошибка поставщика, лимитера или Redis → 503 `supplier_unavailable`, заказа нет.
6. `repriceCartLines`; хэш и сумма свежих строк сравниваются с `expectedTotalKop`/`itemsHash`
   клиента. Любое расхождение или любое изменение (`price`, `qty`, `unavailable`, `excluded`) →
   `persistRepricing` и 409 `{ error:'stale', changes, totalKop, itemsHash }`. Заказ, пользователь,
   согласия не создаются; правило `checkout_stale` не пишется в `order_events` (строки заказа нет),
   в лог — `checkout stale` с числом изменений.
7. `checkOrderMinimums` по свежим суммам → 422 `below_minimum` с `message`.
8. Транзакция (`db.transaction`):
   1. `users` upsert по телефону (`onConflictDoUpdate`, Д14) → `id`, `noShowCount`.
   2. `orders` insert: `status 'draft'`, `accessToken` = 32 байта base64url (256 бит),
      `paymentScheme` из `choosePaymentScheme`, `fulfillment 'pickup'`, `subtotalKop`,
      `courierFeeKop 0`, `totalKop = subtotal + courier_fee`, `itemsHash`, `promisedDate =
      promisedDate(etaDates, eta)`, `pickupCode`, `offerVersionId`, `preferredChannel`,
      `checkoutKey`, `cartId`, `expiresAt` (Д11). Номер `DT-…` — из sequence по умолчанию.
   3. `consents` insert: `pd` (документ `consent_pd`: `document_version_id`, `text_sha256 =
      sha256` версии, `ip = consentIp`, `user_agent`, `channel 'web'`, `order_id`), `marketing` —
      если отмечено.
   4. `order_items` insert: поля позиции, `priceSupplierAtOrderKop`, `priceClientKop`,
      `markupBp`, `etaDate`, `offerSnapshot`, `offerKey`, `searchArticleNorm`, `state 'pending'`.
   5. `resolveTransition('draft', 'checkout', ctx)` с `actor:'client'`, `hasPdConsent:true`,
      `allItemsLocal`, `totalKop`, `minOrderTotalKop`, `orderMarginKop`, `minMarginKop`,
      `onPickupMaxTotalKop`, `noShowCount`, `noShowLimit`, `fulfillment:'pickup'`. Не `ok` →
      откат и 500 (рассогласование с шагом 7 — ошибка кода). `rule.to` должно совпасть со схемой
      из `choosePaymentScheme` (иначе тоже откат): эффект `set_scheme_*` — контроль.
   6. `orders` update `status = rule.to`; `order_events` insert `{type:'checkout', fromStatus:
      'draft', toStatus: rule.to, actorType:'client', actorId: userId, payload: {part,
      scheme, items: n, deferredEffects: ['create_payment'] (только prepay)}}` — без телефона и
      имени.
   7. Оформленные строки удаляются из корзины; корзина пуста → `status 'converted'`,
      `user_id` проставляется.
   8. Нарушение `orders_checkout_key_unique` (гонка двух отправок) → откат и ответ шага 3.
9. 201 `{ orderUrl: '/o/<token>', number }`; в лог — `order created` с номером, схемой и числом
   позиций, без ПД.

`server/checkout/hash.ts`: `itemsHash(lines) = sha256hex(itemsHashPayload(lines))` — используется
и страницей (скрытое поле), и API.

## 7. Страница заказа и отмена (волна 2, пакет `order`)

### 7.1. `/o/[token]`

1. Токен проверяется регуляркой `^[A-Za-z0-9_-]{43}$` до запроса в БД; не найден → `notFound()`.
2. `metadata`: `robots: {index:false, follow:false}`, `referrer: 'no-referrer'`, заголовок
   «Заказ DT-000123». Заголовки `Referrer-Policy: no-referrer` и `X-Robots-Tag` ставит пакет
   `limits` (раздел 8).
3. Блоки: номер и статус человеческим словом (карта всех 17 статусов: «Ждёт оплаты», «Ждёт
   подтверждения», «Отменён», остальные — для 1B), дата «Получение к чт 8 октября»
   (`formatPromise(promised_date)`), точка выдачи (адрес, часы, телефон из env), способ оплаты:
   - prepay: «Предоплата 100% онлайн» + неактивная кнопка «Оплатить 1 170 ₽» и текст «Оплата
     подключается — пришлём ссылку, как только она заработает»;
   - pay_on_handover: «Оплата при получении картой или по QR» + «Подтверждение заказа
     подключается: мы свяжемся с вами»;
   позиции (бренд, артикул, название, количество, цена) и сумма; таймлайн; кнопки «Статусы в MAX» и
   «Статусы в Telegram» — неактивные заглушки «скоро» (выбранный при оформлении канал
   подсвечен; `link_tokens` не создаются до 1C); код выдачи — только со статуса `ready` (Д13).
4. Таймлайн (`server/orders/timeline.ts`): `order_events` по времени, фразы:
   `checkout` → `awaiting_payment` «Заказ оформлен, ждём оплату»; → `awaiting_confirmation`
   «Заказ оформлен, оплата при получении»; `client_cancelled` «Вы отменили заказ»; неизвестное
   событие → «Статус заказа: <статус>». Время — «2 октября, 14:05» в Asia/Yekaterinburg.
5. Если в корзине этого браузера остались позиции (после «Разделить») — плашка «В корзине
   остались детали под заказ — оформить второй заказ» → `/checkout?part=order` (или `/cart`).
6. «Отменить заказ» показывается, только если `availableEvents(status, ctx)` содержит
   `client_cancelled`: раскрывающийся блок «Для подтверждения введите последние 4 цифры
   телефона» (`inputMode="numeric"`, 4 цифры) и кнопка «Отменить заказ» (`CancelOrderForm`,
   `'use client'`).

### 7.2. `POST /api/orders/[token]/cancel`

Тело `{ last4 }`. Порядок: Origin (403) → токен (404) → счётчик неудач заказа в Redis
`rl:cancel-fail:<orderId>` (5 в час; Redis недоступен → 503, fail closed) → транзакция:
`select … for update` заказа, сравнение `last4` с `phoneLast4(users.phone)` через
`timingSafeEqual` (неверно → инкремент счётчика, 422 `wrong_digits` с `attemptsLeft`; при
исчерпании — 429), контекст `{actor:'client', scheme, providerPaymentStatus}` (статус последней
строки `payments` заказа или `null`), `resolveTransition(status, 'client_cancelled', ctx)`; не
`ok` → 409 `not_cancellable` («Этот заказ уже нельзя отменить на сайте — позвоните нам»);
`ok` → `status 'cancelled'`, `cancelled_at = now`, `expires_at = null`, `order_events
{type:'client_cancelled', from, to:'cancelled', actorType:'client', actorId:userId}`. Ответ 200
`{status:'cancelled'}`, клиент делает `router.refresh()`. Позиции не возвращаются в корзину.

## 8. Лимиты и заголовки (волна 2, пакет `limits`)

1. `server/rate-limit.ts` обобщается: `RATE_LIMITS = { search: [min 20/60 с, day 300/24 ч],
   checkout: [hour 10/1 ч], cancel: [hour 5/1 ч], cart: [hour 120/1 ч] }`,
   `hitRateLimit(redis, {kind, secret, ip, keyPrefix?, now?})`, ключ
   `rl:<kind>:<window>:<HMAC(SESSION_SECRET, rateLimitSubject(ip))>`. `hitSearchRateLimit`
   остаётся обёрткой (тесты фазы 0 не меняются).
2. `server/request-limits.ts`: `classifyLimitedRequest({method, pathname, searchParams,
   headers}) → {kind, action: 'count'|'head'|'pass'}`: поиск — как `classifySearchRequest`;
   `POST /api/checkout` → checkout; `POST /api/orders/<token>/cancel` → cancel;
   `POST|PATCH|DELETE /api/cart` и `/api/cart/**` → cart; остальное — pass.
3. `proxy.ts`: использует классификатор; превышение → 429 с `Retry-After`: JSON, если путь
   `/api/` и клиент не просит `text/html`; HTML-страница для навигации формой (корзина без JS).
   Redis недоступен → fail open (как поиск; отмена всё равно закрыта счётчиком неудач).
4. Заголовки в proxy: `/o/*` и `/api/orders/*` — `Referrer-Policy: no-referrer`,
   `X-Robots-Tag: noindex, nofollow`, `Cache-Control: no-store`; `/cart`, `/checkout` —
   `X-Robots-Tag`. `next.config.ts`: глобальный `Referrer-Policy` не должен перебить proxy на
   `/o/` — правило с `source: '/((?!o/).*)'` для `Referrer-Policy` и отдельное правило
   `/o/:token` с `no-referrer` (проверяется e2e по фактическому ответу).
5. `robots.ts`: `/cart`, `/checkout` закрыты meta noindex (в robots.txt не запрещаются, по той
   же причине, что `/search`); `/o/` уже запрещён.

## 9. E2E (волна 3, пакет `e2e`)

`apps/web/e2e/checkout.spec.ts`, проекты `mobile` 375×812 и `desktop` 1280×800, сервер — standalone
на :3100 с env из CI (раздел 2), уникальный телефон на прогон (`+79` + 9 случайных цифр).

1. Смешанная корзина и предоплата: `/search?q=OC90` → «В корзину» у Knecht OC 90 (ORB1, местный)
   и у BOSCH 0 451 103 079 (MSK7, под заказ) → `/cart`: две строки, `PaymentModeNotice` с кнопкой
   «Разделить на два заказа», нет горизонтального скролла, скриншот `<project>-cart.png` →
   «Оформить заказ» → `/checkout`: текст про предоплату, кнопка неактивна до чекбоксов, скриншот
   → телефон `8 (9xx) …`, имя, канал MAX, оба чекбокса → `/o/<token>`: «DT-», «Ждёт оплаты»,
   «к » + день недели, адрес точки, неактивная «Оплатить» и «Оплата подключается», таймлайн
   «Заказ оформлен», `referrer-policy: no-referrer` и `x-robots-tag: noindex` в ответе, скриншот.
2. Разделение и отмена: местная + под заказ → «Разделить на два заказа» → `/checkout?part=local`
   → оформление → «Ждёт подтверждения», «Оплата при получении», плашка «оформить второй заказ»
   → «Отменить заказ» с неверными цифрами (ошибка) → с верными → «Отменён», в таймлайне «Вы
   отменили заказ», кнопки отмены нет → переход по плашке: `/checkout?part=order` с одной строкой.
3. 409: `page.route('**/api/checkout')` подменяет `expectedTotalKop` на сумму − 100 ₽ → DiffBanner
   «Корзина изменилась…», адрес страницы не сменился; повторная отправка без подмены → `/o/…`.
4. Без согласия: кнопка неактивна; прямой `fetch` без `consentPd` → 422 и заказа нет.
5. Стоп-группа: `/search?q=EDGE5W40` — нет кнопки «В корзину»; прямой POST в
   `/api/cart/items` → 422.
6. `limits.spec.ts`: 11-й `POST /api/checkout` за час с одного `X-Real-IP` → 429 (тело может быть
   невалидным — лимит считается в proxy до обработчика); 21-й поиск → 429 (как было).
7. `screens.spec.ts`: в обход добавляются пустая `/cart` и `/checkout` без корзины (редирект).

Скриншоты в `test-results/screens/`, агент открывает их через Read и смотрит глазами.

## 10. Тест-кейсы (сводка) и строки Verification «Фаза 1A»

| Где | Кейс | Ожидание |
|---|---|---|
| domain unit | `choosePaymentScheme`: все местные, 15 000,00 ₽, неявок 1 | pay_on_handover |
| domain unit | то же 15 000,01 ₽ / неявок 2 / одна позиция под заказ / курьер | prepay с причиной `over_limit` / `no_show` / `to_order` / `courier` |
| domain unit | `splitCartLines`, `selectCartPart`, `splitAdvice` | смешанная корзина делится; разделение не предлагается, если местная часть > 15 000 ₽ |
| domain unit | `repriceCartLines` | price (+53 ₽), qty (остаток 6 → 2), unavailable, excluded, дубль предложения → дешёвое, `null` по артикулу → без изменений |
| domain unit | `checkOrderMinimums`, `cartTotals`, `itemsHashPayload` | порог суммы и маржи, нули = нет порога; хэш не зависит от порядка строк и меняется от цены и количества |
| domain unit | `normalizePhone` | раздел 3.1 |
| domain spec | `client_cancelled` | раздел 3.4 |
| db int | миграция 0001 и ограничения | раздел 1 |
| web int (cart) | добавить OC90 ORB1 | 200/303, cookie `HttpOnly; SameSite=Lax`, строка с ценой 528 ₽ = ceil(412,50 × 1,28) |
| web int (cart) | повторно то же предложение | одна строка, количество 2 |
| web int (cart) | добавить EDGE5W40 (масло) | 422 `excluded`, строк нет — **стоп-группа не добавляется** |
| web int (cart) | количество больше остатка / не кратно | 422 |
| web int (cart) | чужая строка, чужой Origin | 404, 403 |
| web int (cart) | открытие корзины после подорожания в caller (+10%) | DiffBanner-изменение price, цена в БД обновлена |
| web int (checkout) | успех, смешанная корзина | 201, `awaiting_payment`, prepay, `order_events` checkout draft→awaiting_payment с `deferredEffects`, `order_items` со снимком и `offer_key`, consent pd: `text_sha256` = sha256 документа, ip, user_agent, `order_id`; корзина пуста и converted; `promised_date` = max(eta)+1; `total = subtotal` |
| web int (checkout) | успех, только местные ≤ 15 000 ₽ | `awaiting_confirmation`, `expires_at` ≈ +24 ч |
| web int (checkout) | пользователь с `no_show_count = 2` | prepay, причина нейтральная |
| web int (checkout) | цена в caller выросла между страницей и POST | 409 `stale` с `changes[0].kind='price'`, заказа, пользователя, согласий нет, цены корзины обновлены — **устаревший total → 409** |
| web int (checkout) | клиент прислал устаревший `expectedTotalKop` | 409 |
| web int (checkout) | без `consentPd` / без `acceptOffer` | 422, нет строк в users, orders, consents — **заказ без согласия невозможен** |
| web int (checkout) | honeypot заполнен | 400, ничего не создано |
| web int (checkout) | чужой Origin; без Origin и Sec-Fetch-Site | 403 |
| web int (checkout) | `minOrderTotalKop` 100 000 через внедрённые настройки | 422 `below_minimum` «…ещё на 472 ₽» |
| web int (checkout) | `minMarginKop` выше маржи | 422 без раскрытия маржи |
| web int (checkout) | стоп-правило появилось после добавления (внедрённые excludedRules) | 409 `excluded`, строка удалена из корзины — **стоп-группа не попадает в заказ** |
| web int (checkout) | `RKN_NOTICE_NUMBER` пуст | 403 `checkout_closed`, страница без полей ПД |
| web int (checkout) | тот же `checkoutKey` дважды (последовательно и параллельно) | один заказ, оба ответа с одним `orderUrl` |
| web int (checkout) | `part=local`, потом `part=order` | два заказа, схемы pay_on_handover и prepay, корзина converted после второго |
| web int (checkout) | отмеченный маркетинг | две строки consents |
| web int (checkout) | caller бросает / лимитер `RosskoRateLimitError` | 503, ничего не создано |
| web int (order) | загрузка по токену | позиции, сумма, таймлайн; неизвестный и кривой токен → notFound |
| web int (order) | отмена верными цифрами из awaiting_payment и awaiting_confirmation | cancelled, `cancelled_at`, событие `client_cancelled` |
| web int (order) | неверные цифры ×5, затем верные | 422 ×5 с `attemptsLeft`, затем 429 |
| web int (order) | отмена уже отменённого; при `payments.status='succeeded'` (вставленная строка) | 409 `not_cancellable` |
| web int (limits) | 11-й checkout, 6-й cancel, 121-я запись в корзину | 429 с Retry-After, JSON/HTML по Accept |
| web unit (limits) | классификатор | HEAD/OPTIONS/GET не считаются для POST-лимитов; поиск как раньше |
| e2e | раздел 9 | на 375 и 1280 без горизонтального скролла, скриншоты |

Строки Verification «Фаза 1A» из PLAN и чем закрыты:

| Строка PLAN | Закрытие в 1A |
|---|---|
| Поиск по 10 артикулам Лёши: цена = ceil(опт × наценка диапазона), бейдж склада, дата «к чт 9 октября» | Формула и бейджи — тесты фазы 0 на фикстурах; живые артикулы **заблокированы сетью** (раздел 12), сверка руками после ключей |
| Стоп-группа не добавляется | int cart EDGE5W40 → 422; int checkout: стоп-правило → 409 и удаление; e2e п. 5 |
| Смешанная корзина предлагает разделение | unit `splitAdvice`; e2e п. 1–2 |
| POST /checkout с устаревшим total → 409 и DiffBanner | int checkout (цена в caller, устаревший expected); e2e п. 3 |
| Оформление без согласия невозможно, в consents запись с sha256 | int checkout; охрана `hasPdConsent`; e2e п. 4 |
| 21-й поиск за минуту — 429 | `limits.spec.ts` фазы 0 (не меняется) |
| Телефон без горизонтального скролла | e2e на 375 по `/cart`, `/checkout`, `/o/<token>` и всем страницам фазы 0 |

## 11. Критерии приёмки фазы 1A (в этой среде)

1. `pnpm install --frozen-lockfile`, `pnpm lint`, `pnpm format:check`, `pnpm typecheck`,
   `pnpm test` (все тесты фазы 0 и новые), `pnpm --filter @detaly/db db:drift` — зелёные.
2. `pnpm db:migrate && pnpm db:seed` на базе фазы 0 проходят, повторный сид ничего не меняет.
3. Добавление в корзину из `/search` работает, цена позиции = `ceil(опт × наценка)` из настроек,
   масло (стоп-группа) не добавляется.
4. Корзина пересчитывается при открытии через кэш, изменение цены видно в DiffBanner, смешанная
   корзина показывает `PaymentModeNotice` и «Разделить на два заказа».
5. `/checkout` — один экран; способ оплаты выбран правилом раунда 4 и объяснён словами; без
   `RKN_NOTICE_NUMBER` полей ПД нет и POST отвечает 403.
6. `POST /api/checkout` пересчитывает мимо кэша через общий лимитер (priority critical); при
   расхождении 409 и DiffBanner без создания заказа; без согласия, с honeypot, с чужим Origin,
   ниже порога — отказ без единой строки в БД.
7. Успешное оформление в одной транзакции создаёт/обновляет `users`, пишет `consents` (pd
   обязательно, marketing по желанию) с версией документа, sha256, IP и user agent, `orders` с
   номером `DT-…`, токеном ≥128 бит, схемой, `offer_version_id`, `items_hash`, `promised_date`,
   `pickup_code`, `order_items` со снимком, одно событие `order_events` `draft → awaiting_*`
   через `resolveTransition`.
8. `/o/<token>`: noindex, `Referrer-Policy: no-referrer`, таймлайн человеческими фразами, дата
   «к чт …», адрес и часы точки, способ оплаты, позиции и сумма, заглушки MAX/Telegram, неактивная
   оплата для prepay; «Отменить» с последними 4 цифрами переводит в `cancelled` по машине
   состояний.
9. Лимиты: 11-й checkout и 6-я отмена за час с одного IP-бакета → 429.
10. E2E на 375 и 1280 проходит, горизонтального скролла нет, скриншоты просмотрены.
11. В логах нет телефонов, имён и IP (проверка grep по `web.log` e2e: нет `+79`, нет имени из
    теста).

## 12. Заблокировано сетью и как закрыто

| Что | Почему недоступно | Чем закрыто в 1A |
|---|---|---|
| Живой GetSearch Rossko (`api.rossko.ru`): цены 10 артикулов Лёши, id складов Оренбурга, семантика `count` (`">10"`), `multiplicity`, стабильность `stockId` между вызовами, находятся ли кроссы запросом исходного артикула | `.ru` закрыт, ключей нет | Синтетические фикстуры `fx:`; подмена `RosskoCaller` в int-тестах (подорожание, исчезновение, ошибка); `VERIFY:` в `cart.ts`/`cart-store.ts` и строки в `docs/external.md` (R5, R9 + новые про `count` и `stockId`) |
| ЮKassa (`api.yookassa.ru`) | `.ru` | В 1A не вызывается: эффект `create_payment` отложен (Д12) |
| MAX (`platform-api.max.ru`), Telegram (`api.telegram.org`) | закрыты | Кнопки привязки — заглушки, `link_tokens` не создаются; уведомлений в 1A нет |
| Реестр РКН | ручной внешний шаг | `RKN_NOTICE_NUMBER` — флаг; в тестах и e2e задаётся тестовое значение |
| Сравнение цен 20–30 позиций (аккаунты, розница Rossko, Emex, Autodoc), ответы менеджера Rossko | ручные шаги PLAN п. 10 раздела 7 | Остаются Лёше и Максиму; в 1A — только строки в `docs/external.md` |
| npm registry | не нужен: новых зависимостей нет | lock не меняется |

## 13. Риски и обходы

| Риск | Обход | Проверка |
|---|---|---|
| Оформление включат в проде (зададут `RKN_NOTICE_NUMBER`) до 1B: заказы без оплаты и без уведомлений продавцу | Runbook: не задавать номер в проде до 1B; в 1A гейт ещё требует опубликованных документов | Пакет `docs`, раздел runbook |
| `TRUSTED_IP_HEADER=none` в проде: все клиенты в одном бакете, 10 оформлений в час на сайт | Runbook и предупреждение в лог при старте production с `none` | Проверка из runbook фазы 0 про реальный IP |
| Вторая копия `drizzle-orm` в web | Операторы только из `@detaly/db` (раздел 1) | `pnpm why drizzle-orm` — одна версия, у web нет прямой зависимости |
| Next 16: `cookies()` нельзя менять в Server Component; `params` асинхронные; глобальный `Referrer-Policy` из `next.config` может перебить proxy | Cookie ставят только route handlers; `await params`; разделённые правила `headers()` и e2e по фактическому заголовку | Читать `node_modules/next/dist/docs` (01-app, route handlers, cookies, headers) |
| Гонка двух отправок формы | `checkout_key` unique + повтор шага 3; блокировка корзины `for update` в транзакции | int «параллельно» |
| Пересчёт мимо кэша съедает квоту и медленный | ≤ 10 артикулов на оформление, лимит 10 оформлений/час на IP, `critical` ждёт ≤ 5 с | int с `RosskoRateLimitError` → 503 |
| Кросс не находится повторным поиском своего артикула | `search_article_norm` — артикул запроса (Д9), VERIFY на живом API | Фикстура OC90 с кроссом W 712/75 |
| Перебор 4 цифр отмены | Токен ≥128 бит + 5 попыток в час на заказ + 5 отмен в час на IP, Redis недоступен → 503 | int «неверные ×5» |
| Утечка токена заказа через Referer | `no-referrer` (заголовок и meta), внешних ресурсов на странице нет | e2e проверяет заголовок |
| Параллельные пакеты волны 2 в одной тестовой базе `_web` и в одном Redis | своя база на worktree (`dev-db.sh env` даёт `detaly_test_<worktree>`), уникальные телефоны и токены в каждом тесте, ключи под `test:<uuid>:`, пороги и стоп-правила — внедрением зависимостей, не правкой общих `settings`/`excluded_groups` | Повторный прогон `pnpm --filter @detaly/web test` |
| Тест `documents.int.test.ts` ждёт черновики | Глобальный сид web-тестов не меняется (Д4: вне production черновики допустимы) | Тест фазы 0 зелёный |
| Pay_on_handover-заказы 1A без механизма подтверждения | `expires_at` проставлен, обработка — housekeeping 1B; на странице честное «подключается» | — |

## 14. Волны и пакеты

Правила (как в фазе 0): каждый пакет — отдельный worktree и ветка `wp/1a-<key>`; агент правит
только свои пути, остальное читает; после волны 1 схему, миграции, env, lock,
`packages/domain`, `packages/db`, `packages/config` и общий слой web из раздела 4 не трогает никто
(нужна правка — описать в отчёте, её делает интеграция). Установка
`pnpm install --frozen-lockfile --prefer-offline`; тестовая база —
`scripts/dev-db.sh up && eval "$(scripts/dev-db.sh env)"` (имя `detaly_test_<worktree>`), Redis
— ключи `test:<uuid>:`, `FLUSHDB` запрещён. Коммит после зелёной команды проверки, без push.

### Волна 1 — фундамент (один пакет)

| key | Пути | Суть |
|---|---|---|
| `foundation` | `packages/db/src/schema/{carts,orders,people,relations,index}.ts`, `packages/db/src/index.ts`, `packages/db/drizzle/**`, `packages/db/test/phase1a.int.test.ts`; `packages/config/src/env.ts`, `.env.example`; `packages/domain/src/{types,phone,cart,checkout,index}.ts`, `packages/domain/src/state-machine/{guards,transitions}.ts`, `packages/domain/test/{phone,cart,checkout}.test.ts`, `packages/domain/test/transitions.spec.ts`; `apps/web/src/server/{supplier,cart-store,request-guards,checkout-gate,search,rossko,settings,documents}.ts`, `apps/web/src/components/DiffBanner.tsx`, `apps/web/test/{request-guards,cart-store.int,checkout-gate.int,settings}.test.ts`; `.github/workflows/ci.yml`; `docs/external.md` | Разделы 1–4 |

### Волна 2 — фичи (четыре пакета параллельно)

| key | Пути | Суть |
|---|---|---|
| `cart` | `apps/web/src/server/cart/**`, `apps/web/src/app/api/cart/**`, `apps/web/src/app/(site)/cart/**`, `apps/web/src/components/{AddToCartForm,CartLineRow,CartSummary,PaymentModeNotice}.tsx`, `apps/web/src/components/{OfferRow,SiteHeader}.tsx`, `apps/web/src/app/(site)/layout.tsx`, `apps/web/src/app/(site)/search/page.tsx`, `apps/web/test/cart-*.test.ts` | Раздел 5 |
| `checkout` | `apps/web/src/server/checkout/**`, `apps/web/src/app/api/checkout/**`, `apps/web/src/app/(site)/checkout/**`, `apps/web/src/components/checkout/**`, `apps/web/test/checkout-*.test.ts` | Раздел 6 |
| `order` | `apps/web/src/server/orders/**`, `apps/web/src/app/(site)/o/**`, `apps/web/src/app/api/orders/**`, `apps/web/src/components/order/**`, `apps/web/test/order-*.test.ts` | Раздел 7 |
| `limits` | `apps/web/src/proxy.ts`, `apps/web/src/server/{rate-limit,request-limits,search-request}.ts`, `apps/web/next.config.ts`, `apps/web/src/app/robots.ts`, `apps/web/test/{rate-limit.int,search-request,request-limits,proxy}.test.ts` | Раздел 8 |

### Волна 3 — сквозная проверка и документы (два пакета)

| key | Пути | Суть |
|---|---|---|
| `e2e` | `apps/web/e2e/**`, `apps/web/playwright.config.ts` | Раздел 9 |
| `docs` | `docs/runbook.md`, `README.md`, `docs/external.md` | Runbook: включение оформления (RKN, `LEGAL_*`, `APP_BASE_URL`), запрет включать в проде до 1B, ручной разбор заказов 1A (`psql`), отмена по звонку; README: страницы и эндпоинты 1A; external: ответы и VERIFY 1A |

### Шаг И — интеграция (последовательно)

Слияние волны 2, затем 3; полный прогон раздела 15; скриншоты глазами; правки по ревью; коммит
без push.

## 15. Итоговая проверка фазы в этой сессии

```bash
cd /home/user/detaly
pnpm install --frozen-lockfile
scripts/dev-db.sh up && eval "$(scripts/dev-db.sh env)"
pnpm lint && pnpm format:check && pnpm typecheck
pnpm test && pnpm --filter @detaly/db db:drift
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
pnpm db:migrate && pnpm db:seed && pnpm db:seed
pnpm --filter @detaly/web build && node apps/web/scripts/prepare-standalone.mjs
PORT=3100 HOSTNAME=127.0.0.1 TRUSTED_IP_HEADER=x-real-ip \
  node apps/web/.next/standalone/apps/web/server.js > /tmp/web-1a.log 2>&1 &
E2E_BASE_URL=http://127.0.0.1:3100 PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers \
  pnpm --filter @detaly/web e2e
grep -cE '\+79[0-9]{9}' /tmp/web-1a.log   # 0: телефонов в логах нет
```

Ручная проверка API на запущенном сервере: `curl -X POST -H 'Origin: https://evil.example'
…/api/checkout` → 403; 11 POST с одним `X-Real-IP` → последний 429; `curl -I …/o/<token>` →
`referrer-policy: no-referrer`, `x-robots-tag: noindex`.

## 15a. Исправления по аудиту фазы 1A

| Находка | Решение в коде |
|---|---|
| `client_cancelled` из `awaiting_payment` после «Оплатить заранее» (все позиции уже `arrived`) тихо отменял заказ | Правило разделено по прибытию: `all(noPaymentSucceeded, itemsNotArrived)` — как раньше, без уведомлений; `all(noPaymentSucceeded, allLiveItemsArrived)` — `cancelled` с `client('order_cancelled')`, `sellers('staff_cancel_at_supplier_task')` и эффектом `cancel_at_supplier_task` (отказ до передачи, PLAN раздел 3). Флаг считает `liveItemsAllArrived(order_items.state)` (`@detaly/domain`); отмена и страница заказа передают его в `clientCancelContext`. 1A уведомлений не шлёт: невыполненные `deferredEffects`/`deferredNotify` пишутся в `order_events.payload` для 1B |
| Счётчик неверных 4 цифр проверялся до блокировки строки заказа | Повторная проверка `recentFailures` сразу после `select … for update`: попытки одного заказа сериализуются блокировкой, шестой и следующие запросы получают 429 до сравнения цифр |
| Версии оферты и согласий брались из гейта в момент POST | Форма отправляет `offerVersionId`, `consentPdVersionId`, `consentMarketingVersionId` показанных документов; расхождение с гейтом → 409 `documents_changed`, галочки сбрасываются, страница перерисовывается |
| Оформление по env-дефолтам при недоступных `settings`/`excluded_groups` | `CheckoutSettings.fromDatabase === false` → 503 `settings_unavailable`, поставщик не вызывается |
| Срок получения пересчитывался молча | Форма отправляет `expectedPromisedDate`; свежая дата позже показанной → 409 `stale` с `promisedDate`/`promiseText` («Срок получения изменился: к пт 9 октября»), более ранняя принимается (Д8 для хэша сохраняется) |
| Схема оплаты молча менялась на предоплату по неявкам | Форма отправляет `expectedScheme`; другая схема у сервера → откат транзакции и 409 `scheme_changed` с `explainPaymentScheme` (нейтральная фраза Д15), форма показывает новую схему и шлёт её при повторе; причины пишутся в `payload.schemeReasons` |
| Нет верхней границы суммы | `MAX_ORDER_TOTAL_KOP` = 500 000 ₽ (VERIFY Ю13 в `docs/external.md`): `checkOrderMinimums` → `max_total`, корзина отвечает 422 `cart_total` на добавление и увеличение количества |
| GET `/cart` и `/checkout` вызывали GetSearch при промахе кэша, без лимитов на IP | Просмотр страниц читает только кэш (`search(…, { cacheOnly: true })` в `@detaly/rossko`, промах — `SearchCacheMissError`, строка остаётся со старой ценой и пометкой «Цены и наличие проверим у поставщика при оформлении заказа»). Свежая проверка — только POST `/api/checkout` (лимит 10/час). Новых лимитов в proxy не понадобилось |
| Секреты в логах (`DrizzleQueryError.message` с параметрами) | `errorInfo()` в `server/errors.ts` (имя драйверной ошибки, SQLSTATE, constraint, без message) в отмене, на страницах `/o/<token>`, `/cart`, `/checkout`; страницы бросают `PageDataError` без текста драйвера. E2E проверяет, что токены заказов не попали в лог сервера |
| Тела запросов корзины и отмены без ограничения размера | `server/body.ts`: потоковое чтение с отсечкой (корзина 8 КБ, отмена 256 Б, оформление 16 КБ); `experimental.proxyClientMaxBodySize: '64kb'` |
| Закрытый гейт: тупик с корзиной | `/search` при закрытом гейте не показывает «В корзину» и даёт подсказку с tel-ссылкой; `/cart` при любом закрытом гейте — кнопка «Позвонить …»; текст гейта: «Оформление на сайте скоро откроется. Пока закажите по телефону …» |
| «Разделить на два заказа» без проверки минимумов частей | `splitAdvice` принимает `minOrderTotalKop`/`minMarginKop` и предлагает разделение, только если обе части проходят `checkOrderMinimums` |
| «Окончательно способ оплаты определим по номеру телефона» под предоплатой | Одна константа `FINAL_SCHEME_NOTE`, только при `pay_on_handover` (на `/cart` и `/checkout`) |
| Оформление без адреса и часов точки | Гейт закрыт (`reason: 'pickup'`) без `PICKUP_ADDRESS` или `PICKUP_HOURS`; заглушки адреса сведены к одной фразе без обещания сообщений |
| Городские и 8-800 номера | Оформление принимает только мобильные 9xx (`normalizeMobilePhone`), подсказка «Мобильный номер» |
| С `/cart` не вернуться к поиску | Ссылка «Найти ещё деталь» под корзиной |

## 16. Что не входит в 1A (честно)

Платёж ЮKassa и `expires_at` для prepay, подтверждение pay_on_handover (SMS/мессенджер),
уведомления клиенту и продавцу о новом заказе, привязка мессенджеров и `link_tokens`, отказ после
подтверждения (`client_refused`) на `/o/<token>`, «Оплатить заранее», показ кода выдачи, курьер,
очистка брошенных корзин (housekeeping), мини-админка. Всё это — фазы 1B, 1C и 2. Живые цены
Rossko и сравнение с розницей — после ключей и руками.
