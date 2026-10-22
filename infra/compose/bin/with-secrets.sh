#!/bin/sh
# Container entrypoint shim (dev compose): build connection URLs from
# /run/secrets/* so no password is set via compose env, then exec the app.
# DB_ROLE=app|migrator chooses the Postgres role. *_FILE pattern: the apps'
# config loader does not read *_FILE yet (Backend dependency), so we export here.
set -eu
s=/run/secrets
db="${MEETOPS_DB_NAME:?}"
if [ -r "$s/redis_password" ]; then
  export REDIS_URL="redis://:$(cat "$s/redis_password")@redis:6379"
fi
# Scoped app user (bucket-only policy); the MinIO root password is never mounted here.
if [ -r "$s/minio_app_password" ]; then
  export STORAGE_SECRET_ACCESS_KEY="$(cat "$s/minio_app_password")"
fi
# Optional app secrets: exported only when the secret file is mounted and non-empty.
for pair in csrf_secret:CSRF_SECRET smtp_password:SMTP_PASSWORD \
  gemini_api_key:GEMINI_API_KEY assemblyai_api_key:ASSEMBLYAI_API_KEY \
  openai_api_key:OPENAI_API_KEY deepgram_api_key:DEEPGRAM_API_KEY; do
  f="$s/${pair%%:*}"
  if [ -s "$f" ]; then export "${pair#*:}=$(cat "$f")"; fi
done
case "${DB_ROLE:-app}" in
  app)
    if [ -r "$s/meetops_app_db_password" ]; then
      export DATABASE_URL="postgresql://meetops_app:$(cat "$s/meetops_app_db_password")@postgres:5432/$db"
    fi
    export MIGRATION_DATABASE_URL=""
    ;;
  migrator)
    if [ -r "$s/meetops_migrator_db_password" ]; then
      export MIGRATION_DATABASE_URL="postgresql://meetops_migrator:$(cat "$s/meetops_migrator_db_password")@postgres:5432/$db"
      export DATABASE_URL="$MIGRATION_DATABASE_URL"
    fi
    ;;
  none) export DATABASE_URL="" MIGRATION_DATABASE_URL="" ;;
esac
exec "$@"
