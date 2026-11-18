-- Org consent / retention settings (ADR-019 / ADR-020). One row per organization.
-- Timestamp is after 20261109120000_google_oidc_hardening; do not reuse 20261104200000.

CREATE TABLE "organization_consent_settings" (
    "org_id" UUID NOT NULL,
    "mode" "ConsentMethod" NOT NULL DEFAULT 'all_parties_consented',
    "notice_text" TEXT NOT NULL,
    "skip_external_participants" BOOLEAN NOT NULL,
    "retention_days" INTEGER NOT NULL DEFAULT 90,
    "current_consent_version" TEXT NOT NULL,
    "updated_by_id" UUID,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "organization_consent_settings_pkey" PRIMARY KEY ("org_id")
);

CREATE INDEX "organization_consent_settings_updated_by_id_idx"
  ON "organization_consent_settings"("updated_by_id");

ALTER TABLE "organization_consent_settings"
  ADD CONSTRAINT "organization_consent_settings_org_id_fkey"
  FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "organization_consent_settings"
  ADD CONSTRAINT "organization_consent_settings_updated_by_id_fkey"
  FOREIGN KEY ("updated_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "organization_consent_settings"
  ADD CONSTRAINT "organization_consent_settings_notice_text_check"
    CHECK (char_length("notice_text") BETWEEN 1 AND 4000),
  -- Whitespace-only notices are rejected here as well as in the contract (trimmed, non-empty). btrim's default
  -- strips only spaces, so tabs, newlines and other ASCII whitespace are listed explicitly.
  ADD CONSTRAINT "organization_consent_settings_notice_text_not_blank_check"
    CHECK (char_length(btrim("notice_text", E' \t\n\r\f\v')) >= 1),
  ADD CONSTRAINT "organization_consent_settings_retention_days_check"
    CHECK ("retention_days" BETWEEN 7 AND 365),
  ADD CONSTRAINT "organization_consent_settings_consent_version_check"
    CHECK ("current_consent_version" ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$');

-- Tenant isolation, forced (canonical ADR-010 setting only; fail-closed when unset).
ALTER TABLE "organization_consent_settings" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "organization_consent_settings" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "organization_consent_settings"
  USING (org_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid);

REVOKE ALL ON TABLE "organization_consent_settings" FROM meetops_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "organization_consent_settings" TO meetops_app;

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
