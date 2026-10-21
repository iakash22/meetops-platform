#!/usr/bin/env sh
# Idempotently create/update the MeetOps LOGIN roles (and optionally the database) for local dev.
# Usage:
#   export ADMIN_DATABASE_URL=postgresql://postgres:<pw>@localhost:5432/postgres
#   export MEETOPS_APP_PASSWORD=... MEETOPS_MIGRATOR_PASSWORD=...   # required
#   export MEETOPS_RELAY_PASSWORD=...                               # optional (outbox relay)
#   export MEETOPS_DB_NAME=meetops                                  # optional
#   ./scripts/create-db-roles.sh
# Passwords are passed to psql as variables (never on the command line, never echoed).
set -eu
: "${ADMIN_DATABASE_URL:?ADMIN_DATABASE_URL is required (superuser connection)}"
: "${MEETOPS_APP_PASSWORD:?MEETOPS_APP_PASSWORD is required}"
: "${MEETOPS_MIGRATOR_PASSWORD:?MEETOPS_MIGRATOR_PASSWORD is required}"
PSQL="${PSQL:-psql}"
DIR="$(cd "$(dirname "$0")" && pwd)"
# Feed variables through stdin so they don't appear in `ps`.
{
  printf '\\set app_pw %s\n' "'$(printf %s "$MEETOPS_APP_PASSWORD" | sed "s/'/''/g")'"
  printf '\\set migrator_pw %s\n' "'$(printf %s "$MEETOPS_MIGRATOR_PASSWORD" | sed "s/'/''/g")'"
  printf '\\set relay_pw %s\n' "'$(printf %s "${MEETOPS_RELAY_PASSWORD:-}" | sed "s/'/''/g")'"
  printf '\\set db_name %s\n' "${MEETOPS_DB_NAME:-meetops}"
  cat "$DIR/bootstrap-roles.sql"
} | "$PSQL" "$ADMIN_DATABASE_URL" -q -X -v ON_ERROR_STOP=1 -f -
echo "MeetOps roles are up to date."
