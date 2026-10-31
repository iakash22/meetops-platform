-- Phase 7: calendar_connections. One connected calendar account per (organization, user, provider account).
-- OAuth tokens are stored only as TokenCipher envelopes ('v1.<keyId>.<wrappedKey>.<iv|ct|tag>', AES-256-GCM,
-- AAD = org + connection id). Plaintext never reaches the database. Additive only; tenant isolation is forced.
--
-- Disconnect is a soft delete (the app role has no DELETE): status 'revoked', revoked_at stamped and both token
-- columns wiped to NULL in one UPDATE (enforced by the revoked-wipe CHECK).

-- CreateEnum
CREATE TYPE "CalendarConnectionStatus" AS ENUM ('active', 'error', 'revoked');

-- CreateTable
CREATE TABLE "calendar_connections" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "provider" TEXT NOT NULL,
    "status" "CalendarConnectionStatus" NOT NULL DEFAULT 'active',
    "display_name" TEXT NOT NULL,
    "external_account_id" TEXT NOT NULL,
    "access_token_enc" TEXT,
    "refresh_token_enc" TEXT,
    "token_key_id" TEXT NOT NULL,
    "access_token_expires_at" TIMESTAMPTZ(3),
    "revoked_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "calendar_connections_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "calendar_connections_org_id_id_key" ON "calendar_connections"("org_id", "id");
CREATE UNIQUE INDEX "calendar_connections_org_id_user_id_provider_external_account_id_key" ON "calendar_connections"("org_id", "user_id", "provider", "external_account_id");
CREATE INDEX "calendar_connections_org_id_user_id_idx" ON "calendar_connections"("org_id", "user_id");
CREATE INDEX "calendar_connections_token_key_id_idx" ON "calendar_connections"("token_key_id");

ALTER TABLE "calendar_connections" ADD CONSTRAINT "calendar_connections_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "calendar_connections" ADD CONSTRAINT "calendar_connections_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "calendar_connections"
  ADD CONSTRAINT "calendar_connections_provider_check" CHECK ("provider" IN ('google')),
  ADD CONSTRAINT "calendar_connections_access_token_enc_check" CHECK ("access_token_enc" IS NULL OR "access_token_enc" ~ '^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$'),
  ADD CONSTRAINT "calendar_connections_refresh_token_enc_check" CHECK ("refresh_token_enc" IS NULL OR "refresh_token_enc" ~ '^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$'),
  ADD CONSTRAINT "calendar_connections_external_account_id_not_blank_check" CHECK (btrim("external_account_id") <> ''),
  ADD CONSTRAINT "calendar_connections_token_key_id_not_blank_check" CHECK (btrim("token_key_id") <> ''),
  ADD CONSTRAINT "calendar_connections_revoked_wipe_check" CHECK (
    ("status" = 'revoked' AND "revoked_at" IS NOT NULL AND "access_token_enc" IS NULL AND "refresh_token_enc" IS NULL)
    OR ("status" <> 'revoked' AND "revoked_at" IS NULL AND "access_token_enc" IS NOT NULL));

-- Tenant isolation, forced (canonical ADR-010 setting only; fail-closed when unset).
ALTER TABLE "calendar_connections" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "calendar_connections" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "calendar_connections"
  USING (org_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid);
REVOKE DELETE, TRUNCATE ON TABLE "calendar_connections" FROM meetops_app;
GRANT SELECT, INSERT, UPDATE ON TABLE "calendar_connections" TO meetops_app;

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
