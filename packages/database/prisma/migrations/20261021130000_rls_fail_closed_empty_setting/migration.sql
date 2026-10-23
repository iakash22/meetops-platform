-- Fix found in live verification (XT-28): after a transaction-local set_config() ends, Postgres
-- resets the custom GUC to '' (not NULL) on that pooled connection, so ''::uuid raised 22P02 instead
-- of returning 0 rows. NULLIF(..., '') keeps the policies fail-closed (NULL => no rows) in both cases.

DROP POLICY IF EXISTS tenant_isolation ON "memberships";
CREATE POLICY tenant_isolation ON "memberships"
  USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);

DROP POLICY IF EXISTS tenant_isolation ON "invitations";
CREATE POLICY tenant_isolation ON "invitations"
  USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);

DROP POLICY IF EXISTS tenant_isolation ON "employees";
CREATE POLICY tenant_isolation ON "employees"
  USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);

DROP POLICY IF EXISTS tenant_isolation ON "projects";
CREATE POLICY tenant_isolation ON "projects"
  USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);

DROP POLICY IF EXISTS tenant_isolation ON "meetings";
CREATE POLICY tenant_isolation ON "meetings"
  USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);

DROP POLICY IF EXISTS tenant_isolation ON "meeting_participants";
CREATE POLICY tenant_isolation ON "meeting_participants"
  USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);

DROP POLICY IF EXISTS tenant_isolation ON "file_objects";
CREATE POLICY tenant_isolation ON "file_objects"
  USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);

DROP POLICY IF EXISTS tenant_isolation ON "transcripts";
CREATE POLICY tenant_isolation ON "transcripts"
  USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);

DROP POLICY IF EXISTS tenant_isolation ON "transcript_segments";
CREATE POLICY tenant_isolation ON "transcript_segments"
  USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);

DROP POLICY IF EXISTS tenant_isolation ON "reports";
CREATE POLICY tenant_isolation ON "reports"
  USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);

DROP POLICY IF EXISTS tenant_isolation ON "extracted_tasks";
CREATE POLICY tenant_isolation ON "extracted_tasks"
  USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);

DROP POLICY IF EXISTS tenant_isolation ON "task_approvals";
CREATE POLICY tenant_isolation ON "task_approvals"
  USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);

DROP POLICY IF EXISTS tenant_isolation ON "tasks";
CREATE POLICY tenant_isolation ON "tasks"
  USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);

DROP POLICY IF EXISTS tenant_isolation ON "integration_issues";
CREATE POLICY tenant_isolation ON "integration_issues"
  USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);

DROP POLICY IF EXISTS tenant_isolation ON "ai_runs";
CREATE POLICY tenant_isolation ON "ai_runs"
  USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);

DROP POLICY IF EXISTS tenant_isolation ON "outbox_events";
CREATE POLICY tenant_isolation ON "outbox_events"
  USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);

DROP POLICY IF EXISTS tenant_isolation ON "audit_events";
CREATE POLICY tenant_isolation ON "audit_events"
  USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);

DROP POLICY IF EXISTS tenant_isolation ON "recordings";
CREATE POLICY tenant_isolation ON "recordings"
  USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);

DROP POLICY IF EXISTS membership_self_read ON "memberships";
CREATE POLICY membership_self_read ON "memberships" FOR SELECT
  USING (user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid);
