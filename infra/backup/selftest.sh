#!/usr/bin/env bash
# End-to-end check of backup.sh + restore.sh without S3 and without the real keys:
# makes a throwaway age key, backs up SOURCE_URL with STORAGE=local, restores "latest" into a
# temporary database on the same server, compares exact row counts of every table, then
# repeats with the gpg fallback. The temporary database and files are removed.
#
# Usage: selftest.sh <source_database_url>
# Needs: pg_dump/pg_restore/psql 16, age, age-keygen, gpg; CREATEDB right on the server.
# Used in CI (job check) and by hand (docs/runbook.md, «Проверка бэкапа»).
set -euo pipefail

LOG_TAG=selftest
HERE="$(dirname "$(readlink -f "$0")")"
# shellcheck source-path=SCRIPTDIR source=lib.sh
source "$HERE/lib.sh"

[[ $# -eq 1 ]] || die "usage: selftest.sh <source_database_url>"
SOURCE_URL="$1"

WORK="$(mktemp -d)"
RESTORE_DB="detaly_restore_selftest_$$"
ADMIN_URL="$SOURCE_URL"

cleanup() {
  psql "$ADMIN_URL" -X -q -c "set client_min_messages = warning" -c "drop database if exists \"$RESTORE_DB\"" >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT

# Same server, different database name (works for postgres://user:pass@host:port/db?params).
target_url() {
  local url="$1" db="$2" base query=""
  if [[ "$url" == *\?* ]]; then
    query="?${url#*\?}"
    url="${url%%\?*}"
  fi
  base="${url%/*}"
  printf '%s/%s%s' "$base" "$db" "$query"
}
TARGET_URL="$(target_url "$SOURCE_URL" "$RESTORE_DB")"

counts() {
  psql "$1" -X -v ON_ERROR_STOP=1 -At -F $'\t' <<'SQL'
select format('select %L, count(*) from %I.%I', n.nspname || '.' || c.relname, n.nspname, c.relname)
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where c.relkind in ('r', 'p')
  and n.nspname not in ('pg_catalog', 'information_schema')
  and n.nspname not like 'pg_toast%'
order by 1
\gexec
SQL
}

run_case() {
  local mode="$1"
  local dir="$WORK/$mode"
  mkdir -p "$dir/storage"
  psql "$ADMIN_URL" -X -q -c "set client_min_messages = warning" -c "drop database if exists \"$RESTORE_DB\"" >/dev/null
  psql "$ADMIN_URL" -X -q -c "create database \"$RESTORE_DB\"" >/dev/null

  local -a enc_env
  if [[ "$mode" == age ]]; then
    age-keygen -o "$dir/key.txt" 2>/dev/null
    enc_env=(BACKUP_AGE_RECIPIENT="$(age-keygen -y "$dir/key.txt")" BACKUP_AGE_IDENTITY="$dir/key.txt" BACKUP_PASSPHRASE=)
  else
    enc_env=(BACKUP_AGE_RECIPIENT= BACKUP_PASSPHRASE="selftest-$RANDOM-$RANDOM")
  fi

  env "${enc_env[@]}" STORAGE=local BACKUP_LOCAL_DIR="$dir/storage" DATABASE_URL="$SOURCE_URL" \
    TG_SELLER_BOT_TOKEN= "$HERE/backup.sh"

  local name
  name="$(STORAGE=local BACKUP_LOCAL_DIR="$dir/storage" storage_list | tail -n 1)"
  [[ "$name" == *".dump.$mode" ]] || die "$mode: unexpected dump name '$name'"
  # The stored file must be encrypted, not a plain pg_dump archive.
  if pg_restore --list "$dir/storage/$name" >/dev/null 2>&1; then
    die "$mode: stored dump is readable without decryption"
  fi

  env "${enc_env[@]}" STORAGE=local BACKUP_LOCAL_DIR="$dir/storage" DATABASE_URL="$SOURCE_URL" \
    "$HERE/restore.sh" latest "$TARGET_URL" >"$dir/restore.out"

  counts "$SOURCE_URL" >"$dir/source.counts"
  counts "$TARGET_URL" >"$dir/target.counts"
  if ! diff -u "$dir/source.counts" "$dir/target.counts"; then
    die "$mode: row counts differ after restore"
  fi
  # restore.sh prints the same counts it computed itself
  grep -vE '^[0-9-]+T|\[restore\]' "$dir/restore.out" | diff -u "$dir/source.counts" - >/dev/null \
    || die "$mode: restore.sh summary differs from source counts"
  log "$mode: ok, $(wc -l <"$dir/source.counts") tables, rows: $(awk -F'\t' '{s+=$2} END {print s+0}' "$dir/source.counts")"
  sed 's/^/  /' "$dir/source.counts"
}

run_case age
run_case gpg
log "backup/restore selftest passed"
