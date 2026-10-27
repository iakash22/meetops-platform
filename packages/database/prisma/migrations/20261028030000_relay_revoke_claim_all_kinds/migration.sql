-- Follow-up to 20261028000000_relay_claim_by_event_type (#279). The relay now claims only the event types it
-- handles via relay_claim_outbox_events(integer, text[]). The original claim-all-kinds overload
-- relay_claim_outbox_events(integer) would let the relay consume events meant for other consumers, so the relay
-- role loses EXECUTE on it. The function itself is kept (not dropped): it is owned by meetops_migrator, nobody else
-- holds EXECUTE (PUBLIC was revoked in 20261022033000), and keeping it avoids breaking an older worker mid-deploy
-- with "function does not exist" instead of a clear permission error. Idempotent. Run as meetops_migrator.
REVOKE ALL ON FUNCTION public.relay_claim_outbox_events(integer) FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'meetops_relay') THEN
    REVOKE EXECUTE ON FUNCTION public.relay_claim_outbox_events(integer) FROM meetops_relay;
  END IF;
END
$$;
