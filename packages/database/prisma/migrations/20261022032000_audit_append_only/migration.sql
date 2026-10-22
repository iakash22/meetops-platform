-- Security review (2): audit_events is append-only for everyone, including the owner.
-- UPDATE/DELETE/TRUNCATE raise unless a migration running as meetops_migrator explicitly opts in with
--   SET LOCAL meetops.audit_maintenance = 'on';
-- (the app cannot use the escape hatch: it is not a member of meetops_migrator). Under FORCE RLS a
-- maintenance migration also needs its own NO FORCE window, since there is no UPDATE/DELETE policy. The one allowed UPDATE
-- is the FK action from deleting a user (actor_id -> NULL, nothing else changes).
CREATE OR REPLACE FUNCTION public.audit_events_append_only()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF current_setting('meetops.audit_maintenance', true) = 'on'
     AND pg_has_role(current_user, 'meetops_migrator', 'MEMBER') THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.actor_id IS NOT NULL AND NEW.actor_id IS NULL
     AND (to_jsonb(NEW) - 'actor_id') = (to_jsonb(OLD) - 'actor_id') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'audit_events is append-only (% refused)', TG_OP USING ERRCODE = 'insufficient_privilege';
END
$$;
REVOKE ALL ON FUNCTION public.audit_events_append_only() FROM PUBLIC;
CREATE TRIGGER audit_events_append_only
  BEFORE UPDATE OR DELETE ON "audit_events"
  FOR EACH ROW EXECUTE FUNCTION public.audit_events_append_only();
CREATE TRIGGER audit_events_no_truncate
  BEFORE TRUNCATE ON "audit_events"
  FOR EACH STATEMENT EXECUTE FUNCTION public.audit_events_append_only();

-- The app may only insert rows for its current org; org-NULL (global auth) events go through
-- record_global_auth_event, which validates the action against an allowlist.
DROP POLICY IF EXISTS audit_insert ON "audit_events";
CREATE POLICY audit_insert ON "audit_events" FOR INSERT
  WITH CHECK (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);

CREATE OR REPLACE FUNCTION public.record_global_auth_event(
  p_action text,
  p_actor_id uuid,
  p_target_type text,
  p_target_id text,
  p_metadata jsonb DEFAULT '{}'::jsonb,
  p_ip_address text DEFAULT NULL,
  p_user_agent text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE v_id uuid := gen_random_uuid();
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
  INSERT INTO public.audit_events (id, org_id, actor_id, actor_type, action, target_type, target_id, metadata,
                                   ip_address, user_agent, created_at)
  VALUES (v_id, NULL, p_actor_id, CASE WHEN p_actor_id IS NULL THEN 'anonymous' ELSE 'user' END, p_action,
          p_target_type, left(p_target_id, 200), p_metadata, left(p_ip_address, 64), left(p_user_agent, 512), now());
  RETURN v_id;
END
$$;
ALTER FUNCTION public.record_global_auth_event(text, uuid, text, text, jsonb, text, text) OWNER TO meetops_migrator;
REVOKE ALL ON FUNCTION public.record_global_auth_event(text, uuid, text, text, jsonb, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.record_global_auth_event(text, uuid, text, text, jsonb, text, text) TO meetops_app;
