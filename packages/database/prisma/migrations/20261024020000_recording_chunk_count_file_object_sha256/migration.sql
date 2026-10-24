-- Media PR #92: STT chunk count per recording, and chunk FileObject rows written by the media worker.
-- Additive only. recordings RLS (org_id) already applies, so no new policy is needed.

-- AlterTable
ALTER TABLE "recordings" ADD COLUMN "chunk_count" INTEGER;
ALTER TABLE "recordings" ADD CONSTRAINT "recordings_chunk_count_check"
  CHECK ("chunk_count" IS NULL OR ("chunk_count" >= 1 AND "chunk_count" <= 10000));

-- file_objects.checksum_sha256 is lowercase hex (64 chars), as sent by Media. NOT VALID: enforced for new and
-- updated rows only, so legacy rows (e.g. the old 'demo-checksum' seed value) do not block the migration.
-- Run "ALTER TABLE file_objects VALIDATE CONSTRAINT file_objects_checksum_sha256_check" after cleanup.
ALTER TABLE "file_objects" ADD CONSTRAINT "file_objects_checksum_sha256_check"
  CHECK ("checksum_sha256" IS NULL OR "checksum_sha256" ~ '^[0-9a-f]{64}$') NOT VALID;

-- Chunk FileObject lookup by (org, meeting, kind) already has an index; chunk rows are fetched by id.
