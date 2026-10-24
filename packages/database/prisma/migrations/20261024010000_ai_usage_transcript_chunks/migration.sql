-- AI usage, AI config/idempotency and chunked transcripts. Additive only: new enums, tables and nullable or
-- defaulted columns only; nothing existing is removed or rewritten (the transcripts default is a fast default).
-- Tenant key: Prisma organizationId -> column org_id (ADR-004 3a, ADR-010).

-- CreateEnum
CREATE TYPE "AiUsagePeriodKind" AS ENUM ('day', 'month');

-- CreateEnum
CREATE TYPE "AiIdempotencyStatus" AS ENUM ('pending', 'succeeded', 'failed');

-- CreateEnum
CREATE TYPE "TranscriptChunkStatus" AS ENUM ('pending', 'processing', 'done', 'failed');

-- CreateEnum
CREATE TYPE "TranscriptMergeStatus" AS ENUM ('pending', 'merging', 'merged', 'failed');

-- AlterTable
ALTER TABLE "ai_runs" ADD COLUMN     "audio_seconds" DECIMAL(10,3);

-- AlterTable
ALTER TABLE "transcripts" ADD COLUMN     "merge_status" "TranscriptMergeStatus" NOT NULL DEFAULT 'pending',
ADD COLUMN     "merged_at" TIMESTAMPTZ(3);

-- CreateTable
CREATE TABLE "ai_usage_counters" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "provider" TEXT NOT NULL,
    "period_kind" "AiUsagePeriodKind" NOT NULL,
    "period_start" DATE NOT NULL,
    "requests" INTEGER NOT NULL DEFAULT 0,
    "input_tokens" BIGINT NOT NULL DEFAULT 0,
    "output_tokens" BIGINT NOT NULL DEFAULT 0,
    "audio_seconds" DECIMAL(12,3) NOT NULL DEFAULT 0,
    "cost_usd" DECIMAL(12,6) NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_usage_counters_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_org_config" (
    "org_id" UUID NOT NULL,
    "config" JSONB NOT NULL DEFAULT '{}',
    "monthly_budget_usd" DECIMAL(12,2),
    "updated_by_id" UUID,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_org_config_pkey" PRIMARY KEY ("org_id")
);

-- CreateTable
CREATE TABLE "ai_idempotency" (
    "org_id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "status" "AiIdempotencyStatus" NOT NULL DEFAULT 'pending',
    "result_ref" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "ai_idempotency_pkey" PRIMARY KEY ("org_id","key")
);

-- CreateTable
CREATE TABLE "transcript_chunks" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "transcript_id" UUID NOT NULL,
    "chunk_index" INTEGER NOT NULL,
    "start_ms" INTEGER NOT NULL,
    "end_ms" INTEGER NOT NULL,
    "status" "TranscriptChunkStatus" NOT NULL DEFAULT 'pending',
    "provider" TEXT NOT NULL,
    "text" TEXT,
    "segments" JSONB,
    "attempt_count" INTEGER NOT NULL DEFAULT 0,
    "error" VARCHAR(500),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "transcript_chunks_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ai_usage_counters_org_id_provider_period_kind_period_start_key" ON "ai_usage_counters"("org_id", "provider", "period_kind", "period_start");

-- CreateIndex
CREATE UNIQUE INDEX "ai_usage_counters_org_id_id_key" ON "ai_usage_counters"("org_id", "id");

-- CreateIndex
CREATE INDEX "ai_org_config_updated_by_id_idx" ON "ai_org_config"("updated_by_id");

-- CreateIndex
CREATE INDEX "ai_idempotency_expires_at_idx" ON "ai_idempotency"("expires_at");

-- CreateIndex
CREATE INDEX "transcript_chunks_org_id_transcript_id_idx" ON "transcript_chunks"("org_id", "transcript_id");

-- CreateIndex
CREATE UNIQUE INDEX "transcript_chunks_transcript_id_chunk_index_key" ON "transcript_chunks"("transcript_id", "chunk_index");

-- CreateIndex
CREATE UNIQUE INDEX "transcript_chunks_org_id_id_key" ON "transcript_chunks"("org_id", "id");

-- AddForeignKey
ALTER TABLE "ai_usage_counters" ADD CONSTRAINT "ai_usage_counters_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_org_config" ADD CONSTRAINT "ai_org_config_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_org_config" ADD CONSTRAINT "ai_org_config_updated_by_id_fkey" FOREIGN KEY ("updated_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_idempotency" ADD CONSTRAINT "ai_idempotency_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transcript_chunks" ADD CONSTRAINT "transcript_chunks_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transcript_chunks" ADD CONSTRAINT "transcript_chunks_org_id_transcript_id_fkey" FOREIGN KEY ("org_id", "transcript_id") REFERENCES "transcripts"("org_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Integrity checks.
ALTER TABLE "ai_org_config"
  ADD CONSTRAINT "ai_org_config_config_object_check" CHECK (jsonb_typeof("config") = 'object'),
  ADD CONSTRAINT "ai_org_config_budget_check" CHECK ("monthly_budget_usd" IS NULL OR "monthly_budget_usd" >= 0);
ALTER TABLE "ai_usage_counters"
  ADD CONSTRAINT "ai_usage_counters_nonnegative_check" CHECK (
    "requests" >= 0 AND "input_tokens" >= 0 AND "output_tokens" >= 0 AND "audio_seconds" >= 0 AND "cost_usd" >= 0
  ),
  ADD CONSTRAINT "ai_usage_counters_period_start_check" CHECK (
    "period_kind" = 'day' OR "period_start" = date_trunc('month', "period_start")::date
  );
ALTER TABLE "ai_runs"
  ADD CONSTRAINT "ai_runs_audio_seconds_check" CHECK ("audio_seconds" IS NULL OR "audio_seconds" >= 0);
ALTER TABLE "ai_idempotency"
  ADD CONSTRAINT "ai_idempotency_key_check" CHECK (length("key") BETWEEN 1 AND 255);
ALTER TABLE "transcript_chunks"
  ADD CONSTRAINT "transcript_chunks_range_check" CHECK ("chunk_index" >= 0 AND "start_ms" >= 0 AND "end_ms" >= "start_ms"),
  ADD CONSTRAINT "transcript_chunks_attempt_count_check" CHECK ("attempt_count" >= 0);

-- Tenant isolation (ADR-010 expression, same as every tenant table), forced; app DML granted explicitly.
ALTER TABLE "ai_usage_counters" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ai_usage_counters" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "ai_usage_counters"
  USING (org_id = COALESCE(NULLIF(current_setting('app.current_organization_id', true), ''), NULLIF(current_setting('app.current_org_id', true), ''))::uuid)
  WITH CHECK (org_id = COALESCE(NULLIF(current_setting('app.current_organization_id', true), ''), NULLIF(current_setting('app.current_org_id', true), ''))::uuid);
ALTER TABLE "ai_org_config" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ai_org_config" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "ai_org_config"
  USING (org_id = COALESCE(NULLIF(current_setting('app.current_organization_id', true), ''), NULLIF(current_setting('app.current_org_id', true), ''))::uuid)
  WITH CHECK (org_id = COALESCE(NULLIF(current_setting('app.current_organization_id', true), ''), NULLIF(current_setting('app.current_org_id', true), ''))::uuid);
ALTER TABLE "ai_idempotency" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ai_idempotency" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "ai_idempotency"
  USING (org_id = COALESCE(NULLIF(current_setting('app.current_organization_id', true), ''), NULLIF(current_setting('app.current_org_id', true), ''))::uuid)
  WITH CHECK (org_id = COALESCE(NULLIF(current_setting('app.current_organization_id', true), ''), NULLIF(current_setting('app.current_org_id', true), ''))::uuid);
ALTER TABLE "transcript_chunks" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "transcript_chunks" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "transcript_chunks"
  USING (org_id = COALESCE(NULLIF(current_setting('app.current_organization_id', true), ''), NULLIF(current_setting('app.current_org_id', true), ''))::uuid)
  WITH CHECK (org_id = COALESCE(NULLIF(current_setting('app.current_organization_id', true), ''), NULLIF(current_setting('app.current_org_id', true), ''))::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "ai_usage_counters", "ai_org_config", "ai_idempotency", "transcript_chunks" TO meetops_app;
