#!/bin/sh
# First-boot only (empty volume): login roles for PR #25's RLS model.
#   meetops_migrator  schema owner, used by `migrate` via MIGRATION_DATABASE_URL
#   meetops_app       runtime role (NOSUPERUSER, NOBYPASSRLS) for api/worker DATABASE_URL
# The #25 migration's CREATE ROLE IF NOT EXISTS then no-ops and only grants DML.
# Passwords come from env (placeholders in .env.example); nothing is hardcoded.
set -eu
: "${MEETOPS_MIGRATOR_DB_PASSWORD:?}" "${MEETOPS_APP_DB_PASSWORD:?}"
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  -v migrator_pw="$MEETOPS_MIGRATOR_DB_PASSWORD" -v app_pw="$MEETOPS_APP_DB_PASSWORD" <<'SQL'
SELECT format('CREATE ROLE meetops_migrator LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD %L', :'migrator_pw')
  WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'meetops_migrator') \gexec
SELECT format('CREATE ROLE meetops_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS PASSWORD %L', :'app_pw')
  WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'meetops_app') \gexec
-- pgvector needs superuser to install; do it here so migrations don't have to.
CREATE EXTENSION IF NOT EXISTS vector;
SELECT format('ALTER DATABASE %I OWNER TO meetops_migrator', current_database()) \gexec
ALTER SCHEMA public OWNER TO meetops_migrator;
SELECT format('GRANT CONNECT ON DATABASE %I TO meetops_app', current_database()) \gexec
GRANT USAGE ON SCHEMA public TO meetops_app;
SQL
