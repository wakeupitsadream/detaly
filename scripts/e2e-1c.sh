#!/usr/bin/env bash
# Phase 1C end to end run (docs/phase-1c-implementation.md sections 11 item 5 and 18), on the
# pattern of scripts/e2e-1b.sh:
#
#   scripts/dev-db.sh up && eval "$(scripts/dev-db.sh env)"
#   bash scripts/e2e-1c.sh [playwright args, e.g. e2e/vin-flow.spec.ts]
#
# 1. migrations and seed (twice-safe) on DATABASE_URL;
# 2. web standalone build (skip with E2E_SKIP_BUILD=1 when .next/standalone is fresh);
# 3. the YooKassa mock (scripts/yookassa-mock-server.ts) on :3199, the worker (apps/worker
#    src/main.ts, no Telegram tokens: no network, the client bot does not start) and web
#    standalone on :3100, with the env of section 18: phase 1A + 1B e2e env plus
#    FILES_STORAGE=local in a temporary directory, INSTALL_PARTNER_*, TG_CLIENT_BOT_USERNAME,
#    the fake review links of step 3 (REVIEW_URL_YANDEX, REVIEW_URL_2GIS), the fit guarantee
#    of step 4 switched on (FIT_GUARANTEE_ENABLED=true) and «Моя машина» of step 6 switched on
#    (GARAGE_ENABLED=true);
# 4. Playwright, every spec of phases 1A, 1B and 1C, mobile 375 and desktop 1280;
# 5. the web and worker logs must contain no phone numbers (+79…, 79… as in receipts), no VIN in
#    full (a 17-character VIN-shaped run) and none of the phones, VINs and tokens (/o, /p, link)
#    the specs used (E2E_SECRETS_FILE, counts only: the matching lines are never printed).
#
# Every variable below can be overridden from the environment (CI sets the seller requisites and
# the pickup point at the job level). Ports: E2E_WEB_PORT (3100), E2E_MOCK_PORT (3199).
# Redis: the processes use the production key names (detaly:…), so a dedicated Redis database
# for the run is preferable: E2E_REDIS_URL=redis://127.0.0.1:56379/7 (default: REDIS_URL).
# Logs, the secrets list and screenshots: E2E_OUT_DIR (apps/web/test-results/e2e-1c).
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
cd "$ROOT"

if [[ -z "${DATABASE_URL:-}" || -z "${REDIS_URL:-}" ]]; then
  # shellcheck disable=SC2016 # the command is printed for the reader, not expanded
  echo 'e2e-1c: DATABASE_URL and REDIS_URL are required: eval "$(scripts/dev-db.sh env)"' >&2
  exit 64
fi

WEB_PORT=${E2E_WEB_PORT:-3100}
MOCK_PORT=${E2E_MOCK_PORT:-3199}
WEB_URL="http://127.0.0.1:${WEB_PORT}"
MOCK_URL="http://127.0.0.1:${MOCK_PORT}"
OUT_DIR=${E2E_OUT_DIR:-$ROOT/apps/web/test-results/e2e-1c}
mkdir -p "$OUT_DIR"
WEB_LOG="$OUT_DIR/web.log"
WORKER_LOG="$OUT_DIR/worker.log"
MOCK_LOG="$OUT_DIR/yookassa-mock.log"
SECRETS_FILE="$OUT_DIR/secrets.txt"
: >"$SECRETS_FILE"

# --- env: phase 1A e2e (1A document, section 15) -------------------------------------------
export REDIS_URL="${E2E_REDIS_URL:-$REDIS_URL}"
export SESSION_SECRET="${SESSION_SECRET:-e2e-session-secret-0123456789abcdef0123}"
export APP_BASE_URL="$WEB_URL"
export RKN_NOTICE_NUMBER="${RKN_NOTICE_NUMBER:-E2E-TEST}"
export ROSSKO_MODE=fixtures
export LEGAL_OFFER_VERSION="${LEGAL_OFFER_VERSION:-2026-10-d1}"
export LEGAL_PRIVACY_VERSION="${LEGAL_PRIVACY_VERSION:-2026-10-d1}"
export LEGAL_CONSENT_PD_VERSION="${LEGAL_CONSENT_PD_VERSION:-2026-10-d1}"
export LEGAL_CONSENT_MARKETING_VERSION="${LEGAL_CONSENT_MARKETING_VERSION:-2026-10-d1}"
export LEGAL_RETURN_MEMO_VERSION="${LEGAL_RETURN_MEMO_VERSION:-2026-10-d1}"
# The 2026-10-d1 texts are still drafts for the lawyer: only e2e may publish them.
export LEGAL_ALLOW_DRAFT_PUBLISH=true
export SELLER_REQUISITES_NAME="${SELLER_REQUISITES_NAME:-Тестов Тест Тестович}"
export SELLER_REQUISITES_INN="${SELLER_REQUISITES_INN:-561234567890}"
export SELLER_REQUISITES_OGRNIP="${SELLER_REQUISITES_OGRNIP:-312565800012345}"
export SELLER_REQUISITES_ADDRESS="${SELLER_REQUISITES_ADDRESS:-г. Оренбург, ул. Тестовая, 1}"
export SELLER_REQUISITES_EMAIL="${SELLER_REQUISITES_EMAIL:-seller@example.test}"
export SELLER_REQUISITES_PHONE="${SELLER_REQUISITES_PHONE:-+7 900 000-00-00}"
export PICKUP_POINT_NAME="${PICKUP_POINT_NAME:-Тестовый пункт выдачи}"
export PICKUP_ADDRESS="${PICKUP_ADDRESS:-г. Оренбург, ул. Тестовая, 1}"
export PICKUP_HOURS="${PICKUP_HOURS:-Пн–Пт 10:00–19:00}"
export PICKUP_PHONE="${PICKUP_PHONE:-+7 900 000-00-01}"
# Step 7 (docs/month-close.md): the parties of the act, fake ones (never real requisites).
export CONTRACTOR_REQUISITES_NAME="${CONTRACTOR_REQUISITES_NAME:-ИП Пунктов Пётр Петрович}"
export CONTRACTOR_REQUISITES_INN="${CONTRACTOR_REQUISITES_INN:-561234567891}"
export CONTRACTOR_REQUISITES_OGRNIP="${CONTRACTOR_REQUISITES_OGRNIP:-312565800012346}"
export CONTRACTOR_REQUISITES_ADDRESS="${CONTRACTOR_REQUISITES_ADDRESS:-г. Оренбург, ул. Тестовая, 1}"
export CONTRACT_NUMBER="${CONTRACT_NUMBER:-E2E-1}"
export CONTRACT_DATE="${CONTRACT_DATE:-2026-01-15}"
export E2E_EXPECT_INN="${E2E_EXPECT_INN:-$SELLER_REQUISITES_INN}"
export NEXT_TELEMETRY_DISABLED=1

# --- env: phase 1B (section 23) --------------------------------------------------------------
export YOOKASSA_SHOP_ID="${YOOKASSA_SHOP_ID:-test-shop}"
export YOOKASSA_SECRET_KEY="${YOOKASSA_SECRET_KEY:-test-secret}"
export YOOKASSA_API_URL="$MOCK_URL/v3"
export YOOKASSA_VAT_CODE="${YOOKASSA_VAT_CODE:-1}"
export YOOKASSA_TAX_SYSTEM_CODE="${YOOKASSA_TAX_SYSTEM_CODE:-2}"
export YOOKASSA_WEBHOOK_IP_ALLOWLIST="${YOOKASSA_WEBHOOK_IP_ALLOWLIST:-127.0.0.1/32}"
export TRUSTED_IP_HEADER=x-real-ip
export ADMIN_BASIC_AUTH="${ADMIN_BASIC_AUTH:-admin:e2e-admin-password}"
export ROSSKO_ALLOW_CHECKOUT=true
export ROSSKO_DELIVERY_ID="${ROSSKO_DELIVERY_ID:-fx-delivery}"
export ROSSKO_PAYMENT_ID="${ROSSKO_PAYMENT_ID:-fx-payment}"
export SMS_PROVIDER=none
# The seller bot would long-poll api.telegram.org: no token, no bot (cards are skipped).
export TG_SELLER_BOT_TOKEN=''

# --- env: phase 1C (section 18) --------------------------------------------------------------
FILES_DIR=$(mktemp -d "${TMPDIR:-/tmp}/detaly-e2e-files.XXXXXX")
export FILES_STORAGE=local
export FILES_LOCAL_DIR="$FILES_DIR"
export INSTALL_PARTNER_NAME="${INSTALL_PARTNER_NAME:-Тестовый сервис}"
export INSTALL_PARTNER_REQUISITES="${INSTALL_PARTNER_REQUISITES:-ИП Тестов Т. Т., ИНН 561234567890}"
# The deep link shows on /vin/sent and /o/<token>; without TG_CLIENT_BOT_TOKEN the client bot
# does not start (no network).
export TG_CLIENT_BOT_USERNAME="${TG_CLIENT_BOT_USERNAME:-detaly_test_bot}"
export TG_CLIENT_BOT_TOKEN=''

# --- env: step 3 (docs/reviews.md): review links, fake ones (never the real cards) ----------
export REVIEW_URL_YANDEX="${REVIEW_URL_YANDEX:-https://yandex.ru/maps/org/test/1/reviews/}"
export REVIEW_URL_2GIS="${REVIEW_URL_2GIS:-https://2gis.ru/orenburg/firm/1}"

# --- env: step 4 (docs/fit-check.md): the fit guarantee on (e2e-1b runs it off) -------------
export FIT_GUARANTEE_ENABLED="${FIT_GUARANTEE_ENABLED:-true}"

# --- env: step 6 (docs/garage.md): «Моя машина» on (e2e-1b runs it off) ---------------------
export GARAGE_ENABLED="${GARAGE_ENABLED:-true}"

# --- what the specs read -------------------------------------------------------------------
export E2E_BASE_URL="$WEB_URL"
export E2E_PAYMENTS=on
export E2E_YOOKASSA_MOCK_URL="$MOCK_URL"
export E2E_ADMIN_USER="${ADMIN_BASIC_AUTH%%:*}"
export E2E_ADMIN_PASSWORD="${ADMIN_BASIC_AUTH#*:}"
export E2E_WEB_LOG="$WEB_LOG"
export E2E_WORKER_LOG="$WORKER_LOG"
export E2E_SECRETS_FILE="$SECRETS_FILE"
if [[ -z "${PLAYWRIGHT_BROWSERS_PATH:-}" && -d /opt/pw-browsers ]]; then
  export PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers
fi

log() { printf '[e2e-1c] %s\n' "$*"; }

PIDS=()
cleanup() {
  local pid
  for pid in "${PIDS[@]}"; do
    kill -TERM "$pid" 2>/dev/null || true
  done
  for pid in "${PIDS[@]}"; do
    wait "$pid" 2>/dev/null || true
  done
  PIDS=()
}
on_exit() {
  cleanup
  # The uploaded test photos (synthetic images) go with the run.
  rm -rf "$FILES_DIR"
}
trap on_exit EXIT

# Fails early instead of testing somebody else's server.
for url in "$WEB_URL" "$MOCK_URL"; do
  if curl -s -o /dev/null --max-time 2 "$url/"; then
    echo "e2e-1c: $url is already in use (E2E_WEB_PORT / E2E_MOCK_PORT)" >&2
    exit 1
  fi
done

wait_for() {
  local what=$1 url=$2 pid=$3
  for _ in $(seq 90); do
    if curl -fs -o /dev/null --max-time 2 "$url"; then
      log "$what is up"
      return 0
    fi
    if ! kill -0 "$pid" 2>/dev/null; then
      echo "e2e-1c: $what exited during startup, see its log in $OUT_DIR" >&2
      return 1
    fi
    sleep 1
  done
  echo "e2e-1c: $what did not start in 90 s, see its log in $OUT_DIR" >&2
  return 1
}

log 'migrate and seed'
pnpm db:migrate >/dev/null
pnpm db:seed >/dev/null

if [[ "${E2E_SKIP_BUILD:-0}" != 1 ]]; then
  log 'build web (standalone)'
  pnpm --filter @detaly/web build >"$OUT_DIR/build.log" 2>&1 || {
    tail -n 40 "$OUT_DIR/build.log" >&2
    exit 1
  }
fi
node apps/web/scripts/prepare-standalone.mjs >/dev/null

log "YooKassa mock on $MOCK_URL"
node --import tsx scripts/yookassa-mock-server.ts --port "$MOCK_PORT" \
  --webhook "$WEB_URL/api/webhooks/yookassa" --webhook-ip 127.0.0.1 \
  --shop-id "$YOOKASSA_SHOP_ID" --secret "$YOOKASSA_SECRET_KEY" >"$MOCK_LOG" 2>&1 &
PIDS+=("$!")
wait_for 'YooKassa mock' "$MOCK_URL/__mock/health" "${PIDS[-1]}"

log 'worker'
(cd apps/worker && exec node --import tsx src/main.ts) >"$WORKER_LOG" 2>&1 &
PIDS+=("$!")
WORKER_PID=${PIDS[-1]}

log "web on $WEB_URL"
PORT="$WEB_PORT" HOSTNAME=127.0.0.1 \
  node apps/web/.next/standalone/apps/web/server.js >"$WEB_LOG" 2>&1 &
PIDS+=("$!")
wait_for 'web' "$WEB_URL/api/health/live" "${PIDS[-1]}"
for _ in $(seq 30); do
  grep -q '"worker started"' "$WORKER_LOG" && break
  if ! kill -0 "$WORKER_PID" 2>/dev/null; then
    echo "e2e-1c: the worker exited during startup, see $WORKER_LOG" >&2
    exit 1
  fi
  sleep 1
done
grep -q '"worker started"' "$WORKER_LOG" || {
  echo "e2e-1c: the worker did not start, see $WORKER_LOG" >&2
  exit 1
}
log 'worker is up'

log 'playwright (phase 1A, 1B and 1C specs)'
status=0
pnpm --filter @detaly/web e2e "$@" || status=$?

# Stop web and worker first: their last lines reach the logs before the grep.
cleanup

leaks=0
count_matches() {
  # Counts only: printing the matching lines would copy the data into the CI log. Ids are masked
  # first: a random UUID may hold «79» and nine digits (a receipt id did, 09.10), and an id is
  # never a phone; the VIN and the secrets checks read the log as is.
  local count
  count=$(sed -E 's/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/<uuid>/g' "$2" |
    grep -cE "$1" || true)
  echo "${count:-0}"
}
for file in "$WEB_LOG" "$WORKER_LOG"; do
  name=$(basename "$file")
  plus=$(count_matches '\+79[0-9]{9}' "$file")
  bare=$(count_matches '(^|[^0-9])79[0-9]{9}([^0-9]|$)' "$file")
  # A VIN in full: 17 of [A-HJ-NPR-Z0-9] with a letter, not inside a longer word (logs use
  # maskVin: 'XTA**********4567').
  vins=$(grep -cP '(?<![A-Za-z0-9])(?=[0-9]*[A-HJ-NPR-Z])[A-HJ-NPR-Z0-9]{17}(?![A-Za-z0-9])' "$file" || true)
  secrets=0
  if [[ -s "$SECRETS_FILE" ]]; then
    secrets=$(grep -v '^$' "$SECRETS_FILE" | grep -cFf - "$file" || true)
  fi
  log "$name: +79… $plus, 79… $bare, VIN ${vins:-0}, phones, VINs and tokens of the specs ${secrets:-0}"
  if [[ "$plus" != 0 || "$bare" != 0 || "${vins:-0}" != 0 || "${secrets:-0}" != 0 ]]; then
    leaks=1
  fi
done
if [[ "$leaks" != 0 ]]; then
  echo 'e2e-1c: personal data, VINs or tokens in the logs' >&2
  [[ "$status" != 0 ]] || status=1
fi
if [[ "$status" == 0 ]]; then
  log 'passed'
else
  log "failed (status $status), logs in $OUT_DIR"
fi
exit "$status"
