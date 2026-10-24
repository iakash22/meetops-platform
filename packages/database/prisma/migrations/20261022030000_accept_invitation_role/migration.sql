-- Security review BLOCKER: re-accepting into an existing (e.g. soft-deleted) membership kept the OLD role,
-- so a removed owner re-invited as viewer came back as owner. The invitation's role now always wins.
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

  INSERT INTO public.memberships (id, org_id, user_id, role, created_at, updated_at)
  VALUES (gen_random_uuid(), inv.org_id, p_user_id, inv.role, now(), now())
  ON CONFLICT (org_id, user_id) DO UPDATE SET role = EXCLUDED.role, deleted_at = NULL, updated_at = now()
  RETURNING id INTO m_id;

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
