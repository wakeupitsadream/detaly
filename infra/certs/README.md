# Сертификат Минцифры для Node-процессов

Часть российских API (MAX Bot API, банки, госсервисы) отдаёт сертификаты, подписанные
**Russian Trusted Root CA** (НУЦ Минцифры). Этого корня нет в стандартном наборе Node.js, и
такие запросы падают с `UNABLE_TO_GET_ISSUER_CERT_LOCALLY` или `SELF_SIGNED_CERT_IN_CHAIN`.

Сертификат не вшивается в образы и не коммитится: `.gitignore` исключает `infra/certs/*.pem`,
`.dockerignore` исключает весь каталог. Compose монтирует каталог в web и worker как
`./certs:/certs:ro`. Переменная `NODE_EXTRA_CA_CERTS=/certs/russian_trusted_root_ca.pem`
**добавляет** корень к стандартному набору, а не заменяет его.

## Как положить сертификат на VPS

1. Скачайте корневой сертификат с официальной страницы Госуслуг «Сертификаты НУЦ Минцифры»
   (`https://www.gosuslugi.ru/crt`): файл «Корневой сертификат» (Russian Trusted Root CA).
   Скачивайте только с gosuslugi.ru, не из зеркал.
2. Если файл в DER (`.cer`, бинарный), переведите его в PEM:

   ```sh
   openssl x509 -inform DER -in russian_trusted_root_ca.cer -out infra/certs/russian_trusted_root_ca.pem
   ```

   Если файл уже начинается с `-----BEGIN CERTIFICATE-----`, просто переименуйте его.
3. Проверьте субъект и отпечаток, сверьте SHA-256 с опубликованным на той же странице:

   ```sh
   openssl x509 -in infra/certs/russian_trusted_root_ca.pem -noout -subject -enddate -fingerprint -sha256
   ```

   Ожидается `subject=C = RU, O = The Ministry of Digital Development and Communications, CN = Russian Trusted Root CA`.
4. Права: `chmod 644 infra/certs/russian_trusted_root_ca.pem`. Контейнеры работают от пользователя
   `node` и должны иметь право читать файл.
5. Перезапустите сервисы, которые читают файл при старте: `docker compose -f infra/docker-compose.yml --env-file .env up -d --force-recreate web worker`.

## Проверка

```sh
docker compose -f infra/docker-compose.yml --env-file .env exec worker \
  node -e "fetch('https://platform-api.max.ru/').then(r=>console.log('tls ok', r.status),e=>console.log('tls error', e.cause?.code ?? e))"
```

`tls ok` с любым HTTP-кодом, включая 401 и 404, значит, что цепочка доверия собрана. Если вывод
`tls error UNABLE_TO_GET_ISSUER_CERT_LOCALLY`, значит, файл не подхватился. Проверьте путь, права
и строку `Warning: Ignoring extra certs from ...` в логе контейнера.

Без файла Node только пишет предупреждение при старте и работает со стандартным набором. Поэтому
в фазе 0, пока MAX не подключён, файл можно не класть: `deploy.sh` только предупредит.

## Срок действия

Корневой сертификат действует до 2032 года. Промежуточный (Russian Trusted Sub CA) сервер
обычно отдаёт сам. Если API начнёт падать с ошибкой цепочки, повторите шаги 1–5 и добавьте
промежуточный сертификат в тот же PEM-файл: сертификаты просто идут друг за другом.
