#!/usr/bin/env bash
# Shared helpers for backup.sh, restore.sh, healthwatch.sh and selftest.sh (sourced, not run).
# shellcheck shell=bash

# Timestamped log line on stdout (cron redirects it to the container log).
log() {
  printf '%s [%s] %s\n' "$(date '+%Y-%m-%dT%H:%M:%S%z')" "${LOG_TAG:-backup}" "$*"
}

die() {
  log "error: $*" >&2
  exit 1
}

require_env() {
  local name
  for name in "$@"; do
    [[ -n "${!name:-}" ]] || die "environment variable $name is not set"
  done
}

# Telegram message to the sellers' chat. Never prints the token (curl errors are discarded:
# some curl versions include the URL) and never puts it into argv: the URL goes to curl as a
# config on stdin (-K -), so ps, /proc/<pid>/cmdline and `docker top` do not show it. Returns 1
# when delivery failed so that callers can retry later; returns 0 when no bot is configured
# (nothing to retry). TG_API_BASE is for local tests.
tg_alert() {
  local text="$1"
  if [[ -z "${TG_SELLER_BOT_TOKEN:-}" || -z "${TG_SELLER_CHAT_ID:-}" ]]; then
    log "alert not sent (TG_SELLER_BOT_TOKEN/TG_SELLER_CHAT_ID not set): $text"
    return 0
  fi
  local rc=0
  curl -fs -m 15 -o /dev/null -K - \
    --data-urlencode "chat_id=${TG_SELLER_CHAT_ID}" \
    --data-urlencode "text=${text}" \
    --data-urlencode "disable_web_page_preview=true" \
    2>/dev/null <<<"url = \"${TG_API_BASE:-https://api.telegram.org}/bot${TG_SELLER_BOT_TOKEN}/sendMessage\"" || rc=$?
  if ((rc == 0)); then
    log "alert sent"
    return 0
  fi
  log "alert delivery failed (curl exit $rc)"
  return 1
}

# Splits a postgres URL so that the password never reaches argv of pg_dump/pg_restore/psql
# (visible to every process of the container through ps and to the host through `docker top`):
# exports PGPASSWORD (percent-decoded; the environment is readable only by the same user) and
# sets PG_URL to the same URL without the password. A URL without a password is kept as is.
# Usage: pg_conn "$DATABASE_URL"; pg_dump ... "$PG_URL"
pg_conn() {
  local url="$1"
  local re='^(postgres(ql)?://)([^:@/]*):([^@/]*)@(.*)$'
  if [[ "$url" =~ $re ]]; then
    local pass="${BASH_REMATCH[4]}"
    PG_URL="${BASH_REMATCH[1]}${BASH_REMATCH[3]}@${BASH_REMATCH[5]}"
    PGPASSWORD="$(printf '%b' "${pass//%/\\x}")"
    export PGPASSWORD
  else
    PG_URL="$url"
  fi
}

# Storage location for dumps: a local directory (STORAGE=local) or an rclone remote "s3:".
# The s3 remote is configured from S3_* through RCLONE_CONFIG_S3_* (no rclone.conf needed);
# any RCLONE_CONFIG_S3_* already set wins (tests use a local-type remote).
storage_init() {
  STORAGE="${STORAGE:-s3}"
  case "$STORAGE" in
    local)
      BACKUP_LOCAL_DIR="${BACKUP_LOCAL_DIR:-/backups}"
      ;;
    s3)
      # The remote is defined by environment variables only; silence "rclone.conf not found".
      export RCLONE_CONFIG="${RCLONE_CONFIG:-/dev/null}"
      if [[ -z "${RCLONE_CONFIG_S3_TYPE:-}" ]]; then
        require_env S3_ENDPOINT S3_BUCKET S3_KEY S3_SECRET
        export RCLONE_CONFIG_S3_TYPE=s3
        export RCLONE_CONFIG_S3_PROVIDER="${RCLONE_CONFIG_S3_PROVIDER:-Other}"
        export RCLONE_CONFIG_S3_ENDPOINT="$S3_ENDPOINT"
        export RCLONE_CONFIG_S3_ACCESS_KEY_ID="$S3_KEY"
        export RCLONE_CONFIG_S3_SECRET_ACCESS_KEY="$S3_SECRET"
        export RCLONE_CONFIG_S3_REGION="${S3_REGION:-}"
        # The key may lack ListBuckets/CreateBucket rights.
        export RCLONE_CONFIG_S3_NO_CHECK_BUCKET=true
      fi
      require_env S3_BUCKET
      BACKUP_REMOTE="s3:${S3_BUCKET}/${BACKUP_PREFIX:-postgres}"
      ;;
    *)
      die "STORAGE must be s3 or local, got '$STORAGE'"
      ;;
  esac
}

# Prints dump object names (detaly-<UTC timestamp>.dump.{age,gpg}), oldest first.
storage_list() {
  case "$STORAGE" in
    local)
      [[ -d "$BACKUP_LOCAL_DIR" ]] || return 0
      local f
      for f in "$BACKUP_LOCAL_DIR"/detaly-*.dump.*; do
        if [[ -f "$f" && "$f" != *.sha256 ]]; then printf '%s\n' "${f##*/}"; fi
      done | sort
      ;;
    s3)
      rclone lsf --files-only --filter '- *.sha256' --filter '+ detaly-*.dump.*' --filter '- *' \
        "$BACKUP_REMOTE" | sort
      ;;
  esac
}

# storage_put <local file> <object name>
storage_put() {
  local src="$1" name="$2"
  case "$STORAGE" in
    local)
      mkdir -p "$BACKUP_LOCAL_DIR"
      cp "$src" "$BACKUP_LOCAL_DIR/.$name.part"
      mv "$BACKUP_LOCAL_DIR/.$name.part" "$BACKUP_LOCAL_DIR/$name"
      ;;
    s3)
      rclone copyto --retries 3 "$src" "$BACKUP_REMOTE/$name"
      ;;
  esac
}

# storage_get <object name> <local file>; returns 1 when the object does not exist.
storage_get() {
  local name="$1" dest="$2"
  case "$STORAGE" in
    local)
      [[ -f "$BACKUP_LOCAL_DIR/$name" ]] || return 1
      cp "$BACKUP_LOCAL_DIR/$name" "$dest"
      ;;
    s3)
      rclone copyto --retries 3 "$BACKUP_REMOTE/$name" "$dest"
      ;;
  esac
}

# Deletes dumps older than BACKUP_RETENTION_DAYS (default 30). The bucket should also have a
# lifecycle rule as a second line of defence (docs/runbook.md).
storage_prune() {
  local days="${BACKUP_RETENTION_DAYS:-30}"
  case "$STORAGE" in
    local)
      find "$BACKUP_LOCAL_DIR" -maxdepth 1 -type f -name 'detaly-*' -mmin "+$((days * 1440))" -print -delete
      ;;
    s3)
      rclone delete --min-age "${days}d" --include 'detaly-*' "$BACKUP_REMOTE"
      ;;
  esac
}

# Milliseconds since epoch without external tools (bash 5).
now_ms() {
  local us="${EPOCHREALTIME//[!0-9]/}"
  printf '%s\n' "$((us / 1000))"
}
