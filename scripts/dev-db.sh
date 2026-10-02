#!/usr/bin/env bash
# Local PostgreSQL 16 + Redis 7 for development and tests, without Docker.
#
# Usage:
#   scripts/dev-db.sh up              start PG (127.0.0.1:55432) and Redis (127.0.0.1:56379); idempotent
#   scripts/dev-db.sh down            stop both
#   scripts/dev-db.sh status          print what is running
#   scripts/dev-db.sh env             print export lines: eval "$(scripts/dev-db.sh env)"
#   scripts/dev-db.sh ensure-db NAME  create database NAME if missing (owner detaly)
#   scripts/dev-db.sh reset           down, wipe ${DETALY_DEV_DIR}, up
#
# Environment:
#   DETALY_DEV_DIR   data directory (default /tmp/detaly-dev)
#   DETALY_PG_PORT   default 55432
#   DETALY_REDIS_PORT default 56379
#   DETALY_TEST_DB   test database name (default detaly_test_<worktree dir name>)
#   PG_BIN           directory with initdb/pg_ctl (default: newest /usr/lib/postgresql/*/bin)
#
# Under root, initdb/pg_ctl run as the "postgres" system user via runuser
# (initdb refuses to run as root). As a regular user they run directly.
set -euo pipefail

DEV_DIR="${DETALY_DEV_DIR:-/tmp/detaly-dev}"
PG_PORT="${DETALY_PG_PORT:-55432}"
REDIS_PORT="${DETALY_REDIS_PORT:-56379}"
PG_HOST=127.0.0.1
APP_ROLE=detaly
APP_PASSWORD=detaly
DEV_DB=detaly

PG_DATA="$DEV_DIR/pg/data"
PG_RUN="$DEV_DIR/pg/run"
PG_LOG="$DEV_DIR/pg/postgres.log"
REDIS_DIR="$DEV_DIR/redis"

log() { printf '[dev-db] %s\n' "$*" >&2; }
die() {
  printf '[dev-db] error: %s\n' "$*" >&2
  exit 1
}

find_pg_bin() {
  if [[ -n "${PG_BIN:-}" ]]; then
    printf '%s\n' "$PG_BIN"
    return
  fi
  local candidate
  candidate="$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -V | tail -1 || true)"
  if [[ -n "$candidate" && -x "$candidate/initdb" ]]; then
    printf '%s\n' "$candidate"
    return
  fi
  if command -v pg_config >/dev/null 2>&1; then
    pg_config --bindir
    return
  fi
  die "PostgreSQL binaries not found; set PG_BIN"
}

PG_BIN_DIR="$(find_pg_bin)"

is_root() { [[ "$(id -u)" -eq 0 ]]; }

# Run a command as the PostgreSQL server owner.
as_pg() {
  if is_root; then
    (cd "$DEV_DIR" && runuser -u postgres -- "$@")
  else
    "$@"
  fi
}

sanitize_name() {
  printf '%s' "$1" | tr '[:upper:]' '[:lower:]' | tr -c 'a-z0-9_\n' '_' | cut -c1-50
}

test_db_name() {
  if [[ -n "${DETALY_TEST_DB:-}" ]]; then
    printf '%s\n' "$DETALY_TEST_DB"
    return
  fi
  local top
  top="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
  printf 'detaly_test_%s\n' "$(sanitize_name "$(basename "$top")")"
}

psql_admin() {
  "$PG_BIN_DIR/psql" -X -q -v ON_ERROR_STOP=1 -h "$PG_HOST" -p "$PG_PORT" -U postgres -d postgres "$@"
}

pg_running() {
  "$PG_BIN_DIR/pg_isready" -q -h "$PG_HOST" -p "$PG_PORT" >/dev/null 2>&1
}

redis_running() {
  redis-cli -h "$PG_HOST" -p "$REDIS_PORT" ping 2>/dev/null | grep -q PONG
}

pg_init() {
  if [[ -f "$PG_DATA/PG_VERSION" ]]; then
    return
  fi
  log "initdb in $PG_DATA"
  mkdir -p "$PG_DATA" "$PG_RUN"
  chmod 755 "$DEV_DIR" "$DEV_DIR/pg"
  if is_root; then
    chown -R postgres:postgres "$DEV_DIR/pg"
  fi
  chmod 700 "$PG_DATA"
  as_pg "$PG_BIN_DIR/initdb" -D "$PG_DATA" -U postgres --auth=trust --encoding=UTF8 \
    --locale=C.UTF-8 >/dev/null
}

pg_start() {
  if pg_running; then
    log "postgres already running on $PG_HOST:$PG_PORT"
    return
  fi
  pg_init
  log "starting postgres on $PG_HOST:$PG_PORT"
  as_pg "$PG_BIN_DIR/pg_ctl" -D "$PG_DATA" -l "$PG_LOG" -w -t 30 \
    -o "-p $PG_PORT -c listen_addresses=$PG_HOST -k $PG_RUN -c fsync=off -c synchronous_commit=off -c full_page_writes=off -c max_connections=200" \
    start >/dev/null
}

pg_bootstrap() {
  psql_admin <<SQL
DO \$\$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '$APP_ROLE') THEN
    CREATE ROLE $APP_ROLE LOGIN SUPERUSER PASSWORD '$APP_PASSWORD';
  END IF;
END
\$\$;
SQL
  ensure_db "$DEV_DB"
  ensure_db "$(test_db_name)"
}

ensure_db() {
  local name="$1"
  [[ "$name" =~ ^[a-z_][a-z0-9_]{0,62}$ ]] || die "invalid database name: $name"
  if [[ "$(psql_admin -tAc "SELECT 1 FROM pg_database WHERE datname = '$name'")" != "1" ]]; then
    log "creating database $name"
    psql_admin -c "CREATE DATABASE \"$name\" OWNER $APP_ROLE"
  fi
}

pg_stop() {
  if [[ -f "$PG_DATA/postmaster.pid" ]]; then
    log "stopping postgres"
    as_pg "$PG_BIN_DIR/pg_ctl" -D "$PG_DATA" -m fast -w stop >/dev/null || true
  fi
}

redis_start() {
  if redis_running; then
    log "redis already running on $PG_HOST:$REDIS_PORT"
    return
  fi
  mkdir -p "$REDIS_DIR"
  log "starting redis on $PG_HOST:$REDIS_PORT"
  redis-server --bind "$PG_HOST" --port "$REDIS_PORT" --daemonize yes \
    --dir "$REDIS_DIR" --pidfile "$REDIS_DIR/redis.pid" --logfile "$REDIS_DIR/redis.log" \
    --save '' --appendonly no --maxmemory-policy noeviction >/dev/null
  for _ in $(seq 1 50); do
    redis_running && return
    sleep 0.1
  done
  die "redis did not start, see $REDIS_DIR/redis.log"
}

redis_stop() {
  if redis_running; then
    log "stopping redis"
    redis-cli -h "$PG_HOST" -p "$REDIS_PORT" shutdown nosave >/dev/null 2>&1 || true
  fi
}

print_env() {
  local test_db
  test_db="$(test_db_name)"
  cat <<EOF
export DATABASE_URL='postgres://$APP_ROLE:$APP_PASSWORD@$PG_HOST:$PG_PORT/$DEV_DB'
export DATABASE_URL_TEST='postgres://$APP_ROLE:$APP_PASSWORD@$PG_HOST:$PG_PORT/$test_db'
export REDIS_URL='redis://$PG_HOST:$REDIS_PORT/0'
export REDIS_URL_TEST='redis://$PG_HOST:$REDIS_PORT/1'
EOF
}

status() {
  if pg_running; then echo "postgres: up ($PG_HOST:$PG_PORT, data $PG_DATA)"; else echo "postgres: down"; fi
  if redis_running; then echo "redis: up ($PG_HOST:$REDIS_PORT)"; else echo "redis: down"; fi
}

cmd="${1:-}"
case "$cmd" in
  up)
    mkdir -p "$DEV_DIR"
    pg_start
    pg_bootstrap
    redis_start
    status >&2
    ;;
  down)
    pg_stop
    redis_stop
    ;;
  status)
    status
    ;;
  env)
    print_env
    ;;
  ensure-db)
    [[ $# -ge 2 ]] || die "usage: $0 ensure-db NAME"
    pg_running || die "postgres is not running; run: $0 up"
    ensure_db "$2"
    ;;
  reset)
    pg_stop
    redis_stop
    case "$DEV_DIR" in
      /tmp/* | */.dev | */.dev/*) rm -rf "$DEV_DIR" ;;
      *) die "refusing to wipe $DEV_DIR (only /tmp/* or */.dev allowed)" ;;
    esac
    "$0" up
    ;;
  *)
    sed -n '2,20p' "$0" >&2
    exit 2
    ;;
esac
