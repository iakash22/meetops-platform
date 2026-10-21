-- Idempotent role + database bootstrap for local dev / CI. Run as a superuser.
-- Prefer the wrappers: scripts/create-db-roles.sh (Linux/macOS) or scripts/create-db-roles.ts (any OS).
-- Direct use: psql "$ADMIN_DATABASE_URL" -v app_pw=... -v migrator_pw=... -v relay_pw= -v db_name=meetops -f bootstrap-roles.sql
-- Empty relay_pw skips meetops_relay. Production provisioning is owned by infra.
\set ON_ERROR_STOP on
SELECT (:'app_pw' = '' OR :'migrator_pw' = '') AS missing_pw \gset
\if :missing_pw
  \echo 'app_pw and migrator_pw are required'
  SELECT 1/0;
\endif
SELECT 'CREATE ROLE meetops_migrator' WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'meetops_migrator') \gexec
SELECT 'CREATE ROLE meetops_app' WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'meetops_app') \gexec
SELECT 'CREATE ROLE meetops_relay' WHERE :'relay_pw' <> '' AND NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'meetops_relay') \gexec
SELECT format('ALTER ROLE meetops_migrator LOGIN NOSUPERUSER NOBYPASSRLS CREATEDB PASSWORD %L', :'migrator_pw') \gexec
SELECT format('ALTER ROLE meetops_app LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE PASSWORD %L', :'app_pw') \gexec
SELECT format('ALTER ROLE meetops_relay LOGIN NOSUPERUSER BYPASSRLS NOCREATEDB NOCREATEROLE PASSWORD %L', :'relay_pw') WHERE :'relay_pw' <> '' \gexec
SELECT format('CREATE DATABASE %I OWNER meetops_migrator', :'db_name') WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = :'db_name') \gexec
\connect :db_name
-- pgvector is not a trusted extension: create it as superuser so the migration's IF NOT EXISTS is a no-op.
CREATE EXTENSION IF NOT EXISTS vector;
