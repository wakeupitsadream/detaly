# Runbook: эксплуатация

Короткие инструкции на случай «что-то сломалось» и для регулярных операций. Все команды
выполняются на VPS из корня клона репозитория (`/opt/detaly` в примерах), если не сказано иное.
Сокращение для compose:

```sh
alias dc='docker compose -f infra/docker-compose.yml --env-file .env'
# /api/health снаружи закрыт (Caddy отвечает 404): проверяем изнутри контейнера web.
health() { dc exec -T web node -e "fetch('http://127.0.0.1:3000/api/health').then(async r=>console.log(r.status, await r.text()))"; }
```

Состав: caddy (80/443) → web (Next.js, порт наружу не открыт) + worker (BullMQ, боты) + postgres
+ redis + backup (cron: бэкап в 02:30, healthwatch каждые 5 минут). Stage — профиль `stage`,
поднимается только на время тестов ЮKassa.

## 1. Первая установка на VPS

1. Ubuntu 24.04, swap 2 ГБ, Docker Engine с compose-плагином, firewall: открыты только 22, 80 и
   443 (TCP), а также 443/udp для HTTP/3.
2. `git clone` репозитория в `/opt/detaly`. Образы на сервере не собираются (сборка Next съест
   память), их собирает CI.
3. `cp .env.example .env` и заполнить:
   - `SITE_DOMAIN`, `ACME_EMAIL` (DNS A-запись домена уже указывает на VPS);
   - `SESSION_SECRET=$(openssl rand -hex 32)`;
   - `POSTGRES_PASSWORD=$(openssl rand -hex 24)` — только hex, потому что пароль подставляется в URL.
     `DATABASE_URL` и `REDIS_URL` для контейнеров compose собирает сам из `POSTGRES_*`, значения
     в `.env` нужны только для запуска инструментов с хоста;
   - `BACKUP_AGE_RECIPIENT` — публичный ключ (раздел 4), `S3_*`;
   - `TG_SELLER_BOT_TOKEN`, `TG_SELLER_CHAT_ID`, `STAFF_SEED_JSON`;
   - реквизиты `SELLER_REQUISITES_*`, `PICKUP_*`.
   Права: `chmod 600 .env`.
4. Сертификат Минцифры — по `infra/certs/README.md` (до подключения MAX можно пропустить).
5. Доступ к ghcr.io: PAT GitHub с правом `read:packages`, затем
   `echo <PAT> | docker login ghcr.io -u <github-user> --password-stdin`.
6. Первый деплой: `infra/deploy.sh <git-sha>` (тег — полный SHA коммита из CI, раздел 2).
7. Проверки: `health` → 200 (снаружи `https://$SITE_DOMAIN/api/health` отвечает 404 — так и
   задумано); сертификат выдан
   (`curl -vI https://$SITE_DOMAIN 2>&1 | grep -i 'issuer'`); `/ping` в боте продавца отвечает;
   `dc exec caddy caddy validate --config /etc/caddy/Caddyfile` → `Valid configuration`;
   раздел 9 про реальный IP.

## 2. Деплой

CI на каждый push в `main` и тег `v*` публикует образы `detaly-web`, `detaly-worker`,
`detaly-backup` с тегами `<полный sha>`, `latest` (main) и semver (теги). Деплоим всегда по SHA,
`latest` не используем.

```sh
cd /opt/detaly && git pull            # обновить compose, Caddyfile и скрипты
DRY_RUN=1 infra/deploy.sh <sha>        # посмотреть команды
infra/deploy.sh <sha>
```

Что делает `deploy.sh <sha>`:
1. Preflight по `.env`: домен, ACME e-mail, пароль Postgres не по умолчанию, `SESSION_SECRET`,
   ключ шифрования бэкапа.
2. `pull` образов web, worker, backup.
3. Поднимает postgres и redis, затем `run --rm worker` для миграций и сида (сид идемпотентный).
4. Записывает тег в `.env` (`IMAGE_TAG` и `GIT_SHA`) и делает `up -d web worker backup caddy`.
   Благодаря записи в `.env` любые ручные `dc up -d ...` дальше поднимают тот же тег, а не `latest`.
5. До 90 секунд ждёт, пока **новый** worker запишет heartbeat в Redis (heartbeat старого worker'а
   остаётся свежим до 5 минут и скрыл бы падающий новый), затем `200` от `/api/health` изнутри
   контейнера web (БД, Redis, heartbeat).
6. При успехе пишет `.deploy/current_tag` и `.deploy/prev_tag`, при провале поднимает предыдущий
   тег (и возвращает его в `.env`) и выходит с кодом 1. Журнал — `.deploy/history.log`.

Правило миграций: только expand/contract. Новая версия добавляет колонки и таблицы, удаление идёт
отдельным релизом после того, как старый код уже не нужен. Иначе откат на старый образ упадёт
на новой схеме.

`Caddyfile` и `docker-compose.yml` берутся с диска, не из образа. После их правки нужен
`git pull` и `dc up -d caddy` (Caddy перечитывает конфиг при пересоздании) либо
`dc exec caddy caddy reload --config /etc/caddy/Caddyfile`.

## 3. Откат

```sh
infra/deploy.sh rollback      # тег из .deploy/prev_tag, без миграций
```

Вручную на любой тег — тоже через скрипт: `infra/deploy.sh <sha>` (миграции идемпотентны). Если
запустить `IMAGE_TAG=<sha> dc up -d ...` мимо скрипта, `.env` останется со старым тегом, и
следующий `dc up` вернёт его. Тогда поправьте `IMAGE_TAG` и `GIT_SHA` в `.env` руками.
Если сломала данные миграция, откат образа не поможет. Тогда восстановление из бэкапа на stage,
разбор, исправляющая миграция (раздел 4).

## 4. Бэкап и восстановление

Бэкап: каждую ночь в 02:30 по `TZ` контейнер backup делает `pg_dump -Fc`. Дамп шифруется на
публичный ключ age (`BACKUP_AGE_RECIPIENT`) и уходит в `s3:$S3_BUCKET/postgres/` вместе с файлом
`.sha256`. Дампы старше 30 дней удаляются. При сбое приходит сообщение в чат продавцов.

Дополнительно в бакете включите lifecycle-правило «удалять объекты с префиксом `postgres/` старше
35 дней» — вторая линия на случай, если скрипт перестанет чистить. Ключ S3 для бэкапа должен
уметь только читать, писать и удалять объекты в этом бакете.

### Ключ age

```sh
age-keygen -o detaly-backup.key        # на своём компьютере, НЕ на VPS
age-keygen -y detaly-backup.key        # публичный ключ age1... → BACKUP_AGE_RECIPIENT в .env
```

Приватный ключ хранится офлайн у Максима (менеджер паролей и копия на флешке). На VPS он
появляется только на время восстановления. Без ключа бэкапы бесполезны. Запасной режим —
`BACKUP_PASSPHRASE` (gpg, AES256), он используется, только если `BACKUP_AGE_RECIPIENT` пуст.

### Ручной бэкап и список дампов

```sh
dc exec backup backup.sh
dc exec backup restore.sh --list
```

### Восстановление на stage (проверка раз в месяц и перед рискованной миграцией)

```sh
scp detaly-backup.key root@vps:/root/detaly-backup.key   # временно
infra/deploy.sh stage <sha>                               # stage-база detaly_stage
dc run --rm -v /root/detaly-backup.key:/key:ro -e BACKUP_AGE_IDENTITY=/key backup \
  sh -c 'RESTORE_TARGET_URL="${DATABASE_URL%@*}@postgres-stage:5432/detaly_stage" restore.sh latest'
shred -u /root/detaly-backup.key
```

`${DATABASE_URL%@*}` берёт из `DATABASE_URL` контейнера логин и пароль Postgres
(`postgres://user:pass`), чтобы не набирать пароль в командной строке хоста.

`restore.sh` сверяет sha256, расшифровывает, выполняет `pg_restore --clean --if-exists --no-owner
--single-transaction` и печатает число строк по таблицам. Сравните с продом:

```sh
dc exec postgres psql -U detaly -d detaly -c "select count(*) from settings" -c "select count(*) from document_versions" -c "select count(*) from orders"
```

Конкретный дамп вместо последнего: `restore.sh detaly-20261002T213000Z.dump.age <url>`. Цель
восстановления в фазе 2 — меньше 30 минут от команды до работающего сайта.

### Восстановление продакшена (авария)

1. `dc stop web worker` — новые записи в базу не идут.
2. Если старая база ещё читается, сделайте её копию: `dc exec backup backup.sh`.
3. Восстановление в рабочую базу (защита требует `RESTORE_FORCE=1`):
   `dc run --rm -v /root/detaly-backup.key:/key:ro -e BACKUP_AGE_IDENTITY=/key -e RESTORE_FORCE=1 backup sh -c 'RESTORE_TARGET_URL="$DATABASE_URL" restore.sh latest'`
4. `dc up -d web worker` и `health`.
5. Платежи за период между бэкапом и аварией нужно сверить вручную с ЛК ЮKassa: reconciliation
   догонит pending-платежи, но заказы, созданные после бэкапа, потеряны. Свяжитесь с клиентами
   по списку платежей ЮKassa.

### Локальная проверка без S3 и Docker

```sh
scripts/dev-db.sh up && eval "$(scripts/dev-db.sh env)"
pnpm db:migrate && pnpm db:seed
infra/backup/selftest.sh "$DATABASE_URL"
```

`selftest.sh` создаёт одноразовый ключ age и делает бэкап в `STORAGE=local`. Затем он
восстанавливает `latest` во временную базу, сравнивает точное число строк каждой таблицы и
повторяет то же с gpg. Этот же шаг выполняется в CI.

## 5. «Worker молчит»

Признаки: в чат продавцов пришло «worker молчит» от healthwatch, `/api/health` отвечает 503 с
проблемой heartbeat, бот продавца не отвечает на `/ping`, напоминания не приходят.

1. `dc ps worker` — статус и health. `dc logs --tail=200 worker` — последняя ошибка.
2. Частые причины:
   - нет связи с Redis или Postgres: `dc ps redis postgres`, `dc logs redis`;
   - OOM: `docker inspect detaly-worker-1 --format '{{.State.OOMKilled}}'`, `dmesg | grep -i oom`.
     Лимит 512m, при повторении — разбираться с утечкой, а не поднимать лимит;
   - Redis упёрся в `maxmemory` 256mb с `noeviction`: запись отклоняется (`OOM command not
     allowed`). Смотрите `dc exec redis redis-cli info memory` и размер очередей. Чистить
     завершённые задачи нужно средствами BullMQ (`clean`), а не удалением ключей вручную.
     `FLUSHDB` и `FLUSHALL` запрещены: вместе с задачами пропадут кэш, лимиты и heartbeat;
   - ошибка конфигурации после деплоя: в логе `EnvError` со списком переменных.
3. `dc restart worker`, через минуту проверьте `health`.
4. Если сломал релиз — `infra/deploy.sh rollback`.
5. После восстановления healthwatch пришлёт «worker снова работает». Задачи BullMQ при
   перезапуске не теряются. Проверьте `dead-letter` командой `/queues` в боте (фаза 1B).

Heartbeat пишется каждые 30 секунд с TTL 10 минут. Порог тревоги — 300 секунд
(`HEARTBEAT_STALE_SEC`), повтор алерта — раз в час, пока проблема не устранена. Если healthwatch
сам молчит (упал контейнер backup), это видно по `dc ps backup`. Внешний мониторинг (Uptime Kuma)
добавится в фазе 2.

## 6. Квота Rossko исчерпана

Лимиты: `ROSSKO_RPM_LIMIT=250` запросов в минуту и `ROSSKO_DAILY_LIMIT=90000` в сутки. Сутки
считаются по Москве и сбрасываются в 00:00 МСК, это 02:00 по Екатеринбургу. При 70% суточной
квоты (`ROSSKO_QUOTA_BREAKER_PCT`) поиск отвечает только из кэша, а без кэша — «попробуйте позже»
(503). Критичные вызовы (перепроверка перед заказом, GetCheckout, GetOrders) работают до 100%.

1. Текущий счётчик: `dc exec redis redis-cli --scan --pattern 'rossko:quota:*'`, затем
   `dc exec redis redis-cli get rossko:quota:<день>`.
2. Причина — обычно боты или перебор. Смотрите `search_log` за последний час:
   `select query, count(*) from search_log where created_at > now() - interval '1 hour' group by 1 order by 2 desc limit 20;`
   и 429 в логах web (`dc logs web | grep 429`). Лимиты на IP — 20 в минуту и 300 в сутки.
3. Если упёрлись честно, напишите менеджеру Rossko и попросите поднять лимит (вопрос R1 в
   `docs/external.md`). Новое значение задайте в `ROSSKO_DAILY_LIMIT` и сделайте `dc up -d web worker`.
4. До сброса заказы оформляются по кэшу. Заказ у поставщика и перепроверка идут через критичную
   квоту. Если исчерпана и она — ручной режим (раздел 10).
5. Сбрасывать счётчик в Redis вручную нельзя: реальный лимит у Rossko от этого не изменится.

## 7. Инцидент с персональными данными (152-ФЗ, ст. 21 ч. 3.1)

Инцидент — неправомерная или случайная передача, утечка, доступ посторонних к ПД: утечка `.env`
или дампа, взлом VPS, ошибочная рассылка, потерянный ноутбук с ключом.

**Сроки отсчитываются с момента, когда инцидент обнаружен:**
- **24 часа** — уведомить РКН (через портал pd.rkn.gov.ru, раздел об инцидентах): что
  произошло, предполагаемые причины, предполагаемый вред, принятые меры, контактное лицо;
- **72 часа** — второе уведомление с результатами внутреннего расследования и сведениями о
  виновных, если они установлены.

Порядок:
1. Зафиксировать время обнаружения и источник — записка или сообщение самому себе с отметкой
   времени.
2. Остановить утечку: сменить скомпрометированные секреты (`SESSION_SECRET`, `POSTGRES_PASSWORD`,
   токены ботов через @BotFather, ключи ЮKassa и Rossko, ключи S3, PAT ghcr). Если скомпрометирован
   приватный ключ age — новый ключ, новый `BACKUP_AGE_RECIPIENT`, старые дампы удалить после
   появления новых. При взломе VPS — новый сервер и восстановление из бэкапа (раздел 4).
3. Оценить объём: какие таблицы и поля, сколько субъектов, за какой период (`users`, `orders.address`,
   `consents`, фото VIN).
4. Уведомить РКН в 24 часа, даже если данных пока мало, и дополнить в 72 часа.
5. Сохранить логи: `dc logs --since 72h > incident-<дата>.log`, логи Caddy и доступа к S3.
6. Записать инцидент во внутренний журнал (пакет документов оператора ПД) и пересмотреть меры.
7. При необходимости уведомить субъектов. Решение — вместе с юристом.

## 8. Stage

```sh
cp .env .env.stage   # затем отредактировать
```

В `.env.stage` нужны тестовый магазин ЮKassa (`YOOKASSA_SHOP_ID` и `YOOKASSA_SECRET_KEY`),
`APP_BASE_URL=https://$STAGE_DOMAIN` и **другие** токены ботов или пустые. Два процесса с одним
токеном Telegram в long polling перехватывают апдейты друг у друга, поэтому `deploy.sh` откажется
стартовать при совпадении. `ROSSKO_ALLOW_CHECKOUT=false` и `NOINDEX_ALL=true` compose задаёт сам.
База stage — отдельная (`postgres-stage`, база `detaly_stage`).

Basic auth: `docker run --rm caddy:2-alpine caddy hash-password --plaintext '<пароль>'` → в `.env`
пишем `STAGE_BASIC_AUTH_USER=...` и `STAGE_BASIC_AUTH_HASH='$2a$14$...'`. Одинарные кавычки
обязательны, иначе compose примет `$` за подстановку. Пока хэш не задан, stage отвечает 401 всем.
Вебхуки `/api/webhooks/*` basic auth не требуют, их проверяет приложение.

```sh
infra/deploy.sh stage <sha>     # поднять (миграции и сид — в базу stage)
infra/deploy.sh stage-down      # остановить; тома с данными stage сохраняются
```

Stage занимает ≈1,4 ГБ памяти. Держите его поднятым только на время тестов.

## 9. Проверка реального IP клиента за Docker NAT

Лимиты поиска (а с фазы 1A и лимиты корзины, оформления и отмены, раздел 11.6) считаются по IP
из `X-Real-IP`, который ставит Caddy (`{remote_host}`). Если Docker подменяет адрес клиента на
адрес шлюза (`172.x.0.1`), все клиенты получат один общий лимит, и 21-й запрос в минуту от всех
вместе получит 429, а 11-е оформление в час — тоже 429.

Проверка после первого деплоя и после обновления Docker:
1. С **внешнего** устройства (телефон в мобильной сети) откройте `https://$SITE_DOMAIN/`.
2. На VPS: `dc logs --since 2m caddy | grep -o '"remote_ip":"[^"]*"' | sort | uniq -c`.
   Журнал Caddy хранит адрес усечённым до подсети (IPv4 /24, IPv6 /48, требование политики ПД),
   поэтому последний октет всегда `0`.
3. Должна быть подсеть публичного адреса телефона: первые три октета совпадают с адресом на
   любом сайте «мой IP». Если виден `172.x.x.0` или `10.x.x.0`, адрес подменяется. Тогда:
   - чаще всего это IPv6-клиент при выключенном `ip6tables`: его проксирует `docker-proxy`
     (userland-proxy). В `/etc/docker/daemon.json` укажите `{"ip6tables": true}` (в Docker 27+
     по умолчанию включено) или `{"userland-proxy": false}`, затем `systemctl restart docker`
     и `dc up -d`;
   - либо уберите AAAA-запись домена, пока IPv6 не настроен;
   - крайний вариант — `network_mode: host` для caddy с правкой адресов upstream.
4. Повторите шаг 2. Проверка подмены заголовка снаружи:
   `curl -s -H 'X-Real-IP: 1.2.3.4' https://$SITE_DOMAIN/ -o /dev/null` — в логе Caddy остаётся
   ваш адрес, а в приложение уходит `X-Real-IP` от Caddy. Клиентский заголовок перезаписывается.
5. web снаружи недоступен: `curl -m 5 http://<IP VPS>:3000/` должен завершиться таймаутом или
   отказом.

## 10. Ручной режим через ЛК Rossko и ЮKassa

Когда автоматика недоступна (API Rossko лежит, квота исчерпана, ЮKassa API отвечает ошибками,
worker не поднимается), работаем руками. Каждое ручное действие записываем, чтобы потом провести
его в системе.

**Rossko (заказ у поставщика):**
1. Карточка заказа в боте или админке: бренд, артикул, количество, склад.
2. ЛК Rossko → поиск по артикулу → тот же склад → в корзину → оформить на адрес пункта выдачи.
   В комментарии — наш номер `DT-000123`.
3. Номер заказа Rossko записать в заказ: кнопка или комментарий в админке. Отправленный
   вручную заказ НЕ отправлять повторно через кнопку «Заказать» — будет дубль.
4. Отмена у Rossko — через ЛК или менеджера до отгрузки (вопрос R6 в `docs/external.md`).

**ЮKassa (платежи и чеки):**
1. Статус платежа — ЛК ЮKassa → Платежи → поиск по описанию «Заказ DT-000123» или по
   `metadata.order_id`. Источник истины — ЛК, а не наша база.
2. Возврат — ЛК → платёж → «Вернуть», сумма по строкам. Чек возврата ЮKassa формирует сама.
   Возврат клиенту — не позже 10 дней от требования (ст. 22 ЗоЗПП).
3. Чек зачёта аванса при выдаче, если очередь receipts не работает: выдачу **не** делаем, пока
   чек не пробит. Клиенту — «приходите позже» (выдача без чека запрещена, PLAN раздел 3).
   Если доступен ручной чек в ЛК «Чеков от ЮKassa» — пробить там и записать номер.
4. После восстановления reconciliation сам подтянет статусы платежей и возвратов (каждые 10 минут).
   Ручные чеки сверить с `receipts`.

**Связь с клиентом:** телефон — в админке. В мессенджерах номер и адрес клиента не пишем.

## 11. Оформление заказов (фаза 1A)

Фаза 1A добавила корзину (`/cart`), оформление (`/checkout`), страницу заказа (`/o/<token>`) и
отмену заказа клиентом. Оплаты, подтверждения pay_on_handover и уведомлений продавцу и клиенту в
1A **нет**. Заказ только создаётся в статусе `awaiting_payment` (предоплата) или
`awaiting_confirmation` (оплата при получении) и остаётся в базе. Подробности —
`docs/phase-1a-implementation.md`.

### 11.1. Не включать оформление в проде до фазы 1B

> **Не задавайте `RKN_NOTICE_NUMBER` в продовом `.env`, пока не выкатится фаза 1B.** В 1A
> новый заказ никто не увидит: нет сообщения в чат продавцов, нет оплаты, нет подтверждения, нет
> кнопок в боте. Клиент оформит заказ и будет ждать, а деталь никто не закажет. Кроме того,
> форма начнёт собирать персональные данные (телефон, имя), а по PLAN формы сбора ПД
> публикуются только после уведомления РКН и получения номера записи.

До 1B оформление проверяется только локально, в CI (e2e) и на stage силами команды (stage
закрыт basic auth, раздел 8). Пока номера нет, `/cart` вместо кнопки «Оформить заказ», а
`/checkout` вместо формы показывают текст «Онлайн-оформление откроется после регистрации
оператора персональных данных. Пока заказать можно по телефону …» (телефон из `PICKUP_PHONE`,
иначе `SELLER_REQUISITES_PHONE`). Полей ПД на странице нет, `POST /api/checkout` отвечает
`403 checkout_closed`. Корзина при этом работает: персональных данных в ней нет.

### 11.2. Как включается оформление

Оформление открыто, только когда выполнены **все** условия (`apps/web/src/server/checkout-gate.ts`):

1. `RKN_NOTICE_NUMBER` — номер записи в реестре операторов ПД (заявка №11 в
   `docs/external.md`). Формат не проверяется: любой непустой текст открывает форму. Поэтому в
   прод вписывается только настоящий номер.
2. Есть тексты оферты (`offer`), политики (`privacy`) и согласия на обработку ПД
   (`consent_pd`). При `NODE_ENV=production` (в compose так всегда, и на stage тоже) это должны
   быть **опубликованные** версии: заданы `LEGAL_OFFER_VERSION`, `LEGAL_PRIVACY_VERSION`,
   `LEGAL_CONSENT_PD_VERSION`, и сид их опубликовал. Согласие на черновик ничего не доказывает.
   Вне production допускаются черновики: в `consents` пишутся их версия и sha256.
3. Чекбокс «Хочу получать предложения и скидки» показывается, только если опубликован
   `consent_marketing` (`LEGAL_CONSENT_MARKETING_VERSION`). Без него оформление работает, просто
   без маркетингового согласия.
4. `APP_BASE_URL` точно совпадает с публичным origin сайта: схема, хост и порт, например
   `https://example.ru` (без `www`, если сайт открывается без `www`). Все изменяющие запросы
   (корзина, оформление, отмена) сравнивают заголовок `Origin` с
   `new URL(APP_BASE_URL).origin`. Без `Origin` запрос проходит только с
   `Sec-Fetch-Site: same-origin`. При несовпадении корзина и оформление отвечают 403
   `forbidden_origin`, клиент видит «Запрос отклонён: откройте страницу … на сайте». Если сайт
   доступен и с `www`, и без него, второй адрес должен перенаправлять на первый.
5. `TRUSTED_IP_HEADER=x-real-ip` у web (compose задаёт его сам, проверка ниже). Иначе все
   клиенты попадают в один общий бакет лимитов: **10 оформлений в час на весь сайт**, а также 5
   отмен и 120 изменений корзины на всех. Кроме того, в `consents.ip` тогда пишется `null`, и
   доказательство согласия становится слабее.

Порядок включения (после выкатки 1B):

```sh
cd /opt/detaly
# 1. Тексты вычитаны юристом (заявка №13), версии лежат файлами content/legal/<kind>/<version>.md.
#    Опубликованную версию менять нельзя: сид упадёт. Новый текст — новый файл и новая версия.
# 2. В .env: LEGAL_OFFER_VERSION, LEGAL_PRIVACY_VERSION, LEGAL_CONSENT_PD_VERSION
#    (+ LEGAL_CONSENT_MARKETING_VERSION, LEGAL_RETURN_MEMO_VERSION); проверить APP_BASE_URL.
infra/deploy.sh "$(cat .deploy/current_tag)"   # тот же образ: миграции + сид опубликуют версии
dc exec postgres psql -U detaly -d detaly -c \
  "select kind, version, published_at from document_versions where published_at is not null order by kind"
dc exec web printenv APP_BASE_URL TRUSTED_IP_HEADER   # https://<домен> и x-real-ip
# 3. Только теперь: RKN_NOTICE_NUMBER=<номер записи> в .env
dc up -d web          # web пересоздаётся с новым .env
```

Проверка: в корзине с позицией есть кнопка «Оформить заказ», на `/checkout` — форма с
телефоном и чекбоксами. Если вместо формы написано «Оформление временно недоступно», смотрите
11.5. Проверка Origin снаружи:
`curl -s -X POST -H 'Origin: https://evil.example' -H 'Content-Type: application/json' -d '{}' https://$SITE_DOMAIN/api/checkout`
→ 403 `forbidden_origin`. Реальный IP клиента — раздел 9.

Выключить оформление: убрать `RKN_NOTICE_NUMBER` из `.env` и выполнить `dc up -d web`. Уже
созданные заказы и страницы `/o/<token>` продолжают работать.

### 11.3. Новые заказы и согласия в базе (без выгрузки ПД)

До 1B нет ни мини-админки, ни карточек в боте, поэтому заказы смотрят через `psql` на VPS:

```sh
dc exec postgres psql -U detaly -d detaly
```

Правила:

- результаты не сохраняются в файлы (`\o`, `\copy`, `> file`), не копируются в мессенджеры, чаты
  и задачи, не фотографируются. В переписке — только номер заказа, статус, бренд и артикул;
- телефон и имя запрашиваются отдельным запросом и только когда без них никак (звонок клиенту,
  выдача). Заказ ищите по номеру: телефон в условии запроса останется в истории `psql`;
- `ip` и `user_agent` из `consents` выводятся только для ответа на запрос РКН или в споре.

Последние заказы — номер, статус, схема, сумма, без ПД:

```sql
select o.number, o.status, o.payment_scheme as scheme,
       (o.total_kop / 100.0)::numeric(12, 2) as total_rub,
       o.promised_date,
       to_char(o.created_at at time zone 'Asia/Yekaterinburg', 'DD.MM HH24:MI') as created,
       (select count(*) from order_items i where i.order_id = o.id) as lines
from orders o
where o.created_at > now() - interval '7 days'
order by o.created_at desc
limit 50;
```

Сводка по статусам:

```sql
select status, payment_scheme, count(*), sum(total_kop) / 100 as total_rub
from orders group by 1, 2 order by 1, 2;
```

Позиции заказа (бренд, артикул, склад, цены):

```sql
select i.brand, i.article, i.name, i.qty, i.stock_id, i.is_local,
       (i.price_client_kop / 100.0)::numeric(12, 2) as price_rub,
       (i.price_supplier_at_order_kop / 100.0)::numeric(12, 2) as supplier_rub,
       i.eta_date
from order_items i join orders o on o.id = i.order_id
where o.number = 'DT-000123'
order by i.brand, i.article;
```

Журнал заказа (`payload` без ПД: часть корзины, схема, число позиций, отложенные эффекты):

```sql
select to_char(e.created_at at time zone 'Asia/Yekaterinburg', 'DD.MM HH24:MI:SS') as at,
       e.type, e.from_status, e.to_status, e.actor_type, e.payload
from order_events e join orders o on o.id = e.order_id
where o.number = 'DT-000123'
order by e.created_at, e.id;
```

Согласия заказа: какой документ, опубликован ли он, совпадает ли хэш. IP не выводится, только
признак, что он записан:

```sql
select c.kind, d.kind as document, d.version, d.published_at is not null as published,
       c.text_sha256 = d.sha256 as hash_ok,
       to_char(c.given_at at time zone 'Asia/Yekaterinburg', 'DD.MM.YYYY HH24:MI') as given,
       c.ip is not null as has_ip, c.revoked_at
from consents c
join orders o on o.id = c.order_id
join document_versions d on d.id = c.document_version_id
where o.number = 'DT-000123'
order by c.kind;
```

Контроль: заказы без согласия `pd`. Результат должен быть пустым, иначе это ошибка кода, и её
надо разбирать:

```sql
select o.number, o.status from orders o
where o.status <> 'draft'
  and not exists (select 1 from consents c where c.order_id = o.id and c.kind = 'pd');
```

Телефон и имя — только при необходимости и только по номеру заказа:

```sql
select u.phone, u.name from orders o join users u on u.id = o.user_id where o.number = 'DT-000123';
```

Если клиент не помнит номер, спросите последние 4 цифры телефона и примерную дату заказа:

```sql
select o.number, o.status, o.created_at from orders o join users u on u.id = o.user_id
where right(u.phone, 4) = '4567' and o.created_at > now() - interval '3 days';
```

Код выдачи (`orders.pickup_code`) создаётся при оформлении, но клиенту показывается только со
статуса `ready`. В 1A этот статус не наступает, код никому не называйте.

### 11.4. Отмена по звонку клиента (до 1B)

Клиент может отменить заказ сам на странице `/o/<token>`: кнопка «Отменить заказ» и последние 4
цифры телефона. Кнопка есть в статусах `awaiting_payment` и `awaiting_confirmation`. Если клиент
звонит и просит отменить заказ, проще всего попросить его открыть ссылку и нажать кнопку. Если
это не получается (ссылка потеряна, 5 попыток ввода цифр исчерпаны), есть два пути:

- подождать 1B: там появится кнопка отмены у продавца. Заказ без оплаты в 1A ничего не стоит,
  но клиент будет видеть его действующим на странице заказа;
- отменить вручную в базе, как описано ниже.

Ручная отмена — это обход машины состояний. Она допустима только для этих двух статусов и
только пока нет оплаты. У перехода `client_cancelled` из этих статусов нет ни действий, ни
уведомлений (`packages/domain`), поэтому SQL повторяет ровно то, что делает кнопка клиента:
статус, `cancelled_at`, `expires_at = null` и одна строка `order_events`. Событие записывается
как `client_cancelled` (по просьбе клиента), но с `actor_type = 'staff'` и id сотрудника. На
странице заказа клиент увидит «Отменён», а в ленте — «Вы отменили заказ».

```sql
-- 1. Кто отменяет: id сотрудника.
select id, name, role from staff where is_active order by name;
-- 2. Заказ и платежи: статус awaiting_payment или awaiting_confirmation, платежей нет (в 1A их не бывает).
select o.number, o.status, o.payment_scheme,
       (select string_agg(p.status::text, ', ') from payments p where p.order_id = o.id) as payments
from orders o where o.number = 'DT-000123';
-- 3. Отмена одной транзакцией. Подставьте номер заказа и id сотрудника.
begin;
with prev as (
  select o.id, o.status
  from orders o
  where o.number = 'DT-000123'
    and o.status in ('awaiting_payment', 'awaiting_confirmation')
    and not exists (
      select 1 from payments p
      where p.order_id = o.id and p.status in ('succeeded', 'waiting_for_capture')
    )
  for update
), upd as (
  update orders o
  set status = 'cancelled', cancelled_at = now(), expires_at = null, updated_at = now()
  from prev
  where o.id = prev.id
  returning o.id, prev.status as from_status
)
insert into order_events (id, order_id, type, from_status, to_status, actor_type, actor_id, payload)
select gen_random_uuid(), upd.id, 'client_cancelled', upd.from_status, 'cancelled', 'staff',
       '<id сотрудника>', '{"via": "phone", "manual": true}'::jsonb
from upd
returning order_id, from_status, to_status;
-- Вернулась ровно одна строка → commit; ноль строк (статус уже другой или есть оплата) → rollback.
commit;
```

`gen_random_uuid()` даёт uuid v4, приложение пишет v7. Для ручной записи это допустимо: лента
сортируется по `created_at`. Позиции заказа в корзину клиента не возвращаются. Если в статусе
`awaiting_payment` по заказу уже есть оплата (это возможно с 1B), вручную не отменяйте: нужен
возврат денег, а он делается только через машину состояний (раздел 10, ЮKassa).

### 11.5. Что значат ответы и сообщения в логах

Логи web — `dc logs --since 1h web`, коды ответов — в журнале Caddy
(`dc logs --since 1h caddy | grep -E '"status":(403|409|429|503)'`). ПД в логи не пишутся: о
заказе логируются номер, схема и число позиций, об ошибках — коды.

| Где | Что значит | Что делать |
|---|---|---|
| `POST /api/checkout` → 409, в логе web `checkout stale` (с числом изменений) | Цена, остаток или наличие у Rossko изменились между открытием `/checkout` и отправкой, либо сумма и хэш позиций от клиента устарели. Заказ **не** создан, корзина пересчитана, клиент видит «Корзина изменилась — проверьте состав и сумму» и отправляет форму ещё раз | Изредка — норма. Если 409 получает каждое оформление, значит, цены «прыгают» между вызовами Rossko или хэш считается по-разному: сверить R14 в `docs/external.md` и разобрать с разработчиком |
| `checkout stale: cart changed meanwhile` | Корзину изменили в другой вкладке во время оформления | Норма |
| `POST /api/orders/<token>/cancel` → 409 `not_cancellable` | Заказ уже нельзя отменить на сайте: статус не `awaiting_*` (например, уже отменён) или по заказу есть успешная оплата. Клиент видит «Этот заказ уже нельзя отменить на сайте — позвоните нам» | Если клиент звонит, посмотреть статус (11.3) |
| На `/cart` и `/checkout` надпись «Оформление временно недоступно», в логе web `checkout closed: legal documents are not published` с полем `missing` | `RKN_NOTICE_NUMBER` задан, но нужных документов нет или (в production) они не опубликованы. `missing` перечисляет виды: `offer`, `privacy`, `consent_pd` | Задать `LEGAL_*_VERSION` и прогнать сид (11.2). Если это прод до 1B — убрать `RKN_NOTICE_NUMBER` (11.1) |
| `checkout supplier unavailable`, ответ 503 `supplier_unavailable` | Перепроверка цен у Rossko мимо кэша не удалась: ошибка API, лимитер не дал окно за 5 с или недоступен Redis. Заказ не создан, клиент видит «Не удалось проверить цены у поставщика — попробуйте через минуту» | Разделы 6 (квота) и 5 (Redis) |
| `checkout honeypot`, ответ 400 | Заполнено скрытое поле формы — это бот | Ничего. Если таких много — смотреть 429 и подсети в журнале Caddy |
| `checkout failed`, ответ 500 | Ошибка базы или кода, транзакция заказа откатилась | Смотреть ошибку в логе, разбирать |
| `order created` | Заказ создан: номер, схема, число позиций, часть корзины | — |
| `order cancelled by client` / `order cancel: wrong digits` | Клиент отменил заказ / ввёл неверные цифры | — |
| `order cancel: attempt counter unavailable`, ответ 503 | Redis недоступен, и отмена закрыта (fail closed), чтобы нельзя было перебирать цифры | Раздел 5 |
| `rate limit unavailable, failing open` | Redis недоступен, лимиты на IP не считаются | Раздел 5 |
| 403 `forbidden_origin` на `/api/cart/*`, `/api/checkout` или отмене | `Origin` не совпадает с `APP_BASE_URL` | Проверить `APP_BASE_URL` (11.2, п. 4). Единичные 403 с чужим `Origin` — чужие сайты или боты, это норма |
| 429 `rate_limited` | Превышен лимит (11.6) | Если 429 получают многие разные клиенты, проверить `TRUSTED_IP_HEADER` и раздел 9 |

### 11.6. Лимиты 1A

Лимиты считаются в `apps/web/src/proxy.ts` по бакету IP: ключ — `HMAC(SESSION_SECRET, IP)`,
IPv6 группируется по /64, сам IP в Redis не попадает. Значения — константы в коде
(`apps/web/src/server/rate-limit.ts`), через `.env` они не настраиваются.

| Что | Лимит | Если Redis недоступен |
|---|---|---|
| Оформление `POST /api/checkout` | 10 в час | не считается (fail open) |
| Отмена `POST /api/orders/<token>/cancel` | 5 в час | не считается |
| Изменение корзины `POST/PATCH/DELETE /api/cart/**` | 120 в час | не считается |
| Неверные 4 цифры при отмене | 5 в час **на заказ** (`rl:cancel-fail:<order id>`) | отмена закрыта, 503 |
| Поиск (фаза 0) | 20 в минуту и 300 в сутки | поиск отвечает 503 |

Превышение — ответ 429 с `Retry-After`: JSON для `fetch` и короткая HTML-страница для обычной
формы (корзина без JavaScript). Запросы с чужим `Origin` в лимит не засчитываются, чтобы другой
сайт не мог израсходовать лимит посетителя. Сбрасывать счётчики вручную не нужно: окна
скользящие и освобождаются сами.

Пределы корзины (это не лимиты запросов): до 20 строк; количество от 1 до 99, кратное
кратности и не больше остатка; до 10 разных артикулов запроса, потому что каждый при оформлении
— отдельный вызов GetSearch.

### 11.7. Корзины

Cookie `cart` хранит только случайный токен, а цены и количества лежат в `carts` и
`cart_items`. Срок cookie — `CART_TTL_DAYS` (по умолчанию 30 дней). Строки в базе по этому
сроку не удаляются: очистка брошенных корзин — задача housekeeping фазы 1B. Персональных данных
в корзине нет, `user_id` проставляется только у оформленной (`converted`) корзины. Размер
таблицы: `select status, count(*) from carts group by 1;`.
