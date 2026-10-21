-- Bootstrap for local/CI databases. Run ONCE as a superuser (e.g. postgres) against the
-- maintenance DB:  psql -v migrator_pw=... -v app_pw=... -v relay_pw=... -f bootstrap-roles.sql
-- Production provisioning is owned by infra; this mirrors it for dev/CI only.
\set ON_ERROR_STOP on
SELECT 'CREATE ROLE meetops_migrator' WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='meetops_migrator') \gexec
SELECT 'CREATE ROLE meetops_app' WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='meetops_app') \gexec
SELECT 'CREATE ROLE meetops_relay' WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='meetops_relay') \gexec
ALTER ROLE meetops_migrator LOGIN NOSUPERUSER NOBYPASSRLS CREATEDB PASSWORD :'migrator_pw';
ALTER ROLE meetops_app LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE PASSWORD :'app_pw';
ALTER ROLE meetops_relay LOGIN NOSUPERUSER BYPASSRLS NOCREATEDB NOCREATEROLE PASSWORD :'relay_pw';
SELECT 'CREATE DATABASE meetops OWNER meetops_migrator' WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname='meetops') \gexec
\connect meetops
-- pgvector is not a trusted extension: create it as superuser so the migration's IF NOT EXISTS is a no-op.
CREATE EXTENSION IF NOT EXISTS vector;
