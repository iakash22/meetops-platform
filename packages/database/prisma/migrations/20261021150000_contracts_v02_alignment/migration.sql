-- Contracts v0.2 (PR #38) alignment. Data-preserving: attendee/guest -> participant.
-- AlterEnum
BEGIN;
CREATE TYPE "MeetingParticipantRole_new" AS ENUM ('host', 'participant');
ALTER TABLE "meeting_participants" ALTER COLUMN "role" DROP DEFAULT;
ALTER TABLE "meeting_participants" ALTER COLUMN "role" TYPE "MeetingParticipantRole_new" USING ((CASE "role"::text WHEN 'host' THEN 'host' ELSE 'participant' END)::"MeetingParticipantRole_new");
ALTER TYPE "MeetingParticipantRole" RENAME TO "MeetingParticipantRole_old";
ALTER TYPE "MeetingParticipantRole_new" RENAME TO "MeetingParticipantRole";
DROP TYPE "MeetingParticipantRole_old";
ALTER TABLE "meeting_participants" ALTER COLUMN "role" SET DEFAULT 'participant';
COMMIT;

-- AlterTable
ALTER TABLE "meeting_participants" ADD COLUMN     "joined_at" TIMESTAMPTZ(3),
ADD COLUMN     "left_at" TIMESTAMPTZ(3),
ADD COLUMN     "user_id" UUID,
ALTER COLUMN "role" SET DEFAULT 'participant';

-- Backfill user_id from linked employees.
UPDATE "meeting_participants" p SET "user_id" = e."user_id"
FROM "employees" e WHERE e."org_id" = p."org_id" AND e."id" = p."employee_id" AND e."user_id" IS NOT NULL;

-- AlterTable
ALTER TABLE "extracted_tasks" ADD COLUMN     "assignee_hint" TEXT,
ADD COLUMN     "due_hint" TEXT;

-- CreateIndex
CREATE INDEX "meeting_participants_org_id_user_id_idx" ON "meeting_participants"("org_id", "user_id");

-- AddForeignKey
ALTER TABLE "meeting_participants" ADD CONSTRAINT "meeting_participants_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

