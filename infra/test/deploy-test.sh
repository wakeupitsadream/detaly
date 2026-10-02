#!/usr/bin/env bash
# Tests for infra/deploy.sh without a Docker daemon: a fake `docker` on PATH records every call
# and plays the worker heartbeat (fresh or stale) and the /api/health answer.
#
# Usage: infra/test/deploy-test.sh      (exit 0 when every case passes; used in CI, job check)
set -euo pipefail

HERE="$(cd "$(dirname "$(readlink -f "$0")")" && pwd)"
SRC="$HERE/../deploy.sh"
T="$(mktemp -d)"
trap 'rm -rf "$T"' EXIT

mkdir -p "$T/root/infra/certs" "$T/bin"
cp "$SRC" "$T/root/infra/deploy.sh"
chmod +x "$T/root/infra/deploy.sh"

# --- fake docker ---
# $T/hb_mode: fresh (heartbeat written "now") | stale (an old heartbeat of the replaced worker)
# $T/health_rc: exit code of `exec web node -e <health>`
cat >"$T/bin/docker" <<'SHIM'
#!/usr/bin/env bash
T="$(dirname "$(dirname "$(readlink -f "$0")")")"
printf 'IMAGE_TAG=%s STAGE_IMAGE_TAG=%s :: %s\n' "${IMAGE_TAG:-}" "${STAGE_IMAGE_TAG:-}" "$*" >>"$T/docker.log"
args=" $* "
if [[ "$args" == *" exec "* && "$args" == *" redis-cli "* ]]; then
  if [[ "$(cat "$T/hb_mode")" == fresh ]]; then
    us="${EPOCHREALTIME//[!0-9]/}"
    echo "$((us / 1000))"
  else
    echo 1000
  fi
  exit 0
fi
if [[ "$args" == *" exec "* && "$args" == *" node -e "* ]]; then
  rc="$(cat "$T/health_rc")"
  echo "$([[ $rc == 0 ]] && echo 200 || echo 503) {}"
  exit "$rc"
fi
exit 0
SHIM
chmod +x "$T/bin/docker"
export PATH="$T/bin:$PATH"

ENV="$T/root/.env"
write_env() {
  cat >"$ENV" <<'ENVF'
SITE_DOMAIN=example.ru
ACME_EMAIL=ops@example.ru
POSTGRES_PASSWORD=0123456789abcdef0123456789abcdef
SESSION_SECRET=0123456789abcdef0123456789abcdef0123456789abcdef
BACKUP_AGE_RECIPIENT=age1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq
S3_ENDPOINT=https://s3.example.ru
S3_BUCKET=b
S3_KEY=k
S3_SECRET=s
IMAGE_TAG=latest
GIT_SHA=dev
TG_SELLER_BOT_TOKEN=prod-token
ENVF
  chmod 600 "$ENV"
}

fails=0
pass() { printf 'ok   %s\n' "$1"; }
fail() {
  printf 'FAIL %s\n' "$1"
  fails=$((fails + 1))
}
check() { # check <name> <command...>
  local name="$1"
  shift
  if "$@"; then pass "$name"; else fail "$name"; fi
}
deploy() { # deploy <args...>; prints nothing, returns the exit code
  local rc=0
  (cd "$T" && HEALTH_TIMEOUT=6 "$T/root/infra/deploy.sh" "$@") >>"$T/out.log" 2>&1 || rc=$?
  return "$rc"
}
state() { cat "$T/root/.deploy/$1" 2>/dev/null || true; }
envv() { grep -E "^$1=" "$ENV" | tail -n 1 | cut -d= -f2-; }
last_up_tag() { grep ' up -d web worker backup caddy' "$T/docker.log" | tail -n 1 | sed -E 's/^IMAGE_TAG=([^ ]*) .*/\1/'; }

write_env
: >"$T/docker.log"

# 1. first deploy: new worker writes a heartbeat, health 200
echo fresh >"$T/hb_mode"
echo 0 >"$T/health_rc"
rc=0
deploy aaa111 || rc=$?
check "first deploy exits 0" test "$rc" -eq 0
check "current_tag = aaa111" test "$(state current_tag)" = aaa111
check "IMAGE_TAG and GIT_SHA persisted in .env" test "$(envv IMAGE_TAG)/$(envv GIT_SHA)" = aaa111/aaa111
check ".env keeps mode 600" test "$(stat -c %a "$ENV")" = 600
check ".env has one IMAGE_TAG line" test "$(grep -c '^IMAGE_TAG=' "$ENV")" -eq 1
check "migrations ran before up" bash -c "grep -n 'migrate.ts\|up -d web worker' '$T/docker.log' | head -n 1 | grep -q migrate.ts"

# 2. new tag, but only the old worker's heartbeat is there (new worker crash-loops): health
#    alone would be 200, deploy must still fail and bring aaa111 back
echo stale >"$T/hb_mode"
rc=0
deploy bbb222 || rc=$?
check "stale heartbeat: deploy exits 1" test "$rc" -eq 1
check "stale heartbeat: current_tag stays aaa111" test "$(state current_tag)" = aaa111
check "stale heartbeat: last up is aaa111 (auto-rollback)" test "$(last_up_tag)" = aaa111
check "stale heartbeat: .env back to aaa111" test "$(envv IMAGE_TAG)" = aaa111

# 3. health 503 with a fresh heartbeat also fails
echo fresh >"$T/hb_mode"
echo 1 >"$T/health_rc"
rc=0
deploy bbb222 || rc=$?
check "health 503: deploy exits 1" test "$rc" -eq 1
check "health 503: current_tag stays aaa111" test "$(state current_tag)" = aaa111

# 4. good second deploy, then rollback
echo 0 >"$T/health_rc"
rc=0
deploy bbb222 || rc=$?
check "second deploy exits 0" test "$rc" -eq 0
check "prev_tag = aaa111, current_tag = bbb222" test "$(state prev_tag)/$(state current_tag)" = aaa111/bbb222
rc=0
deploy rollback || rc=$?
check "rollback exits 0" test "$rc" -eq 0
check "after rollback current = aaa111, prev = bbb222" test "$(state current_tag)/$(state prev_tag)" = aaa111/bbb222
check "after rollback .env IMAGE_TAG = aaa111" test "$(envv IMAGE_TAG)" = aaa111
check "rollback runs no migrations" bash -c "! tail -n 6 '$T/docker.log' | grep -q migrate.ts"

# 5. DRY_RUN changes nothing
cp "$ENV" "$T/env.before"
lines_before="$(wc -l <"$T/docker.log")"
rc=0
DRY_RUN=1 deploy ccc333 || rc=$?
check "DRY_RUN exits 0" test "$rc" -eq 0
check "DRY_RUN leaves .env untouched" cmp -s "$ENV" "$T/env.before"
check "DRY_RUN does not call docker" test "$(wc -l <"$T/docker.log")" -eq "$lines_before"
check "DRY_RUN keeps current_tag" test "$(state current_tag)" = aaa111

# 6. preflight: default Postgres password refuses to deploy before any docker call
sed -i 's/^POSTGRES_PASSWORD=.*/POSTGRES_PASSWORD=detaly/' "$ENV"
rc=0
deploy ddd444 || rc=$?
check "preflight rejects default POSTGRES_PASSWORD" test "$rc" -eq 1
check "preflight: no docker calls" test "$(wc -l <"$T/docker.log")" -eq "$lines_before"
sed -i 's/^POSTGRES_PASSWORD=.*/POSTGRES_PASSWORD=p@ss:word/' "$ENV"
rc=0
deploy ddd444 || rc=$?
check "preflight rejects a POSTGRES_PASSWORD that breaks the URL" test "$rc" -eq 1
write_env
sed -i 's/^S3_BUCKET=.*/S3_BUCKET=/' "$ENV"
rc=0
deploy ddd444 || rc=$?
check "preflight rejects empty S3_BUCKET" test "$rc" -eq 1
echo 'BACKUP_STORAGE=local' >>"$ENV"
rc=0
deploy ddd444 || rc=$?
check "BACKUP_STORAGE=local does not need S3_*" test "$rc" -eq 0

# 7. invalid tag
rc=0
deploy 'bad tag;rm' || rc=$?
check "invalid tag is rejected" test "$rc" -eq 1

# 8. stage refuses the production bot token
write_env
printf 'TG_SELLER_BOT_TOKEN=prod-token\n' >"$T/root/.env.stage"
rc=0
deploy stage eee555 || rc=$?
check "stage with the production bot token is refused" test "$rc" -eq 1
printf 'TG_SELLER_BOT_TOKEN=\n' >"$T/root/.env.stage"
rc=0
deploy stage eee555 || rc=$?
check "stage up exits 0" test "$rc" -eq 0
check "stage tag persisted as STAGE_IMAGE_TAG" test "$(envv STAGE_IMAGE_TAG)" = eee555
check "stage keeps the production IMAGE_TAG" test "$(envv IMAGE_TAG)" = latest

if ((fails > 0)); then
  echo "--- deploy.sh output ---"
  cat "$T/out.log"
  echo "$fails case(s) failed"
  exit 1
fi
echo "deploy.sh: all cases passed"
