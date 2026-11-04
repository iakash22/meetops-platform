-- Async task -> GitHub/Jira sync (TASK_SYNC_ENABLED, off by default). Additive only.
--
-- task_sync_jobs: one row per (task, integration). POST /orgs/:organizationId/tasks/:taskId/sync is idempotent on
-- it; the worker moves it queued -> creating -> succeeded | failed | needs_reconcile. A crash or an ambiguous provider
-- error after the create was sent ends in needs_reconcile (ADR-007: a non-idempotent create is never re-sent).
-- Tenant isolation is forced and fail-closed; the app role has no DELETE.

-- CreateTable
CREATE TABLE "task_sync_jobs" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "task_id" UUID NOT NULL,
    "integration_id" UUID NOT NULL,
    "approval_id" UUID NOT NULL,
    "provider" TEXT NOT NULL,
    "target" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "external_id" TEXT,
    "external_url" TEXT,
    "error_code" TEXT,
    "requested_by_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "task_sync_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "task_sync_jobs_org_id_status_idx" ON "task_sync_jobs"("org_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "task_sync_jobs_org_id_id_key" ON "task_sync_jobs"("org_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "task_sync_jobs_org_id_task_id_integration_id_key" ON "task_sync_jobs"("org_id", "task_id", "integration_id");

-- AddForeignKey
ALTER TABLE "task_sync_jobs" ADD CONSTRAINT "task_sync_jobs_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_sync_jobs" ADD CONSTRAINT "task_sync_jobs_org_id_task_id_fkey" FOREIGN KEY ("org_id", "task_id") REFERENCES "tasks"("org_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_sync_jobs" ADD CONSTRAINT "task_sync_jobs_org_id_integration_id_fkey" FOREIGN KEY ("org_id", "integration_id") REFERENCES "integration_connections"("org_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_sync_jobs" ADD CONSTRAINT "task_sync_jobs_org_id_approval_id_fkey" FOREIGN KEY ("org_id", "approval_id") REFERENCES "task_approvals"("org_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_sync_jobs" ADD CONSTRAINT "task_sync_jobs_requested_by_id_fkey" FOREIGN KEY ("requested_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Integrity checks.
ALTER TABLE "task_sync_jobs"
  ADD CONSTRAINT "task_sync_jobs_provider_check" CHECK ("provider" IN ('github', 'jira')),
  ADD CONSTRAINT "task_sync_jobs_status_check" CHECK ("status" IN ('queued', 'creating', 'succeeded', 'failed', 'needs_reconcile')),
  ADD CONSTRAINT "task_sync_jobs_attempts_check" CHECK ("attempts" >= 0),
  ADD CONSTRAINT "task_sync_jobs_target_check" CHECK (btrim("target") <> '' AND length("target") <= 255),
  ADD CONSTRAINT "task_sync_jobs_external_url_check" CHECK ("external_url" IS NULL OR "external_url" ~ '^https://'),
  ADD CONSTRAINT "task_sync_jobs_error_code_check" CHECK ("error_code" IS NULL OR length("error_code") <= 64),
  ADD CONSTRAINT "task_sync_jobs_succeeded_check" CHECK ("status" <> 'succeeded' OR "external_id" IS NOT NULL);

-- Tenant isolation, forced (canonical ADR-010 setting only; fail-closed when unset).
ALTER TABLE "task_sync_jobs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "task_sync_jobs" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "task_sync_jobs"
  USING (org_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid);
REVOKE DELETE, TRUNCATE ON TABLE "task_sync_jobs" FROM meetops_app;
GRANT SELECT, INSERT, UPDATE ON TABLE "task_sync_jobs" TO meetops_app;
