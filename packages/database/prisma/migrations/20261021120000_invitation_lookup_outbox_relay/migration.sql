-- Invitation acceptance (pre-org-context) and outbox relay access.
-- Idempotent. Run as meetops_migrator.

-- 1. Invitation lookup / accept -------------------------------------------------
-- These run before an org context exists, so they are SECURITY DEFINER functions owned by
-- meetops_migrator. Because invitations/memberships/audit_events use FORCE RLS (which also binds
-- the owner), narrowly scoped policies TO meetops_migrator let the definer functions see/write
-- the rows they need. meetops_migrator already owns these tables, so this grants nothing new.
DROP POLICY IF EXISTS definer_invitation_access ON "invitations";
CREATE POLICY definer_invitation_access ON "invitations" TO meetops_migrator USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS definer_membership_insert ON "memberships";
CREATE POLICY definer_membership_insert ON "memberships" TO meetops_migrator USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS definer_audit_insert ON "audit_events";
CREATE POLICY definer_audit_insert ON "audit_events" FOR INSERT TO meetops_migrator WITH CHECK (true);

-- Lookup by token hash only; returns minimal fields. Callers must still check status/expiry.
CREATE OR REPLACE FUNCTION lookup_invitation_by_token_hash(p_token_hash text)
RETURNS TABLE (
  id uuid,
  org_id uuid,
  email text,
  role "MembershipRole",
  status "InvitationStatus",
  expires_at timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT i.id, i.org_id, i.email, i.role, i.status, i.expires_at
  FROM public.invitations i
  WHERE i.token_hash = p_token_hash
  LIMIT 1
$$;

-- Accept: token must be pending + unexpired and the user's email must match the invitation.
-- Creates (or reuses) the membership, marks the invitation accepted, writes an audit event.
CREATE OR REPLACE FUNCTION accept_invitation(p_token_hash text, p_user_id uuid)
RETURNS TABLE (membership_id uuid, org_id uuid, role "MembershipRole")
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  inv public.invitations%ROWTYPE;
  u_email text;
  m_id uuid;
BEGIN
  SELECT * INTO inv FROM public.invitations i WHERE i.token_hash = p_token_hash FOR UPDATE;
  IF NOT FOUND OR inv.status <> 'pending' OR inv.expires_at <= now() THEN
    RAISE EXCEPTION 'invitation_invalid' USING ERRCODE = 'P0002';
  END IF;
  SELECT u.email INTO u_email FROM public.users u WHERE u.id = p_user_id AND u.deleted_at IS NULL;
  IF u_email IS NULL OR lower(u_email) <> lower(inv.email) THEN
    RAISE EXCEPTION 'invitation_invalid' USING ERRCODE = 'P0002';
  END IF;

  INSERT INTO public.memberships (id, org_id, user_id, role, created_at, updated_at)
  VALUES (gen_random_uuid(), inv.org_id, p_user_id, inv.role, now(), now())
  ON CONFLICT (org_id, user_id) DO UPDATE SET deleted_at = NULL, updated_at = now()
  RETURNING id INTO m_id;

  UPDATE public.invitations
  SET status = 'accepted', accepted_at = now(), updated_at = now()
  WHERE id = inv.id;

  INSERT INTO public.audit_events (id, org_id, actor_id, actor_type, action, target_type, target_id, metadata, created_at)
  VALUES (gen_random_uuid(), inv.org_id, p_user_id, 'user', 'invitation.accepted', 'invitation', inv.id::text,
          jsonb_build_object('membership_id', m_id, 'role', inv.role), now());

  RETURN QUERY SELECT m_id, inv.org_id, inv.role;
END
$$;

ALTER FUNCTION lookup_invitation_by_token_hash(text) OWNER TO meetops_migrator;
ALTER FUNCTION accept_invitation(text, uuid) OWNER TO meetops_migrator;
REVOKE ALL ON FUNCTION lookup_invitation_by_token_hash(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION accept_invitation(text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION lookup_invitation_by_token_hash(text) TO meetops_app;
GRANT EXECUTE ON FUNCTION accept_invitation(text, uuid) TO meetops_app;

-- 2. Outbox relay ----------------------------------------------------------------
-- meetops_relay (LOGIN, BYPASSRLS; created by infra/bootstrap because BYPASSRLS needs a superuser)
-- reads pending events across all orgs. Its blast radius is limited by privileges: SELECT +
-- UPDATE of delivery columns on outbox_events only. No other table, no INSERT/DELETE.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'meetops_relay') THEN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'meetops_relay' AND (rolsuper OR rolcreaterole OR rolcreatedb)) THEN
      RAISE EXCEPTION 'meetops_relay must be NOSUPERUSER NOCREATEROLE NOCREATEDB';
    END IF;
    EXECUTE format('GRANT USAGE ON SCHEMA %I TO meetops_relay', current_schema());
    EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA %I FROM meetops_relay', current_schema());
    GRANT SELECT ON TABLE "outbox_events" TO meetops_relay;
    GRANT UPDATE ("status", "attempts", "last_error", "available_at", "published_at", "updated_at")
      ON TABLE "outbox_events" TO meetops_relay;
  ELSE
    RAISE NOTICE 'meetops_relay not found; outbox relay grants skipped (run scripts/bootstrap-roles.sql)';
  END IF;
END
$$;
