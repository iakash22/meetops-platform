-- Contracts v0.2 recording sessions (chunked browser upload). Separate tables, not a column on
-- recordings: a session exists before any file object (recordings.file_object_id is NOT NULL),
-- carries transport state (running bytes, chunk manifest, abort reason), and an aborted session
-- never produces a recording. On complete it links recording_id; status then follows the recording.

-- CreateEnum
CREATE TYPE "RecordingSource" AS ENUM ('tab');

-- CreateEnum
CREATE TYPE "RecordingSessionStatus" AS ENUM ('uploading', 'completed', 'aborted', 'failed');

-- CreateEnum
CREATE TYPE "RecordingAbortReason" AS ENUM ('user_stopped', 'consent_revoked', 'tab_closed', 'local_storage_exhausted', 'error');

-- CreateTable
CREATE TABLE "recording_sessions" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "meeting_id" UUID NOT NULL,
    "created_by_id" UUID,
    "recording_id" UUID,
    "mime_type" TEXT NOT NULL,
    "source" "RecordingSource" NOT NULL DEFAULT 'tab',
    "status" "RecordingSessionStatus" NOT NULL DEFAULT 'uploading',
    "abort_reason" "RecordingAbortReason",
    "started_at" TIMESTAMPTZ(3) NOT NULL,
    "chunk_count" INTEGER,
    "duration_ms" INTEGER,
    "total_bytes" BIGINT NOT NULL DEFAULT 0,
    "failure_code" TEXT,
    "completed_at" TIMESTAMPTZ(3),
    "aborted_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "recording_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "recording_session_chunks" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "session_id" UUID NOT NULL,
    "seq" INTEGER NOT NULL,
    "size_bytes" INTEGER NOT NULL,
    "sha256" TEXT,
    "storage_key" TEXT NOT NULL,
    "uploaded_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "recording_session_chunks_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "recording_sessions_recording_id_key" ON "recording_sessions"("recording_id");

-- CreateIndex
CREATE INDEX "recording_sessions_org_id_meeting_id_idx" ON "recording_sessions"("org_id", "meeting_id");

-- CreateIndex
CREATE INDEX "recording_sessions_org_id_status_idx" ON "recording_sessions"("org_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "recording_sessions_org_id_id_key" ON "recording_sessions"("org_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "recording_sessions_org_id_recording_id_key" ON "recording_sessions"("org_id", "recording_id");

-- CreateIndex
CREATE UNIQUE INDEX "recording_session_chunks_storage_key_key" ON "recording_session_chunks"("storage_key");

-- CreateIndex
CREATE INDEX "recording_session_chunks_org_id_session_id_idx" ON "recording_session_chunks"("org_id", "session_id");

-- CreateIndex
CREATE UNIQUE INDEX "recording_session_chunks_org_id_id_key" ON "recording_session_chunks"("org_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "recording_session_chunks_session_id_seq_key" ON "recording_session_chunks"("session_id", "seq");

-- AddForeignKey
ALTER TABLE "recording_sessions" ADD CONSTRAINT "recording_sessions_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recording_sessions" ADD CONSTRAINT "recording_sessions_org_id_meeting_id_fkey" FOREIGN KEY ("org_id", "meeting_id") REFERENCES "meetings"("org_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recording_sessions" ADD CONSTRAINT "recording_sessions_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recording_sessions" ADD CONSTRAINT "recording_sessions_org_id_recording_id_fkey" FOREIGN KEY ("org_id", "recording_id") REFERENCES "recordings"("org_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recording_session_chunks" ADD CONSTRAINT "recording_session_chunks_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recording_session_chunks" ADD CONSTRAINT "recording_session_chunks_org_id_session_id_fkey" FOREIGN KEY ("org_id", "session_id") REFERENCES "recording_sessions"("org_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Contract limits (MAX_RECORDING_CHUNKS = 10000, MAX_CHUNK_BYTES = 64 MiB, MAX_RECORDING_SESSION_BYTES = 2e9).
ALTER TABLE "recording_sessions"
  ADD CONSTRAINT "recording_sessions_chunk_count_check" CHECK ("chunk_count" IS NULL OR "chunk_count" BETWEEN 1 AND 10000),
  ADD CONSTRAINT "recording_sessions_duration_ms_check" CHECK ("duration_ms" IS NULL OR "duration_ms" BETWEEN 0 AND 86400000),
  ADD CONSTRAINT "recording_sessions_total_bytes_check" CHECK ("total_bytes" BETWEEN 0 AND 2000000000),
  ADD CONSTRAINT "recording_sessions_abort_check" CHECK (("status" = 'aborted') = ("abort_reason" IS NOT NULL)),
  ADD CONSTRAINT "recording_sessions_completed_check" CHECK ("status" <> 'completed' OR ("recording_id" IS NOT NULL AND "chunk_count" IS NOT NULL));
ALTER TABLE "recording_session_chunks"
  ADD CONSTRAINT "recording_session_chunks_seq_check" CHECK ("seq" BETWEEN 0 AND 9999),
  ADD CONSTRAINT "recording_session_chunks_size_check" CHECK ("size_bytes" BETWEEN 1 AND 67108864),
  ADD CONSTRAINT "recording_session_chunks_sha256_check" CHECK ("sha256" IS NULL OR "sha256" ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT "recording_session_chunks_key_check" CHECK ("storage_key" LIKE 'org/' || "org_id"::text || '/%');

-- Tenant isolation (same policy as every tenant table), forced; app DML via default privileges, re-granted here.
ALTER TABLE "recording_sessions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "recording_sessions" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "recording_sessions"
  USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);
ALTER TABLE "recording_session_chunks" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "recording_session_chunks" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "recording_session_chunks"
  USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "recording_sessions", "recording_session_chunks" TO meetops_app;
