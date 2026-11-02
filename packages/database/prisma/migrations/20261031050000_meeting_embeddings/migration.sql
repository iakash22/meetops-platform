-- Phase 7: semantic search over meeting content (pgvector). Additive only. Off unless SEMANTIC_SEARCH_ENABLED=true.
--
-- meeting_embeddings: one vector per embedded source (a transcript segment or a summary report) and model. The text
-- itself is NOT copied here: search joins back to transcript_segments / reports, so deleting the source (or the
-- meeting) removes the embedding through the composite tenant FKs. The vector extension is already enabled by the
-- initial migration; IF NOT EXISTS keeps this idempotent.
--
-- No ANN (HNSW/IVFFlat) index on purpose: an index-ordered scan would rank across all tenants and filter org_id
-- afterwards. Queries select the organization's rows first (btree on org_id, model) and order only those.

CREATE EXTENSION IF NOT EXISTS "vector";

-- CreateTable
CREATE TABLE "meeting_embeddings" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "meeting_id" UUID NOT NULL,
    "source_kind" TEXT NOT NULL,
    "segment_id" UUID,
    "report_id" UUID,
    "model" TEXT NOT NULL,
    "content_sha256" TEXT NOT NULL,
    "embedding" vector(1536) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "meeting_embeddings_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "meeting_embeddings_org_id_id_key" ON "meeting_embeddings"("org_id", "id");
CREATE UNIQUE INDEX "meeting_embeddings_org_id_segment_id_model_key" ON "meeting_embeddings"("org_id", "segment_id", "model");
CREATE UNIQUE INDEX "meeting_embeddings_org_id_report_id_model_key" ON "meeting_embeddings"("org_id", "report_id", "model");
CREATE INDEX "meeting_embeddings_org_id_model_idx" ON "meeting_embeddings"("org_id", "model");
CREATE INDEX "meeting_embeddings_org_id_meeting_id_idx" ON "meeting_embeddings"("org_id", "meeting_id");

ALTER TABLE "meeting_embeddings" ADD CONSTRAINT "meeting_embeddings_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "meeting_embeddings" ADD CONSTRAINT "meeting_embeddings_org_id_meeting_id_fkey" FOREIGN KEY ("org_id", "meeting_id") REFERENCES "meetings"("org_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "meeting_embeddings" ADD CONSTRAINT "meeting_embeddings_org_id_segment_id_fkey" FOREIGN KEY ("org_id", "segment_id") REFERENCES "transcript_segments"("org_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "meeting_embeddings" ADD CONSTRAINT "meeting_embeddings_org_id_report_id_fkey" FOREIGN KEY ("org_id", "report_id") REFERENCES "reports"("org_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "meeting_embeddings"
  ADD CONSTRAINT "meeting_embeddings_source_check" CHECK (
    ("source_kind" = 'transcript_segment' AND "segment_id" IS NOT NULL AND "report_id" IS NULL) OR
    ("source_kind" = 'summary' AND "report_id" IS NOT NULL AND "segment_id" IS NULL)),
  ADD CONSTRAINT "meeting_embeddings_model_check" CHECK (btrim("model") <> '' AND length("model") <= 200),
  ADD CONSTRAINT "meeting_embeddings_content_sha256_check" CHECK ("content_sha256" ~ '^[0-9a-f]{64}$');

-- Tenant isolation, forced (canonical ADR-010 setting only; fail-closed when unset).
ALTER TABLE "meeting_embeddings" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "meeting_embeddings" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "meeting_embeddings"
  USING (org_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid);
REVOKE TRUNCATE ON TABLE "meeting_embeddings" FROM meetops_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "meeting_embeddings" TO meetops_app;

DO $$
DECLARE bad text;
BEGIN
  SELECT string_agg(c.relname, ', ' ORDER BY c.relname) INTO bad
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = current_schema() AND c.relkind = 'r' AND c.relrowsecurity AND NOT c.relforcerowsecurity;
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'RLS enabled but not forced on: %', bad;
  END IF;
END $$;
