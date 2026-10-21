-- Tenant isolation: roles, grants, and forced row level security.
-- Idempotent. Run as the schema owner (meetops_migrator via MIGRATION_DATABASE_URL).
-- Passwords/LOGIN for these roles are provisioned out of band (infra/secrets), never in migrations.

-- 1. Roles ---------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'meetops_migrator') THEN
    CREATE ROLE meetops_migrator NOLOGIN NOSUPERUSER NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'meetops_app') THEN
    CREATE ROLE meetops_app NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
  END IF;
END
$$;
ALTER ROLE meetops_app NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;

-- 2. Ownership: schema objects belong to meetops_migrator (best effort when the
--    migration runs as another role that is allowed to hand objects over).
DO $$
DECLARE r record;
BEGIN
  IF current_user <> 'meetops_migrator' AND pg_has_role(current_user, 'meetops_migrator', 'MEMBER') THEN
    FOR r IN SELECT tablename FROM pg_tables WHERE schemaname = current_schema() LOOP
      EXECUTE format('ALTER TABLE %I OWNER TO meetops_migrator', r.tablename);
    END LOOP;
  END IF;
END
$$;

-- 3. Grants: meetops_app gets DML only (no DDL, no TRUNCATE, no ownership).
DO $$
BEGIN
  EXECUTE format('GRANT USAGE ON SCHEMA %I TO meetops_app', current_schema());
  EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA %I TO meetops_app', current_schema());
  EXECUTE format('GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA %I TO meetops_app', current_schema());
  EXECUTE format('REVOKE CREATE ON SCHEMA %I FROM meetops_app', current_schema());
  IF pg_has_role(current_user, 'meetops_migrator', 'MEMBER') THEN
    EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE meetops_migrator IN SCHEMA %I GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO meetops_app', current_schema());
    EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE meetops_migrator IN SCHEMA %I GRANT USAGE, SELECT ON SEQUENCES TO meetops_app', current_schema());
  END IF;
END
$$;
REVOKE ALL ON TABLE "_prisma_migrations" FROM meetops_app;

-- audit_events is append-only for the app role.
REVOKE UPDATE, DELETE ON TABLE "audit_events" FROM meetops_app;

-- 4. Forced RLS on every tenant table. Unset app.current_org_id => NULL => no rows (fail closed).

-- memberships
ALTER TABLE "memberships" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "memberships" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "memberships";
CREATE POLICY tenant_isolation ON "memberships"
  USING (org_id = current_setting('app.current_org_id', true)::uuid)
  WITH CHECK (org_id = current_setting('app.current_org_id', true)::uuid);

-- invitations
ALTER TABLE "invitations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "invitations" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "invitations";
CREATE POLICY tenant_isolation ON "invitations"
  USING (org_id = current_setting('app.current_org_id', true)::uuid)
  WITH CHECK (org_id = current_setting('app.current_org_id', true)::uuid);

-- employees
ALTER TABLE "employees" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "employees" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "employees";
CREATE POLICY tenant_isolation ON "employees"
  USING (org_id = current_setting('app.current_org_id', true)::uuid)
  WITH CHECK (org_id = current_setting('app.current_org_id', true)::uuid);

-- projects
ALTER TABLE "projects" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "projects" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "projects";
CREATE POLICY tenant_isolation ON "projects"
  USING (org_id = current_setting('app.current_org_id', true)::uuid)
  WITH CHECK (org_id = current_setting('app.current_org_id', true)::uuid);

-- meetings
ALTER TABLE "meetings" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "meetings" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "meetings";
CREATE POLICY tenant_isolation ON "meetings"
  USING (org_id = current_setting('app.current_org_id', true)::uuid)
  WITH CHECK (org_id = current_setting('app.current_org_id', true)::uuid);

-- meeting_participants
ALTER TABLE "meeting_participants" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "meeting_participants" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "meeting_participants";
CREATE POLICY tenant_isolation ON "meeting_participants"
  USING (org_id = current_setting('app.current_org_id', true)::uuid)
  WITH CHECK (org_id = current_setting('app.current_org_id', true)::uuid);

-- file_objects
ALTER TABLE "file_objects" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "file_objects" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "file_objects";
CREATE POLICY tenant_isolation ON "file_objects"
  USING (org_id = current_setting('app.current_org_id', true)::uuid)
  WITH CHECK (org_id = current_setting('app.current_org_id', true)::uuid);

-- transcripts
ALTER TABLE "transcripts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "transcripts" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "transcripts";
CREATE POLICY tenant_isolation ON "transcripts"
  USING (org_id = current_setting('app.current_org_id', true)::uuid)
  WITH CHECK (org_id = current_setting('app.current_org_id', true)::uuid);

-- transcript_segments
ALTER TABLE "transcript_segments" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "transcript_segments" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "transcript_segments";
CREATE POLICY tenant_isolation ON "transcript_segments"
  USING (org_id = current_setting('app.current_org_id', true)::uuid)
  WITH CHECK (org_id = current_setting('app.current_org_id', true)::uuid);

-- reports
ALTER TABLE "reports" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "reports" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "reports";
CREATE POLICY tenant_isolation ON "reports"
  USING (org_id = current_setting('app.current_org_id', true)::uuid)
  WITH CHECK (org_id = current_setting('app.current_org_id', true)::uuid);

-- extracted_tasks
ALTER TABLE "extracted_tasks" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "extracted_tasks" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "extracted_tasks";
CREATE POLICY tenant_isolation ON "extracted_tasks"
  USING (org_id = current_setting('app.current_org_id', true)::uuid)
  WITH CHECK (org_id = current_setting('app.current_org_id', true)::uuid);

-- task_approvals
ALTER TABLE "task_approvals" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "task_approvals" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "task_approvals";
CREATE POLICY tenant_isolation ON "task_approvals"
  USING (org_id = current_setting('app.current_org_id', true)::uuid)
  WITH CHECK (org_id = current_setting('app.current_org_id', true)::uuid);

-- internal_tasks
ALTER TABLE "internal_tasks" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "internal_tasks" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "internal_tasks";
CREATE POLICY tenant_isolation ON "internal_tasks"
  USING (org_id = current_setting('app.current_org_id', true)::uuid)
  WITH CHECK (org_id = current_setting('app.current_org_id', true)::uuid);

-- external_issue_links
ALTER TABLE "external_issue_links" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "external_issue_links" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "external_issue_links";
CREATE POLICY tenant_isolation ON "external_issue_links"
  USING (org_id = current_setting('app.current_org_id', true)::uuid)
  WITH CHECK (org_id = current_setting('app.current_org_id', true)::uuid);

-- ai_runs
ALTER TABLE "ai_runs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ai_runs" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "ai_runs";
CREATE POLICY tenant_isolation ON "ai_runs"
  USING (org_id = current_setting('app.current_org_id', true)::uuid)
  WITH CHECK (org_id = current_setting('app.current_org_id', true)::uuid);

-- outbox_events
ALTER TABLE "outbox_events" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "outbox_events" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "outbox_events";
CREATE POLICY tenant_isolation ON "outbox_events"
  USING (org_id = current_setting('app.current_org_id', true)::uuid)
  WITH CHECK (org_id = current_setting('app.current_org_id', true)::uuid);

-- audit_events
ALTER TABLE "audit_events" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "audit_events" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "audit_events";
CREATE POLICY tenant_isolation ON "audit_events"
  USING (org_id = current_setting('app.current_org_id', true)::uuid)
  WITH CHECK (org_id = current_setting('app.current_org_id', true)::uuid);

-- memberships: allow a user to list their own memberships before an org is chosen
-- (login / org switcher). Read-only; requires app.current_user_id set per transaction.
DROP POLICY IF EXISTS membership_self_read ON "memberships";
CREATE POLICY membership_self_read ON "memberships" FOR SELECT
  USING (user_id = current_setting('app.current_user_id', true)::uuid);
