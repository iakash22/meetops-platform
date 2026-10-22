-- Architecture review B1 (HIGH): 20261022030000 rewrote the role of ANY existing membership, so a viewer
-- invite accepted by the sole owner left the org with 0 owners. Now:
--   * active membership (deleted_at IS NULL)  -> RAISE 'already_member', nothing changes;
--   * soft-deleted membership                 -> revived with the invitation's role;
--   * no membership                           -> inserted with the invitation's role (unchanged).
-- Decision: on 'already_member' the invitation stays PENDING. The exception aborts the whole call, so the
-- invite is not consumed, no audit row is written, and an admin can see and revoke it (the API should
-- also refuse to invite active members). It expires on its own otherwise.
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
  SELECT * INTO inv FROM public.invitations i
  WHERE i.token_hash = p_token_hash AND i.deleted_at IS NULL FOR UPDATE;
  IF NOT FOUND OR inv.status <> 'pending' OR inv.revoked_at IS NOT NULL OR inv.expires_at <= now() THEN
    RAISE EXCEPTION 'invitation_invalid' USING ERRCODE = 'P0002';
  END IF;
  SELECT u.email INTO u_email FROM public.users u WHERE u.id = p_user_id AND u.deleted_at IS NULL;
  IF u_email IS NULL OR lower(u_email) <> lower(inv.email) THEN
    RAISE EXCEPTION 'invitation_invalid' USING ERRCODE = 'P0002';
  END IF;

  -- An ACTIVE membership is never changed by an invitation (no demotion, no last-owner bypass).
  PERFORM 1 FROM public.memberships m
  WHERE m.org_id = inv.org_id AND m.user_id = p_user_id AND m.deleted_at IS NULL
  FOR UPDATE;
  IF FOUND THEN
    RAISE EXCEPTION 'already_member' USING ERRCODE = 'P0001',
      DETAIL = 'user already has an active membership in this organization; the invitation was not used';
  END IF;

  -- New row: invitation role. Soft-deleted row: revived with the invitation role.
  INSERT INTO public.memberships (id, org_id, user_id, role, created_at, updated_at)
  VALUES (gen_random_uuid(), inv.org_id, p_user_id, inv.role, now(), now())
  ON CONFLICT (org_id, user_id) DO UPDATE SET role = EXCLUDED.role, deleted_at = NULL, updated_at = now()
  WHERE memberships.deleted_at IS NOT NULL
  RETURNING id INTO m_id;
  IF m_id IS NULL THEN
    -- lost a race with a concurrent accept that made the membership active
    RAISE EXCEPTION 'already_member' USING ERRCODE = 'P0001';
  END IF;

  UPDATE public.invitations
  SET status = 'accepted', accepted_at = now(), accepted_by_id = p_user_id, updated_at = now()
  WHERE id = inv.id;

  INSERT INTO public.audit_events (id, org_id, actor_id, actor_type, action, target_type, target_id, metadata, created_at)
  VALUES (gen_random_uuid(), inv.org_id, p_user_id, 'user', 'invitation.accepted', 'invitation', inv.id::text,
          jsonb_build_object('membership_id', m_id, 'role', inv.role), now());

  RETURN QUERY SELECT m_id, inv.org_id, inv.role;
END
$$;
ALTER FUNCTION accept_invitation(text, uuid) OWNER TO meetops_migrator;
REVOKE ALL ON FUNCTION accept_invitation(text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION accept_invitation(text, uuid) TO meetops_app;
