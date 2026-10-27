-- Phase 5 (ADR-008): App-wide GitHub webhook routing. GitHub Apps have a single webhook URL (POST /webhooks/github),
-- so deliveries carry only payload.installation.id. This resolves (provider, external_account_id) to the live
-- connections that own it. Identifiers only (never secrets or names); callers re-enter forced RLS with
-- app.current_organization_id before reading anything else. Same shape as integration_connection_org().
-- Reads through the definer SELECT policy from 20261027140000_integration_routing_definer_policy (#281).
-- Additive and idempotent-safe (new function only). Run as meetops_migrator.
CREATE FUNCTION integration_connections_by_external_account(p_provider text, p_external_account_id text)
RETURNS TABLE (org_id uuid, id uuid)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT c.org_id, c.id
  FROM public.integration_connections c
  WHERE c.provider = p_provider
    AND c.external_account_id = p_external_account_id
    AND c.status <> 'revoked'
  ORDER BY c.updated_at DESC, c.id ASC
  LIMIT 10
$$;
ALTER FUNCTION integration_connections_by_external_account(text, text) OWNER TO meetops_migrator;
REVOKE ALL ON FUNCTION integration_connections_by_external_account(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION integration_connections_by_external_account(text, text) TO meetops_app;
