-- ADR-010: the canonical RLS session variable is app.current_organization_id.
-- For one minor version, policies fall back to the legacy app.current_org_id so code written before ADR-010
-- (which sets only the legacy GUC) keeps working. runWithOrganizationContext sets both to the same value.
-- Fail-closed is unchanged: if neither GUC is set (or both are ''), the expression is NULL and no rows match.
-- Only policies are recreated: no columns, data, FKs or indexes change (org_id stays, see ADR-010 section 2).

DROP POLICY IF EXISTS tenant_isolation ON "memberships";
CREATE POLICY tenant_isolation ON "memberships"
  USING (org_id = COALESCE(NULLIF(current_setting('app.current_organization_id', true), ''), NULLIF(current_setting('app.current_org_id', true), ''))::uuid)
  WITH CHECK (org_id = COALESCE(NULLIF(current_setting('app.current_organization_id', true), ''), NULLIF(current_setting('app.current_org_id', true), ''))::uuid);

DROP POLICY IF EXISTS tenant_isolation ON "invitations";
CREATE POLICY tenant_isolation ON "invitations"
  USING (org_id = COALESCE(NULLIF(current_setting('app.current_organization_id', true), ''), NULLIF(current_setting('app.current_org_id', true), ''))::uuid)
  WITH CHECK (org_id = COALESCE(NULLIF(current_setting('app.current_organization_id', true), ''), NULLIF(current_setting('app.current_org_id', true), ''))::uuid);

DROP POLICY IF EXISTS tenant_isolation ON "employees";
CREATE POLICY tenant_isolation ON "employees"
  USING (org_id = COALESCE(NULLIF(current_setting('app.current_organization_id', true), ''), NULLIF(current_setting('app.current_org_id', true), ''))::uuid)
  WITH CHECK (org_id = COALESCE(NULLIF(current_setting('app.current_organization_id', true), ''), NULLIF(current_setting('app.current_org_id', true), ''))::uuid);

DROP POLICY IF EXISTS tenant_isolation ON "projects";
CREATE POLICY tenant_isolation ON "projects"
  USING (org_id = COALESCE(NULLIF(current_setting('app.current_organization_id', true), ''), NULLIF(current_setting('app.current_org_id', true), ''))::uuid)
  WITH CHECK (org_id = COALESCE(NULLIF(current_setting('app.current_organization_id', true), ''), NULLIF(current_setting('app.current_org_id', true), ''))::uuid);

DROP POLICY IF EXISTS tenant_isolation ON "meetings";
CREATE POLICY tenant_isolation ON "meetings"
  USING (org_id = COALESCE(NULLIF(current_setting('app.current_organization_id', true), ''), NULLIF(current_setting('app.current_org_id', true), ''))::uuid)
  WITH CHECK (org_id = COALESCE(NULLIF(current_setting('app.current_organization_id', true), ''), NULLIF(current_setting('app.current_org_id', true), ''))::uuid);

DROP POLICY IF EXISTS tenant_isolation ON "meeting_participants";
CREATE POLICY tenant_isolation ON "meeting_participants"
  USING (org_id = COALESCE(NULLIF(current_setting('app.current_organization_id', true), ''), NULLIF(current_setting('app.current_org_id', true), ''))::uuid)
  WITH CHECK (org_id = COALESCE(NULLIF(current_setting('app.current_organization_id', true), ''), NULLIF(current_setting('app.current_org_id', true), ''))::uuid);

DROP POLICY IF EXISTS tenant_isolation ON "file_objects";
CREATE POLICY tenant_isolation ON "file_objects"
  USING (org_id = COALESCE(NULLIF(current_setting('app.current_organization_id', true), ''), NULLIF(current_setting('app.current_org_id', true), ''))::uuid)
  WITH CHECK (org_id = COALESCE(NULLIF(current_setting('app.current_organization_id', true), ''), NULLIF(current_setting('app.current_org_id', true), ''))::uuid);

DROP POLICY IF EXISTS tenant_isolation ON "transcripts";
CREATE POLICY tenant_isolation ON "transcripts"
  USING (org_id = COALESCE(NULLIF(current_setting('app.current_organization_id', true), ''), NULLIF(current_setting('app.current_org_id', true), ''))::uuid)
  WITH CHECK (org_id = COALESCE(NULLIF(current_setting('app.current_organization_id', true), ''), NULLIF(current_setting('app.current_org_id', true), ''))::uuid);

DROP POLICY IF EXISTS tenant_isolation ON "transcript_segments";
CREATE POLICY tenant_isolation ON "transcript_segments"
  USING (org_id = COALESCE(NULLIF(current_setting('app.current_organization_id', true), ''), NULLIF(current_setting('app.current_org_id', true), ''))::uuid)
  WITH CHECK (org_id = COALESCE(NULLIF(current_setting('app.current_organization_id', true), ''), NULLIF(current_setting('app.current_org_id', true), ''))::uuid);

DROP POLICY IF EXISTS tenant_isolation ON "reports";
CREATE POLICY tenant_isolation ON "reports"
  USING (org_id = COALESCE(NULLIF(current_setting('app.current_organization_id', true), ''), NULLIF(current_setting('app.current_org_id', true), ''))::uuid)
  WITH CHECK (org_id = COALESCE(NULLIF(current_setting('app.current_organization_id', true), ''), NULLIF(current_setting('app.current_org_id', true), ''))::uuid);

DROP POLICY IF EXISTS tenant_isolation ON "extracted_tasks";
CREATE POLICY tenant_isolation ON "extracted_tasks"
  USING (org_id = COALESCE(NULLIF(current_setting('app.current_organization_id', true), ''), NULLIF(current_setting('app.current_org_id', true), ''))::uuid)
  WITH CHECK (org_id = COALESCE(NULLIF(current_setting('app.current_organization_id', true), ''), NULLIF(current_setting('app.current_org_id', true), ''))::uuid);

DROP POLICY IF EXISTS tenant_isolation ON "task_approvals";
CREATE POLICY tenant_isolation ON "task_approvals"
  USING (org_id = COALESCE(NULLIF(current_setting('app.current_organization_id', true), ''), NULLIF(current_setting('app.current_org_id', true), ''))::uuid)
  WITH CHECK (org_id = COALESCE(NULLIF(current_setting('app.current_organization_id', true), ''), NULLIF(current_setting('app.current_org_id', true), ''))::uuid);

DROP POLICY IF EXISTS tenant_isolation ON "tasks";
CREATE POLICY tenant_isolation ON "tasks"
  USING (org_id = COALESCE(NULLIF(current_setting('app.current_organization_id', true), ''), NULLIF(current_setting('app.current_org_id', true), ''))::uuid)
  WITH CHECK (org_id = COALESCE(NULLIF(current_setting('app.current_organization_id', true), ''), NULLIF(current_setting('app.current_org_id', true), ''))::uuid);

DROP POLICY IF EXISTS tenant_isolation ON "integration_issues";
CREATE POLICY tenant_isolation ON "integration_issues"
  USING (org_id = COALESCE(NULLIF(current_setting('app.current_organization_id', true), ''), NULLIF(current_setting('app.current_org_id', true), ''))::uuid)
  WITH CHECK (org_id = COALESCE(NULLIF(current_setting('app.current_organization_id', true), ''), NULLIF(current_setting('app.current_org_id', true), ''))::uuid);

DROP POLICY IF EXISTS tenant_isolation ON "ai_runs";
CREATE POLICY tenant_isolation ON "ai_runs"
  USING (org_id = COALESCE(NULLIF(current_setting('app.current_organization_id', true), ''), NULLIF(current_setting('app.current_org_id', true), ''))::uuid)
  WITH CHECK (org_id = COALESCE(NULLIF(current_setting('app.current_organization_id', true), ''), NULLIF(current_setting('app.current_org_id', true), ''))::uuid);

DROP POLICY IF EXISTS tenant_isolation ON "outbox_events";
CREATE POLICY tenant_isolation ON "outbox_events"
  USING (org_id = COALESCE(NULLIF(current_setting('app.current_organization_id', true), ''), NULLIF(current_setting('app.current_org_id', true), ''))::uuid)
  WITH CHECK (org_id = COALESCE(NULLIF(current_setting('app.current_organization_id', true), ''), NULLIF(current_setting('app.current_org_id', true), ''))::uuid);

DROP POLICY IF EXISTS tenant_isolation ON "recordings";
CREATE POLICY tenant_isolation ON "recordings"
  USING (org_id = COALESCE(NULLIF(current_setting('app.current_organization_id', true), ''), NULLIF(current_setting('app.current_org_id', true), ''))::uuid)
  WITH CHECK (org_id = COALESCE(NULLIF(current_setting('app.current_organization_id', true), ''), NULLIF(current_setting('app.current_org_id', true), ''))::uuid);

DROP POLICY IF EXISTS tenant_isolation ON "recording_sessions";
CREATE POLICY tenant_isolation ON "recording_sessions"
  USING (org_id = COALESCE(NULLIF(current_setting('app.current_organization_id', true), ''), NULLIF(current_setting('app.current_org_id', true), ''))::uuid)
  WITH CHECK (org_id = COALESCE(NULLIF(current_setting('app.current_organization_id', true), ''), NULLIF(current_setting('app.current_org_id', true), ''))::uuid);

DROP POLICY IF EXISTS tenant_isolation ON "recording_session_chunks";
CREATE POLICY tenant_isolation ON "recording_session_chunks"
  USING (org_id = COALESCE(NULLIF(current_setting('app.current_organization_id', true), ''), NULLIF(current_setting('app.current_org_id', true), ''))::uuid)
  WITH CHECK (org_id = COALESCE(NULLIF(current_setting('app.current_organization_id', true), ''), NULLIF(current_setting('app.current_org_id', true), ''))::uuid);

-- audit_events: org events are readable and insertable only in-org (global events go via record_global_auth_event).
DROP POLICY IF EXISTS audit_read_own_org ON "audit_events";
CREATE POLICY audit_read_own_org ON "audit_events" FOR SELECT
  USING (org_id = COALESCE(NULLIF(current_setting('app.current_organization_id', true), ''), NULLIF(current_setting('app.current_org_id', true), ''))::uuid);
DROP POLICY IF EXISTS audit_insert ON "audit_events";
CREATE POLICY audit_insert ON "audit_events" FOR INSERT
  WITH CHECK (org_id = COALESCE(NULLIF(current_setting('app.current_organization_id', true), ''), NULLIF(current_setting('app.current_org_id', true), ''))::uuid);
