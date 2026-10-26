-- BE meetings module: idempotency key for POST /orgs/:organizationId/meetings/resolve.
-- Additive only: one nullable column, one unique index, one list index. Existing rows keep NULL
-- (Postgres treats NULLs as distinct, so uploads without an external id never collide).
-- meetings already has forced RLS (tenant_isolation); nothing to change there.

-- AlterTable
ALTER TABLE "meetings" ADD COLUMN "external_meeting_id" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "meetings_org_id_source_external_meeting_id_key" ON "meetings"("org_id", "source", "external_meeting_id");

-- CreateIndex
CREATE INDEX "meetings_org_id_created_at_id_idx" ON "meetings"("org_id", "created_at", "id");
