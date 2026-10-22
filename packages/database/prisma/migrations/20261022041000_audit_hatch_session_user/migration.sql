-- Architecture review nit: the audit maintenance hatch keyed on current_user, which a SECURITY DEFINER
-- function owned by the migrator would satisfy for any caller. Key it on session_user instead.
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
  RAISE EXCEPTION 'audit_events is append-only (% refused)', TG_OP USING ERRCODE = 'insufficient_privilege';
END
$$;
REVOKE ALL ON FUNCTION public.audit_events_append_only() FROM PUBLIC;
