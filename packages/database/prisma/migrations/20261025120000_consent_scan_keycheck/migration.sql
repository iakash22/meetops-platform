-- DB-3 (G6 + G11): consent attestations, file_objects.scan_status and storage-key / sha256 CHECKs.
-- ADDITIVE ONLY: new enums, one new column with a default, one new table, new constraints. No existing column is
-- altered or dropped. Pairs with @meetops/contracts 0.4.1 (CONSENT_*, FILE_OBJECT_SCAN_STATUSES).

-- CreateEnum
CREATE TYPE "FileScanStatus" AS ENUM ('pending', 'clean', 'quarantined', 'rejected');

-- CreateEnum
CREATE TYPE "ConsentSubjectType" AS ENUM ('upload', 'recording_session');

-- CreateEnum
CREATE TYPE "ConsentMethod" AS ENUM ('all_parties_notified', 'all_parties_consented');

-- AlterTable (additive; also takes the ACCESS EXCLUSIVE lock the preflight below relies on)
ALTER TABLE "file_objects" ADD COLUMN     "scan_status" "FileScanStatus" NOT NULL DEFAULT 'pending';

-- CreateIndex
CREATE INDEX "file_objects_org_id_scan_status_idx" ON "file_objects"("org_id", "scan_status");

-- G6 preflight: fail loudly, with counts and sample ids, if any existing row would violate the new CHECKs, instead
-- of a bare constraint error. Fix the rows (or their keys) and re-run; nothing is rewritten here.
DO $$
DECLARE
  bad_key bigint;
  bad_key_ids text;
  bad_sha bigint;
  bad_sha_ids text;
BEGIN
  SELECT count(*), string_agg(id::text, ', ' ORDER BY id) FILTER (WHERE rn <= 5)
    INTO bad_key, bad_key_ids
  FROM (
    SELECT id, row_number() OVER (ORDER BY id) AS rn FROM "file_objects"
    WHERE NOT (starts_with("storage_key", 'organizations/' || "org_id"::text || '/')
               OR starts_with("storage_key", 'org/' || "org_id"::text || '/'))
  ) k;
  SELECT count(*), string_agg(id::text, ', ' ORDER BY id) FILTER (WHERE rn <= 5)
    INTO bad_sha, bad_sha_ids
  FROM (
    SELECT id, row_number() OVER (ORDER BY id) AS rn FROM "file_objects"
    WHERE "checksum_sha256" IS NOT NULL AND "checksum_sha256" !~ '^[0-9a-f]{64}$'
  ) s;
  IF bad_key > 0 OR bad_sha > 0 THEN
    RAISE EXCEPTION 'consent_scan_keycheck preflight failed: % file_objects row(s) with a storage_key outside '
      'organizations/<org_id>/ or org/<org_id>/ (e.g. %), % row(s) with a non-hex checksum_sha256 (e.g. %)',
      bad_key, coalesce(bad_key_ids, '-'), bad_sha, coalesce(bad_sha_ids, '-')
      USING ERRCODE = 'check_violation';
  END IF;
END
$$;

-- G6: an object key is bound to its own organization's prefix. 'organizations/<org_id>/' is canonical; the legacy
-- 'org/<org_id>/' form is still accepted for existing objects. Something must follow the prefix.
ALTER TABLE "file_objects" ADD CONSTRAINT "file_objects_storage_key_org_check" CHECK (
  (starts_with("storage_key", 'organizations/' || "org_id"::text || '/')
     AND length("storage_key") > length('organizations/' || "org_id"::text || '/'))
  OR (starts_with("storage_key", 'org/' || "org_id"::text || '/')
     AND length("storage_key") > length('org/' || "org_id"::text || '/'))
);

-- Hex sha256: file_objects_checksum_sha256_check was added NOT VALID in 20261024020000; validate it now so it also
-- covers pre-existing rows (the preflight above has already reported any offender).
ALTER TABLE "file_objects" VALIDATE CONSTRAINT "file_objects_checksum_sha256_check";

-- CreateTable
CREATE TABLE "consent_attestations" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "subject_type" "ConsentSubjectType" NOT NULL,
    "subject_id" UUID NOT NULL,
    "consent_version" TEXT NOT NULL,
    "method" "ConsentMethod" NOT NULL,
    "attested_by_user_id" UUID NOT NULL,
    "attested_at" TIMESTAMPTZ(3) NOT NULL,
    "recorded_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "consent_attestations_pkey" PRIMARY KEY ("id"),
    -- contracts CONSENT_VERSION_PATTERN (1..32 chars).
    CONSTRAINT "consent_attestations_consent_version_check"
      CHECK ("consent_version" ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$'),
    -- contracts CONSENT_ATTESTATION_MAX_SKEW_SECONDS: the client clock may be at most 300 s ahead of the server.
    CONSTRAINT "consent_attestations_attested_at_skew_check"
      CHECK ("attested_at" <= "recorded_at" + interval '300 seconds')
);

-- CreateIndex
CREATE INDEX "consent_attestations_org_id_subject_type_subject_id_idx" ON "consent_attestations"("org_id", "subject_type", "subject_id");

-- CreateIndex
CREATE INDEX "consent_attestations_org_id_attested_by_user_id_idx" ON "consent_attestations"("org_id", "attested_by_user_id");

-- CreateIndex
CREATE UNIQUE INDEX "consent_attestations_org_id_id_key" ON "consent_attestations"("org_id", "id");

-- AddForeignKey (RESTRICT, like audit_events: evidence must not vanish with its organization or attester)
ALTER TABLE "consent_attestations" ADD CONSTRAINT "consent_attestations_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "consent_attestations" ADD CONSTRAINT "consent_attestations_attested_by_user_id_fkey" FOREIGN KEY ("attested_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- The subject is polymorphic (FileObject id or recording session id), so there is no FK. At insert time it must be
-- an existing row of the SAME organization. SECURITY INVOKER: under forced RLS the lookup only sees the current
-- organization's rows anyway; the explicit org_id match also holds for the owner. AFTER INSERT so the RLS
-- WITH CHECK runs first (a cross-org insert reports the RLS violation, not a missing subject).
CREATE OR REPLACE FUNCTION public.consent_attestations_subject_check()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW.subject_type = 'upload' THEN
    IF NOT EXISTS (SELECT 1 FROM public.file_objects f WHERE f.id = NEW.subject_id AND f.org_id = NEW.org_id) THEN
      RAISE EXCEPTION 'consent_attestations: upload subject % not found in organization', NEW.subject_id
        USING ERRCODE = 'foreign_key_violation';
    END IF;
  ELSIF NEW.subject_type = 'recording_session' THEN
    IF NOT EXISTS (SELECT 1 FROM public.recording_sessions r WHERE r.id = NEW.subject_id AND r.org_id = NEW.org_id) THEN
      RAISE EXCEPTION 'consent_attestations: recording_session subject % not found in organization', NEW.subject_id
        USING ERRCODE = 'foreign_key_violation';
    END IF;
  END IF;
  RETURN NULL;
END
$$;
REVOKE ALL ON FUNCTION public.consent_attestations_subject_check() FROM PUBLIC;
CREATE TRIGGER consent_attestations_subject_check
  AFTER INSERT ON "consent_attestations"
  FOR EACH ROW EXECUTE FUNCTION public.consent_attestations_subject_check();

-- Append-only for everyone, including the owner (same shape as audit_events_append_only). A migration running as
-- meetops_migrator may opt in with SET LOCAL meetops.consent_maintenance = 'on'; the app cannot (it is not a
-- member of meetops_migrator), and it has no UPDATE/DELETE/TRUNCATE privilege either.
CREATE OR REPLACE FUNCTION public.consent_attestations_append_only()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF current_setting('meetops.consent_maintenance', true) = 'on'
     AND pg_has_role(current_user, 'meetops_migrator', 'MEMBER') THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  RAISE EXCEPTION 'consent_attestations is append-only (% refused)', TG_OP USING ERRCODE = 'insufficient_privilege';
END
$$;
REVOKE ALL ON FUNCTION public.consent_attestations_append_only() FROM PUBLIC;
CREATE TRIGGER consent_attestations_append_only
  BEFORE UPDATE OR DELETE ON "consent_attestations"
  FOR EACH ROW EXECUTE FUNCTION public.consent_attestations_append_only();
CREATE TRIGGER consent_attestations_no_truncate
  BEFORE TRUNCATE ON "consent_attestations"
  FOR EACH STATEMENT EXECUTE FUNCTION public.consent_attestations_append_only();

-- Tenant isolation, forced, canonical ADR-010 setting only (see 20261025090000_teams). Only SELECT and INSERT
-- policies: with no UPDATE/DELETE policy those are denied by RLS too. Fail-closed when the setting is unset.
ALTER TABLE "consent_attestations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "consent_attestations" FORCE ROW LEVEL SECURITY;
CREATE POLICY consent_select ON "consent_attestations" FOR SELECT
  USING (org_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid);
CREATE POLICY consent_insert ON "consent_attestations" FOR INSERT
  WITH CHECK (org_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid);
-- Default privileges granted SELECT, INSERT, UPDATE, DELETE; narrow them to SELECT, INSERT.
REVOKE ALL ON TABLE "consent_attestations" FROM meetops_app;
GRANT SELECT, INSERT ON TABLE "consent_attestations" TO meetops_app;

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
