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
| Документы | `content/legal`, вшитые в сборку модулем `apps/web/src/server/demo/legal-bundle.ts`. Реквизиты подставляются из env. Пока `LEGAL_*_VERSION` и реквизиты не заданы, документ показывается как черновик: над текстом одна строка «Реквизиты продавца появятся к запуску», в тексте на месте реквизитов пропуски `________` |
| Оформление | на `/checkout` настоящая форма над демо-корзиной, поля заполнены примером. Кнопка «Оформить — покажем пример заказа» ведёт на `/o/demo`, форма никуда не отправляется. `POST /api/checkout` отвечает `403 {"error":"demo"}`, тело запроса не читается |
| Заказ | `/o/demo`: пример заказа из двух позиций из фикстур со статусом «Заказан у поставщика». Остальные `/o/*` отвечают 404 |
| Админка, вебхуки, API заказов | `/admin`, `/api/admin/*`, `/api/webhooks/*`, `/api/orders/*` отвечают 404 |
| Лимиты | те же правила, что в проде (поиск 20 в минуту и 300 в сутки, корзина 120 записей в час), но счётчики живут в памяти. Каждый инстанс Vercel считает сам за себя |
| `/api/health` | `{"status":"ok","mode":"demo","db":"skipped","redis":"skipped"}` |
| Индексация | закрыта всегда: `robots.txt` запрещает всё, на каждом ответе `X-Robots-Tag: noindex` |
| Заголовки | те же, что в проде: CSP с новым nonce на каждый ответ (`src/proxy.ts`, `src/lib/csp.ts`, без `'unsafe-inline'` в `script-src`), Open Graph с картинкой `/images/og.png` (кроме `/o/*`, `/p/*`, `/cart`, `/checkout`) |

Переключатель один: `apps/web/src/server/mode.ts` → `isDemoMode()`. Фабрики серверного слоя
(`getSupplier`, `getSearchService`, `getCartService`, `requestCartCount`,
`loadPublishedDocument`, `currentCheckoutGate`) выбирают реализацию по нему сами. `getDb()` и
`getRedis()` в демо бросают `DemoModeError`, поэтому лишнее обращение к базе сразу видно в
логе, а не висит на таймауте подключения.

## Проект на Vercel

1. Import Git Repository → этот репозиторий.
2. **Root Directory**: `apps/web`. Галочка «Include files outside the root directory in the
   Build Step» должна стоять (она стоит по умолчанию): сборке нужны `packages/*`.
3. Framework Preset: Next.js. Install, Build и регион берутся из `apps/web/vercel.json`:
   - install: `pnpm install --frozen-lockfile` (pnpm сам поднимается к корню монорепо);
   - build: `pnpm run build`, то есть `next build` в `apps/web`. Генерировать перед сборкой
     ничего не нужно: модуль с документами закоммичен, к базе и Redis сборка не обращается;
   - `"regions": ["fra1"]` (perf-12): функции работают во Франкфурте, а не в Вашингтоне. На
     Hobby один регион разрешён; после деплоя в ответе должно быть `x-vercel-id: fra1::…`.
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
| `PICKUP_POINT_NAME`, `PICKUP_ADDRESS`, `PICKUP_HOURS`, `PICKUP_PHONE` | пункт выдачи: автосервис, где покупатель забирает заказ (`PICKUP_POINT_NAME=Сервис56`). На сайте он только пункт выдачи (решение 08.10): шапка «Пункт выдачи: {адрес без «г. Оренбург, »}», карточка «Пункт выдачи» с названием строкой текста, футер «Пункт выдачи — {название}, {адрес}». Телефон точки — единственный номер для покупателя во всех кнопках. **Для показа партнёру задавать обязательно**: без них у витрины нет ни адреса, ни телефона — шапка без кнопки звонка, футер без крупного номера, на главной нет карточки «Пункт выдачи» |
| `PICKUP_LOGO_SRC`, `PICKUP_EMBLEM_WHITE_SRC` | **на production не задавать** (решение 08.10: логотипы Сервис56 на сайте не показываем). Код их по-прежнему читает (пути от корня сайта к файлам `public/images/partner/*`: цветной знак в широкой карточке пункта, белая эмблема вместо пина в шапке), но без них страница полная: в шапке пин, в карточке пункта — название текстом. В футере, на странице заказа и в оформлении знака нет при любых значениях |
| `PICKUP_MAP_URL_YANDEX`, `PICKUP_MAP_URL_2GIS` | ссылки «Маршрут в Яндекс Картах» и «2ГИС» (https). Без них кнопки ищут адрес точки в картах |
| `PICKUP_TELEGRAM_URL` | чат точки (https://t.me/…): на `/vin` появляется кнопка «Отправить фото СТС в Telegram» с готовым началом сообщения |
| `REVIEW_URL_YANDEX`, `REVIEW_URL_2GIS` | шаг 3 (docs/reviews.md): ссылки на вкладку «Отзывы» своей карточки магазина в Яндекс Картах и 2ГИС (https; не карточки Сервис56). С ними появляются страница `/review` (для QR-таблички) и переход `/o/demo/review/<площадка>` (в демо — без записи); без них `/review` отвечает 404. Рейтинга на витрине в демо нет никогда: его вносят в `/admin/reviews`, а в демо нет базы |
| `SELLER_REQUISITES_*` | реквизиты в футере, на «О нас» и в документах. Без них везде одна нейтральная строка «Реквизиты продавца появятся к запуску», в документах — пропуски `________` и пометка «Черновик» |
| `LEGAL_OFFER_VERSION`, `LEGAL_PRIVACY_VERSION`, `LEGAL_CONSENT_PD_VERSION`, `LEGAL_CONSENT_MARKETING_VERSION`, `LEGAL_RETURN_MEMO_VERSION` | `2026-10-d1` (версия файла в `content/legal`). Пока в тексте есть пометки юриста («Черновик, требует вычитки», «Для юриста:», «— уточнить»), документ показывается черновиком даже с ними и с реквизитами. «Действующей редакцией» без плашки он станет после вычитки, в новом файле версии без пометок. `LEGAL_ALLOW_DRAFT_PUBLISH` на Vercel не задавать |
| `APP_BASE_URL` | адрес демо, например `https://detaly-demo.vercel.app`. Если не задан, в демо берётся из системных переменных Vercel: в production это `VERCEL_PROJECT_PRODUCTION_URL`, в preview — `VERCEL_URL` |

Не задавать: `DATABASE_URL`, `REDIS_URL`, любые `YOOKASSA_*`, `ROSSKO_KEY*`, а на production —
`PICKUP_LOGO_SRC` и `PICKUP_EMBLEM_WHITE_SRC`.
`ROSSKO_MODE` оставить пустым или `fixtures`. Схема env с `DEMO_MODE=true` не пропустит ни
боевой Rossko, ни ключи ЮKassa: процесс упадёт с понятной ошибкой ещё до первого запроса.

#### PICKUP_* для production

| Переменная | Нужна | Что показывает |
| --- | --- | --- |
| `PICKUP_POINT_NAME` | да | название пункта: строка в карточке «Пункт выдачи», футер, шапка без адреса, описание `/about` |
| `PICKUP_ADDRESS` | да | адрес: шапка (без «г. Оренбург, »), карточка, футер, описание `/about`; без него кнопки карт ищут адрес и «Адрес появится к запуску» |
| `PICKUP_HOURS` | да | часы: шапка (десктоп), карточка, футер, описание `/about`; по ним же дата получения сдвигается на рабочий день и считаются слоты установки |
| `PICKUP_PHONE` | да | единственный номер для покупателя: кнопка звонка в шапке, крупный номер в футере, карточка |
| `PICKUP_MAP_URL_YANDEX`, `PICKUP_MAP_URL_2GIS` | желательно | кнопки «Яндекс Карты» и «2ГИС» (https) |
| `PICKUP_TELEGRAM_URL` | по желанию | чат точки: кнопка «Отправить фото СТС в Telegram» на `/vin`, кнопка в футере |
| `PICKUP_LOGO_SRC`, `PICKUP_EMBLEM_WHITE_SRC` | **нет** | на production не задаются (решение 08.10) |
| `REVIEW_URL_YANDEX`, `REVIEW_URL_2GIS` | после заведения карточек | ссылки на отзывы своей карточки магазина (docs/reviews.md): кнопки в «Как деталь?», карточка «Оцените нас», `/review`, рейтинг на витрине |

Реальные адрес и телефон пункта живут только в env проекта на Vercel, в репозитории их нет.

> Корзина проверяет `Origin` запроса по `APP_BASE_URL` (решение Д19). Поэтому партнёру нужно
> давать основной адрес проекта. Если открыть демо по адресу конкретного деплоя, а
> `APP_BASE_URL` указывает на основной домен, «В корзину» вернёт ошибку. Для своего домена
> впишите его в `APP_BASE_URL` явно.

## Проверить локально перед деплоем

```bash
pnpm install --frozen-lockfile
unset DATABASE_URL REDIS_URL
cd apps/web
DEMO_MODE=true ROSSKO_MODE=fixtures pnpm run build   # как Vercel: из apps/web

# standalone, как в Docker-образе; на Vercel этот шаг не нужен
cp -r .next/static .next/standalone/apps/web/.next/static
cp -r public .next/standalone/apps/web/public 2>/dev/null || true
# пункт выдачи — как в проекте Vercel (без PICKUP_LOGO_SRC и PICKUP_EMBLEM_WHITE_SRC);
# адрес и телефон ниже — заглушки для проверки, настоящие — только в env Vercel
export PICKUP_POINT_NAME='Сервис56' PICKUP_ADDRESS='г. Оренбург, ул. Тестовая, 1' \
  PICKUP_HOURS='Пн–Сб 9:00–19:00' PICKUP_PHONE='+7 900 000-00-01' \
  PICKUP_MAP_URL_2GIS='https://2gis.ru/orenburg'
DEMO_MODE=true SESSION_SECRET=$(openssl rand -hex 32) PORT=3101 \
  APP_BASE_URL=http://localhost:3101 node .next/standalone/apps/web/server.js
```

Скриншоты снимаются с этими `PICKUP_*`: без них страницы показывают состояние «до запуска»
(нет карточки точки на главной, «Адрес появится к запуску» на `/about` и `/returns`).

Пройти сценарий и снять скриншоты 375 и 1280 одной командой (из корня репозитория, сервер
уже запущен):

```bash
PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers DEMO_URL=http://localhost:3101 \
  node apps/web/scripts/demo-screens.mjs   # -> apps/web/test-results/design-final
```

Скрипт идёт главная → поиск OC90 → «В корзину» (OC90 и GDB1330) → корзина → оформление (форма
с примером, кнопка без запроса к `/api/checkout`) → `/o/demo` → документы, «О магазине», VIN, возврат, подборка `/p/demo`;
отдельно снимает пустую корзину и «ничего не нашли» (`NOTFOUND`), проверяет, что нет горизонтальной
прокрутки на 360, 375, 1280 и 1440, и выходит с кодом 1 на первом сбое.

Затем откройте и проверьте:

- `/`, `/search?q=OC90`, «В корзину», `/cart`;
- `/checkout` (форма с примером, кнопка ведёт на `/o/demo`), `/o/demo`, `/docs/offer`;
- `/admin` и `POST /api/webhooks/yookassa` отвечают 404;
- `curl localhost:3101/api/health` возвращает `"mode":"demo"`;
- `curl -sI localhost:3101/ | grep -i content-security` — в `script-src` есть `'nonce-…'
  'strict-dynamic'` и нет `'unsafe-inline'`, nonce меняется от запроса к запросу;
- `curl -s localhost:3101/ | grep -o '<meta property="og:[^>]*>'` — `og:site_name` = `BRAND_NAME`,
  `og:locale` ru_RU, `og:image` 1200×630;
- `curl -s -A YandexBot localhost:3101/docs/nope` — 404 с текстом «Страница не найдена» в HTML
  (не пустой `<body>`).

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
