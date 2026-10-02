#!/bin/sh
# Backup container entrypoint.
#   no arguments  save the environment for cron jobs and run crond in the foreground
#   arguments     run them instead (docker compose run --rm backup restore.sh latest <url>)
set -eu

if [ "$#" -gt 0 ]; then
  exec "$@"
fi

# busybox crond starts jobs with an empty environment; keep the container's for them, but only
# the variables the scripts read (compose passes an allowlist too; this is the second line).
umask 077
export -p |
  grep -E "^export (TZ|PATH|LANG|STORAGE|DATABASE_URL|REDIS_URL|BACKUP_[A-Z0-9_]*|S3_[A-Z0-9_]*|RCLONE_[A-Z0-9_]*|TG_SELLER_BOT_TOKEN|TG_SELLER_CHAT_ID|TG_API_BASE|BRAND_NAME|HEARTBEAT_[A-Z0-9_]*|HEALTHWATCH_[A-Z0-9_]*)=" \
    >/run/backup.env || true

if [ "${BACKUP_ON_START:-0}" = "1" ]; then
  /usr/local/bin/backup.sh || true
fi

exec crond -f -d 6
