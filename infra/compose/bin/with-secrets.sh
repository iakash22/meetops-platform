#!/bin/sh
# Container entrypoint shim (dev compose): build connection URLs from
# /run/secrets/* so no password is set via compose env, then exec the app.
# DB_ROLE=app|migrator chooses the Postgres role. *_FILE pattern: the apps'
# config loader does not read *_FILE yet (Backend dependency), so we export here.
set -eu
s=/run/secrets
db="${POSTGRES_DB:?}"
if [ -r "$s/redis_password" ]; then
  export REDIS_URL="redis://:$(cat "$s/redis_password")@redis:6379"
fi
if [ -r "$s/minio_root_password" ]; then
  export STORAGE_SECRET_ACCESS_KEY="$(cat "$s/minio_root_password")"
fi
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
