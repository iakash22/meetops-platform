-- Phase 5 (ADR-008): integration_connections. One connected provider account per organization, with its
-- OAuth tokens and per-connection webhook secret stored only as TokenCipher envelopes
-- ('v1.<keyId>.<wrappedKey>.<iv|ct|tag>', AES-256-GCM, AAD = org + integration id). Plaintext never reaches the
-- database. Additive only; tenant isolation is forced like every other tenant table.

-- CreateEnum
CREATE TYPE "IntegrationConnectionStatus" AS ENUM ('active', 'error', 'revoked');

-- CreateTable
CREATE TABLE "integration_connections" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "provider" TEXT NOT NULL,
    "status" "IntegrationConnectionStatus" NOT NULL DEFAULT 'active',
    "display_name" TEXT NOT NULL,
    "external_account_id" TEXT NOT NULL,
    "connected_by_id" UUID,
    "access_token_enc" TEXT NOT NULL,
    "refresh_token_enc" TEXT,
    "webhook_secret_enc" TEXT NOT NULL,
    "token_key_id" TEXT NOT NULL,
    "access_token_expires_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "integration_connections_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "integration_connections_token_key_id_idx" ON "integration_connections"("token_key_id");

-- CreateIndex
CREATE UNIQUE INDEX "integration_connections_org_id_id_key" ON "integration_connections"("org_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "integration_connections_org_id_provider_external_account_id_key" ON "integration_connections"("org_id", "provider", "external_account_id");

-- AddForeignKey
ALTER TABLE "integration_connections" ADD CONSTRAINT "integration_connections_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Integrity checks: secrets must look like a v1 envelope (never plaintext); names and ids are never blank.
ALTER TABLE "integration_connections"
  ADD CONSTRAINT "integration_connections_access_token_enc_check" CHECK ("access_token_enc" ~ '^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$'),
  ADD CONSTRAINT "integration_connections_refresh_token_enc_check" CHECK ("refresh_token_enc" IS NULL OR "refresh_token_enc" ~ '^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$'),
  ADD CONSTRAINT "integration_connections_webhook_secret_enc_check" CHECK ("webhook_secret_enc" ~ '^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$'),
  ADD CONSTRAINT "integration_connections_provider_not_blank_check" CHECK (btrim("provider") <> ''),
  ADD CONSTRAINT "integration_connections_external_account_id_not_blank_check" CHECK (btrim("external_account_id") <> ''),
  ADD CONSTRAINT "integration_connections_token_key_id_not_blank_check" CHECK (btrim("token_key_id") <> '');

-- Tenant isolation, forced (canonical ADR-010 setting only; fail-closed when unset).
ALTER TABLE "integration_connections" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "integration_connections" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "integration_connections"
  USING (org_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "integration_connections" TO meetops_app;

-- Re-run the forced-RLS catalog assertion so this migration fails loudly if any RLS-enabled table is unforced.
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
