#!/usr/bin/env bash
# Nightly PostgreSQL backup: pg_dump -Fc | encrypt | upload, then delete dumps older than 30 days.
#
# Encryption (the plaintext dump never touches the disk):
#   BACKUP_AGE_RECIPIENT  age public key(s) "age1...", comma-separated; preferred.
#                         The private key stays offline with the owner.
#   BACKUP_PASSPHRASE     fallback: gpg --symmetric (AES256) when no age recipient is set.
# Storage:
#   STORAGE=s3 (default)  rclone to s3:$S3_BUCKET/${BACKUP_PREFIX:-postgres} (S3_ENDPOINT/KEY/SECRET/REGION)
#   STORAGE=local         copy to ${BACKUP_LOCAL_DIR:-/backups}; for local checks
# Other: DATABASE_URL (required), BACKUP_RETENTION_DAYS (30).
# On any failure: Telegram message to TG_SELLER_CHAT_ID (if the bot token is set), exit 1.
set -euo pipefail

LOG_TAG=backup
# shellcheck source-path=SCRIPTDIR source=lib.sh
source "$(dirname "$(readlink -f "$0")")/lib.sh"

STEP=init
WORK=""

# Any non-zero exit (set -e, die, a failed pipe) ends here and raises the alert.
finish() {
  local code=$?
  if [[ -n "$WORK" ]]; then rm -rf "$WORK"; fi
  if [[ $code -ne 0 ]]; then
    log "failed at step '$STEP' (exit $code)"
    tg_alert "${BRAND_NAME:-Сервис}: ночной бэкап БД не выполнен (шаг: $STEP, хост: $(hostname)). Проверьте: docker compose logs backup"
  fi
  exit "$code"
}
trap finish EXIT

STEP=config
require_env DATABASE_URL
storage_init

if [[ -n "${BACKUP_AGE_RECIPIENT:-}" ]]; then
  MODE=age
  AGE_ARGS=()
  IFS=',' read -r -a recipients <<<"$BACKUP_AGE_RECIPIENT"
  for r in "${recipients[@]}"; do
    r="${r//[[:space:]]/}"
    [[ -n "$r" ]] && AGE_ARGS+=(-r "$r")
  done
  [[ ${#AGE_ARGS[@]} -gt 0 ]] || die "BACKUP_AGE_RECIPIENT has no recipients"
elif [[ -n "${BACKUP_PASSPHRASE:-}" ]]; then
  MODE=gpg
else
  # Never upload a plaintext dump.
  die "neither BACKUP_AGE_RECIPIENT nor BACKUP_PASSPHRASE is set"
fi

WORK="$(mktemp -d)"
NAME="detaly-$(date -u +%Y%m%dT%H%M%SZ).dump.$MODE"
OUT="$WORK/$NAME"

encrypt() {
  case "$MODE" in
    age)
      age "${AGE_ARGS[@]}" -o "$OUT"
      ;;
    gpg)
      local gnupg="$WORK/gnupg"
      mkdir -m 700 "$gnupg"
      GNUPGHOME="$gnupg" gpg --batch --yes --quiet --pinentry-mode loopback \
        --symmetric --cipher-algo AES256 --passphrase-fd 3 -o "$OUT" \
        3< <(printf '%s' "$BACKUP_PASSPHRASE")
      ;;
  esac
}

STEP=dump
log "dump started (mode=$MODE, storage=$STORAGE)"
pg_dump --format=custom --compress=6 --no-password "$DATABASE_URL" | encrypt
[[ -s "$OUT" ]]
(cd "$WORK" && sha256sum "$NAME" >"$NAME.sha256")
SIZE="$(stat -c %s "$OUT")"

STEP=upload
storage_put "$OUT" "$NAME"
storage_put "$OUT.sha256" "$NAME.sha256"

STEP=retention
storage_prune

STEP=finished
log "backup ok: $NAME ($SIZE bytes)"
