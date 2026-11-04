-- Consent API: meeting-level recording consent ledger. ADDITIVE ONLY: one enum, one table. Append-only like
-- consent_attestations / audit_events: a revocation is a new 'revoked' event, never an UPDATE or DELETE.

-- CreateEnum
CREATE TYPE "MeetingConsentEventType" AS ENUM ('granted', 'revoked');

-- CreateTable
CREATE TABLE "meeting_consent_events" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "meeting_id" UUID NOT NULL,
    "event_type" "MeetingConsentEventType" NOT NULL,
    "consent_version" TEXT,
    "method" "ConsentMethod",
    "reason" TEXT,
    "actor_user_id" UUID NOT NULL,
    "occurred_at" TIMESTAMPTZ(3) NOT NULL,
    "recorded_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "meeting_consent_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "meeting_consent_events_org_id_meeting_id_recorded_at_idx" ON "meeting_consent_events"("org_id", "meeting_id", "recorded_at");

-- CreateIndex
CREATE UNIQUE INDEX "meeting_consent_events_org_id_id_key" ON "meeting_consent_events"("org_id", "id");

-- AddForeignKey (RESTRICT: evidence must not vanish with its organization, meeting or actor; meetings are soft-deleted)
ALTER TABLE "meeting_consent_events" ADD CONSTRAINT "meeting_consent_events_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey (composite: the meeting must belong to the same organization)
ALTER TABLE "meeting_consent_events" ADD CONSTRAINT "meeting_consent_events_org_id_meeting_id_fkey" FOREIGN KEY ("org_id", "meeting_id") REFERENCES "meetings"("org_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "meeting_consent_events" ADD CONSTRAINT "meeting_consent_events_actor_user_id_fkey" FOREIGN KEY ("actor_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Shape: a grant carries version + method and no reason; a revocation carries neither (reason optional).
ALTER TABLE "meeting_consent_events"
  ADD CONSTRAINT "meeting_consent_events_shape_check" CHECK (
    ("event_type" = 'granted' AND "consent_version" IS NOT NULL AND "method" IS NOT NULL AND "reason" IS NULL)
    OR ("event_type" = 'revoked' AND "consent_version" IS NULL AND "method" IS NULL)),
  ADD CONSTRAINT "meeting_consent_events_consent_version_check"
    CHECK ("consent_version" IS NULL OR "consent_version" ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$'),
  ADD CONSTRAINT "meeting_consent_events_reason_check"
    CHECK ("reason" IS NULL OR char_length("reason") BETWEEN 1 AND 500),
  -- contracts CONSENT_ATTESTATION_MAX_SKEW_SECONDS: the client clock may be at most 300 s ahead of the server.
  ADD CONSTRAINT "meeting_consent_events_occurred_at_skew_check"
    CHECK ("occurred_at" <= "recorded_at" + interval '300 seconds');

-- Append-only for everyone, including the owner (same shape as consent_attestations_append_only). A migration running
-- as meetops_migrator may opt in with SET LOCAL meetops.consent_maintenance = 'on'.
CREATE OR REPLACE FUNCTION public.meeting_consent_events_append_only()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF current_setting('meetops.consent_maintenance', true) = 'on'
     AND pg_has_role(current_user, 'meetops_migrator', 'MEMBER') THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  RAISE EXCEPTION 'meeting_consent_events is append-only (% refused)', TG_OP USING ERRCODE = 'insufficient_privilege';
END
$$;
REVOKE ALL ON FUNCTION public.meeting_consent_events_append_only() FROM PUBLIC;
CREATE TRIGGER meeting_consent_events_append_only
  BEFORE UPDATE OR DELETE ON "meeting_consent_events"
  FOR EACH ROW EXECUTE FUNCTION public.meeting_consent_events_append_only();
CREATE TRIGGER meeting_consent_events_no_truncate
  BEFORE TRUNCATE ON "meeting_consent_events"
  FOR EACH STATEMENT EXECUTE FUNCTION public.meeting_consent_events_append_only();

-- Tenant isolation, forced (canonical ADR-010 setting only; fail-closed when unset).
ALTER TABLE "meeting_consent_events" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "meeting_consent_events" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "meeting_consent_events"
  USING (org_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid);
-- Default privileges granted SELECT, INSERT, UPDATE, DELETE; narrow them to SELECT, INSERT.
REVOKE ALL ON TABLE "meeting_consent_events" FROM meetops_app;
GRANT SELECT, INSERT ON TABLE "meeting_consent_events" TO meetops_app;

DO $$
DECLARE bad text;
BEGIN
  SELECT string_agg(c.relname, ', ' ORDER BY c.relname) INTO bad
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = current_schema() AND c.relkind = 'r' AND c.relrowsecurity AND NOT c.relforcerowsecurity;
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'RLS enabled but not forced on: %', bad;
  END IF;
END $$;
