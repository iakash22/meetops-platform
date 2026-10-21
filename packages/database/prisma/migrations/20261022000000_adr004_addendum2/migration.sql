-- ADR-004 addendum 2 (contracts 0.3.0, PR #50). Data-preserving except (d), which removes HR PII by decision.
-- (a) organizationId -> org_id is a Prisma field rename only: no DB change.
-- (e) tasks.extracted_task_id (FK, unique) stays the only Task<->ExtractedTask link: no reverse column exists.
-- FORCE RLS also binds the owner, which has no org context here: lift it around backfills, re-force after.

-- (b) extracted_tasks.report_id NOT NULL: attach orphans to their meeting's latest report, else fail.
ALTER TABLE "extracted_tasks" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "reports" NO FORCE ROW LEVEL SECURITY;
UPDATE "extracted_tasks" et SET "report_id" = r."id"
FROM (
  SELECT DISTINCT ON ("org_id", "meeting_id") "org_id", "meeting_id", "id"
  FROM "reports" ORDER BY "org_id", "meeting_id", "version" DESC, "created_at" DESC
) r
WHERE et."report_id" IS NULL AND r."org_id" = et."org_id" AND r."meeting_id" = et."meeting_id";
DO $$
DECLARE n bigint;
BEGIN
  SELECT count(*) INTO n FROM "extracted_tasks" WHERE "report_id" IS NULL;
  IF n > 0 THEN
    RAISE EXCEPTION 'ADR-004 addendum 2 (b): % extracted_tasks have no report_id and their meeting has no report; create a report or delete those rows, then re-run migrate deploy', n;
  END IF;
END
$$;
ALTER TABLE "extracted_tasks" ALTER COLUMN "report_id" SET NOT NULL;
ALTER TABLE "extracted_tasks" FORCE ROW LEVEL SECURITY;
ALTER TABLE "reports" FORCE ROW LEVEL SECURITY;

-- (c) transcripts.provider NOT NULL; legacy rows get 'unknown'.
ALTER TABLE "transcripts" NO FORCE ROW LEVEL SECURITY;
UPDATE "transcripts" SET "provider" = 'unknown' WHERE "provider" IS NULL;
ALTER TABLE "transcripts" ALTER COLUMN "provider" SET NOT NULL;
ALTER TABLE "transcripts" FORCE ROW LEVEL SECURITY;

-- (d) drop meeting_participants.employee_id (user_id was backfilled from employees in 20261021150000).
ALTER TABLE "meeting_participants" DROP CONSTRAINT "meeting_participants_org_id_employee_id_fkey";
DROP INDEX "meeting_participants_meeting_id_employee_id_key";
ALTER TABLE "meeting_participants" DROP COLUMN "employee_id";
