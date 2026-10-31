-- Phase 7: meeting search (Postgres full-text search). Expression GIN indexes only: no new columns, no triggers,
-- no policy changes. Queries run as meetops_app under the existing forced RLS of each table, so a search can only
-- ever see the current organization's rows. The expressions here must match the API search query exactly
-- (apps/api/src/modules/search/prisma.repository.ts), with the 'english' config as an explicit regconfig so the
-- expression is IMMUTABLE.

CREATE INDEX "meetings_search_fts_idx" ON "meetings"
  USING GIN (to_tsvector('english'::regconfig, coalesce("title", '') || ' ' || coalesce("description", '')));

CREATE INDEX "transcript_segments_search_fts_idx" ON "transcript_segments"
  USING GIN (to_tsvector('english'::regconfig, "text"));

CREATE INDEX "reports_search_fts_idx" ON "reports"
  USING GIN (to_tsvector('english'::regconfig, coalesce("title", '') || ' ' || coalesce("summary", '')));

CREATE INDEX "tasks_search_fts_idx" ON "tasks"
  USING GIN (to_tsvector('english'::regconfig, coalesce("title", '') || ' ' || coalesce("description", '')));
