# Демо витрины на Vercel (DEMO_MODE)

Демо нужно, чтобы показать витрину партнёру по ссылке: без Postgres, Redis, воркера и
ключей Rossko. Это тот же `apps/web`, что и в проде, только с `DEMO_MODE=true`. Дизайн
и логику описывает `docs/design.md`, раздел 5.

## Что работает и что выключено

| Часть | В демо |
| --- | --- |
| Поиск | фикстуры Rossko из `packages/rossko/fixtures`, кэш и лимитер в памяти процесса. Есть артикулы `OC90`, `W9142`, `GDB1330`, `EDGE5W40`, а `NOTFOUND` показывает пустой поиск |
| Цены и наценка | значения по умолчанию, как их записал бы сид (`settingsDefaultsFromEnv`), и стандартный стоп-лист |
| Корзина | подписанная httpOnly-cookie `demo_cart` (HMAC от `SESSION_SECRET`, не больше 20 строк). Цены в cookie не хранятся: при каждом чтении корзина пересчитывается по фикстурам |
| Документы | `content/legal`, вшитые в сборку модулем `apps/web/src/server/demo/legal-bundle.ts`. Реквизиты подставляются из env. Пока `LEGAL_*_VERSION` и реквизиты не заданы, документ показывается как черновик с видимыми пропусками |
| Оформление | на `/checkout` экран «В демо оформление отключено» со ссылкой на пример заказа. `POST /api/checkout` отвечает `403 {"error":"demo"}`, тело запроса не читается |
| Заказ | `/o/demo`: пример заказа из двух позиций из фикстур со статусом «Заказан у поставщика». Остальные `/o/*` отвечают 404 |
| Админка, вебхуки, API заказов | `/admin`, `/api/admin/*`, `/api/webhooks/*`, `/api/orders/*` отвечают 404 |
| Лимиты | те же правила, что в проде (поиск 20 в минуту и 300 в сутки, корзина 120 записей в час), но счётчики живут в памяти. Каждый инстанс Vercel считает сам за себя |
| `/api/health` | `{"status":"ok","mode":"demo","db":"skipped","redis":"skipped"}` |
| Индексация | закрыта всегда: `robots.txt` запрещает всё, на каждом ответе `X-Robots-Tag: noindex` |

Переключатель один: `apps/web/src/server/mode.ts` → `isDemoMode()`. Фабрики серверного слоя
(`getSupplier`, `getSearchService`, `getCartService`, `requestCartCount`,
`loadPublishedDocument`, `currentCheckoutGate`) выбирают реализацию по нему сами. `getDb()` и
`getRedis()` в демо бросают `DemoModeError`, поэтому лишнее обращение к базе сразу видно в
логе, а не висит на таймауте подключения.

## Проект на Vercel

1. Import Git Repository → этот репозиторий.
2. **Root Directory**: `apps/web`. Галочка «Include files outside the root directory in the
   Build Step» должна стоять (она стоит по умолчанию): сборке нужны `packages/*`.
3. Framework Preset: Next.js. Install и Build берутся из `apps/web/vercel.json`:
   - install: `pnpm install --frozen-lockfile` (pnpm сам поднимается к корню монорепо);
   - build: `pnpm --filter @detaly/web build`.
4. Node.js Version: **22.x**.
5. Переменные окружения (Production и Preview) — ниже.
6. Deploy. `output: 'standalone'` в `next.config.ts` Vercel не мешает.

### Переменные окружения

Обязательные:

| Переменная | Значение |
| --- | --- |
| `DEMO_MODE` | `true` |
| `SESSION_SECRET` | не короче 32 символов, например `openssl rand -hex 32`. Подписывает cookie корзины. Если его сменить, корзины у всех обнулятся, и это нормально |

Желательные:

| Переменная | Зачем |
| --- | --- |
| `TRUSTED_IP_HEADER` | `x-real-ip`. Vercel сам выставляет этот заголовок с адресом клиента. Без него все посетители попадают в один счётчик лимитов |
| `BRAND_NAME` | название витрины (по умолчанию `Детали`) |
| `PICKUP_POINT_NAME`, `PICKUP_ADDRESS`, `PICKUP_HOURS`, `PICKUP_PHONE` | точка выдачи и установки: автосервис-партнёр |
| `SELLER_REQUISITES_*` | реквизиты в футере и документах. Без них документы показываются черновиками с пропусками |
| `LEGAL_OFFER_VERSION`, `LEGAL_PRIVACY_VERSION`, `LEGAL_CONSENT_PD_VERSION`, `LEGAL_CONSENT_MARKETING_VERSION`, `LEGAL_RETURN_MEMO_VERSION` | `2026-10-d1` (версия файла в `content/legal`). С ними и реквизитами документ идёт как «Действующая редакция», без плашки черновика. Сама пометка юриста внутри текста остаётся, пока её не уберут из `content/legal` |
| `APP_BASE_URL` | адрес демо, например `https://detaly-demo.vercel.app`. Если не задан, в демо берётся из системных переменных Vercel: в production это `VERCEL_PROJECT_PRODUCTION_URL`, в preview — `VERCEL_URL` |

Не задавать: `DATABASE_URL`, `REDIS_URL`, любые `YOOKASSA_*`, `ROSSKO_KEY*`.
`ROSSKO_MODE` оставить пустым или `fixtures`. Схема env с `DEMO_MODE=true` не пропустит ни
боевой Rossko, ни ключи ЮKassa: процесс упадёт с понятной ошибкой ещё до первого запроса.

> Корзина проверяет `Origin` запроса по `APP_BASE_URL` (решение Д19). Поэтому партнёру нужно
> давать основной адрес проекта. Если открыть демо по адресу конкретного деплоя, а
> `APP_BASE_URL` указывает на основной домен, «В корзину» вернёт ошибку. Для своего домена
> впишите его в `APP_BASE_URL` явно.

## Проверить локально перед деплоем

```bash
pnpm install --frozen-lockfile
unset DATABASE_URL REDIS_URL
DEMO_MODE=true pnpm --filter @detaly/web build

# standalone, как в Docker-образе; на Vercel этот шаг не нужен
cd apps/web
cp -r .next/static .next/standalone/apps/web/.next/static
cp -r public .next/standalone/apps/web/public 2>/dev/null || true
DEMO_MODE=true SESSION_SECRET=$(openssl rand -hex 32) PORT=3101 \
  APP_BASE_URL=http://localhost:3101 node .next/standalone/apps/web/server.js
```

Пройти сценарий и снять скриншоты 375 и 1280 одной командой (из корня репозитория, сервер
уже запущен):

```bash
PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers DEMO_URL=http://localhost:3101 \
  node apps/web/scripts/demo-screens.mjs   # -> apps/web/test-results/design-final
```

Скрипт идёт главная → поиск OC90 → «В корзину» (OC90 и GDB1330) → корзина → оформление (экран
демо) → `/o/demo` → документы, «О сервисе», VIN, возврат, проверяет, что нет горизонтальной
прокрутки, и выходит с кодом 1 на первом сбое.

Затем откройте и проверьте:

- `/`, `/search?q=OC90`, «В корзину», `/cart`;
- `/checkout` (экран демо), `/o/demo`, `/docs/offer`;
- `/admin` и `POST /api/webhooks/yookassa` отвечают 404;
- `curl localhost:3101/api/health` возвращает `"mode":"demo"`.

В логе при старте одна строка-предупреждение `demo_mode`, и больше ошибок быть не должно.

## Тексты документов

Документы берутся не из базы, а из модуля, сгенерированного из `content/legal`. После правки
файлов в `content/legal`:

```bash
pnpm --filter @detaly/web gen:legal           # перегенерировать legal-bundle.ts
pnpm --filter @detaly/web gen:legal --check   # выйти с кодом 1, если модуль устарел
```

`apps/web/test/demo-legal-bundle.test.ts` падает, пока закоммиченный модуль расходится с
`content/legal`. Поэтому забыть перегенерацию не получится.

## Если что-то не так

- **«В корзину» возвращает на страницу с ошибкой.** Адрес в браузере не совпадает с
  `APP_BASE_URL`. Задайте его явно или откройте основной адрес проекта.
- **500 на любой странице, в логе `Invalid environment`.** Какая-то переменная не прошла
  схему. Чаще всего это `SESSION_SECRET` короче 32 символов, заданный `ROSSKO_MODE=live` или
  забытый `YOOKASSA_*`.
- **В логе `DemoModeError: database is not available in DEMO_MODE`.** Какая-то страница
  обошла переключатель и полезла в базу. Это баг: найдите вызов `getDb()` в этой странице и
  переведите её на фабрику из `server/`.
- **Лимит поиска срабатывает у всех сразу.** Не задан `TRUSTED_IP_HEADER=x-real-ip`.
