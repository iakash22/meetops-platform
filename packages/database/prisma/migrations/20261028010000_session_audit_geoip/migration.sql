-- ADR-014: coarse GeoIP location on sessions and audit events, plus 30-day raw IP retention.
-- No latitude/longitude is stored. Forced RLS on audit_events is unchanged (no FORCE/NO FORCE toggling here).

ALTER TABLE "sessions"
  ADD COLUMN "geo_city" VARCHAR(128),
  ADD COLUMN "geo_region" VARCHAR(128),
  ADD COLUMN "geo_country" VARCHAR(128),
  ADD COLUMN "geo_country_code" CHAR(2),
  ADD COLUMN "geo_approximate" BOOLEAN;
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_geo_country_code_check"
  CHECK ("geo_country_code" IS NULL OR "geo_country_code" ~ '^[A-Z]{2}$');

ALTER TABLE "audit_events"
  ADD COLUMN "geo_city" VARCHAR(128),
  ADD COLUMN "geo_region" VARCHAR(128),
  ADD COLUMN "geo_country" VARCHAR(128),
  ADD COLUMN "geo_country_code" CHAR(2),
  ADD COLUMN "geo_approximate" BOOLEAN;
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_geo_country_code_check"
  CHECK ("geo_country_code" IS NULL OR "geo_country_code" ~ '^[A-Z]{2}$');

-- Retention scans by age where a raw IP is still present.
CREATE INDEX "sessions_ip_retention_idx" ON "sessions"("created_at") WHERE "ip_address" IS NOT NULL;
CREATE INDEX "audit_events_ip_retention_idx" ON "audit_events"("created_at") WHERE "ip_address" IS NOT NULL;
CREATE INDEX "password_resets_ip_retention_idx" ON "password_resets"("created_at") WHERE "ip_address" IS NOT NULL;

-- Append-only trigger (body from 20261022041000_audit_hatch_session_user, unchanged) plus one narrow case: the
-- retention UPDATE that only nulls ip_address on rows older than 30 days, from the migrator-owned
-- redact_expired_ip_addresses (current_user is the migrator only inside a migrator-owned SECURITY DEFINER
-- function). The app can set the GUC itself, so the change shape and age are what is enforced here.
CREATE OR REPLACE FUNCTION public.audit_events_append_only()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  -- session_user (the login role), not current_user: inside any migrator-owned SECURITY DEFINER
  -- function current_user is the migrator, and the app can set the custom GUC itself.
  IF current_setting('meetops.audit_maintenance', true) = 'on'
     AND session_user = 'meetops_migrator' THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.actor_id IS NOT NULL AND NEW.actor_id IS NULL
     AND (to_jsonb(NEW) - 'actor_id') = (to_jsonb(OLD) - 'actor_id') THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND current_setting('meetops.audit_ip_retention', true) = 'on'
     AND current_user = 'meetops_migrator'
     AND OLD.created_at < now() - interval '30 days'
     AND OLD.ip_address IS NOT NULL AND NEW.ip_address IS NULL
     AND (to_jsonb(NEW) - 'ip_address') = (to_jsonb(OLD) - 'ip_address') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'audit_events is append-only (% refused)', TG_OP USING ERRCODE = 'insufficient_privilege';
END
$$;
REVOKE ALL ON FUNCTION public.audit_events_append_only() FROM PUBLIC;

-- Forced RLS has no UPDATE policy on audit_events. UPDATE ... WHERE also needs a SELECT policy, so both are scoped
-- TO meetops_migrator, gated on the retention GUC, and limited to rows the exception may touch (older than
-- 30 days; the UPDATE policy also requires a raw IP present and NULL after). meetops_app gets no UPDATE grant and FORCE RLS stays on.
DROP POLICY IF EXISTS audit_ip_retention_select ON "audit_events";
-- (The SELECT policy cannot require ip_address IS NOT NULL: Postgres also checks the updated row against it.)
CREATE POLICY audit_ip_retention_select ON "audit_events" FOR SELECT TO meetops_migrator
  USING (current_setting('meetops.audit_ip_retention', true) = 'on' AND created_at < now() - interval '30 days');
DROP POLICY IF EXISTS audit_ip_retention_update ON "audit_events";
CREATE POLICY audit_ip_retention_update ON "audit_events" FOR UPDATE TO meetops_migrator
  USING (current_setting('meetops.audit_ip_retention', true) = 'on'
         AND ip_address IS NOT NULL AND created_at < now() - interval '30 days')
  WITH CHECK (current_setting('meetops.audit_ip_retention', true) = 'on' AND ip_address IS NULL);

-- One batch: null raw IPs older than p_days (>= 30, default 30) on sessions, audit_events and password_resets, at most
-- p_batch (1..10000) rows per table. Server time (now()). Idempotent; call until every count is 0. Keeps coarse geo.
CREATE OR REPLACE FUNCTION public.redact_expired_ip_addresses(p_days integer DEFAULT 30, p_batch integer DEFAULT 1000)
RETURNS TABLE (sessions_redacted bigint, audit_events_redacted bigint, password_resets_redacted bigint)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE v_cutoff timestamptz; v_s bigint; v_a bigint; v_p bigint;
BEGIN
  IF p_days IS NULL OR p_days < 30 THEN
    RAISE EXCEPTION 'retention_days_invalid' USING ERRCODE = '22023';
  END IF;
  IF p_batch IS NULL OR p_batch < 1 OR p_batch > 10000 THEN
    RAISE EXCEPTION 'retention_batch_invalid' USING ERRCODE = '22023';
  END IF;
  v_cutoff := now() - make_interval(days => p_days);
  UPDATE public.sessions SET ip_address = NULL
   WHERE id IN (SELECT id FROM public.sessions WHERE ip_address IS NOT NULL AND created_at < v_cutoff
                ORDER BY created_at LIMIT p_batch FOR UPDATE SKIP LOCKED);
  GET DIAGNOSTICS v_s = ROW_COUNT;
  UPDATE public.password_resets SET ip_address = NULL
   WHERE id IN (SELECT id FROM public.password_resets WHERE ip_address IS NOT NULL AND created_at < v_cutoff
                ORDER BY created_at LIMIT p_batch FOR UPDATE SKIP LOCKED);
  GET DIAGNOSTICS v_p = ROW_COUNT;
  PERFORM set_config('meetops.audit_ip_retention', 'on', true);
  UPDATE public.audit_events SET ip_address = NULL
   WHERE id IN (SELECT id FROM public.audit_events WHERE ip_address IS NOT NULL AND created_at < v_cutoff
                ORDER BY created_at LIMIT p_batch FOR UPDATE SKIP LOCKED);
  GET DIAGNOSTICS v_a = ROW_COUNT;
  PERFORM set_config('meetops.audit_ip_retention', 'off', true);
  RETURN QUERY SELECT v_s, v_a, v_p;
END
$$;
ALTER FUNCTION public.redact_expired_ip_addresses(integer, integer) OWNER TO meetops_migrator;
REVOKE ALL ON FUNCTION public.redact_expired_ip_addresses(integer, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.redact_expired_ip_addresses(integer, integer) TO meetops_app;

-- Global auth audit events gain optional coarse geo. Replace (not overload) so 7-arg callers keep working.
DROP FUNCTION IF EXISTS public.record_global_auth_event(text, uuid, text, text, jsonb, text, text);
CREATE FUNCTION public.record_global_auth_event(
  p_action text,
  p_actor_id uuid,
  p_target_type text,
  p_target_id text,
  p_metadata jsonb DEFAULT '{}'::jsonb,
  p_ip_address text DEFAULT NULL,
  p_user_agent text DEFAULT NULL,
  p_geo_city text DEFAULT NULL,
  p_geo_region text DEFAULT NULL,
  p_geo_country text DEFAULT NULL,
  p_geo_country_code text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE v_id uuid := gen_random_uuid(); v_cc text := upper(p_geo_country_code);
BEGIN
  IF p_action IS NULL OR p_action NOT IN (
    'auth.signup', 'auth.login_succeeded', 'auth.login_failed', 'auth.logout',
    'auth.session_revoked', 'auth.email_verification_sent', 'auth.email_verified',
    'auth.password_reset_requested', 'auth.password_reset_completed', 'auth.password_changed'
  ) THEN
    RAISE EXCEPTION 'audit_action_not_allowed' USING ERRCODE = '22023';
  END IF;
  IF p_target_type IS NULL OR p_target_type NOT IN ('user', 'session', 'email') THEN
    RAISE EXCEPTION 'audit_target_not_allowed' USING ERRCODE = '22023';
  END IF;
  IF p_metadata IS NULL OR jsonb_typeof(p_metadata) <> 'object' OR pg_column_size(p_metadata) > 4096 THEN
    RAISE EXCEPTION 'audit_metadata_invalid' USING ERRCODE = '22023';
  END IF;
  IF v_cc IS NOT NULL AND v_cc !~ '^[A-Z]{2}$' THEN v_cc := NULL; END IF;
  INSERT INTO public.audit_events (id, org_id, actor_id, actor_type, action, target_type, target_id, metadata,
                                   ip_address, user_agent, geo_city, geo_region, geo_country, geo_country_code,
                                   geo_approximate, created_at)
  VALUES (v_id, NULL, p_actor_id, CASE WHEN p_actor_id IS NULL THEN 'anonymous' ELSE 'user' END, p_action,
          p_target_type, left(p_target_id, 200), p_metadata, left(p_ip_address, 64), left(p_user_agent, 512),
          left(p_geo_city, 128), left(p_geo_region, 128), left(p_geo_country, 128), v_cc,
          CASE WHEN coalesce(p_geo_city, p_geo_region, p_geo_country, v_cc) IS NULL THEN NULL ELSE true END, now());
  RETURN v_id;
END
$$;
ALTER FUNCTION public.record_global_auth_event(text, uuid, text, text, jsonb, text, text, text, text, text, text)
  OWNER TO meetops_migrator;
REVOKE ALL ON FUNCTION public.record_global_auth_event(text, uuid, text, text, jsonb, text, text, text, text, text, text)
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.record_global_auth_event(text, uuid, text, text, jsonb, text, text, text, text, text, text)
  TO meetops_app;
