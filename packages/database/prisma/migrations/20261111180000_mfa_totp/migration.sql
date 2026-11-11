-- ADR-021 MFA (TOTP + recovery codes). Plan: docs/12-security/mfa-test-plan.md.

-- 1. users.mfa_enabled_at: set in the same transaction that activates a user's first factor, cleared when the last
--    factor is removed. Read with the user on every authenticated request (MFA-TOTP-01 gate), so no extra query.
ALTER TABLE "users" ADD COLUMN "mfa_enabled_at" TIMESTAMPTZ(3);

-- 1b. organizations.mfa_required: the org-wide "require MFA for everyone" policy (ADR-021 D2, OQ-13). Owners and admins
--     always need MFA (OQ-5) whatever this says. organizations is a reviewed global table (no RLS); the column is only
--     changed through the org-context, CASL-checked, step-up-guarded route.
ALTER TABLE "organizations" ADD COLUMN "mfa_required" BOOLEAN NOT NULL DEFAULT false;

-- 2. sessions: when this session last passed an MFA check (step-up freshness, MFA-SU-06), and the auth_level values
--    are pinned (MFA-SU-09). Anything other than exactly 'mfa' is not elevated; the CHECK makes a typo impossible.
ALTER TABLE "sessions" ADD COLUMN "mfa_at" TIMESTAMPTZ(3);
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_auth_level_check"
  CHECK ("auth_level" IN ('password', 'google', 'mfa'));
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_mfa_at_level_check"
  CHECK ("mfa_at" IS NULL OR "auth_level" = 'mfa');

-- 3. mfa_factors: one row per enrolled factor. The TOTP secret (and the user's recovery-code HMAC key) live only in a
--    TokenCipher envelope whose AAD is ['meetops.mfa.totp.v1', user_id, id] (MFA-SEC-01, finding P-3).
--    last_used_step is the RFC 6238 replay guard: a code is accepted only for a step greater than it, set by a
--    conditional UPDATE (atomic across sessions and API instances, MFA-TOTP-04).
CREATE TABLE "mfa_factors" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "secret_enc" TEXT NOT NULL,
    "secret_key_id" TEXT NOT NULL,
    "last_used_step" BIGINT,
    "pending_expires_at" TIMESTAMPTZ(3),
    "confirmed_at" TIMESTAMPTZ(3),
    "last_used_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "mfa_factors_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "mfa_factors_type_check" CHECK ("type" IN ('totp')),
    CONSTRAINT "mfa_factors_status_check" CHECK ("status" IN ('pending', 'active')),
    CONSTRAINT "mfa_factors_secret_enc_check" CHECK ("secret_enc" LIKE 'v1.%'),
    CONSTRAINT "mfa_factors_pending_check" CHECK (
      ("status" = 'pending' AND "pending_expires_at" IS NOT NULL AND "confirmed_at" IS NULL)
      OR ("status" = 'active' AND "confirmed_at" IS NOT NULL)
    )
);
CREATE INDEX "mfa_factors_user_id_idx" ON "mfa_factors"("user_id");
-- At most one active TOTP factor per user (replacement retires the old one in the same transaction). Prisma cannot
-- express a partial unique index, so it lives here only (same approach as users_google_sub_key).
CREATE UNIQUE INDEX "mfa_factors_one_active_totp" ON "mfa_factors"("user_id") WHERE "status" = 'active' AND "type" = 'totp';
ALTER TABLE "mfa_factors" ADD CONSTRAINT "mfa_factors_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 4. mfa_recovery_codes: single-use codes, stored only as HMAC-SHA256(per-user key, code) (MFA-RC-03). The key is in
--    the factor's encrypted envelope, so a database dump alone cannot be brute-forced. used_at is set by a
--    conditional UPDATE (... WHERE used_at IS NULL): a code works once even under concurrency (MFA-RC-02).
CREATE TABLE "mfa_recovery_codes" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "factor_id" UUID NOT NULL,
    "code_hash" TEXT NOT NULL,
    "used_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mfa_recovery_codes_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "mfa_recovery_codes_factor_id_code_hash_key" ON "mfa_recovery_codes"("factor_id", "code_hash");
CREATE INDEX "mfa_recovery_codes_user_id_idx" ON "mfa_recovery_codes"("user_id");
ALTER TABLE "mfa_recovery_codes" ADD CONSTRAINT "mfa_recovery_codes_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "mfa_recovery_codes" ADD CONSTRAINT "mfa_recovery_codes_factor_id_fkey"
  FOREIGN KEY ("factor_id") REFERENCES "mfa_factors"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 5. Forced RLS keyed on the user (these tables have no org_id: MFA is per user, MFA-AUD-03 / OQ-13). The app sets
--    app.current_user_id LOCAL in a transaction (runWithUserContext); unset or '' => NULL => no rows (fail closed).
ALTER TABLE "mfa_factors" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "mfa_factors" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS user_isolation ON "mfa_factors";
CREATE POLICY user_isolation ON "mfa_factors"
  USING (user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid)
  WITH CHECK (user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid);

ALTER TABLE "mfa_recovery_codes" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "mfa_recovery_codes" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS user_isolation ON "mfa_recovery_codes";
CREATE POLICY user_isolation ON "mfa_recovery_codes"
  USING (user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid)
  WITH CHECK (user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid);

-- 6. Grants: DML for the app role (default privileges cover new tables only when meetops_migrator ran this; be explicit).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'meetops_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "mfa_factors" TO meetops_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "mfa_recovery_codes" TO meetops_app;
  END IF;
END
$$;

-- 7. MFA audit events are pre-tenant (organization_id NULL, like login; MFA-AUD-03). They go through the SECURITY
--    DEFINER record_global_auth_event, whose allowlist grows by the MFA actions and the 'mfa_factor' target type.
--    Same signature, owner and grants as 20261109120000.
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
    'auth.google_linked',
    'auth.mfa_enrolled', 'auth.mfa_confirmed', 'auth.mfa_disabled', 'auth.mfa_challenge_succeeded',
    'auth.mfa_challenge_failed', 'auth.mfa_step_up', 'auth.mfa_recovery_code_used',
    'auth.mfa_recovery_codes_regenerated'
  ) THEN
    RAISE EXCEPTION 'audit_action_not_allowed' USING ERRCODE = '22023';
  END IF;
  IF p_target_type IS NULL OR p_target_type NOT IN ('user', 'session', 'email', 'mfa_factor') THEN
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
