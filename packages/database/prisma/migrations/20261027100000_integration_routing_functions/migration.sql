-- Phase 5 (ADR-008): routing helpers for callers that do not yet know the tenant.
-- Webhooks arrive at /webhooks/:provider/:integrationId (no org in the path) and the token-refresh sweep runs
-- across tenants. Both functions return identifiers only (never secrets or names), and only for live rows, so
-- the caller then re-enters forced RLS with app.current_organization_id set before reading anything else.
CREATE FUNCTION integration_connection_org(p_id uuid, p_provider text)
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT c.org_id
  FROM public.integration_connections c
  WHERE c.id = p_id
    AND c.provider = p_provider
    AND c.status <> 'revoked'
  LIMIT 1
$$;
ALTER FUNCTION integration_connection_org(uuid, text) OWNER TO meetops_migrator;
REVOKE ALL ON FUNCTION integration_connection_org(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION integration_connection_org(uuid, text) TO meetops_app;

-- Live connections whose access token expires before p_before (oldest first, capped at 500 per call).
CREATE FUNCTION integration_connections_due_for_refresh(p_before timestamptz, p_limit integer)
RETURNS TABLE (org_id uuid, id uuid, provider text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT c.org_id, c.id, c.provider
  FROM public.integration_connections c
  WHERE c.status = 'active'
    AND c.access_token_expires_at IS NOT NULL
    AND c.access_token_expires_at < p_before
  ORDER BY c.access_token_expires_at ASC, c.id ASC
  LIMIT LEAST(GREATEST(p_limit, 1), 500)
$$;
ALTER FUNCTION integration_connections_due_for_refresh(timestamptz, integer) OWNER TO meetops_migrator;
REVOKE ALL ON FUNCTION integration_connections_due_for_refresh(timestamptz, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION integration_connections_due_for_refresh(timestamptz, integer) TO meetops_app;
