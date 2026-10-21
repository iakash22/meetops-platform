-- Contracts v0.2 (#38): integration_issues.integration_id + provider, unique (org_id, provider, external_id).
ALTER TABLE "integration_issues" ADD COLUMN "integration_id" UUID,
ADD COLUMN "provider" TEXT;
-- FORCE RLS binds the owner too; lift it for the backfill (re-forced below).
ALTER TABLE "integration_issues" NO FORCE ROW LEVEL SECURITY;
UPDATE "integration_issues" SET "provider" = lower("integration") WHERE "provider" IS NULL;
ALTER TABLE "integration_issues" FORCE ROW LEVEL SECURITY;
ALTER TABLE "integration_issues" ALTER COLUMN "provider" SET NOT NULL;
DROP INDEX IF EXISTS "integration_issues_org_id_integration_external_id_key";
CREATE UNIQUE INDEX "integration_issues_org_id_provider_external_id_key" ON "integration_issues"("org_id", "provider", "external_id");

-- Re-assert app privileges and FORCE RLS at the head of the chain (idempotent; works with roles
-- pre-created by infra/compose/postgres/initdb/10-meetops-roles.sh from DevOps PR #7).
DO $$
DECLARE r record;
BEGIN
  EXECUTE format('GRANT USAGE ON SCHEMA %I TO meetops_app', current_schema());
  EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA %I TO meetops_app', current_schema());
  EXECUTE format('GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA %I TO meetops_app', current_schema());
  IF pg_has_role(current_user, 'meetops_migrator', 'MEMBER') THEN
    EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE meetops_migrator IN SCHEMA %I GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO meetops_app', current_schema());
    EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE meetops_migrator IN SCHEMA %I GRANT USAGE, SELECT ON SEQUENCES TO meetops_app', current_schema());
  END IF;
  IF to_regclass('_prisma_migrations') IS NOT NULL THEN
    REVOKE ALL ON TABLE "_prisma_migrations" FROM meetops_app;
  END IF;
  FOR r IN SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
           WHERE n.nspname = current_schema() AND c.relkind = 'r' AND c.relrowsecurity LOOP
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', r.relname);
  END LOOP;
END
$$;
-- audit_events stays append-only for the app role.
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE "audit_events" FROM meetops_app;
