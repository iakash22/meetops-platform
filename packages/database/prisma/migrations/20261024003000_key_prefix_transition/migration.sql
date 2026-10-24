-- ADR-010 phase A (2026-10-24): storage keys move from org/{organizationId}/ to organizations/{organizationId}/.
-- Both prefixes are accepted while the staging backfill runs. The organization segment must still equal org_id.
-- file_objects.storage_key has no prefix constraint, so this is the only one. Phase B, which rejects org/, is a
-- separate later migration.
ALTER TABLE "recording_session_chunks" DROP CONSTRAINT IF EXISTS "recording_session_chunks_key_check";
ALTER TABLE "recording_session_chunks"
  ADD CONSTRAINT "recording_session_chunks_key_check" CHECK (
    "storage_key" LIKE 'org/' || "org_id"::text || '/%'
    OR "storage_key" LIKE 'organizations/' || "org_id"::text || '/%'
  );
