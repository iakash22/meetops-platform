-- Contracts: Transcript.recordingId is required. Link legacy NULL rows to their meeting's recording
-- when the meeting has exactly one; otherwise fail clearly (no guessing between several recordings).
ALTER TABLE "transcripts" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "recordings" NO FORCE ROW LEVEL SECURITY;
UPDATE "transcripts" t SET "recording_id" = r."id"
FROM (
  SELECT "org_id", "meeting_id", min("id"::text)::uuid AS "id"
  FROM "recordings" WHERE "deleted_at" IS NULL
  GROUP BY "org_id", "meeting_id" HAVING count(*) = 1
) r
WHERE t."recording_id" IS NULL AND r."org_id" = t."org_id" AND r."meeting_id" = t."meeting_id";
DO $$
DECLARE n bigint;
BEGIN
  SELECT count(*) INTO n FROM "transcripts" WHERE "recording_id" IS NULL;
  IF n > 0 THEN
    RAISE EXCEPTION 'transcripts.recording_id NOT NULL: % transcripts cannot be linked (meeting has no recording or more than one); set recording_id explicitly, then re-run migrate deploy', n;
  END IF;
END
$$;
ALTER TABLE "transcripts" ALTER COLUMN "recording_id" SET NOT NULL;
ALTER TABLE "transcripts" FORCE ROW LEVEL SECURITY;
ALTER TABLE "recordings" FORCE ROW LEVEL SECURITY;
