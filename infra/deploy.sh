#!/usr/bin/env bash
# Deploy by image tag on the VPS (images are built by CI and pulled from ghcr.io).
#
# Usage (from anywhere; works relative to the repository root):
#   infra/deploy.sh <tag>          pull <tag>, migrate + seed, up -d, wait for a heartbeat of the
#                                  new worker and /api/health; on failure bring the previous tag
#                                  back and exit 1
#   infra/deploy.sh rollback       up -d the tag from .deploy/prev_tag (no migrations)
#   infra/deploy.sh stage <tag>    stage profile: own Postgres/Redis, .env.stage, migrate + seed
#   infra/deploy.sh stage-down     stop and remove the stage containers (volumes are kept)
#
# Environment:
#   DRY_RUN=1          print the docker commands instead of running them
#   ENV_FILE           default .env (stage: .env.stage for the containers, .env for compose)
#   HEALTH_TIMEOUT     seconds to wait for the worker heartbeat and /api/health, default 90
#
# Migrations must be expand/contract: a rollback runs the previous image against the new schema.
# State: .deploy/current_tag, .deploy/prev_tag, .deploy/history.log.
# The tag that is brought up is also written to the env file (IMAGE_TAG, GIT_SHA; for stage
# STAGE_IMAGE_TAG), so a later manual `docker compose ... up -d web` keeps running that tag
# instead of falling back to the IMAGE_TAG=latest of .env.example.
set -euo pipefail

ROOT="$(cd "$(dirname "$(readlink -f "$0")")/.." && pwd)"
cd "$ROOT"

ENV_FILE="${ENV_FILE:-.env}"
COMPOSE_FILE="infra/docker-compose.yml"
STATE_DIR=".deploy"
HEALTH_TIMEOUT="${HEALTH_TIMEOUT:-90}"
DRY_RUN="${DRY_RUN:-0}"

MIGRATE_CMD=(node --import tsx /app/packages/db/src/migrate.ts)
SEED_CMD=(node --import tsx /app/packages/db/src/seed-cli.ts)
HEARTBEAT_KEY="detaly:heartbeat:worker"
HEALTH_JS="fetch('http://127.0.0.1:3000/api/health').then(async r=>{console.log(r.status, await r.text());process.exit(r.ok?0:1)},e=>{console.log(String(e));process.exit(1)})"

log() { printf '[deploy] %s\n' "$*" >&2; }
die() {
  log "error: $*"
  exit 1
}

# Runs a command, or prints it when DRY_RUN=1.
run() {
  if [[ "$DRY_RUN" == "1" ]]; then
    printf '+'
    printf ' %q' "$@"
    printf '\n'
  else
    "$@"
  fi
}

compose() {
  run docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" "$@"
}

# Value of KEY from an env file (last assignment wins; surrounding quotes removed).
env_value() {
  local file="$1" key="$2" line
  line="$(grep -E "^[[:space:]]*${key}=" "$file" | tail -n 1 || true)"
  line="${line#*=}"
  line="${line%\"}"
  line="${line#\"}"
  line="${line%\'}"
  line="${line#\'}"
  printf '%s' "$line"
}

# Sets KEY=VALUE in an env file in place (first assignment replaced, others dropped, appended
# when missing). Rewrites the file contents, so its owner and mode (600) stay as they were.
set_env_value() {
  local file="$1" key="$2" value="$3" tmp
  if [[ "$DRY_RUN" == "1" ]]; then
    log "DRY_RUN: would set $key=$value in $file"
    return
  fi
  tmp="$(mktemp)"
  awk -v k="$key" -v v="$value" '
    $0 ~ "^[[:space:]]*" k "=" { if (!done) print k "=" v; done = 1; next }
    { print }
    END { if (!done) print k "=" v }
  ' "$file" >"$tmp"
  cat "$tmp" >"$file"
  rm -f "$tmp"
}

# Milliseconds since epoch (bash 5; EPOCHREALTIME may use a locale decimal comma).
now_ms() {
  local us="${EPOCHREALTIME//[!0-9]/}"
  printf '%s\n' "$((us / 1000))"
}

# Problems that would break production; in DRY_RUN they are only reported.
preflight() {
  local file="$1" problems=()
  [[ -f "$file" ]] || die "env file $file not found (copy .env.example and fill it in)"
  [[ -n "$(env_value "$file" SITE_DOMAIN)" ]] || problems+=("SITE_DOMAIN is empty")
  [[ -n "$(env_value "$file" ACME_EMAIL)" ]] || problems+=("ACME_EMAIL is empty (Let's Encrypt)")
  local pg_pass
  pg_pass="$(env_value "$file" POSTGRES_PASSWORD)"
  if [[ -z "$pg_pass" || "$pg_pass" == "detaly" ]]; then
    problems+=("POSTGRES_PASSWORD is empty or default (openssl rand -hex 24)")
  elif [[ ! "$pg_pass" =~ ^[A-Za-z0-9._~-]+$ ]]; then
    # compose puts it into DATABASE_URL unescaped: @ : / ? # % would break the URL
    problems+=("POSTGRES_PASSWORD must be URL-safe ([A-Za-z0-9._~-]; openssl rand -hex 24)")
  fi
  local secret
  secret="$(env_value "$file" SESSION_SECRET)"
  if [[ ${#secret} -lt 32 || "$secret" == change-me* ]]; then
    problems+=("SESSION_SECRET is missing or the example value (openssl rand -hex 32)")
  fi
  if [[ -z "$(env_value "$file" BACKUP_AGE_RECIPIENT)" && -z "$(env_value "$file" BACKUP_PASSPHRASE)" ]]; then
    problems+=("neither BACKUP_AGE_RECIPIENT nor BACKUP_PASSPHRASE is set: backups would fail")
  fi
  if [[ "$(env_value "$file" BACKUP_STORAGE)" != "local" ]]; then
    local k
    for k in S3_ENDPOINT S3_BUCKET S3_KEY S3_SECRET; do
      [[ -n "$(env_value "$file" "$k")" ]] || problems+=("$k is empty: the nightly backup to S3 would fail")
    done
  fi
  if [[ ! -f infra/certs/russian_trusted_root_ca.pem ]]; then
    log "warning: infra/certs/russian_trusted_root_ca.pem is missing (see infra/certs/README.md)"
  fi
  if [[ ${#problems[@]} -gt 0 ]]; then
    local p
    for p in "${problems[@]}"; do log "preflight: $p"; done
    if [[ "$DRY_RUN" == "1" ]]; then
      log "DRY_RUN: continuing despite preflight problems"
    else
      die "fix $file and retry"
    fi
  fi
}

save_state() {
  local name="$1" value="$2"
  if [[ "$DRY_RUN" == "1" ]]; then
    log "DRY_RUN: would write $STATE_DIR/$name = $value"
    return
  fi
  mkdir -p "$STATE_DIR"
  printf '%s\n' "$value" >"$STATE_DIR/$name"
}

read_state() {
  local f="$STATE_DIR/$1"
  if [[ -f "$f" ]]; then head -n 1 "$f"; fi
}

history() {
  if [[ "$DRY_RUN" != "1" ]]; then
    mkdir -p "$STATE_DIR"
    printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >>"$STATE_DIR/history.log"
  fi
}

# Waits until the worker has written a heartbeat after <since_ms> (the containers were brought up
# by then, so it comes from the new worker, not from the one just replaced: its last heartbeat
# stays fresh for HEARTBEAT_STALE_SEC and would hide a crash-looping new worker), and then until
# web answers 200 on /api/health (DB, Redis and the heartbeat are fine).
# Usage: wait_ready <web service> <redis service> <since_ms>
wait_ready() {
  local web="$1" redis="$2" since_ms="$3"
  if [[ "$DRY_RUN" == "1" ]]; then
    compose exec -T "$redis" redis-cli --raw GET "$HEARTBEAT_KEY"
    compose exec -T "$web" node -e "$HEALTH_JS"
    return 0
  fi
  local deadline=$((SECONDS + HEALTH_TIMEOUT)) hb="" hb_ok=0 out="no answer yet"
  while ((SECONDS < deadline)); do
    if ((!hb_ok)); then
      hb="$(compose exec -T "$redis" redis-cli --raw GET "$HEARTBEAT_KEY" 2>/dev/null || true)"
      hb="${hb//[!0-9]/}"
      if [[ -n "$hb" ]] && ((hb > since_ms)); then
        hb_ok=1
        log "worker heartbeat ok (new container)"
      fi
    fi
    if ((hb_ok)); then
      if out="$(compose exec -T "$web" node -e "$HEALTH_JS" 2>&1)"; then
        log "health ok: $out"
        return 0
      fi
    fi
    sleep 5
  done
  if ((!hb_ok)); then
    log "no worker heartbeat newer than the deploy after ${HEALTH_TIMEOUT}s (see: logs worker)"
  else
    log "health check failed after ${HEALTH_TIMEOUT}s: $out"
  fi
  return 1
}

validate_tag() {
  [[ "$1" =~ ^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$ ]] || die "invalid image tag: '$1'"
}

# Starts the app services with a given tag (no migrations). Only when `compose up` succeeded is
# the tag recorded in the env file: a failed up must not leave an unverified tag there for the
# next manual `docker compose up -d`. Returns 1 on failure (callers roll back), so call it in
# an `if` / `&&` chain. Sets UP_SINCE: the time (ms) after which a heartbeat can only come from
# the started worker.
UP_SINCE=0
up_tag() {
  local tag="$1"
  export IMAGE_TAG="$tag" GIT_SHA="$tag"
  if ! compose up -d web worker backup caddy; then
    log "compose up -d with $tag failed"
    return 1
  fi
  UP_SINCE="$(now_ms)"
  set_env_value "$ENV_FILE" IMAGE_TAG "$tag"
  set_env_value "$ENV_FILE" GIT_SHA "$tag"
}

deploy() {
  local tag="$1"
  validate_tag "$tag"
  preflight "$ENV_FILE"
  local current
  current="$(read_state current_tag)"
  log "deploying $tag (current: ${current:-none})"

  export IMAGE_TAG="$tag" GIT_SHA="$tag"
  compose pull web worker backup
  compose up -d --wait postgres redis
  log "migrations"
  compose run --rm --no-deps worker "${MIGRATE_CMD[@]}"
  log "seed"
  compose run --rm --no-deps worker "${SEED_CMD[@]}"
  if up_tag "$tag" && wait_ready web redis "$UP_SINCE"; then
    if [[ -n "$current" && "$current" != "$tag" ]]; then save_state prev_tag "$current"; fi
    save_state current_tag "$tag"
    history "deploy $tag ok"
    log "deployed $tag"
    return 0
  fi

  history "deploy $tag failed"
  if [[ -n "$current" && "$current" != "$tag" ]]; then
    log "rolling back to $current"
    if up_tag "$current" && wait_ready web redis "$UP_SINCE"; then
      history "auto-rollback to $current ok"
    else
      history "auto-rollback to $current: health still failing"
    fi
  else
    log "no previous tag to roll back to"
  fi
  exit 1
}

rollback() {
  local prev current
  prev="$(read_state prev_tag)"
  current="$(read_state current_tag)"
  [[ -n "$prev" ]] || die "$STATE_DIR/prev_tag is empty: nothing to roll back to"
  validate_tag "$prev"
  preflight "$ENV_FILE"
  log "rollback $current -> $prev (no migrations; schema stays expanded)"
  if up_tag "$prev" && wait_ready web redis "$UP_SINCE"; then
    save_state current_tag "$prev"
    if [[ -n "$current" ]]; then save_state prev_tag "$current"; fi
    history "rollback to $prev ok"
    return 0
  fi
  history "rollback to $prev failed"
  exit 1
}

stage_up() {
  local tag="$1"
  validate_tag "$tag"
  [[ -f "$ENV_FILE" ]] || die "env file $ENV_FILE not found"
  [[ -f .env.stage ]] || die ".env.stage not found (stage containers read it; see docs/runbook.md)"
  # Two long-polling processes on one bot token steal each other's updates.
  local key prod_v stage_v
  for key in TG_SELLER_BOT_TOKEN TG_CLIENT_BOT_TOKEN MAX_BOT_TOKEN; do
    prod_v="$(env_value "$ENV_FILE" "$key")"
    stage_v="$(env_value .env.stage "$key")"
    if [[ -n "$stage_v" && "$stage_v" == "$prod_v" ]]; then
      die "$key in .env.stage equals production: use a separate test bot or leave it empty"
    fi
  done
  # exec/run on stage services need the profile enabled for every compose call
  export STAGE_IMAGE_TAG="$tag" COMPOSE_PROFILES=stage
  compose --profile stage pull web-stage worker-stage
  compose --profile stage up -d --wait postgres-stage redis-stage
  compose --profile stage run --rm --no-deps worker-stage "${MIGRATE_CMD[@]}"
  compose --profile stage run --rm --no-deps worker-stage "${SEED_CMD[@]}"
  compose --profile stage up -d web-stage worker-stage
  set_env_value "$ENV_FILE" STAGE_IMAGE_TAG "$tag"
  wait_ready web-stage redis-stage "$(now_ms)"
  history "stage $tag up"
}

stage_down() {
  export COMPOSE_PROFILES=stage
  compose --profile stage stop web-stage worker-stage postgres-stage redis-stage
  compose --profile stage rm -f web-stage worker-stage postgres-stage redis-stage
  history "stage down"
}

main() {
  [[ $# -ge 1 ]] || die "usage: deploy.sh <tag> | rollback | stage <tag> | stage-down"
  if [[ "$DRY_RUN" != "1" ]]; then
    command -v docker >/dev/null || die "docker not found"
  fi
  case "$1" in
    rollback) rollback ;;
    stage)
      [[ $# -eq 2 ]] || die "usage: deploy.sh stage <tag>"
      stage_up "$2"
      ;;
    stage-down) stage_down ;;
    -h | --help) sed -n '2,23p' "$0" ;;
    *) deploy "$1" ;;
  esac
}

main "$@"
