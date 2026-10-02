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

Лимиты поиска считаются по IP из `X-Real-IP`, который ставит Caddy (`{remote_host}`). Если Docker
подменяет адрес клиента на адрес шлюза (`172.x.0.1`), все клиенты получат один общий лимит, и
21-й запрос в минуту от всех вместе получит 429.

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
