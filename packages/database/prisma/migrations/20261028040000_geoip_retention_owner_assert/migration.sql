-- Security review #288 L-1 (remainder): redact_expired_ip_addresses() runs as meetops_migrator and relies on it owning
-- (or holding column grants on) sessions, password_resets and audit_events. The 20261028010000 GRANT ran while the
-- migrator owned the tables, so on sessions/audit_events it was an owner self-grant that does not survive a change of
-- owner. Re-assert ownership the same best-effort way as 20261021110000 (only when the session role is a member of
-- meetops_migrator and not it already; a no-op in prod, where the migrator runs migrations and owns every table), then
-- re-issue the column-level grants so a non-migrator owner still leaves the migrator exactly these rights.
-- Additive only: no DROP, no RLS change, no grants to meetops_app.
DO $$
DECLARE
  t text;
BEGIN
  IF current_user <> 'meetops_migrator' AND pg_has_role(current_user, 'meetops_migrator', 'MEMBER') THEN
    FOREACH t IN ARRAY ARRAY['sessions', 'password_resets', 'audit_events'] LOOP
      IF (SELECT tableowner FROM pg_tables WHERE schemaname = current_schema() AND tablename = t)
         IS DISTINCT FROM 'meetops_migrator' THEN
        EXECUTE format('ALTER TABLE %I OWNER TO meetops_migrator', t);
      END IF;
    END LOOP;
  END IF;
END
$$;

GRANT SELECT (id, ip_address, created_at), UPDATE (ip_address)
  ON TABLE "sessions", "password_resets", "audit_events" TO meetops_migrator;
