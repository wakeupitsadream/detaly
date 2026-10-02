#!/usr/bin/env bash
# Worker watchdog, run every 5 minutes by cron in the backup container. It depends on neither
# web nor worker: it reads the worker heartbeat straight from Redis.
#
#   REDIS_URL               required (redis://redis:6379/0)
#   HEARTBEAT_KEY           default detaly:heartbeat:worker (value: epoch ms, written every 30 s)
#   HEARTBEAT_STALE_SEC     default 300: older heartbeat (or none) = worker is silent
#   HEALTHWATCH_REPEAT_MIN  default 60: repeat the alert while the problem lasts
#   HEALTHWATCH_STATE       default /tmp/healthwatch.state (last status and alert time)
#
# Alerts go to the sellers' Telegram chat on ok->problem, every REPEAT_MIN while it lasts,
# and once on recovery. Exit code: 0 ok, 1 problem.
set -euo pipefail

LOG_TAG=healthwatch
# shellcheck source-path=SCRIPTDIR source=lib.sh
source "$(dirname "$(readlink -f "$0")")/lib.sh"

require_env REDIS_URL
KEY="${HEARTBEAT_KEY:-detaly:heartbeat:worker}"
STALE_SEC="${HEARTBEAT_STALE_SEC:-300}"
REPEAT_SEC=$((${HEALTHWATCH_REPEAT_MIN:-60} * 60))
STATE_FILE="${HEALTHWATCH_STATE:-/tmp/healthwatch.state}"
BRAND="${BRAND_NAME:-Сервис}"

NOW_MS="$(now_ms)"
NOW_SEC=$((NOW_MS / 1000))

status=ok
detail=""
if ! raw="$(redis-cli -u "$REDIS_URL" --no-auth-warning --raw GET "$KEY" 2>&1)"; then
  status=redis_down
  detail="Redis недоступен"
elif [[ "$raw" == *"ERR"* || "$raw" == *"Could not connect"* ]]; then
  # redis-cli may exit 0 while printing a connection or protocol error.
  status=redis_down
  detail="Redis недоступен"
elif [[ -z "$raw" ]]; then
  status=stale
  detail="heartbeat отсутствует (worker не писал его больше 10 минут или не запускался)"
elif [[ ! "$raw" =~ ^[0-9]+$ ]]; then
  status=stale
  detail="heartbeat повреждён"
else
  age_sec=$(((NOW_MS - raw) / 1000))
  if ((age_sec > STALE_SEC)); then
    status=stale
    detail="последний heartbeat ${age_sec} с назад (порог ${STALE_SEC} с)"
  else
    detail="heartbeat ${age_sec} с назад"
  fi
fi

prev_status=ok
last_alert=0
if [[ -r "$STATE_FILE" ]]; then
  read -r prev_status last_alert <"$STATE_FILE" || true
  [[ "$last_alert" =~ ^[0-9]+$ ]] || last_alert=0
  [[ -n "$prev_status" ]] || prev_status=ok
fi

if [[ "$status" == ok ]]; then
  if [[ "$prev_status" != ok ]]; then
    tg_alert "${BRAND}: worker снова работает (${detail})." || true
  fi
  log "ok: $detail"
  printf '%s %s\n' ok 0 >"$STATE_FILE"
  exit 0
fi

# last_alert moves only when the message was delivered: a failed send is retried on the next run.
if [[ "$prev_status" == ok || $((NOW_SEC - last_alert)) -ge $REPEAT_SEC ]]; then
  if tg_alert "${BRAND}: worker молчит: ${detail}. Очереди, бот продавца и напоминания стоят. Порядок действий: docs/runbook.md, раздел «Worker молчит»."; then
    last_alert=$NOW_SEC
  fi
fi
log "problem ($status): $detail"
printf '%s %s\n' "$status" "$last_alert" >"$STATE_FILE"
exit 1
