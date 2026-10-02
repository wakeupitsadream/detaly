# Backup and watchdog container: pg_dump 16 + age/gpg + rclone, driven by busybox crond.
#   30 2 * * *   backup.sh       encrypted dump to S3, 30-day retention, Telegram alert on failure
#   */5 * * * *  healthwatch.sh  worker heartbeat in Redis, Telegram alert when silent
# Build: docker build -t detaly-backup infra/backup
FROM alpine:3.22

RUN apk add --no-cache \
      bash \
      coreutils \
      findutils \
      ca-certificates \
      curl \
      tzdata \
      postgresql16-client \
      age \
      gnupg \
      rclone \
      redis

ENV TZ=Asia/Yekaterinburg \
    STORAGE=s3 \
    BACKUP_LOCAL_DIR=/backups

COPY lib.sh backup.sh restore.sh healthwatch.sh selftest.sh entrypoint.sh /usr/local/bin/
COPY crontab /etc/crontabs/root
RUN chmod 0755 /usr/local/bin/*.sh \
 && chmod 0600 /etc/crontabs/root \
 && mkdir -p /backups

VOLUME ["/backups"]
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
