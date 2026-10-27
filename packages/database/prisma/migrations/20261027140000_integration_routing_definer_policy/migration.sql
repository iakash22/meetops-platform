-- Fix for 20261027100000_integration_routing_functions: integration_connection_org() and
-- integration_connections_due_for_refresh() are SECURITY DEFINER functions owned by meetops_migrator, but
-- integration_connections uses FORCE ROW LEVEL SECURITY (which also binds the owner) and its only policy is the
-- org-scoped tenant_isolation one. Without an org context the definer saw no rows, so webhook routing and the
-- refresh sweep always came back empty.
--
-- Same pattern as 20261021120000_invitation_lookup_outbox_relay: a narrow, SELECT-only policy TO meetops_migrator,
-- limited to live (non-revoked) rows, which is exactly what both functions read. The functions return ids only;
-- callers then re-enter forced RLS with app.current_organization_id set. meetops_app gains nothing.
-- Idempotent. Run as meetops_migrator.
GRANT SELECT ON TABLE "integration_connections" TO meetops_migrator;

DROP POLICY IF EXISTS definer_integration_routing_select ON "integration_connections";
CREATE POLICY definer_integration_routing_select ON "integration_connections"
  FOR SELECT
  TO meetops_migrator
  USING (status <> 'revoked');
