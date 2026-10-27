-- ADR-013: notifications, per-attempt delivery log, preferences and push device tokens.
-- Additive only: three enums and four new tenant tables. Tenant key: Prisma organizationId -> org_id (ADR-010).
-- Links between tenant rows are composite (org_id, id) FKs. Push tokens are stored encrypted (ADR-008) plus a
-- SHA-256 hash; nothing here stores message bodies.

-- CreateEnum
CREATE TYPE "NotificationChannel" AS ENUM ('in_app', 'email', 'web_push', 'mobile_push', 'desktop');

-- CreateEnum
CREATE TYPE "NotificationDeliveryStatus" AS ENUM ('pending', 'sent', 'failed', 'skipped');

-- CreateEnum
CREATE TYPE "PushPlatform" AS ENUM ('web', 'extension', 'ios', 'android');

-- CreateTable
CREATE TABLE "notifications" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "subject_type" TEXT,
    "subject_id" UUID,
    "data" JSONB NOT NULL DEFAULT '{}',
    "dedupe_key" TEXT NOT NULL,
    "read_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification_delivery_attempts" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "notification_id" UUID NOT NULL,
    "channel" "NotificationChannel" NOT NULL,
    "delivery_key" TEXT NOT NULL,
    "attempt" INTEGER NOT NULL DEFAULT 1,
    "status" "NotificationDeliveryStatus" NOT NULL DEFAULT 'pending',
    "push_device_token_id" UUID,
    "provider_message_id" TEXT,
    "error_code" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMPTZ(3),

    CONSTRAINT "notification_delivery_attempts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification_preferences" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "channel" "NotificationChannel" NOT NULL,
    "enabled" BOOLEAN NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "notification_preferences_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "push_device_tokens" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "platform" "PushPlatform" NOT NULL,
    "token_hash" TEXT NOT NULL,
    "token_enc" TEXT,
    "token_key_id" TEXT,
    "label" TEXT,
    "last_seen_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revoked_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "push_device_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "notifications_org_id_user_id_created_at_idx" ON "notifications"("org_id", "user_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "notifications_org_id_user_id_read_at_idx" ON "notifications"("org_id", "user_id", "read_at");

-- CreateIndex
CREATE UNIQUE INDEX "notifications_org_id_id_key" ON "notifications"("org_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "notifications_org_id_user_id_dedupe_key_key" ON "notifications"("org_id", "user_id", "dedupe_key");

-- CreateIndex
CREATE INDEX "notification_delivery_attempts_org_id_notification_id_idx" ON "notification_delivery_attempts"("org_id", "notification_id");

-- CreateIndex
CREATE UNIQUE INDEX "notification_delivery_attempts_org_id_id_key" ON "notification_delivery_attempts"("org_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "notification_delivery_attempts_org_id_delivery_key_attempt_key" ON "notification_delivery_attempts"("org_id", "delivery_key", "attempt");

-- CreateIndex
CREATE UNIQUE INDEX "notification_preferences_org_id_id_key" ON "notification_preferences"("org_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "notification_preferences_org_id_user_id_type_channel_key" ON "notification_preferences"("org_id", "user_id", "type", "channel");

-- CreateIndex
CREATE INDEX "push_device_tokens_org_id_user_id_idx" ON "push_device_tokens"("org_id", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX "push_device_tokens_org_id_id_key" ON "push_device_tokens"("org_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "push_device_tokens_org_id_token_hash_key" ON "push_device_tokens"("org_id", "token_hash");

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification_delivery_attempts" ADD CONSTRAINT "notification_delivery_attempts_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification_delivery_attempts" ADD CONSTRAINT "notification_delivery_attempts_org_id_notification_id_fkey" FOREIGN KEY ("org_id", "notification_id") REFERENCES "notifications"("org_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification_preferences" ADD CONSTRAINT "notification_preferences_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification_preferences" ADD CONSTRAINT "notification_preferences_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "push_device_tokens" ADD CONSTRAINT "push_device_tokens_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "push_device_tokens" ADD CONSTRAINT "push_device_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Integrity checks: identifiers are never blank; attempts start at 1; an encrypted token always has its key id.
ALTER TABLE "notifications"
  ADD CONSTRAINT "notifications_type_not_blank_check" CHECK (btrim("type") <> ''),
  ADD CONSTRAINT "notifications_dedupe_key_not_blank_check" CHECK (btrim("dedupe_key") <> '');
ALTER TABLE "notification_delivery_attempts"
  ADD CONSTRAINT "notification_delivery_attempts_attempt_check" CHECK ("attempt" >= 1),
  ADD CONSTRAINT "notification_delivery_attempts_error_code_len_check" CHECK ("error_code" IS NULL OR char_length("error_code") <= 64);
ALTER TABLE "notification_preferences"
  ADD CONSTRAINT "notification_preferences_type_not_blank_check" CHECK (btrim("type") <> '');
ALTER TABLE "push_device_tokens"
  ADD CONSTRAINT "push_device_tokens_token_hash_check" CHECK ("token_hash" ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT "push_device_tokens_token_key_check" CHECK (("token_enc" IS NULL) = ("token_key_id" IS NULL));

-- Tenant isolation, forced, canonical ADR-010 setting only (fail-closed: unset or '' => no rows, writes rejected).
ALTER TABLE "notifications" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "notifications" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "notifications"
  USING (org_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid);
ALTER TABLE "notification_delivery_attempts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "notification_delivery_attempts" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "notification_delivery_attempts"
  USING (org_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid);
ALTER TABLE "notification_preferences" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "notification_preferences" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "notification_preferences"
  USING (org_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid);
ALTER TABLE "push_device_tokens" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "push_device_tokens" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "push_device_tokens"
  USING (org_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid);

-- Owner-only rows (security review C, finding 3): when a request also sets app.current_user_id, a RESTRICTIVE policy
-- limits user-owned rows to that user. Org-level jobs (fan-out worker) run with the org context only and are still
-- bound by tenant_isolation above.
CREATE POLICY owner_only ON "notifications" AS RESTRICTIVE
  USING (NULLIF(current_setting('app.current_user_id', true), '')::uuid IS NULL OR user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid)
  WITH CHECK (NULLIF(current_setting('app.current_user_id', true), '')::uuid IS NULL OR user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid);
CREATE POLICY owner_only ON "notification_preferences" AS RESTRICTIVE
  USING (NULLIF(current_setting('app.current_user_id', true), '')::uuid IS NULL OR user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid)
  WITH CHECK (NULLIF(current_setting('app.current_user_id', true), '')::uuid IS NULL OR user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid);
CREATE POLICY owner_only ON "push_device_tokens" AS RESTRICTIVE
  USING (NULLIF(current_setting('app.current_user_id', true), '')::uuid IS NULL OR user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid)
  WITH CHECK (NULLIF(current_setting('app.current_user_id', true), '')::uuid IS NULL OR user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "notifications", "notification_delivery_attempts", "notification_preferences", "push_device_tokens" TO meetops_app;

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
