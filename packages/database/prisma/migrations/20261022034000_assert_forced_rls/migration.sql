-- Security review (4): post-migration assertion. Every table with RLS enabled must still be FORCED
-- (backfill migrations lift FORCE temporarily; each migration runs as one implicit transaction, so a
-- failure rolls the NO FORCE back, and this guard catches any migration that forgot to re-force).
DO $$
DECLARE bad text;
BEGIN
  SELECT string_agg(c.relname, ', ' ORDER BY c.relname) INTO bad
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = current_schema() AND c.relkind = 'r' AND c.relrowsecurity AND NOT c.relforcerowsecurity;
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'RLS enabled but not forced on: %', bad;
  END IF;
END
$$;
