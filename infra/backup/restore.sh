#!/usr/bin/env bash
# Restore a dump made by backup.sh into a target database, then print row counts per table.
#
# Usage: restore.sh <object|latest> [<target_database_url>]
#        restore.sh --list            dump names in the storage, oldest first
#   target   omitted: RESTORE_TARGET_URL from the environment (keeps the password out of argv,
#            e.g. sh -c 'RESTORE_TARGET_URL="$DATABASE_URL" restore.sh latest'); the password
#            is passed to pg_restore/psql through PGPASSWORD, never on their command line
#   object   dump name (detaly-20261002T213000Z.dump.age), or a path to a local file
#   latest   newest dump in the storage (STORAGE=s3|local, same settings as backup.sh)
#
# Decryption:
#   *.age  BACKUP_AGE_IDENTITY = path to the age private key file (brought in for the restore
#          only, e.g. docker compose run -v /root/backup.key:/key:ro -e BACKUP_AGE_IDENTITY=/key ...)
#   *.gpg  BACKUP_PASSPHRASE
#
# Restoring over DATABASE_URL (the live database) is refused unless RESTORE_FORCE=1.
# pg_restore runs with --clean --if-exists --no-owner --single-transaction --exit-on-error.
set -euo pipefail

LOG_TAG=restore
# shellcheck source-path=SCRIPTDIR source=lib.sh
source "$(dirname "$(readlink -f "$0")")/lib.sh"

if [[ "${1:-}" == "--list" ]]; then
  storage_init
  storage_list
  exit 0
fi

[[ $# -eq 1 || $# -eq 2 ]] ||
  die "usage: restore.sh <object|latest> [<target_database_url>] | restore.sh --list"
OBJECT="$1"
TARGET="${2:-${RESTORE_TARGET_URL:-}}"
[[ -n "$TARGET" ]] || die "no target: pass <target_database_url> or set RESTORE_TARGET_URL"

if [[ "$TARGET" == "${DATABASE_URL:-}" && "${RESTORE_FORCE:-}" != "1" ]]; then
  die "target equals DATABASE_URL (live database); set RESTORE_FORCE=1 if this is intended"
fi

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# --- locate and fetch the dump ---
if [[ "$OBJECT" != "latest" && -f "$OBJECT" ]]; then
  NAME="$(basename "$OBJECT")"
  cp "$OBJECT" "$WORK/$NAME"
  if [[ -f "$OBJECT.sha256" ]]; then cp "$OBJECT.sha256" "$WORK/$NAME.sha256"; fi
else
  storage_init
  if [[ "$OBJECT" == "latest" ]]; then
    NAME="$(storage_list | tail -n 1)"
    [[ -n "$NAME" ]] || die "no dumps found in storage ($STORAGE)"
  else
    NAME="$OBJECT"
  fi
  log "fetching $NAME from $STORAGE"
  storage_get "$NAME" "$WORK/$NAME" || die "dump $NAME not found"
  storage_get "$NAME.sha256" "$WORK/$NAME.sha256" 2>/dev/null || log "no checksum file for $NAME"
fi

if [[ -f "$WORK/$NAME.sha256" ]]; then
  (cd "$WORK" && sha256sum -c --quiet "$NAME.sha256") || die "checksum mismatch for $NAME"
  log "checksum ok"
fi

# --- decrypt (plaintext stays in the temp dir and is removed on exit) ---
DUMP="$WORK/db.dump"
case "$NAME" in
  *.age)
    require_env BACKUP_AGE_IDENTITY
    [[ -r "$BACKUP_AGE_IDENTITY" ]] || die "BACKUP_AGE_IDENTITY file is not readable"
    age -d -i "$BACKUP_AGE_IDENTITY" -o "$DUMP" "$WORK/$NAME"
    ;;
  *.gpg)
    require_env BACKUP_PASSPHRASE
    mkdir -m 700 "$WORK/gnupg"
    GNUPGHOME="$WORK/gnupg" gpg --batch --yes --quiet --pinentry-mode loopback \
      --passphrase-fd 3 -o "$DUMP" --decrypt "$WORK/$NAME" \
      3< <(printf '%s' "$BACKUP_PASSPHRASE")
    ;;
  *)
    die "unknown dump format: $NAME (expected .age or .gpg)"
    ;;
esac

pg_restore --list "$DUMP" >/dev/null || die "decrypted file is not a pg_dump archive"

# --- restore ---
log "restoring $NAME"
pg_conn "$TARGET"
pg_restore --clean --if-exists --no-owner --no-acl --single-transaction --exit-on-error \
  --dbname="$PG_URL" "$DUMP"
log "restore ok: $NAME"

# --- row counts (exact) for every user table, schema.table<TAB>rows ---
psql "$PG_URL" -X -v ON_ERROR_STOP=1 -At -F $'\t' <<'SQL'
select format('select %L, count(*) from %I.%I', n.nspname || '.' || c.relname, n.nspname, c.relname)
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where c.relkind in ('r', 'p')
  and n.nspname not in ('pg_catalog', 'information_schema')
  and n.nspname not like 'pg_toast%'
order by 1
\gexec
SQL
