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

-- AlterEnum
BEGIN;
CREATE TYPE "MembershipRole_new" AS ENUM ('owner', 'admin', 'member', 'viewer');
ALTER TABLE "memberships" ALTER COLUMN "role" DROP DEFAULT;
ALTER TABLE "invitations" ALTER COLUMN "role" DROP DEFAULT;
ALTER TABLE "memberships" ALTER COLUMN "role" TYPE "MembershipRole_new" USING ("role"::text::"MembershipRole_new");
ALTER TABLE "invitations" ALTER COLUMN "role" TYPE "MembershipRole_new" USING ("role"::text::"MembershipRole_new");
ALTER TYPE "MembershipRole" RENAME TO "MembershipRole_old";
ALTER TYPE "MembershipRole_new" RENAME TO "MembershipRole";
DROP TYPE "MembershipRole_old";
ALTER TABLE "memberships" ALTER COLUMN "role" SET DEFAULT 'member';
ALTER TABLE "invitations" ALTER COLUMN "role" SET DEFAULT 'member';
COMMIT;

-- AlterEnum
BEGIN;
CREATE TYPE "InvitationStatus_new" AS ENUM ('pending', 'accepted', 'revoked', 'expired');
ALTER TABLE "invitations" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "invitations" ALTER COLUMN "status" TYPE "InvitationStatus_new" USING ("status"::text::"InvitationStatus_new");
ALTER TYPE "InvitationStatus" RENAME TO "InvitationStatus_old";
ALTER TYPE "InvitationStatus_new" RENAME TO "InvitationStatus";
DROP TYPE "InvitationStatus_old";
ALTER TABLE "invitations" ALTER COLUMN "status" SET DEFAULT 'pending';
COMMIT;

-- AlterEnum
BEGIN;
CREATE TYPE "ProjectStatus_new" AS ENUM ('active', 'archived');
ALTER TABLE "projects" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "projects" ALTER COLUMN "status" TYPE "ProjectStatus_new" USING ("status"::text::"ProjectStatus_new");
ALTER TYPE "ProjectStatus" RENAME TO "ProjectStatus_old";
ALTER TYPE "ProjectStatus_new" RENAME TO "ProjectStatus";
DROP TYPE "ProjectStatus_old";
ALTER TABLE "projects" ALTER COLUMN "status" SET DEFAULT 'active';
COMMIT;

-- AlterEnum
BEGIN;
CREATE TYPE "MeetingStatus_new" AS ENUM ('scheduled', 'recording', 'processing', 'completed', 'failed');
ALTER TABLE "meetings" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "meetings" ALTER COLUMN "status" TYPE "MeetingStatus_new" USING ("status"::text::"MeetingStatus_new");
ALTER TYPE "MeetingStatus" RENAME TO "MeetingStatus_old";
ALTER TYPE "MeetingStatus_new" RENAME TO "MeetingStatus";
DROP TYPE "MeetingStatus_old";
ALTER TABLE "meetings" ALTER COLUMN "status" SET DEFAULT 'scheduled';
COMMIT;

-- AlterEnum
BEGIN;
CREATE TYPE "MeetingParticipantRole_new" AS ENUM ('host', 'attendee', 'guest');
ALTER TABLE "meeting_participants" ALTER COLUMN "role" DROP DEFAULT;
ALTER TABLE "meeting_participants" ALTER COLUMN "role" TYPE "MeetingParticipantRole_new" USING ("role"::text::"MeetingParticipantRole_new");
ALTER TYPE "MeetingParticipantRole" RENAME TO "MeetingParticipantRole_old";
ALTER TYPE "MeetingParticipantRole_new" RENAME TO "MeetingParticipantRole";
DROP TYPE "MeetingParticipantRole_old";
ALTER TABLE "meeting_participants" ALTER COLUMN "role" SET DEFAULT 'attendee';
COMMIT;

-- AlterEnum
BEGIN;
CREATE TYPE "TranscriptStatus_new" AS ENUM ('pending', 'processing', 'ready', 'failed');
ALTER TABLE "transcripts" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "transcripts" ALTER COLUMN "status" TYPE "TranscriptStatus_new" USING ("status"::text::"TranscriptStatus_new");
ALTER TYPE "TranscriptStatus" RENAME TO "TranscriptStatus_old";
ALTER TYPE "TranscriptStatus_new" RENAME TO "TranscriptStatus";
DROP TYPE "TranscriptStatus_old";
ALTER TABLE "transcripts" ALTER COLUMN "status" SET DEFAULT 'pending';
COMMIT;

-- AlterEnum
BEGIN;
CREATE TYPE "ReportStatus_new" AS ENUM ('draft', 'published', 'archived');
ALTER TABLE "reports" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "reports" ALTER COLUMN "status" TYPE "ReportStatus_new" USING ("status"::text::"ReportStatus_new");
ALTER TYPE "ReportStatus" RENAME TO "ReportStatus_old";
ALTER TYPE "ReportStatus_new" RENAME TO "ReportStatus";
DROP TYPE "ReportStatus_old";
ALTER TABLE "reports" ALTER COLUMN "status" SET DEFAULT 'draft';
COMMIT;

-- AlterEnum
BEGIN;
CREATE TYPE "ExtractedTaskStatus_new" AS ENUM ('pending_review', 'approved', 'rejected', 'converted');
ALTER TABLE "extracted_tasks" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "extracted_tasks" ALTER COLUMN "status" TYPE "ExtractedTaskStatus_new" USING ("status"::text::"ExtractedTaskStatus_new");
ALTER TYPE "ExtractedTaskStatus" RENAME TO "ExtractedTaskStatus_old";
ALTER TYPE "ExtractedTaskStatus_new" RENAME TO "ExtractedTaskStatus";
DROP TYPE "ExtractedTaskStatus_old";
ALTER TABLE "extracted_tasks" ALTER COLUMN "status" SET DEFAULT 'pending_review';
COMMIT;

-- AlterEnum
BEGIN;
CREATE TYPE "TaskPriority_new" AS ENUM ('low', 'medium', 'high', 'urgent');
ALTER TABLE "internal_tasks" ALTER COLUMN "priority" DROP DEFAULT;
ALTER TABLE "extracted_tasks" ALTER COLUMN "priority" DROP DEFAULT;
ALTER TABLE "extracted_tasks" ALTER COLUMN "priority" TYPE "TaskPriority_new" USING ("priority"::text::"TaskPriority_new");
ALTER TABLE "tasks" ALTER COLUMN "priority" TYPE "TaskPriority_new" USING ("priority"::text::"TaskPriority_new");
ALTER TYPE "TaskPriority" RENAME TO "TaskPriority_old";
ALTER TYPE "TaskPriority_new" RENAME TO "TaskPriority";
DROP TYPE "TaskPriority_old";
ALTER TABLE "extracted_tasks" ALTER COLUMN "priority" SET DEFAULT 'medium';
COMMIT;

-- AlterEnum
BEGIN;
CREATE TYPE "ApprovalDecision_new" AS ENUM ('approved', 'rejected', 'changes_requested');
ALTER TABLE "task_approvals" ALTER COLUMN "decision" TYPE "ApprovalDecision_new" USING ("decision"::text::"ApprovalDecision_new");
ALTER TYPE "ApprovalDecision" RENAME TO "ApprovalDecision_old";
ALTER TYPE "ApprovalDecision_new" RENAME TO "ApprovalDecision";
DROP TYPE "ApprovalDecision_old";
COMMIT;

-- AlterEnum
BEGIN;
CREATE TYPE "AiRunStatus_new" AS ENUM ('queued', 'running', 'succeeded', 'failed', 'cancelled');
ALTER TABLE "ai_runs" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "ai_runs" ALTER COLUMN "status" TYPE "AiRunStatus_new" USING ("status"::text::"AiRunStatus_new");
ALTER TYPE "AiRunStatus" RENAME TO "AiRunStatus_old";
ALTER TYPE "AiRunStatus_new" RENAME TO "AiRunStatus";
DROP TYPE "AiRunStatus_old";
ALTER TABLE "ai_runs" ALTER COLUMN "status" SET DEFAULT 'queued';
COMMIT;

-- AlterEnum
BEGIN;
CREATE TYPE "AiRunKind_new" AS ENUM ('transcription', 'summary', 'task_extraction', 'embedding', 'other');
ALTER TABLE "ai_runs" ALTER COLUMN "kind" TYPE "AiRunKind_new" USING ("kind"::text::"AiRunKind_new");
ALTER TYPE "AiRunKind" RENAME TO "AiRunKind_old";
ALTER TYPE "AiRunKind_new" RENAME TO "AiRunKind";
DROP TYPE "AiRunKind_old";
COMMIT;

-- AlterEnum
BEGIN;
CREATE TYPE "OutboxStatus_new" AS ENUM ('pending', 'processing', 'published', 'failed');
ALTER TABLE "outbox_events" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "outbox_events" ALTER COLUMN "status" TYPE "OutboxStatus_new" USING ("status"::text::"OutboxStatus_new");
ALTER TYPE "OutboxStatus" RENAME TO "OutboxStatus_old";
ALTER TYPE "OutboxStatus_new" RENAME TO "OutboxStatus";
DROP TYPE "OutboxStatus_old";
ALTER TABLE "outbox_events" ALTER COLUMN "status" SET DEFAULT 'pending';
COMMIT;

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
ALTER TABLE "sessions" ADD COLUMN     "absolute_expires_at" TIMESTAMPTZ(3) NOT NULL,
ADD COLUMN     "auth_level" TEXT NOT NULL DEFAULT 'password',
ADD COLUMN     "last_seen_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- AlterTable
ALTER TABLE "invitations" ALTER COLUMN "role" SET DEFAULT 'member',
ALTER COLUMN "status" SET DEFAULT 'pending';

-- AlterTable
ALTER TABLE "projects" ALTER COLUMN "status" SET DEFAULT 'active';

-- AlterTable
ALTER TABLE "meetings" DROP COLUMN "recording_file_id",
ADD COLUMN     "source" "MeetingSource" NOT NULL DEFAULT 'upload',
ALTER COLUMN "status" SET DEFAULT 'scheduled';

-- AlterTable
ALTER TABLE "meeting_participants" ALTER COLUMN "role" SET DEFAULT 'attendee';

-- AlterTable
ALTER TABLE "file_objects" DROP COLUMN "key",
ADD COLUMN     "channels" INTEGER,
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
ADD COLUMN     "storage_key" TEXT NOT NULL,
ADD COLUMN     "upload_id" TEXT,
ALTER COLUMN "size_bytes" DROP NOT NULL;

-- AlterTable
ALTER TABLE "transcripts" DROP COLUMN "source_file_id",
ADD COLUMN     "recording_id" UUID,
ALTER COLUMN "status" SET DEFAULT 'pending';

-- AlterTable
ALTER TABLE "reports" ALTER COLUMN "status" SET DEFAULT 'draft';

-- AlterTable
ALTER TABLE "extracted_tasks" ALTER COLUMN "priority" SET DEFAULT 'medium',
ALTER COLUMN "status" SET DEFAULT 'pending_review';

-- AlterTable
ALTER TABLE "ai_runs" ALTER COLUMN "status" SET DEFAULT 'queued';

-- AlterTable
ALTER TABLE "outbox_events" ALTER COLUMN "status" SET DEFAULT 'pending';

-- DropTable
DROP TABLE "internal_tasks";

-- DropTable
DROP TABLE "external_issue_links";

-- DropTable
DROP TABLE "audit_logs";

-- DropEnum
DROP TYPE "InternalTaskStatus";

-- DropEnum
DROP TYPE "ExternalProvider";

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

-- CreateTable
CREATE TABLE "tasks" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "project_id" UUID,
    "extracted_task_id" UUID,
    "assignee_id" UUID,
    "created_by_id" UUID,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "status" "TaskStatus" NOT NULL DEFAULT 'todo',
    "priority" "TaskPriority" NOT NULL DEFAULT 'medium',
    "meeting_id" UUID,
    "due_at" TIMESTAMPTZ(3),
    "completed_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "deleted_at" TIMESTAMPTZ(3),

    CONSTRAINT "tasks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "integration_issues" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "task_id" UUID NOT NULL,
    "integration" TEXT NOT NULL,
    "external_id" TEXT NOT NULL,
    "external_url" TEXT,
    "synced_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "integration_issues_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_events" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "actor_id" UUID,
    "actor_type" TEXT NOT NULL DEFAULT 'user',
    "action" TEXT NOT NULL,
    "target_type" TEXT NOT NULL,
    "target_id" TEXT,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "ip_address" TEXT,
    "user_agent" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "recordings_file_object_id_key" ON "recordings"("file_object_id");

-- CreateIndex
CREATE INDEX "recordings_org_id_meeting_id_idx" ON "recordings"("org_id", "meeting_id");

-- CreateIndex
CREATE UNIQUE INDEX "recordings_org_id_id_key" ON "recordings"("org_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "recordings_org_id_file_object_id_key" ON "recordings"("org_id", "file_object_id");

-- CreateIndex
CREATE UNIQUE INDEX "tasks_extracted_task_id_key" ON "tasks"("extracted_task_id");

-- CreateIndex
CREATE INDEX "tasks_org_id_status_idx" ON "tasks"("org_id", "status");

-- CreateIndex
CREATE INDEX "tasks_org_id_project_id_idx" ON "tasks"("org_id", "project_id");

-- CreateIndex
CREATE INDEX "tasks_org_id_assignee_id_idx" ON "tasks"("org_id", "assignee_id");

-- CreateIndex
CREATE UNIQUE INDEX "tasks_org_id_id_key" ON "tasks"("org_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "tasks_org_id_extracted_task_id_key" ON "tasks"("org_id", "extracted_task_id");

-- CreateIndex
CREATE INDEX "integration_issues_org_id_task_id_idx" ON "integration_issues"("org_id", "task_id");

-- CreateIndex
CREATE UNIQUE INDEX "integration_issues_org_id_integration_external_id_key" ON "integration_issues"("org_id", "integration", "external_id");

-- CreateIndex
CREATE UNIQUE INDEX "integration_issues_org_id_id_key" ON "integration_issues"("org_id", "id");

-- CreateIndex
CREATE INDEX "audit_events_org_id_created_at_idx" ON "audit_events"("org_id", "created_at");

-- CreateIndex
CREATE INDEX "audit_events_org_id_target_type_target_id_idx" ON "audit_events"("org_id", "target_type", "target_id");

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

