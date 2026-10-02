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
   перезапуске не теряются, а переходы, сделанные пока worker стоял, ждут в `outbox` и уйдут после
   запуска. Проверьте `dead-letter` командой `/queues` в боте (раздел 12.8).

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
3. Номер заказа Rossko записать в заказ: действие админки «Заказано вручную в ЛК Rossko»
   (раздел 12.4). Отправленный вручную заказ НЕ отправлять повторно через «Заказать всё равно»,
   пока позиции не отмечены заказанными, — будет дубль.
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

> **С фазой 1B этот запрет снят.** Условия включения оформления в проде — раздел 12.11. Текст
> ниже оставлен как история решения 1A.

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
   доказательство согласия становится слабее. При старте production с `none` web пишет в лог
   предупреждение `TRUSTED_IP_HEADER=none in production` (`check: untrusted_client_ip`):
   `dc logs web | grep untrusted_client_ip` должно быть пусто.

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

До 1B не было ни мини-админки, ни карточек в боте, поэтому заказы смотрели через `psql` на VPS.
С фазой 1B основной инструмент — админка `/admin` (раздел 12.10); запросы ниже остаются для
разборов, и правила работы с ПД действуют для обоих способов:

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
select status, payment_scheme, count(*), (sum(total_kop) / 100.0)::numeric(14, 2) as total_rub
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
select o.number, o.status,
       to_char(o.created_at at time zone 'Asia/Yekaterinburg', 'DD.MM HH24:MI') as created
from orders o join users u on u.id = o.user_id
where right(u.phone, 4) = '4567' and o.created_at > now() - interval '3 days'
order by o.created_at desc;
```

Код выдачи (`orders.pickup_code`) создаётся при оформлении, но клиенту показывается только со
статуса `ready`. В 1A этот статус не наступает, код никому не называйте.

### 11.4. Отмена по звонку клиента (до 1B)

Клиент может отменить заказ сам на странице `/o/<token>`: кнопка «Отменить заказ» и последние 4
цифры телефона. Кнопка есть в статусах `awaiting_payment` и `awaiting_confirmation`. Если клиент
звонит и просит отменить заказ, проще всего попросить его открыть ссылку и нажать кнопку. Если
это не получается (ссылка потеряна, 5 попыток ввода цифр исчерпаны), есть два пути:

- подождать таймер: с фазой 1B неоплаченный заказ отменяется сам по истечении срока оплаты
  (`order.payment_ttl_min`), а неподтверждённый — через 24 часа. Кнопки отмены у продавца для
  этих двух статусов нет и в 1B (машина состояний разрешает её только клиенту); после оплаты или
  подтверждения — «Отказ клиента» в боте или админке (раздел 12);
- отменить вручную в базе, как описано ниже.

Ручная отмена — это обход машины состояний. Она допустима только для этих двух статусов и
только пока нет оплаты. С фазой 1B есть исключение: заказ, который попал в `awaiting_payment` из
`ready` через «Оплатить заранее» (детали уже на точке), вручную не отменяйте — у этой отмены есть
задача продавцу про возврат Rossko; попросите клиента отменить по ссылке. Если по заказу висит
неоплаченный платёж и клиент всё же оплатит после ручной отмены, система сама вернёт деньги
(раздел 12.7). У перехода `client_cancelled` из этих статусов нет ни действий, ни
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
| `POST /api/checkout` → 409 `checkout_key_conflict` (в логе web ничего) | Ключ повторной отправки формы (`checkoutKey`) уже использован заказом из другой корзины (другого браузера). Ссылка на чужой заказ не выдаётся, клиент видит «Форма устарела — обновите страницу и попробуйте ещё раз» | Единичные — норма (форма открыта в двух браузерах). Массовые — кто-то подбирает ключи: смотреть 429 и подсети в журнале Caddy |
| `POST /api/orders/<token>/cancel` → 409 `not_cancellable` | Заказ уже нельзя отменить на сайте: статус не `awaiting_*` (например, уже отменён) или по заказу есть успешная оплата. Клиент видит «Этот заказ уже нельзя отменить на сайте — позвоните нам» | Если клиент звонит, посмотреть статус (11.3) |
| На `/cart` и `/checkout` надпись «Оформление временно недоступно», в логе web `checkout closed: legal documents are not published` с полем `missing` | `RKN_NOTICE_NUMBER` задан, но нужных документов нет или (в production) они не опубликованы. `missing` перечисляет виды: `offer`, `privacy`, `consent_pd` | Задать `LEGAL_*_VERSION` и прогнать сид (11.2). Если это прод до 1B — убрать `RKN_NOTICE_NUMBER` (11.1) |
| Та же надпись на `/cart`, в логе web `checkout gate failed` | Не удалось прочитать документы из базы (ошибка Postgres): корзина закрывает оформление, пока база не ответит | Раздел 5 (база), `dc logs postgres` |
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
сроку не удаляются. Очистку брошенных корзин планировали в housekeeping фазы 1B, но в 1B её нет
(задач `timers`, `reminders`, `sms-budget`, `deferred-1a` и `heartbeat` она не касается):
таблица пока только растёт. Персональных данных в корзине нет, `user_id` проставляется только
у оформленной (`converted`) корзины. Размер таблицы: `select status, count(*) from carts group by 1;`.

## 12. Фаза 1B: оплата, чеки, бот продавца, админка

Фаза 1B добавила деньги и работу с заказом: оплату через ЮKassa с чеками (предоплата, зачёт
аванса при выдаче, полный расчёт на точке, возвраты), машину состояний заказа целиком, карточки
и кнопки в боте продавца, заказ у Rossko с защитой от двойной отправки, мини-админку `/admin` и
фоновые задачи (таймеры, напоминания, сверка платежей, dead-letter). Подробности —
`docs/phase-1b-implementation.md`, эндпоинты и очереди — `README.md`.

Главное, что держать в голове:

- переходы заказа и их последствия (уведомления, платежи, возвраты, чеки, заказ у Rossko)
  пишутся в базу одной транзакцией: строка `order_events` плюс строки `outbox`. Воркер забирает
  `outbox` и ставит задачи в очереди. Пока worker стоит, ничего не теряется: после запуска всё
  выполнится один раз и по порядку;
- уведомление ЮKassa — только подсказка. Воркер перечитывает платёж или возврат через API и
  верит только ответу. Пропущенное уведомление подбирает сверка (`reconciliation/sweep`, раз в
  10 минут);
- «Выдал» недоступна, пока не пробит чек: зачёт аванса для предоплаты или полный расчёт для
  оплаты на точке. Это закон (54-ФЗ, PLAN раздел 3), обходного пути в системе нет;
- в Telegram уходят только номер заказа, статус, бренд и артикул. Телефон в карточке продавца
  замаскирован (`•••4567`), полный телефон и имя есть только в админке.

Алиас для stage (сервисы stage живут в профиле compose `stage`):

```sh
alias dcs='COMPOSE_PROFILES=stage docker compose -f infra/docker-compose.yml --env-file .env'
# база stage: dcs exec postgres-stage psql -U detaly -d detaly_stage
```

### 12.1. Включение оплаты (ЮKassa)

Оплата на сайте включается, только когда заданы **все четыре** переменные (решение Б6). Если
хотя бы одной нет, на `/o/<token>` остаётся текст «Оплата подключается», `POST
/api/orders/<token>/pay` отвечает 503 `payments_disabled`, а «Выставить оплату» в боте
отказывает с текстом «Оплата не настроена (ЮKassa)». Платёж без чека не создаётся никогда.

| Переменная | Что | Где взять |
|---|---|---|
| `YOOKASSA_SHOP_ID` | id магазина (shopId) | ЛК ЮKassa → Интеграция → Ключи API |
| `YOOKASSA_SECRET_KEY` | секретный ключ | там же; у тестового магазина свой ключ (`test_…`) |
| `YOOKASSA_VAT_CODE` | код ставки НДС в чеке, ожидаем `1` («без НДС») | ответ ЮKassa на Ю4 (`docs/external.md`) |
| `YOOKASSA_TAX_SYSTEM_CODE` | код системы налогообложения, ожидаем `2` (УСН «доходы») | ответ ЮKassa на Ю4 |

`YOOKASSA_API_URL` оставить по умолчанию (`https://api.yookassa.ru/v3`). `YOOKASSA_RETURN_URL`
в 1B не используется: клиент после оплаты всегда возвращается на свою страницу заказа
`APP_BASE_URL/o/<token>?paid=1` («Проверяем оплату…»), поэтому `APP_BASE_URL` должен быть
точным публичным адресом сайта (раздел 11.2, п. 4).

Ключи нужны и web (кнопка «Оплатить»), и worker (вебхуки, чеки, возвраты, сверка). Оба читают
один `.env` (на stage — `.env.stage`), после правки — `dc up -d web worker` (на stage
`dcs up -d web-stage worker-stage`).

**Тестовый магазин — только на stage.** В ЛК ЮKassa у тестового магазина свои shopId и ключ,
деньги не списываются, тестовые карты успеха, отказа и 3-D Secure — в документации ЮKassa
(раздел «Тестовые банковские карты»; номера впишите в Ю12 `docs/external.md`). Боевой магазин —
только в продовый `.env`, по PLAN это шаг фазы 1C. Один магазин — один адрес уведомлений,
поэтому тестовый магазин смотрит на stage, а боевой — на прод.

**Адрес уведомлений в ЛК ЮKassa** (Интеграция → HTTP-уведомления; название раздела в ЛК может
отличаться):

- URL: `https://<домен>/api/webhooks/yookassa` (на stage — `https://<stage-домен>/api/webhooks/yookassa`;
  basic auth stage этот путь не закрывает, раздел 8);
- события: `payment.succeeded`, `payment.canceled`, `refund.succeeded`. `payment.waiting_for_capture`
  не нужен: платежи создаются с автоматическим списанием, но если его отметить, ничего не
  сломается.

**Кто может прислать уведомление.** Обработчик принимает запрос, только если одновременно:

1. `TRUSTED_IP_HEADER=x-real-ip` у web. В compose это задано и для `web`, и для `web-stage`:
   адрес берётся из `X-Real-IP`, который ставит Caddy и который клиент подменить не может
   (раздел 9);
2. адрес из `X-Real-IP` входит в `YOOKASSA_WEBHOOK_IP_ALLOWLIST` — IP и подсети через запятую,
   IPv4 и IPv6. Опубликованный ЮKassa список (сверить с документацией, Ю5):

   ```sh
   YOOKASSA_WEBHOOK_IP_ALLOWLIST=185.71.76.0/27,185.71.77.0/27,77.75.153.0/25,77.75.156.11,77.75.156.35,77.75.154.128/25,2a02:5180::/32
   ```

Иначе — **403 на любое уведомление** (fail closed): пустой список, `TRUSTED_IP_HEADER=none`, нет
заголовка, адрес не из списка, ошибка в записи списка. Это защита от поддельных уведомлений.
Деньги при этом не теряются: оплату подтвердит сверка `reconciliation/sweep`, но до 10 минут
позже, и всё это время клиент видит заказ неоплаченным. Поэтому после включения оплаты
обязательно:

```sh
dc logs web | grep -E 'yookassa_webhooks_refused|yookassa_allowlist_invalid'   # пусто
dc logs --since 1h web | grep 'yookassa webhook refused'                        # пусто; адрес не пишется, только reason
# подмена заголовка снаружи не проходит: Caddy перезаписывает X-Real-IP своим адресом
curl -s -o /dev/null -w '%{http_code}\n' -X POST -H 'X-Real-IP: 185.71.76.1' \
  -H 'Content-Type: application/json' -d '{}' https://$SITE_DOMAIN/api/webhooks/yookassa   # 403
```

При старте production с включённой оплатой и пустым списком (или `none`) web пишет
предупреждение `check: yookassa_webhooks_refused`, а с ошибкой в записи списка —
`yookassa_allowlist_invalid`. В строке `yookassa webhook refused` поле `reason` объясняет
причину: `untrusted_header`, `no_ip`, `no_allowlist`, `not_allowed`.

Принятое уведомление пишется в `webhook_events` (с IP, как пришёл) и в `outbox`, ответ 200
уходит сразу. Повтор того же уведомления — снова 200, без новой строки. Тело больше 64 КБ — 413,
мусор — 400, ошибка записи в базу — 500 (ЮKassa повторит, VERIFY Ю5).

Проверка, что уведомления доходят и обрабатываются:

```sql
select event_type, result, ip, to_char(received_at at time zone 'Asia/Yekaterinburg', 'DD.MM HH24:MI') as at,
       processed_at is not null as processed
from webhook_events where source = 'yookassa' order by received_at desc limit 20;
```

`result`: `processed` — переход сделан; `duplicate` — уже применено; `stale` — уведомление не
про текущий платёж заказа; `pending` — объект у ЮKassa ещё не финальный; `ignored` — платёж или
возврат не наш (например, возврат, сделанный вручную в ЛК); `amount_mismatch`,
`orphan_payment` — раздел 12.7; `error` — ошибка обработки, смотреть лог worker и 12.8.

### 12.2. Бот продавца и админка: настройка

**Бот продавца** работает в контейнере worker (long polling):

- `TG_SELLER_BOT_TOKEN`, `TG_SELLER_CHAT_ID` (закрытый чат продавцов), `STAFF_SEED_JSON` с
  `tg_user_id` и ролью (`seller` или `owner`). Без токена бот не стартует, карточки заказов не
  отправляются (в логе `seller card: post skipped, …`), а алерты пишутся в `notifications` со
  статусом `skipped` (в логе `alert skipped: TG_SELLER_BOT_TOKEN is empty`);
- владелец (`role: owner`) должен один раз написать боту в личке `/start`: сообщения владельцу
  (неожиданный платёж, возврат не прошёл, счёт Rossko, SMS-бюджет) идут ему лично. Если бот не
  может написать в личку, сообщение уходит в чат продавцов;
- новые заказы приходят карточкой: номер, схема оплаты, сумма, дата, позиции «Бренд Артикул ×
  кол-во — состояние», клиент `•••4567`, причина проблемы и кнопки доступных действий.
  Нажатие меняет эту же карточку. Старая карточка после нового сообщения по заказу закрывается
  («Карточка устарела, откройте свежую»);
- кнопки только для сотрудников из `staff`; «Счёт оплачен» и `/queues` — только владельцу;
- на stage — **свой** бот и свой тестовый чат (два процесса с одним токеном мешают друг другу,
  раздел 8). Без бота на stage проверяйте всё через админку.

**Админка** `/admin` (решения Б19, Б25):

- `ADMIN_BASIC_AUTH=user:пароль` (длинный случайный пароль: `openssl rand -base64 24`). Без
  переменной `/admin` и `/api/admin/*` отвечают 404, будто их нет. Неверный пароль — 401; 20
  неверных паролей за час с одного IP-бакета — 429 даже для верного, подождите час;
- одна учётка, она у Максима: действия из админки записываются как действия владельца
  (`actor_id = 'admin'`). Пароль никому не пересылается; продавцы работают через бота;
- на stage сайт уже закрыт basic auth Caddy, а браузер отправляет только один заголовок
  `Authorization`. Поэтому в `.env.stage` задайте `ADMIN_BASIC_AUTH` **тем же** логином и
  паролем, что и `STAGE_BASIC_AUTH_USER` и пароль к `STAGE_BASIC_AUTH_HASH`, иначе админка stage
  будет отвечать 401 (проверить при первом прогоне);
- проверка: `curl -sI https://$SITE_DOMAIN/admin | grep -iE '^HTTP|www-authenticate|x-robots'` →
  401, `WWW-Authenticate: Basic realm="admin"`, `X-Robots-Tag: noindex, nofollow`.

Подробнее про ПД в админке — 12.10.

### 12.3. Прогон Verification 1B на stage (чек-лист для Максима)

Код проверен автотестами на эмуляции ЮKassa (msw), фикстурах Rossko и подменённом транспорте
Telegram: живые ЮKassa, Rossko, Telegram и SMS из среды разработки недоступны. Этот прогон —
первая встреча с настоящим API ЮKassa. Всё, что разойдётся с ожиданием, записывайте в
`docs/external.md`, раздел 7, строкой с номером шага.

**Подготовка stage:**

1. `.env.stage`: тестовый магазин (`YOOKASSA_SHOP_ID`, `YOOKASSA_SECRET_KEY`), `YOOKASSA_VAT_CODE`,
   `YOOKASSA_TAX_SYSTEM_CODE`, `YOOKASSA_WEBHOOK_IP_ALLOWLIST` (12.1), `APP_BASE_URL=https://<stage-домен>`,
   `ADMIN_BASIC_AUTH` (12.2), тестовый бот продавца и тестовый чат, `RKN_NOTICE_NUMBER` любым
   текстом (stage закрыт basic auth, ПД вводим только свои), опубликованные версии документов
   (раздел 11.2). `ROSSKO_ALLOW_CHECKOUT=false` compose задаёт на stage сам — настоящий заказ у
   Rossko со stage невозможен (12.4).
2. В ЛК тестового магазина — адрес уведомлений stage и три события (12.1).
3. `infra/deploy.sh stage <sha>`, затем проверки 12.1 и 12.2 (403 снаружи, 401 на `/admin`,
   `/ping` в тестовом боте).
4. Для шагов с таймерами (15, 19, 20, 21, молчание в шаге 7) ждать сутки не нужно: на базе
   **stage** сдвиньте срок, и задача `timers` (раз в минуту) сделает переход:

   ```sql
   -- только stage! срок заказа (оплата, подтверждение, хранение, QR, завершение после выдачи)
   update orders set expires_at = now() - interval '1 minute' where number = 'DT-000123';
   -- срок ответа клиента на аналог или новый срок
   update client_approvals set expires_at = now() - interval '1 minute'
   where order_id = (select id from orders where number = 'DT-000123') and decided_at is null;
   ```

Телефон в тестовых заказах — свой. Карты — тестовые из документации ЮKassa.

| ☐ | Шаг | Как проверить на stage | Ожидание |
|---|---|---|---|
| ☐ | 1 | Предоплата: оформить заказ «под заказ», «Оплатить N ₽», карта успеха | `/o/<token>` «Проверяем оплату…», через секунды статус «Подтверждён»; в админке статус `confirmed`, платёж `succeeded`, чек `prepayment` `succeeded` (опрос раз в 2 мин); в ЛК чек с признаком «предоплата 100%»; карточка нового заказа в тестовом чате; журнал заказа заполнен |
| ☐ | 2 | Карта отказа; отдельно карта с 3-D Secure | отказ → `cancelled` («Платёж отменён»); 3-D Secure → `confirmed` только после подтверждения; переход по ответу GET платежа, а не по уведомлению |
| ☐ | 3 | Повтор уведомления шага 1 (рецепт ниже) | ответ 200, вторая строка в `webhook_events` не появилась, второго перехода, чека и сообщения нет |
| ☐ | 4 | В ЛК временно убрать адрес уведомлений (или очистить allowlist в `.env.stage` и перезапустить `web-stage`), оплатить новый заказ | 403 в логе web-stage; через ≤ 10 мин сверка ставит `confirmed`; заказ с неоплаченным pending-платежом по истечении срока оплаты **не** отменяется, пока ЮKassa сама не отменит платёж (Ю18). Вернуть адрес и allowlist |
| ☐ | 5 | «Проверить и заказать» по заказу шага 1 | на stage цены живые, +1 % / +10 % не подстроить: проверить, что перепроверка прошла (журнал `recheck_result`) и заказ дошёл до попытки GetCheckout → `needs_attention` «Автозаказ выключен». Ветки +1 % / +10 % закрыты автотестами (`worker-supplier`) |
| ☐ | 6 | itemErrors одной из двух позиций | на stage не воспроизводится (нет GetCheckout). Проверить ручную ветку: «Отменить позицию» у одной позиции → частичный возврат, чек возврата **только на эту строку** в ЛК; остальное — через 12.4 до выдачи, чек зачёта на остаток |
| ☐ | 7 | Из `needs_attention` «Аналог» (или «Новый срок») → на `/o/<token>` «Согласен»; повторить с «Вернуть деньги» (4 цифры); повторить и «промолчать» (сдвинуть срок SQL выше); повторить с `SMS_PROVIDER=none` | «Согласен» → новая позиция с `replaced_by_item_id`, дозаказ; «Вернуть деньги» → `refund_pending`, чек возврата `full_prepayment` succeeded, затем `refunded`; молчание → `refund_pending`; без SMS и мессенджера кнопка «Аналог» отказывает «Клиенту не доставить сообщение — позвоните ему», заказ остаётся `needs_attention`, таймера нет |
| ☐ | 8 | Заказ из двух позиций: «Приехало» по одной | заказ не `ready`; на `/o/<token>` «Жду до <дата>» и «Отменить позицию» у неприехавшей |
| ☐ | 9 | «Приехало» по всем → «Клиент пришёл» | `ready`, чек зачёта `offset` → `succeeded`, только после этого «Выдал» активна (до этого — «Ждём чек»); «Выдал» → `handed`; в ЛК **два** чека |
| ☐ | 10 | Оплата при получении: оформить (местные позиции, сумма ≤ 15 000 ₽) → «Подтверждаю» на `/o/<token>` (или по ссылке из SMS, если SMS настроен) → довести до `ready` → «Клиент пришёл» → «Выставить оплату» → QR в чате продавцов → оплатить тестовой картой или СБП | до «Клиент пришёл» кнопки «Выставить оплату» нет; QR только в чате продавцов и в админке, клиенту не уходит; после `succeeded` — **один** чек полного расчёта, затем «Выдал» → `handed` |
| ☐ | 11 | «Отменить заказ и вернуть деньги» (из `needs_attention`) и «Отказ клиента» (из оплаченного заказа до выдачи) | `refund_pending` → `refunded`, чек возврата `full_prepayment` succeeded, на `/o/<token>` «Деньги возвращены» (SMS «Деньги отправлены» — если SMS настроен) |
| ☐ | 12 | `dcs stop worker-stage`; 10 мин: нажатия в админке (бот живёт в worker и пока молчит), оплата нового заказа (уведомление примет web); `dcs start worker-stage` | после запуска каждое событие выполнено ровно один раз и в правильном порядке (журнал заказа, `notifications`, ЛК); `select count(*) from outbox where dispatched_at is null` → 0 |
| ☐ | 13 | Оплатить заказ, затем в `.env.stage` поставить неверный `YOOKASSA_TAX_SYSTEM_CODE`, `dcs up -d web-stage worker-stage`, «Клиент пришёл» | через 15 мин алерт «чек не прошёл» продавцам и владельцу, «Выдал» заблокирована, заказ в фильтре «Требуют внимания». Вернуть код, перезапустить, «Повторить чек» → чек succeeded → «Выдал» активна (12.5). Если тестовый магазин принял неверный код — записать в Ю4 |
| ☐ | 14 | Оплата отменённого заказа: «Оплатить» → на странице ЮKassa не платить → в другой вкладке отменить заказ на `/o/<token>` (4 цифры) → вернуться и оплатить | `cancelled` → `refund_pending` автоматически, на `/o/<token>` «Возвращаем деньги», возврат и чек возврата succeeded, затем `refunded`. Отмену по сроку оплаты так не проверить: пока платёж pending у ЮKassa, заказ не отменяется (Ю18) |
| ☐ | 15 | Предоплаченный заказ в `ready`, сдвинуть срок хранения SQL | `refund_pending` без выбора, чек возврата `full_prepayment` succeeded, `users.no_show_count` +1, задача продавцу «вернуть Rossko до …» |
| ☐ | 16 | Сумма платежа ≠ сумме заказа: нажать «Оплатить», **до оплаты** на базе stage выполнить `update orders set subtotal_kop = subtotal_kop + 100, total_kop = total_kop + 100 where number = 'DT-000123';`, затем оплатить | `needs_attention` (`amount_mismatch`), алерт владельцу «неожиданный платёж»; деньги вернуть кнопкой «Вернуть платёж» в админке (12.7) |
| ☐ | 17 | В `ordered_at_supplier` «Проблема с позицией» (любая причина, кроме «Повреждено») → «Заказать всё равно» | `needs_attention` → `ordered_at_supplier`, причина в журнале |
| ☐ | 18 | Заказ с оплатой при получении в `ready` → «Оплатить заранее» на `/o/<token>` | `awaiting_payment`, после оплаты — `ready` и дальше два чека, как у предоплаты |
| ☐ | 19 | «Выставить оплату», QR не оплачивать 15 мин (или сдвинуть срок SQL) | `awaiting_handover_payment` → `ready`; оплата старого QR после этого возвращает заказ к выдаче без разбора владельцем (Б9) |
| ☐ | 20 | Заказ с оплатой при получении в `ready`, сдвинуть срок хранения | `cancelled` без возврата, `no_show_count` +1 |
| ☐ | 21 | `awaiting_confirmation` без ответа (сдвинуть срок); `handed` без обращений (сдвинуть срок) | `cancelled`; `completed` |
| ☐ | 22 | «Проблема с позицией» → «Повреждено при приёмке» | запись `supplier_returns` вида claim, новая позиция с `replaced_by_item_id`, попытка заказать её у Rossko (на stage — `needs_attention` «Автозаказ выключен», 12.4) |
| ☐ | 23 | `update settings set value = 'true'::jsonb, updated_by = 'admin' where key = 'rossko.prepay_invoice';` (только stage) → «Проверить и заказать» → «Заказано вручную» → «Заказать всё равно» | `awaiting_supplier_invoice`, владельцу «оплатить счёт Rossko»; «Счёт оплачен» (номер и дата п/п) → `ordered_at_supplier`, дата получения с лагом `eta.supplier_invoice_lag_days`. Вернуть `false` |

Рецепт шага 3 — повтор уведомления изнутри сети compose (снаружи Caddy перезапишет `X-Real-IP`, и
будет 403). Тело берётся из `webhook_events`, в файл не сохраняется:

```sh
PAYMENT_ID=<id платежа ЮKassa из админки>
dcs exec -T postgres-stage psql -U detaly -d detaly_stage -At -c \
  "select payload::text from webhook_events where external_id = '$PAYMENT_ID' and event_type = 'payment.succeeded'" \
| dcs exec -T web-stage node -e "let b='';process.stdin.on('data',d=>b+=d).on('end',()=>fetch('http://127.0.0.1:3000/api/webhooks/yookassa',{method:'POST',headers:{'content-type':'application/json','x-real-ip':'185.71.76.1'},body:b.trim()}).then(async r=>console.log(r.status,await r.text())))"
# 200 {} ; затем count(*) по этому external_id и событию = 1
```

Итог прогона: дата, sha образа, номера шагов с расхождениями — в `docs/external.md`, раздел 7.
Приёмка PLAN «Фаза 1B»: prepay даёт два чека, pay_on_handover — один, частичный возврат — чек
только на строку, дубль уведомления без второго перехода, пропуск уведомления закрывает сверка,
«Выдал» недоступна без чека, остановка worker не теряет и не дублирует задачи, оплата
отменённого заказа уходит в `refund_pending`.

### 12.4. Заказ у Rossko: `ROSSKO_ALLOW_CHECKOUT` и ручной режим

«Проверить и заказать» (только в `confirmed`) делает перепроверку цен и наличия у Rossko мимо
кэша. Если цена выросла не больше допуска (`pricing.drift_tolerance_pct`) и всё в наличии,
создаётся попытка заказа (`supplier_orders`, статус `sending`) и **одна** задача GetCheckout.
Иначе — `needs_attention` с альтернативами. Защита от двойного заказа: строка попытки
записывается до вызова, задача GetCheckout никогда не повторяется очередью, а после таймаута
система не повторяет GetCheckout, а ищет заказ (GetOrders по комментарию `DT-000123/<номер
попытки>`).

`ROSSKO_ALLOW_CHECKOUT` (по умолчанию `false`, на stage compose всегда ставит `false`):

- `false` — GetCheckout технически не вызывается. Заказ после перепроверки уходит в
  `needs_attention` с текстом «Автозаказ выключен — закажите в ЛК Rossko и отметьте в
  админке». Это режим по умолчанию до ответов Rossko (R6, R10, R11, R16, R19, R20);
- `true` — GetCheckout вызывается. Нужны `ROSSKO_DELIVERY_ID` и `ROSSKO_PAYMENT_ID` (и при
  необходимости `ROSSKO_ADDRESS_ID`) из GetCheckoutDetails, иначе попытка падает до сети
  (ошибка конфигурации, `needs_attention`). Включать только после ответов R10, R11, R16 и
  проверочного заказа одной дешёвой позиции в проде с контролем в ЛК.

Изменение — в `.env` и `dc up -d web worker`.

**Ручной режим (действие админки «Заказано вручную в ЛК Rossko»):**

1. Карточка заказа в админке: позиции (бренд, артикул, количество, склад) в состоянии
   «ожидает заказа».
2. ЛК Rossko → поиск по артикулу → **тот же склад** → в корзину → оформить на адрес пункта
   выдачи, в комментарии — номер `DT-000123`.
3. В админке «Заказано вручную в ЛК Rossko», вписать номера заказов Rossko (через запятую или
   пробел). Все ожидающие позиции станут «заказаны», незавершённая
   попытка `sending` (после таймаута) закроется.
4. Нажать «Заказать всё равно» (в админке или боте) → `ordered_at_supplier` (или
   `awaiting_supplier_invoice`, если включён `rossko.prepay_invoice`).

**Карточка «Проверьте ЛК Rossko: заказ мог создаться»** (`reason: unknown_after_timeout`):
GetCheckout не ответил вовремя, и найти заказ через GetOrders не удалось. Не нажимайте сразу
«Заказать всё равно»: при ожидающих позициях это **новая** попытка GetCheckout. Сначала ЛК
Rossko → заказы за сегодня, поиск по комментарию `DT-000123/<попытка>`:
- заказ есть → «Заказано вручную» с его номером → «Заказать всё равно»;
- заказа точно нет → «Заказать всё равно» (новая попытка) или ручной заказ по шагам выше.

**`rossko.prepay_invoice`** (R7: отгружает ли Rossko до оплаты счёта) меняется только SQL, в
админке страницы настроек в 1B нет:

```sql
update settings set value = 'true'::jsonb, updated_by = 'admin', updated_at = now()
where key = 'rossko.prepay_invoice';
```

Значение читается при каждом переходе, перезапуск не нужен. С `true` заказ после GetCheckout
ждёт оплаты счёта (`awaiting_supplier_invoice`), владельцу каждые 4 часа «оплатить счёт Rossko»
с номером и суммой (VERIFY R19). После оплаты — «Счёт оплачен» в боте (кнопка только у
владельца, бот спросит номер и дату платёжного поручения) или в админке.

Отмена у Rossko после отказа клиента — задача продавцу «Отменить у Rossko через ЛК или
менеджера до отгрузки, иначе — возврат поставщику». Через API отмена не делается (R6).

### 12.5. «Чек не прошёл»

Признаки: в чат продавцов и владельцу пришло «Заказ DT-…: чек не прошёл»; в карточке заказа
кнопка «Выдал» серая с подписью «Ждём чек»; заказ в фильтре админки «Требуют внимания»; в логе
worker `offset receipt rejected`, `offset receipt not registered in 15 minutes` или
`payment receipt canceled by the provider`.

Как это устроено (решения Б22, Б23): чек зачёта аванса создаётся по «Клиент пришёл», воркер
опрашивает его каждые 2 минуты. Если за 15 минут чек не стал `succeeded` или ЮKassa его
окончательно отвергла — алерт, и «Выдал» остаётся заблокированной. **Выдать деталь без чека
нельзя** (54-ФЗ, PLAN раздел 3), обходного пути в системе нет специально.

Что сказать клиенту: «Касса не пробила чек, без чека выдать деталь мы не можем по закону.
Подождите несколько минут — или приходите позже, мы напишем, когда всё будет готово». Деталь
остаётся на хранении, срок хранения не продлевается сам — при необходимости сдвиньте его
(`orders.expires_at`) после разговора с клиентом.

Что делать:

1. Причина — в админке, раздел «Чеки» (колонка ошибки), и в логе worker
   (`dc logs --since 1h worker | grep -i receipt`). Частые причины: неверный
   `YOOKASSA_TAX_SYSTEM_CODE` или `YOOKASSA_VAT_CODE` (ответ 400), не подключены «Чеки от
   ЮKassa» или зачёт аванса не поддерживается (Ю1), сбой у ЮKassa.
2. Исправить настройки (`.env`, затем `dc up -d web worker`: коды нужны обоим) или дождаться
   ЮKassa.
3. «Повторить чек» в карточке (бот или админка). Если прошлая попытка окончательно отвергнута,
   создаётся новый чек с новым ключом и текущими кодами; если она просто долго в pending —
   повторяется та же попытка с тем же ключом и новым окном 15 минут. Двух чеков зачёта на заказ
   система не допустит.
4. Чек `succeeded` → карточка перерисуется, «Выдал» активна.

Если «Чеки от ЮKassa» не умеют зачёт аванса (ответ на Ю1 отрицательный) — это план Б с облачной
ККТ (`docs/external.md`, раздел 3); до него предоплату не включать.

Чек **в составе платежа** (предоплата онлайн, полный расчёт по QR на точке) повторить из системы
нельзя: он уходит вместе с платежом. Если ЮKassa отменила такой чек (`payment receipt canceled by
the provider`), деталь не выдавать и разбирать с поддержкой ЮKassa и разработчиком; ручной чек в
ЛК «Выдал» не разблокирует.

### 12.6. «Возврат не прошёл»

Признаки: владельцу «Заказ DT-…: возврат не прошёл. Срок 10 дней продолжает идти, проверьте
возврат в ЛК ЮKassa»; в админке раздел «Возвраты денег» — строка `failed` с ошибкой, заказ в
фильтре «Требуют внимания»; в логе worker `refund rejected by the provider`. Заказ остаётся в
`refund_pending` (или в прежнем статусе, если это возврат за одну позицию).

Срок вернуть деньги — 10 дней от требования клиента (ст. 22 ЗоЗПП), он виден в админке
(`deadline_at` возврата). За 2 дня до срока по возврату, который не прошёл или всё ещё в
обработке, владельцу приходит напоминание. Просрочка — неустойка 1 % в день (ст. 23 ЗоЗПП).

Что делать:

1. Причина: ошибка в админке и в ЛК ЮKassa (платёж → возвраты). Частые: возврат по СБП или
   карте временно недоступен, сумма больше остатка платежа, ошибка в чеке возврата (коды НДС и
   СНО, Ю10).
2. Вернуть деньги вручную в ЛК ЮKassa: платёж (поиск по описанию «Заказ DT-000123» или
   `metadata.order_id`) → «Вернуть» → сумма по строкам. Чек возврата ЮKassa сформирует сама.
3. **Ограничение 1B:** возврат, сделанный вручную в ЛК, система не узнаёт (уведомление по нему
   записывается как `ignored`), кнопки «Возврат проведён вручную» нет. Заказ останется в
   `refund_pending`, напоминания о сроке возврата будут продолжаться. Запишите номер возврата
   из ЛК и сообщите разработчику номер заказа: закрыть такой возврат в базе можно только правкой
   кода или SQL под контролем разработчика.
4. Клиенту сообщить срок зачисления (обычно до нескольких рабочих дней, зависит от банка).

Возврат, который «завис» без ответа ЮKassa: воркер повторяет `POST /refunds` с тем же ключом не
дольше 24 часов от создания (срок жизни ключа, Ю17). Позже задача уходит в dead-letter (12.8) —
повторять её не нужно: проверьте возврат в ЛК и при необходимости сделайте его там.

### 12.7. Поздняя оплата, неожиданный платёж, orphan-возврат

| Ситуация | Что делает система | Что делать вам |
|---|---|---|
| Оплата пришла по заказу, который уже отменён (клиент отменил или ЮKassa отменила платёж, а клиент оплатил из другой вкладки) | `cancelled` → `refund_pending` автоматически, возврат всей суммы с чеком возврата; клиент видит возврат на `/o/<token>` (сообщение в мессенджер — с фазы 1C) | Ничего; проследить, что возврат прошёл (12.6) |
| Оплата по заказу, деньги за который уже возвращены (`refunded`) | orphan-возврат всей суммы, статус заказа не меняется, владельцу «оплата после возврата» | Проверить возврат в ЛК ЮKassa |
| Сумма платежа не равна сумме заказа | `needs_attention` (`amount_mismatch`), владельцу «неожиданный платёж» | Разобраться (подмена суммы, ошибка). Вернуть платёж: админка → «Платежи» → «Вернуть платёж» (причина без ПД, «подтверждаю») и отменить заказ, либо принять решение с разработчиком |
| Второй платёж по заказу (две вкладки, старая ссылка) или оплата, когда заказ её не ждал | переход не делается или делается по первому платежу, владельцу «неожиданный платёж» | Лишний платёж вернуть кнопкой «Вернуть платёж» в админке |
| Оплата старого QR после истечения 15 минут | заказ возвращается к выдаче с оплатой (Б9), без разбора | Ничего |
| Неоплаченный платёж висит pending после срока оплаты | заказ **не** отменяется, пока ЮKassa не подтвердит отмену; раз в 10 минут перепроверка | Если висит больше суток — проверить платёж в ЛК (Ю18) |

«Вернуть платёж» создаёт возврат вида `orphan`: статус заказа он не меняет. Ночная сверка
(`reconciliation/nightly`, 03:15 по Екатеринбургу) сравнивает платежи магазина за сутки с базой
и шлёт владельцу алерт о платежах, которых нет в базе или у которых другой статус. Сама сверка
ничего не меняет.

### 12.8. Dead-letter и `/queues`

Задача, исчерпавшая попытки (или упавшая с ошибкой, которую повторять бессмысленно),
копируется в очередь `dead-letter`, в чат продавцов приходит «Задача не выполнена: <очередь> /
<задача>, попыток N, ошибка …, повторить — /queues». Текст ошибки маскируется: телефонов,
токенов и сумм в нём нет. Сбой периодической задачи (таймеры, сверка) даёт одну запись и один
алерт в час, а не каждую минуту.

Попытки: payments — 5 (10 с, 20 с, 40 с, 80 с), receipts — 3, rossko — 3 (GetCheckout — ровно
1), notify — 5 (от 30 с), reconciliation и housekeeping — 1 (повтор — следующий запуск по
расписанию).

`/queues` в боте (только владелец, в личке или в чате продавцов; остальным бот не отвечает):
очереди с числом задач (ждут, в работе, отложено, с ошибкой) и последние 10 записей
dead-letter с кнопками «Повторить N». Кнопки действуют сутки и срабатывают один раз.

Перед «Повторить» устраните причину (ключи ЮKassa, связь с Rossko, токен бота). Повтор
безопасен: каждая задача сначала читает состояние строки в базе и выходит, если работа уже
сделана. Исключения: возврат старше 24 часов (12.6) и GetCheckout (повтор только через
восстановление, 12.4) — их не повторяйте, а разбирайте вручную.

`outbox` — очередь в базе между переходом и BullMQ. Если Redis недоступен, строки копятся и
уйдут после восстановления:

```sql
select queue, name, count(*), min(created_at) as oldest, max(attempts) as attempts
from outbox where dispatched_at is null group by 1, 2 order by 3 desc;
```

Строки старше пары минут при работающем worker — смотреть лог worker (`outbox pass failed`,
`redis error`) и раздел 5.

### 12.9. SMS: лимиты и бюджет

SMS клиенту уходит только для шаблонов из allowlist (подтверждение заказа с оплатой при
получении, «нужно ваше решение», «приехало», «деньги отправлены», подборка VIN) и только если
у клиента нет мессенджера (клиентский бот — фаза 1C). Без SMS-провайдера такие уведомления
записываются как `skipped`, клиент видит всё на `/o/<token>`.

Настройка (`.env`, затем `dc up -d web worker`): `SMS_PROVIDER` (`smsaero` или `smsc`),
`SMS_LOGIN`, `SMS_API_KEY`, `SMS_SENDER` (подпись, для SMS Aero обязательна), `SMS_API_URL`
(обычно пусто), `SMS_PRICE_KOP` (цена одного сообщения в копейках, по тарифу провайдера, VERIFY),
`SMS_MONTHLY_BUDGET_RUB`. Если чего-то не хватает, worker пишет `SMS driver is not configured:
SMS are disabled` и работает без SMS.

| Ограничение | Значение | При превышении |
|---|---|---|
| На один номер | 1 SMS за 10 минут и 3 за сутки (Redis, ключ — HMAC телефона, без ПД) | `skipped`, `fallback_reason = sms_rate_limited` |
| Бюджет месяца (календарный месяц по Екатеринбургу) | `SMS_MONTHLY_BUDGET_RUB`; расход — сумма `api_calls.cost_kop` (каждое SMS стоит `SMS_PRICE_KOP`) | 80 % — один алерт владельцу за месяц; 100 % — алерт и SMS не отправляются (`sms_budget_exhausted`) до следующего месяца или увеличения бюджета |

**Задайте `SMS_MONTHLY_BUDGET_RUB` обязательно**: без него бюджет не ограничен. Лимиты защищают
от накрутки SMS на чужие номера через оформление (вместе с лимитом 10 оформлений в час на IP).

Расход за текущий месяц:

```sql
select count(*) filter (where ok) as sent, count(*) filter (where not ok) as failed,
       (sum(cost_kop) / 100.0)::numeric(12, 2) as spent_rub
from api_calls
where source = 'sms'
  and created_at >= date_trunc('month', now() at time zone 'Asia/Yekaterinburg') at time zone 'Asia/Yekaterinburg';
```

Причины пропуска — в `notifications.fallback_reason`
(`select fallback_reason, count(*) from notifications where status = 'skipped' and created_at > now() - interval '7 days' group by 1;`).

### 12.10. Админка: доступ и персональные данные

- Доступ — только по `ADMIN_BASIC_AUTH` (12.2), одна учётка у Максима. Сравнение пароля в
  постоянное время, неверные попытки ограничены, ответы с `X-Robots-Tag: noindex, nofollow`,
  `Cache-Control: no-store`, `Referrer-Policy: no-referrer`; `/admin` закрыт в `robots.txt`.
- `/admin` — список: фильтр по статусу и «Требуют внимания» (`needs_attention`, ожидание оплаты
  счёта Rossko, чек не прошёл, возврат не прошёл), поиск по номеру (`DT-000123` или `123`) и по
  последним 4 цифрам телефона, 50 на страницу.
- `/admin/orders/<id>` — карточка: **полный телефон и имя клиента (единственное место в
  системе)**, позиции, платежи, чеки, возвраты, заказы Rossko, согласования, возвраты
  поставщику, полный журнал, действия формами. Необратимые действия («Отменить заказ», «Отказ
  клиента», «Отменить позицию», «Клиент не пришёл», «Вернуть платёж») требуют отметки
  «подтверждаю».
- В боте, в чатах и в логах телефона нет: в карточке продавца — `•••4567`. Правила 11.3
  действуют и для админки: не копировать телефон и имя в мессенджеры, не фотографировать экран,
  не сохранять страницы. В причинах возврата и комментариях ПД не писать.
- Открывать админку только со своего устройства. При подозрении на утечку пароля — новый
  `ADMIN_BASIC_AUTH`, `dc up -d web`, и раздел 7, если был доступ посторонних.

### 12.11. Включение оформления в проде (снятие запрета 1A)

Запрет раздела 11.1 был нужен, потому что в 1A заказ никто не видел и не мог оплатить. С фазой
1B он **снят**, но включать оформление в проде (`RKN_NOTICE_NUMBER` в продовом `.env`) можно
только когда выполнено всё:

1. Условия 11.2: номер РКН, опубликованные документы, точный `APP_BASE_URL`,
   `TRUSTED_IP_HEADER=x-real-ip`.
2. Оплата работает: четыре переменные ЮKassa **боевого** магазина (12.1), адрес уведомлений
   прода в ЛК, allowlist, нет предупреждений `yookassa_*` при старте web, ответы ЮKassa на Ю1–Ю4
   получены письменно (иначе — план Б).
3. Прогон 12.3 на stage пройден, расхождения разобраны.
4. Бот продавца работает: `/ping` отвечает, тестовый заказ дал карточку в чате продавцов,
   владелец сделал `/start` в личке и получает свои сообщения.
5. Админка работает: `/admin` под паролем открывается, карточка заказа показывает действия.
6. Заказ у Rossko: либо `ROSSKO_ALLOW_CHECKOUT=true` с проверенными id доставки и оплаты (12.4),
   либо осознанно ручной режим, и продавцы знают про «Заказано вручную».
7. Желательно: SMS-провайдер и `SMS_MONTHLY_BUDGET_RUB` (12.9). Без SMS клиент с оплатой при
   получении подтверждает заказ только на `/o/<token>` по ссылке, полученной при оформлении.

Порядок: сначала шаги 1–6, потом `RKN_NOTICE_NUMBER` и `dc up -d web`. По PLAN первый боевой
заказ — фаза 1C: Лёша оформляет реальную дешёвую позицию как обычный клиент через сайт,
затем знакомый клиент. Выключение — как в 11.2: убрать `RKN_NOTICE_NUMBER`, `dc up -d web`;
начатые заказы, оплата и бот продолжают работать.

### 12.12. Что значат сообщения 1B в логах

| Где | Что значит | Что делать |
|---|---|---|
| web: `yookassa webhook refused` (`reason`) | уведомление отклонено (403) | 12.1; единичные с чужих адресов — норма |
| web: `yookassa webhook: store failed`, ответ 500 | не удалось записать уведомление в базу | раздел 5 (база); ЮKassa повторит, иначе подберёт сверка |
| web: `pay: payment creation failed` | ЮKassa не создала платёж; клиент видит «Не удалось создать платёж, попробуйте ещё раз» | единичные — норма; массово — ключи, доступность ЮKassa |
| web: `pay: payment unavailable` (`reason`) | платёж не создаётся из-за чека (нет телефона, не сходятся строки) | разобрать заказ с разработчиком |
| worker: `job moved to dead-letter` | задача окончательно не выполнена | 12.8 |
| worker: `offset receipt …`, `payment receipt …` | проблема с чеком | 12.5 |
| worker: `refund rejected by the provider` | возврат отклонён | 12.6 |
| worker: `checkout: outcome unknown, queueing recovery` | GetCheckout не ответил, ищем заказ через GetOrders | если придёт карточка «Проверьте ЛК Rossko» — 12.4 |
| worker: `handover payment has no QR data`, `seller QR: payload is not a link, no button` | ЮKassa не вернула данные QR или вернула не ссылку (VERIFY Ю9) | QR в админке (раздел «QR на оплату»); если его нет — дождаться истечения QR (15 мин) и предложить клиенту «Оплатить заранее» на странице заказа |
| worker: `SMS driver is not configured: SMS are disabled` | неполные настройки SMS | 12.9 |
| worker: `alert skipped: TG_SELLER_BOT_TOKEN is empty`, `alert has no chat` | алерты некуда отправить | 12.2 |
| worker: `nightly: payment list failed` | ночная сверка не прочитала список платежей (VERIFY Ю15) | повторится следующей ночью; при повторах — разработчику |
