-- Hand-edited from `prisma migrate diff` so existing data survives: in-place enum RENAME VALUE,
-- table/column/index/constraint renames instead of DROP/CREATE, and data backfills.
-- CreateEnum
CREATE TYPE "TaskStatus" AS ENUM ('todo', 'in_progress', 'done', 'cancelled');

-- CreateEnum
CREATE TYPE "StorageObjectKind" AS ENUM ('raw', 'normalized', 'chunk');

-- CreateEnum
CREATE TYPE "MeetingSource" AS ENUM ('upload', 'extension', 'desktop', 'bot');

-- CreateEnum
CREATE TYPE "RecordingStatus" AS ENUM ('uploading', 'uploaded', 'processing', 'ready', 'failed');

-- CreateEnum
CREATE TYPE "StorageObjectStatus" AS ENUM ('pending_upload', 'uploaded', 'processing', 'ready', 'failed');

-- AlterEnum (in place: keeps data, defaults and dependent columns)
ALTER TYPE "MembershipRole" RENAME VALUE 'OWNER' TO 'owner';
ALTER TYPE "MembershipRole" RENAME VALUE 'ADMIN' TO 'admin';
ALTER TYPE "MembershipRole" RENAME VALUE 'MEMBER' TO 'member';
ALTER TYPE "MembershipRole" RENAME VALUE 'VIEWER' TO 'viewer';

-- AlterEnum (in place: keeps data, defaults and dependent columns)
ALTER TYPE "InvitationStatus" RENAME VALUE 'PENDING' TO 'pending';
ALTER TYPE "InvitationStatus" RENAME VALUE 'ACCEPTED' TO 'accepted';
ALTER TYPE "InvitationStatus" RENAME VALUE 'REVOKED' TO 'revoked';
ALTER TYPE "InvitationStatus" RENAME VALUE 'EXPIRED' TO 'expired';

-- AlterEnum (in place: keeps data, defaults and dependent columns)
ALTER TYPE "ProjectStatus" RENAME VALUE 'ACTIVE' TO 'active';
ALTER TYPE "ProjectStatus" RENAME VALUE 'ARCHIVED' TO 'archived';

-- AlterEnum
BEGIN;
CREATE TYPE "MeetingStatus_new" AS ENUM ('scheduled', 'recording', 'processing', 'completed', 'failed');
ALTER TABLE "meetings" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "meetings" ALTER COLUMN "status" TYPE "MeetingStatus_new" USING ((CASE "status"::text WHEN 'UPLOADED' THEN 'processing' WHEN 'TRANSCRIBING' THEN 'processing' ELSE lower("status"::text) END)::"MeetingStatus_new");
ALTER TYPE "MeetingStatus" RENAME TO "MeetingStatus_old";
ALTER TYPE "MeetingStatus_new" RENAME TO "MeetingStatus";
DROP TYPE "MeetingStatus_old";
ALTER TABLE "meetings" ALTER COLUMN "status" SET DEFAULT 'scheduled';
COMMIT;

-- AlterEnum (in place: keeps data, defaults and dependent columns)
ALTER TYPE "MeetingParticipantRole" RENAME VALUE 'HOST' TO 'host';
ALTER TYPE "MeetingParticipantRole" RENAME VALUE 'ATTENDEE' TO 'attendee';
ALTER TYPE "MeetingParticipantRole" RENAME VALUE 'GUEST' TO 'guest';

-- AlterEnum (in place: keeps data, defaults and dependent columns)
ALTER TYPE "TranscriptStatus" RENAME VALUE 'PENDING' TO 'pending';
ALTER TYPE "TranscriptStatus" RENAME VALUE 'PROCESSING' TO 'processing';
ALTER TYPE "TranscriptStatus" RENAME VALUE 'READY' TO 'ready';
ALTER TYPE "TranscriptStatus" RENAME VALUE 'FAILED' TO 'failed';

-- AlterEnum (in place: keeps data, defaults and dependent columns)
ALTER TYPE "ReportStatus" RENAME VALUE 'DRAFT' TO 'draft';
ALTER TYPE "ReportStatus" RENAME VALUE 'PUBLISHED' TO 'published';
ALTER TYPE "ReportStatus" RENAME VALUE 'ARCHIVED' TO 'archived';

-- AlterEnum (in place: keeps data, defaults and dependent columns)
ALTER TYPE "ExtractedTaskStatus" RENAME VALUE 'PENDING_REVIEW' TO 'pending_review';
ALTER TYPE "ExtractedTaskStatus" RENAME VALUE 'APPROVED' TO 'approved';
ALTER TYPE "ExtractedTaskStatus" RENAME VALUE 'REJECTED' TO 'rejected';
ALTER TYPE "ExtractedTaskStatus" RENAME VALUE 'CONVERTED' TO 'converted';

-- AlterEnum (in place: keeps data, defaults and dependent columns)
ALTER TYPE "TaskPriority" RENAME VALUE 'LOW' TO 'low';
ALTER TYPE "TaskPriority" RENAME VALUE 'MEDIUM' TO 'medium';
ALTER TYPE "TaskPriority" RENAME VALUE 'HIGH' TO 'high';
ALTER TYPE "TaskPriority" RENAME VALUE 'URGENT' TO 'urgent';

-- AlterEnum (in place: keeps data, defaults and dependent columns)
ALTER TYPE "ApprovalDecision" RENAME VALUE 'APPROVED' TO 'approved';
ALTER TYPE "ApprovalDecision" RENAME VALUE 'REJECTED' TO 'rejected';
ALTER TYPE "ApprovalDecision" RENAME VALUE 'CHANGES_REQUESTED' TO 'changes_requested';

-- AlterEnum (in place: keeps data, defaults and dependent columns)
ALTER TYPE "AiRunStatus" RENAME VALUE 'QUEUED' TO 'queued';
ALTER TYPE "AiRunStatus" RENAME VALUE 'RUNNING' TO 'running';
ALTER TYPE "AiRunStatus" RENAME VALUE 'SUCCEEDED' TO 'succeeded';
ALTER TYPE "AiRunStatus" RENAME VALUE 'FAILED' TO 'failed';
ALTER TYPE "AiRunStatus" RENAME VALUE 'CANCELLED' TO 'cancelled';

-- AlterEnum (in place: keeps data, defaults and dependent columns)
ALTER TYPE "AiRunKind" RENAME VALUE 'TRANSCRIPTION' TO 'transcription';
ALTER TYPE "AiRunKind" RENAME VALUE 'SUMMARY' TO 'summary';
ALTER TYPE "AiRunKind" RENAME VALUE 'TASK_EXTRACTION' TO 'task_extraction';
ALTER TYPE "AiRunKind" RENAME VALUE 'EMBEDDING' TO 'embedding';
ALTER TYPE "AiRunKind" RENAME VALUE 'OTHER' TO 'other';

-- AlterEnum (in place: keeps data, defaults and dependent columns)
ALTER TYPE "OutboxStatus" RENAME VALUE 'PENDING' TO 'pending';
ALTER TYPE "OutboxStatus" RENAME VALUE 'PROCESSING' TO 'processing';
ALTER TYPE "OutboxStatus" RENAME VALUE 'PUBLISHED' TO 'published';
ALTER TYPE "OutboxStatus" RENAME VALUE 'FAILED' TO 'failed';

-- DropForeignKey
ALTER TABLE "meetings" DROP CONSTRAINT "meetings_project_id_fkey";

-- DropForeignKey
ALTER TABLE "meetings" DROP CONSTRAINT "meetings_recording_file_id_fkey";

-- DropForeignKey
ALTER TABLE "meeting_participants" DROP CONSTRAINT "meeting_participants_meeting_id_fkey";

-- DropForeignKey
ALTER TABLE "meeting_participants" DROP CONSTRAINT "meeting_participants_employee_id_fkey";

-- DropForeignKey
ALTER TABLE "transcripts" DROP CONSTRAINT "transcripts_meeting_id_fkey";

-- DropForeignKey
ALTER TABLE "transcripts" DROP CONSTRAINT "transcripts_source_file_id_fkey";

-- DropForeignKey
ALTER TABLE "transcript_segments" DROP CONSTRAINT "transcript_segments_transcript_id_fkey";

-- DropForeignKey
ALTER TABLE "transcript_segments" DROP CONSTRAINT "transcript_segments_participant_id_fkey";

-- DropForeignKey
ALTER TABLE "reports" DROP CONSTRAINT "reports_meeting_id_fkey";

-- DropForeignKey
ALTER TABLE "reports" DROP CONSTRAINT "reports_transcript_id_fkey";

-- DropForeignKey
ALTER TABLE "reports" DROP CONSTRAINT "reports_ai_run_id_fkey";

-- DropForeignKey
ALTER TABLE "extracted_tasks" DROP CONSTRAINT "extracted_tasks_meeting_id_fkey";

-- DropForeignKey
ALTER TABLE "extracted_tasks" DROP CONSTRAINT "extracted_tasks_report_id_fkey";

-- DropForeignKey
ALTER TABLE "extracted_tasks" DROP CONSTRAINT "extracted_tasks_ai_run_id_fkey";

-- DropForeignKey
ALTER TABLE "extracted_tasks" DROP CONSTRAINT "extracted_tasks_suggested_assignee_id_fkey";

-- DropForeignKey
ALTER TABLE "task_approvals" DROP CONSTRAINT "task_approvals_extracted_task_id_fkey";

-- DropForeignKey
ALTER TABLE "internal_tasks" DROP CONSTRAINT "internal_tasks_org_id_fkey";

-- DropForeignKey
ALTER TABLE "internal_tasks" DROP CONSTRAINT "internal_tasks_project_id_fkey";

-- DropForeignKey
ALTER TABLE "internal_tasks" DROP CONSTRAINT "internal_tasks_extracted_task_id_fkey";

-- DropForeignKey
ALTER TABLE "internal_tasks" DROP CONSTRAINT "internal_tasks_assignee_id_fkey";

-- DropForeignKey
ALTER TABLE "internal_tasks" DROP CONSTRAINT "internal_tasks_created_by_id_fkey";

-- DropForeignKey
ALTER TABLE "external_issue_links" DROP CONSTRAINT "external_issue_links_org_id_fkey";

-- DropForeignKey
ALTER TABLE "external_issue_links" DROP CONSTRAINT "external_issue_links_internal_task_id_fkey";

-- DropForeignKey
ALTER TABLE "ai_runs" DROP CONSTRAINT "ai_runs_meeting_id_fkey";

-- DropForeignKey
ALTER TABLE "ai_runs" DROP CONSTRAINT "ai_runs_transcript_id_fkey";

-- DropForeignKey
ALTER TABLE "audit_logs" DROP CONSTRAINT "audit_logs_org_id_fkey";

-- DropForeignKey
ALTER TABLE "audit_logs" DROP CONSTRAINT "audit_logs_actor_id_fkey";

-- DropIndex
DROP INDEX "meetings_recording_file_id_key";

-- DropIndex
DROP INDEX "file_objects_bucket_key_key";

-- AlterTable
ALTER TABLE "memberships" ALTER COLUMN "role" SET DEFAULT 'member';

-- AlterTable
ALTER TABLE "sessions" ADD COLUMN     "absolute_expires_at" TIMESTAMPTZ(3),
ADD COLUMN     "auth_level" TEXT NOT NULL DEFAULT 'password',
ADD COLUMN     "last_seen_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
UPDATE "sessions" SET "absolute_expires_at" = "expires_at";
ALTER TABLE "sessions" ALTER COLUMN "absolute_expires_at" SET NOT NULL;

-- AlterTable
ALTER TABLE "invitations" ALTER COLUMN "role" SET DEFAULT 'member',
ALTER COLUMN "status" SET DEFAULT 'pending';

-- AlterTable
ALTER TABLE "projects" ALTER COLUMN "status" SET DEFAULT 'active';

-- CreateTable
CREATE TABLE "recordings" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "meeting_id" UUID NOT NULL,
    "file_object_id" UUID NOT NULL,
    "duration_ms" INTEGER,
    "status" "RecordingStatus" NOT NULL DEFAULT 'uploading',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "deleted_at" TIMESTAMPTZ(3),

    CONSTRAINT "recordings_pkey" PRIMARY KEY ("id")
);

-- Data: one recording per meeting recording file, and per distinct transcript source file.
INSERT INTO "recordings" ("id", "org_id", "meeting_id", "file_object_id", "status", "created_at", "updated_at")
SELECT gen_random_uuid(), m."org_id", m."id", m."recording_file_id", 'ready', now(), now()
FROM "meetings" m WHERE m."recording_file_id" IS NOT NULL;
INSERT INTO "recordings" ("id", "org_id", "meeting_id", "file_object_id", "status", "created_at", "updated_at")
SELECT DISTINCT ON (t."source_file_id") gen_random_uuid(), t."org_id", t."meeting_id", t."source_file_id", 'ready', now(), now()
FROM "transcripts" t
WHERE t."source_file_id" IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM "recordings" r WHERE r."file_object_id" = t."source_file_id");

-- AlterTable
ALTER TABLE "meetings" DROP COLUMN "recording_file_id",
ADD COLUMN     "source" "MeetingSource" NOT NULL DEFAULT 'upload',
ALTER COLUMN "status" SET DEFAULT 'scheduled';

-- AlterTable
ALTER TABLE "meeting_participants" ALTER COLUMN "role" SET DEFAULT 'attendee';

-- AlterTable
ALTER TABLE "file_objects" RENAME COLUMN "key" TO "storage_key";
ALTER TABLE "file_objects" ADD COLUMN     "channels" INTEGER,
ADD COLUMN     "chunk_index" INTEGER,
ADD COLUMN     "duration_seconds" DOUBLE PRECISION,
ADD COLUMN     "etag" TEXT,
ADD COLUMN     "format" TEXT,
ADD COLUMN     "kind" "StorageObjectKind" NOT NULL DEFAULT 'raw',
ADD COLUMN     "meeting_id" UUID,
ADD COLUMN     "parent_object_id" UUID,
ADD COLUMN     "provider" TEXT NOT NULL DEFAULT 's3',
ADD COLUMN     "sample_rate" INTEGER,
ADD COLUMN     "start_seconds" DOUBLE PRECISION,
ADD COLUMN     "status" "StorageObjectStatus" NOT NULL DEFAULT 'pending_upload',
ADD COLUMN     "upload_id" TEXT,
ALTER COLUMN "size_bytes" DROP NOT NULL;
UPDATE "file_objects" f SET "meeting_id" = r."meeting_id", "status" = 'ready' FROM "recordings" r WHERE r."file_object_id" = f."id";
UPDATE "file_objects" SET "status" = 'uploaded' WHERE "status" = 'pending_upload';

-- AlterTable
ALTER TABLE "transcripts" ADD COLUMN     "recording_id" UUID,
ALTER COLUMN "status" SET DEFAULT 'pending';
UPDATE "transcripts" t SET "recording_id" = r."id" FROM "recordings" r WHERE r."file_object_id" = t."source_file_id";
ALTER TABLE "transcripts" DROP COLUMN "source_file_id";

-- AlterTable
ALTER TABLE "reports" ALTER COLUMN "status" SET DEFAULT 'draft';

-- AlterTable
ALTER TABLE "extracted_tasks" ALTER COLUMN "priority" SET DEFAULT 'medium',
ALTER COLUMN "status" SET DEFAULT 'pending_review';

-- AlterTable
ALTER TABLE "ai_runs" ALTER COLUMN "status" SET DEFAULT 'queued';

-- AlterTable
ALTER TABLE "outbox_events" ALTER COLUMN "status" SET DEFAULT 'pending';


-- Rename internal_tasks -> tasks (keeps rows)
ALTER TABLE "internal_tasks" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "internal_tasks" ALTER COLUMN "status" TYPE "TaskStatus"
  USING ((CASE "status"::text WHEN 'BLOCKED' THEN 'in_progress' ELSE lower("status"::text) END)::"TaskStatus");
ALTER TABLE "internal_tasks" ALTER COLUMN "status" SET DEFAULT 'todo';
ALTER TABLE "internal_tasks" ALTER COLUMN "priority" SET DEFAULT 'medium';
DROP TYPE "InternalTaskStatus";
ALTER TABLE "internal_tasks" RENAME TO "tasks";
ALTER TABLE "tasks" RENAME CONSTRAINT "internal_tasks_pkey" TO "tasks_pkey";
ALTER TABLE "tasks" RENAME COLUMN "due_date" TO "due_at";
ALTER TABLE "tasks" ADD COLUMN "meeting_id" UUID;
ALTER INDEX "internal_tasks_extracted_task_id_key" RENAME TO "tasks_extracted_task_id_key";
ALTER INDEX "internal_tasks_org_id_status_idx" RENAME TO "tasks_org_id_status_idx";
ALTER INDEX "internal_tasks_org_id_project_id_idx" RENAME TO "tasks_org_id_project_id_idx";
ALTER INDEX "internal_tasks_org_id_assignee_id_idx" RENAME TO "tasks_org_id_assignee_id_idx";

-- Rename external_issue_links -> integration_issues (keeps rows)
ALTER TABLE "external_issue_links" RENAME TO "integration_issues";
ALTER TABLE "integration_issues" RENAME CONSTRAINT "external_issue_links_pkey" TO "integration_issues_pkey";
ALTER TABLE "integration_issues" RENAME COLUMN "internal_task_id" TO "task_id";
ALTER TABLE "integration_issues" ALTER COLUMN "provider" TYPE TEXT USING lower("provider"::text);
ALTER TABLE "integration_issues" RENAME COLUMN "provider" TO "integration";
DROP TYPE "ExternalProvider";
ALTER INDEX "external_issue_links_org_id_internal_task_id_idx" RENAME TO "integration_issues_org_id_task_id_idx";
ALTER INDEX "external_issue_links_org_id_provider_external_id_key" RENAME TO "integration_issues_org_id_integration_external_id_key";

-- Rename audit_logs -> audit_events (keeps rows)
ALTER TABLE "audit_logs" RENAME TO "audit_events";
ALTER TABLE "audit_events" RENAME CONSTRAINT "audit_logs_pkey" TO "audit_events_pkey";
ALTER TABLE "audit_events" RENAME COLUMN "entity_type" TO "target_type";
ALTER TABLE "audit_events" ALTER COLUMN "entity_id" TYPE TEXT USING "entity_id"::text;
ALTER TABLE "audit_events" RENAME COLUMN "entity_id" TO "target_id";
ALTER TABLE "audit_events" ADD COLUMN "actor_type" TEXT NOT NULL DEFAULT 'user',
ADD COLUMN "user_agent" TEXT;
UPDATE "audit_events" SET "metadata" = '{}' WHERE "metadata" IS NULL;
ALTER TABLE "audit_events" ALTER COLUMN "metadata" SET DEFAULT '{}',
ALTER COLUMN "metadata" SET NOT NULL;
ALTER INDEX "audit_logs_org_id_created_at_idx" RENAME TO "audit_events_org_id_created_at_idx";
ALTER INDEX "audit_logs_org_id_entity_type_entity_id_idx" RENAME TO "audit_events_org_id_target_type_target_id_idx";

-- CreateIndex
CREATE UNIQUE INDEX "recordings_file_object_id_key" ON "recordings"("file_object_id");

-- CreateIndex
CREATE INDEX "recordings_org_id_meeting_id_idx" ON "recordings"("org_id", "meeting_id");

-- CreateIndex
CREATE UNIQUE INDEX "recordings_org_id_id_key" ON "recordings"("org_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "recordings_org_id_file_object_id_key" ON "recordings"("org_id", "file_object_id");

-- CreateIndex
CREATE UNIQUE INDEX "tasks_org_id_id_key" ON "tasks"("org_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "tasks_org_id_extracted_task_id_key" ON "tasks"("org_id", "extracted_task_id");

-- CreateIndex
CREATE UNIQUE INDEX "integration_issues_org_id_id_key" ON "integration_issues"("org_id", "id");

-- CreateIndex
CREATE INDEX "audit_events_org_id_actor_id_idx" ON "audit_events"("org_id", "actor_id");

-- CreateIndex
CREATE UNIQUE INDEX "audit_events_org_id_id_key" ON "audit_events"("org_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "memberships_org_id_id_key" ON "memberships"("org_id", "id");

-- CreateIndex
CREATE INDEX "sessions_active_org_id_idx" ON "sessions"("active_org_id");

-- CreateIndex
CREATE UNIQUE INDEX "invitations_org_id_id_key" ON "invitations"("org_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "employees_org_id_id_key" ON "employees"("org_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "projects_org_id_id_key" ON "projects"("org_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "meetings_org_id_id_key" ON "meetings"("org_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "meeting_participants_org_id_id_key" ON "meeting_participants"("org_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "file_objects_storage_key_key" ON "file_objects"("storage_key");

-- CreateIndex
CREATE INDEX "file_objects_org_id_meeting_id_kind_idx" ON "file_objects"("org_id", "meeting_id", "kind");

-- CreateIndex
CREATE INDEX "file_objects_org_id_status_idx" ON "file_objects"("org_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "file_objects_org_id_id_key" ON "file_objects"("org_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "file_objects_org_id_bucket_storage_key_key" ON "file_objects"("org_id", "bucket", "storage_key");

-- CreateIndex
CREATE UNIQUE INDEX "file_objects_parent_object_id_chunk_index_key" ON "file_objects"("parent_object_id", "chunk_index");

-- CreateIndex
CREATE UNIQUE INDEX "transcripts_org_id_id_key" ON "transcripts"("org_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "transcript_segments_org_id_id_key" ON "transcript_segments"("org_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "reports_org_id_id_key" ON "reports"("org_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "extracted_tasks_org_id_id_key" ON "extracted_tasks"("org_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "task_approvals_org_id_id_key" ON "task_approvals"("org_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "ai_runs_org_id_id_key" ON "ai_runs"("org_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "outbox_events_org_id_id_key" ON "outbox_events"("org_id", "id");

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_active_org_id_fkey" FOREIGN KEY ("active_org_id") REFERENCES "organizations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "meetings" ADD CONSTRAINT "meetings_org_id_project_id_fkey" FOREIGN KEY ("org_id", "project_id") REFERENCES "projects"("org_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "meeting_participants" ADD CONSTRAINT "meeting_participants_org_id_meeting_id_fkey" FOREIGN KEY ("org_id", "meeting_id") REFERENCES "meetings"("org_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "meeting_participants" ADD CONSTRAINT "meeting_participants_org_id_employee_id_fkey" FOREIGN KEY ("org_id", "employee_id") REFERENCES "employees"("org_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "file_objects" ADD CONSTRAINT "file_objects_org_id_meeting_id_fkey" FOREIGN KEY ("org_id", "meeting_id") REFERENCES "meetings"("org_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "file_objects" ADD CONSTRAINT "file_objects_org_id_parent_object_id_fkey" FOREIGN KEY ("org_id", "parent_object_id") REFERENCES "file_objects"("org_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recordings" ADD CONSTRAINT "recordings_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recordings" ADD CONSTRAINT "recordings_org_id_meeting_id_fkey" FOREIGN KEY ("org_id", "meeting_id") REFERENCES "meetings"("org_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recordings" ADD CONSTRAINT "recordings_org_id_file_object_id_fkey" FOREIGN KEY ("org_id", "file_object_id") REFERENCES "file_objects"("org_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transcripts" ADD CONSTRAINT "transcripts_org_id_meeting_id_fkey" FOREIGN KEY ("org_id", "meeting_id") REFERENCES "meetings"("org_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transcripts" ADD CONSTRAINT "transcripts_org_id_recording_id_fkey" FOREIGN KEY ("org_id", "recording_id") REFERENCES "recordings"("org_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transcript_segments" ADD CONSTRAINT "transcript_segments_org_id_transcript_id_fkey" FOREIGN KEY ("org_id", "transcript_id") REFERENCES "transcripts"("org_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transcript_segments" ADD CONSTRAINT "transcript_segments_org_id_participant_id_fkey" FOREIGN KEY ("org_id", "participant_id") REFERENCES "meeting_participants"("org_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reports" ADD CONSTRAINT "reports_org_id_meeting_id_fkey" FOREIGN KEY ("org_id", "meeting_id") REFERENCES "meetings"("org_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reports" ADD CONSTRAINT "reports_org_id_transcript_id_fkey" FOREIGN KEY ("org_id", "transcript_id") REFERENCES "transcripts"("org_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reports" ADD CONSTRAINT "reports_org_id_ai_run_id_fkey" FOREIGN KEY ("org_id", "ai_run_id") REFERENCES "ai_runs"("org_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "extracted_tasks" ADD CONSTRAINT "extracted_tasks_org_id_meeting_id_fkey" FOREIGN KEY ("org_id", "meeting_id") REFERENCES "meetings"("org_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "extracted_tasks" ADD CONSTRAINT "extracted_tasks_org_id_report_id_fkey" FOREIGN KEY ("org_id", "report_id") REFERENCES "reports"("org_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "extracted_tasks" ADD CONSTRAINT "extracted_tasks_org_id_ai_run_id_fkey" FOREIGN KEY ("org_id", "ai_run_id") REFERENCES "ai_runs"("org_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "extracted_tasks" ADD CONSTRAINT "extracted_tasks_org_id_suggested_assignee_id_fkey" FOREIGN KEY ("org_id", "suggested_assignee_id") REFERENCES "employees"("org_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_approvals" ADD CONSTRAINT "task_approvals_org_id_extracted_task_id_fkey" FOREIGN KEY ("org_id", "extracted_task_id") REFERENCES "extracted_tasks"("org_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_org_id_project_id_fkey" FOREIGN KEY ("org_id", "project_id") REFERENCES "projects"("org_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_org_id_meeting_id_fkey" FOREIGN KEY ("org_id", "meeting_id") REFERENCES "meetings"("org_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_org_id_extracted_task_id_fkey" FOREIGN KEY ("org_id", "extracted_task_id") REFERENCES "extracted_tasks"("org_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_org_id_assignee_id_fkey" FOREIGN KEY ("org_id", "assignee_id") REFERENCES "employees"("org_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "integration_issues" ADD CONSTRAINT "integration_issues_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "integration_issues" ADD CONSTRAINT "integration_issues_org_id_task_id_fkey" FOREIGN KEY ("org_id", "task_id") REFERENCES "tasks"("org_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_runs" ADD CONSTRAINT "ai_runs_org_id_meeting_id_fkey" FOREIGN KEY ("org_id", "meeting_id") REFERENCES "meetings"("org_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_runs" ADD CONSTRAINT "ai_runs_org_id_transcript_id_fkey" FOREIGN KEY ("org_id", "transcript_id") REFERENCES "transcripts"("org_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

