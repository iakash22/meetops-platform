-- transcripts.provider must be a contracts TranscriptProviderId: SttProviderId
-- ('assemblyai', 'faster-whisper', 'deepgram') plus 'unknown' (ADR-004 addendum 2, contracts #50).
-- 'unknown' exists ONLY for legacy rows backfilled by 20261022000000_adr004_addendum2. New rows (and
-- updates that change provider) must name a real STT provider: enforced by the trigger below.
-- There is no column default, so every insert must state its provider explicitly.
ALTER TABLE "transcripts" ADD CONSTRAINT "transcripts_provider_check"
  CHECK ("provider" IN ('assemblyai', 'faster-whisper', 'deepgram', 'unknown'));

CREATE OR REPLACE FUNCTION public.transcripts_reject_unknown_provider()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW.provider = 'unknown' AND (TG_OP = 'INSERT' OR OLD.provider IS DISTINCT FROM NEW.provider) THEN
    RAISE EXCEPTION 'transcripts.provider ''unknown'' is reserved for backfilled legacy rows; use a real SttProviderId'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION public.transcripts_reject_unknown_provider() FROM PUBLIC;

CREATE TRIGGER transcripts_reject_unknown_provider
  BEFORE INSERT OR UPDATE OF "provider" ON "transcripts"
  FOR EACH ROW EXECUTE FUNCTION public.transcripts_reject_unknown_provider();
