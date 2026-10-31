-- P1-DB-4 (1) recording_sessions.bytes_received + add_recording_session_bytes()
--         (2) no new meetings index: listMeetingsPage() reuses meetings_org_id_created_at_id_idx
--             (20261026120000, btree on org_id, created_at, id; scanned backward for DESC order).
--
-- Byte counters on recording_sessions (kept separate on purpose):
--   total_bytes     sum of SIGNED chunk sizes (what upload URLs were issued for), set by the API.
--   bytes_received  sum of bytes the API has CONFIRMED received; only add_recording_session_bytes() moves it.
-- bytes_received is capped at the contract MAX_RECORDING_SESSION_BYTES = MAX_MEDIA_BYTES = 1_400_000_000 (contracts
-- constants.ts). The older recording_sessions_total_bytes_check still allows 2_000_000_000 (pre-1.4 GB contract);
-- tightening it is left to a separate migration. No cross-column CHECK is added:
-- the API does not maintain total_bytes yet, and a CHECK would make increments fail on every existing session.
-- recording_session_chunks.size_bytes stays per-chunk (1..64 MiB); the sum of chunk rows is not stored here.

ALTER TABLE "recording_sessions"
  ADD COLUMN "bytes_received" BIGINT NOT NULL DEFAULT 0,
  ADD CONSTRAINT "recording_sessions_bytes_received_check" CHECK ("bytes_received" BETWEEN 0 AND 1400000000);

-- SECURITY INVOKER: meetops_app already has UPDATE on recording_sessions under forced RLS, so the caller's
-- RLS (app.current_organization_id, legacy app.current_org_id fallback; ADR-010) decides visibility. No definer privileges needed.
-- Errors (RAISE ... USING ERRCODE):
--   recording_session_bytes_invalid_delta  22023  delta NULL or <= 0
--   recording_session_not_found            P0002  no such session in the current org (incl. other org / no org context)
--   recording_session_not_uploading        55000  status <> 'uploading'
--   recording_session_bytes_exceeded       22003  new total would exceed 1_400_000_000
CREATE FUNCTION public.add_recording_session_bytes(p_session_id uuid, p_delta bigint)
RETURNS bigint
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_total bigint;
  v_status "RecordingSessionStatus";
  v_current bigint;
BEGIN
  IF p_delta IS NULL OR p_delta <= 0 THEN
    RAISE EXCEPTION 'recording_session_bytes_invalid_delta' USING ERRCODE = '22023';
  END IF;

  -- One atomic UPDATE: the row lock serializes concurrent callers and READ COMMITTED re-checks the WHERE
  -- against the latest row version, so parallel increments add up exactly and never pass the cap.
  UPDATE public.recording_sessions
     SET bytes_received = bytes_received + p_delta, updated_at = now()
   WHERE id = p_session_id
     AND org_id = COALESCE(NULLIF(current_setting('app.current_organization_id', true), ''), NULLIF(current_setting('app.current_org_id', true), ''))::uuid
     AND status = 'uploading'
     AND bytes_received + p_delta <= 1400000000
  RETURNING bytes_received INTO v_total;

  IF FOUND THEN
    RETURN v_total;
  END IF;

  SELECT s.status, s.bytes_received INTO v_status, v_current
    FROM public.recording_sessions s
   WHERE s.id = p_session_id
     AND s.org_id = COALESCE(NULLIF(current_setting('app.current_organization_id', true), ''), NULLIF(current_setting('app.current_org_id', true), ''))::uuid;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'recording_session_not_found' USING ERRCODE = 'P0002';
  ELSIF v_status <> 'uploading' THEN
    RAISE EXCEPTION 'recording_session_not_uploading' USING ERRCODE = '55000', DETAIL = 'status=' || v_status;
  ELSE
    RAISE EXCEPTION 'recording_session_bytes_exceeded' USING ERRCODE = '22003',
      DETAIL = format('bytes_received=%s delta=%s max=1400000000', v_current, p_delta);
  END IF;
END;
$$;

ALTER FUNCTION public.add_recording_session_bytes(uuid, bigint) OWNER TO meetops_migrator;
REVOKE ALL ON FUNCTION public.add_recording_session_bytes(uuid, bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.add_recording_session_bytes(uuid, bigint) TO meetops_app;

