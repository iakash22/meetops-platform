-- DB-1: teams and team_members (contracts v0.4 directory), plus an optional projects.team_id.
-- Additive only: one new enum, two new tenant tables, one nullable column on projects. Nothing existing is
-- removed or rewritten. Tenant key: Prisma organizationId -> column org_id (ADR-004 3a, ADR-010).
-- Every link between tenant rows is a composite (org_id, id) FK, so a row can never reference another
-- organization's team or employee even if RLS were bypassed.

-- CreateEnum
CREATE TYPE "TeamMemberRole" AS ENUM ('lead', 'member');

-- AlterTable
ALTER TABLE "projects" ADD COLUMN     "team_id" UUID;

-- CreateTable
CREATE TABLE "teams" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "key" TEXT,
    "description" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "deleted_at" TIMESTAMPTZ(3),

    CONSTRAINT "teams_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "team_members" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "team_id" UUID NOT NULL,
    "employee_id" UUID NOT NULL,
    "role" "TeamMemberRole" NOT NULL DEFAULT 'member',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "team_members_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "teams_org_id_id_key" ON "teams"("org_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "teams_org_id_name_key" ON "teams"("org_id", "name");

-- CreateIndex
CREATE INDEX "team_members_org_id_employee_id_idx" ON "team_members"("org_id", "employee_id");

-- CreateIndex
CREATE UNIQUE INDEX "team_members_org_id_id_key" ON "team_members"("org_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "team_members_org_id_team_id_employee_id_key" ON "team_members"("org_id", "team_id", "employee_id");

-- CreateIndex
CREATE INDEX "projects_org_id_team_id_idx" ON "projects"("org_id", "team_id");

-- AddForeignKey
ALTER TABLE "projects" ADD CONSTRAINT "projects_org_id_team_id_fkey" FOREIGN KEY ("org_id", "team_id") REFERENCES "teams"("org_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "teams" ADD CONSTRAINT "teams_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "team_members" ADD CONSTRAINT "team_members_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "team_members" ADD CONSTRAINT "team_members_org_id_team_id_fkey" FOREIGN KEY ("org_id", "team_id") REFERENCES "teams"("org_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "team_members" ADD CONSTRAINT "team_members_org_id_employee_id_fkey" FOREIGN KEY ("org_id", "employee_id") REFERENCES "employees"("org_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Integrity checks: names are never blank; an optional key is never blank.
ALTER TABLE "teams"
  ADD CONSTRAINT "teams_name_not_blank_check" CHECK (btrim("name") <> ''),
  ADD CONSTRAINT "teams_key_not_blank_check" CHECK ("key" IS NULL OR btrim("key") <> '');

-- Tenant isolation, forced. New tables read only the canonical ADR-010 setting, with no fallback to the
-- deprecated pre-ADR-010 setting: runWithOrganizationContext always sets the canonical one, and the fallback
-- is due for removal. Fail-closed: unset or '' => NULL => no rows match and every write is rejected.
ALTER TABLE "teams" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "teams" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "teams"
  USING (org_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid);
ALTER TABLE "team_members" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "team_members" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "team_members"
  USING (org_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "teams", "team_members" TO meetops_app;

-- Re-run the forced-RLS catalog assertion (20261022034000_assert_forced_rls) so this migration fails loudly
-- if any RLS-enabled table is left unforced.
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
