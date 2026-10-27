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
SELECT format('ALTER ROLE meetops_relay LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE PASSWORD %L', :'relay_pw') WHERE :'relay_pw' <> '' \gexec
SELECT format('CREATE DATABASE %I OWNER meetops_migrator', :'db_name') WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = :'db_name') \gexec
-- With compose.dev.yml the DB already exists (POSTGRES_DB) owned by POSTGRES_USER: hand it to the migrator.
SELECT format('ALTER DATABASE %I OWNER TO meetops_migrator', :'db_name') \gexec
\connect :db_name
ALTER SCHEMA public OWNER TO meetops_migrator;
-- pgvector is not a trusted extension: create it as superuser so the migration's IF NOT EXISTS is a no-op.
CREATE EXTENSION IF NOT EXISTS vector;
DO $$
BEGIN
  -- Relay created after migrations ran (e.g. DevOps initdb only makes app/migrator): apply the
  -- same grants as migration 20261021120000 so the order of bootstrap vs migrate does not matter.
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'meetops_relay') AND to_regprocedure('public.relay_claim_outbox_events(integer)') IS NOT NULL THEN
    -- Relay uses only the definer functions (migration 20261022033000); no table privileges.
    GRANT USAGE ON SCHEMA public TO meetops_relay;
    REVOKE ALL ON ALL TABLES IN SCHEMA public FROM meetops_relay;
    GRANT EXECUTE ON FUNCTION public.relay_claim_outbox_events(integer) TO meetops_relay;
    GRANT EXECUTE ON FUNCTION public.relay_complete_outbox_event(uuid, boolean, text, timestamptz) TO meetops_relay;
    IF to_regprocedure('public.relay_claim_outbox_events(integer, text[])') IS NOT NULL THEN
      GRANT EXECUTE ON FUNCTION public.relay_claim_outbox_events(integer, text[]) TO meetops_relay;
    END IF;
  END IF;
END
$$;
