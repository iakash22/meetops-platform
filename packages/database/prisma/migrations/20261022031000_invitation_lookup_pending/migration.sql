-- Security review (1): token lookup returns only usable invitations: pending, unexpired, not revoked,
-- not deleted. Fields are minimal; `status` is dropped (always pending). `email` stays: the accept UI
-- shows/pre-fills which address the invite is for, and accept_invitation matches it in-DB anyway.
DROP FUNCTION IF EXISTS lookup_invitation_by_token_hash(text);
CREATE FUNCTION lookup_invitation_by_token_hash(p_token_hash text)
RETURNS TABLE (id uuid, org_id uuid, email text, role "MembershipRole", expires_at timestamptz)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT i.id, i.org_id, i.email, i.role, i.expires_at
  FROM public.invitations i
  WHERE i.token_hash = p_token_hash
    AND i.status = 'pending'
    AND i.expires_at > now()
    AND i.revoked_at IS NULL
    AND i.deleted_at IS NULL
  LIMIT 1
$$;
ALTER FUNCTION lookup_invitation_by_token_hash(text) OWNER TO meetops_migrator;
REVOKE ALL ON FUNCTION lookup_invitation_by_token_hash(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION lookup_invitation_by_token_hash(text) TO meetops_app;
