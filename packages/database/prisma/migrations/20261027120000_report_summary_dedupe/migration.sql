-- Phase 3 AI summary dedupe: at most one report per (meeting, transcript, transcript revision, prompt version).
-- Additive only: two nullable columns + one unique index. Existing rows keep NULLs, and Postgres treats NULLs as
-- distinct in unique indexes, so manual/legacy reports (no transcript revision or prompt version) are unaffected.
-- reports already has forced RLS bound to org_id; new columns inherit it. Rollback: drop the index and columns.
ALTER TABLE "reports" ADD COLUMN "transcript_revision" INTEGER;
ALTER TABLE "reports" ADD COLUMN "prompt_version" TEXT;
ALTER TABLE "reports" ADD CONSTRAINT "reports_transcript_revision_check" CHECK ("transcript_revision" IS NULL OR "transcript_revision" >= 1);
CREATE UNIQUE INDEX "reports_summary_dedupe_key" ON "reports"("meeting_id", "transcript_id", "transcript_revision", "prompt_version");
