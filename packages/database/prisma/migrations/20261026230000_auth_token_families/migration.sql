-- ADR-005 A1.2 (and ADR-012 once accepted): durable bearer-token devices, refresh families and refresh-token hashes.
-- Additive only: one new enum, three new tenant tables. Nothing existing is removed or rewritten.
-- Only SHA-256 hashes of refresh tokens are stored (CHECK: 64 lowercase hex); plaintext never reaches the database.
-- Access tokens (15 min) and single-use pairing codes stay in Redis (fast path); this is the durable source of truth
-- for families, devices, rotation/reuse state and revocation.
-- Ordering: sorts after 20261026200000_transcript_recording_revision (Phase 3), 20261026210000_recording_source_native
-- and 20261026220000_integration_connections, which are on other unmerged branches. It depends on none of them, so it
-- can merge before or after them; whichever lands last updates the security test's "latest migration" assertion.

-- CreateEnum
CREATE TYPE "AuthTokenAudience" AS ENUM ('extension', 'desktop');

-- CreateTable
CREATE TABLE "auth_devices" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "audience" "AuthTokenAudience" NOT NULL,
    "client_id" TEXT NOT NULL,
    "device_id" UUID NOT NULL,
    "label" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "auth_devices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "auth_token_families" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "auth_device_id" UUID NOT NULL,
    "audience" "AuthTokenAudience" NOT NULL,
    "scopes" TEXT[],
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "max_expires_at" TIMESTAMPTZ(3) NOT NULL,
    "revoked_at" TIMESTAMPTZ(3),

    CONSTRAINT "auth_token_families_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "auth_refresh_tokens" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "family_id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "consumed_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "auth_refresh_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "auth_devices_org_id_user_id_idx" ON "auth_devices"("org_id", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX "auth_devices_org_id_id_key" ON "auth_devices"("org_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "auth_devices_org_id_user_id_audience_client_id_device_id_key" ON "auth_devices"("org_id", "user_id", "audience", "client_id", "device_id");

-- CreateIndex
CREATE INDEX "auth_token_families_org_id_user_id_idx" ON "auth_token_families"("org_id", "user_id");

-- CreateIndex
CREATE INDEX "auth_token_families_org_id_auth_device_id_idx" ON "auth_token_families"("org_id", "auth_device_id");

-- CreateIndex
CREATE UNIQUE INDEX "auth_token_families_org_id_id_key" ON "auth_token_families"("org_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "auth_refresh_tokens_token_hash_key" ON "auth_refresh_tokens"("token_hash");

-- CreateIndex
CREATE INDEX "auth_refresh_tokens_org_id_family_id_idx" ON "auth_refresh_tokens"("org_id", "family_id");

-- CreateIndex
CREATE UNIQUE INDEX "auth_refresh_tokens_org_id_id_key" ON "auth_refresh_tokens"("org_id", "id");

-- AddForeignKey
ALTER TABLE "auth_devices" ADD CONSTRAINT "auth_devices_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "auth_devices" ADD CONSTRAINT "auth_devices_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "auth_token_families" ADD CONSTRAINT "auth_token_families_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "auth_token_families" ADD CONSTRAINT "auth_token_families_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "auth_token_families" ADD CONSTRAINT "auth_token_families_org_id_auth_device_id_fkey" FOREIGN KEY ("org_id", "auth_device_id") REFERENCES "auth_devices"("org_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "auth_refresh_tokens" ADD CONSTRAINT "auth_refresh_tokens_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "auth_refresh_tokens" ADD CONSTRAINT "auth_refresh_tokens_org_id_family_id_fkey" FOREIGN KEY ("org_id", "family_id") REFERENCES "auth_token_families"("org_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;
-- Integrity checks.
ALTER TABLE "auth_refresh_tokens"
  ADD CONSTRAINT "auth_refresh_tokens_token_hash_sha256_check" CHECK ("token_hash" ~ '^[0-9a-f]{64}$');
ALTER TABLE "auth_devices"
  ADD CONSTRAINT "auth_devices_client_id_not_blank_check" CHECK (btrim("client_id") <> ''),
  ADD CONSTRAINT "auth_devices_label_length_check" CHECK ("label" IS NULL OR char_length("label") <= 100);
ALTER TABLE "auth_token_families"
  ADD CONSTRAINT "auth_token_families_lifetime_check" CHECK ("max_expires_at" > "created_at");

-- Tenant isolation, forced, ADR-010 setting only (no legacy fallback). Fail-closed: unset or '' => NULL => no rows.
ALTER TABLE "auth_devices" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "auth_devices" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "auth_devices"
  USING (org_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid);
ALTER TABLE "auth_token_families" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "auth_token_families" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "auth_token_families"
  USING (org_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid);
ALTER TABLE "auth_refresh_tokens" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "auth_refresh_tokens" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "auth_refresh_tokens"
  USING (org_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid);
-- No DELETE for the app: revocation and rotation are UPDATEs, so reuse evidence is kept.
GRANT SELECT, INSERT, UPDATE ON TABLE "auth_devices", "auth_token_families", "auth_refresh_tokens" TO meetops_app;

-- Re-run the forced-RLS catalog assertion (20261022034000_assert_forced_rls).
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
