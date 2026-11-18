-- Per-chunk STT job id so every AssemblyAI (or other provider) copy can be deleted after our
-- chunk is stored. Follow-up to transcripts.provider_job_id on the revision-0 anchor (#513).
-- Nullable: legacy rows predate this column. PostgreSQL unique indexes allow many NULLs.

ALTER TABLE "transcript_chunks" ADD COLUMN "provider_job_id" TEXT;

-- Unique per organization + provider when a job id is present.
CREATE UNIQUE INDEX "transcript_chunks_org_id_provider_provider_job_id_key"
  ON "transcript_chunks"("org_id", "provider", "provider_job_id");

-- Lookup by stored job id when the delete worker re-reads the row (provider not required).
CREATE INDEX "transcript_chunks_org_id_provider_job_id_idx"
  ON "transcript_chunks"("org_id", "provider_job_id");

-- The table already had FORCE RLS (20261024010000). Re-assert so adding a column cannot weaken it.
ALTER TABLE "transcript_chunks" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "transcript_chunks" FORCE ROW LEVEL SECURITY;
