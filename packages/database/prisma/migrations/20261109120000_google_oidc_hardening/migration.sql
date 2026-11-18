-- Google OIDC hardening (review L-1, M-2 / N-4).

-- L-1: a soft-deleted user no longer holds its Google subject. The global unique index becomes partial over live
-- rows, so the same Google account can sign up again after its MeetOps account was deleted. The repositories
-- already filter deleted_at IS NULL on every lookup. users is small and global (no RLS); a plain build is fine.
DROP INDEX "users_google_sub_key";
CREATE UNIQUE INDEX "users_google_sub_key" ON "users"("google_sub") WHERE "deleted_at" IS NULL;

-- M-2 / N-4: linking a Google subject to an existing account is its own global audit action
-- (auth.google_linked). Same signature, owner and grants as 20261028010000; only the allowlist grows.
CREATE OR REPLACE FUNCTION public.record_global_auth_event(
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
    'auth.password_reset_requested', 'auth.password_reset_completed', 'auth.password_changed',
    'auth.google_linked'
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
