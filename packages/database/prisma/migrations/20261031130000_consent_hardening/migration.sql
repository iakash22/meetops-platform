-- Consent hardening. ADDITIVE ONLY: two CHECK constraints, one sequence column, one index.

-- contracts CONSENT_ATTESTATION_MAX_BACKDATE_SECONDS: a client attestation may be at most 24 h older than the server
-- receive time. NOT VALID: enforced for every new row (both tables are append-only) without rejecting legacy rows.
ALTER TABLE "consent_attestations"
  ADD CONSTRAINT "consent_attestations_attested_at_backdate_check"
    CHECK ("attested_at" >= "recorded_at" - interval '86400 seconds') NOT VALID;
ALTER TABLE "meeting_consent_events"
  ADD CONSTRAINT "meeting_consent_events_occurred_at_backdate_check"
    CHECK ("occurred_at" >= "recorded_at" - interval '86400 seconds') NOT VALID;

-- DB-assigned insertion order for the meeting consent ledger: the list and enforcement order by "seq", not by the
-- app-clock "recorded_at". Rows that existed before this migration get sequence values in physical order. The
-- default privileges from 20261021110000_tenant_rls_roles grant meetops_app USAGE on the new sequence.
-- AlterTable
ALTER TABLE "meeting_consent_events" ADD COLUMN "seq" BIGSERIAL NOT NULL;

-- CreateIndex
CREATE INDEX IF NOT EXISTS "meeting_consent_events_org_id_meeting_id_seq_idx" ON "meeting_consent_events"("org_id", "meeting_id", "seq");

-- Explicit too, in case the migration does not run as meetops_migrator (default privileges would not apply).
GRANT USAGE, SELECT ON SEQUENCE "meeting_consent_events_seq_seq" TO meetops_app;
