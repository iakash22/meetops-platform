-- Phase 3: transcripts are revised per recording, not per meeting.
-- A meeting can hold several recordings, each with its own revision sequence (ai-core TranscriptRevision.revision),
-- so the unique key moves from (meeting_id, revision) to (recording_id, revision). Revision 0 is the per-recording
-- anchor row that owns transcript_chunks; revisions >= 1 are merged transcripts with segments.
-- merge_state holds ai-core's opaque merge state (content hash, chunk indexes, speaker map). No text beyond what
-- full_text/segments already store; no secrets.
DROP INDEX IF EXISTS "transcripts_meeting_id_revision_key";
CREATE UNIQUE INDEX "transcripts_recording_id_revision_key" ON "transcripts"("recording_id", "revision");
ALTER TABLE "transcripts" ADD COLUMN "merge_state" JSONB;
ALTER TABLE "transcripts"
  ADD CONSTRAINT "transcripts_revision_nonnegative_check" CHECK ("revision" >= 0);
