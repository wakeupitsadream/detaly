#!/bin/sh
# Backup container entrypoint.
#   no arguments  save the environment for cron jobs and run crond in the foreground
#   arguments     run them instead (docker compose run --rm backup restore.sh latest <url>)
set -eu

if [ "$#" -gt 0 ]; then
  exec "$@"
fi

# busybox crond starts jobs with an empty environment; keep the container's for them.
umask 077
export -p >/run/backup.env

if [ "${BACKUP_ON_START:-0}" = "1" ]; then
  /usr/local/bin/backup.sh || true
fi

exec crond -f -d 6
