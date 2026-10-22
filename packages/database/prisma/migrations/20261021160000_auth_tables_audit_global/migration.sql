-- Backend feedback: global auth token tables, global (org-less) audit events, invitation/org metadata.
-- AlterTable
ALTER TABLE "organizations" ADD COLUMN     "created_by_id" UUID;

-- AlterTable
ALTER TABLE "invitations" ADD COLUMN     "accepted_by_id" UUID,
ADD COLUMN     "deleted_at" TIMESTAMPTZ(3),
ADD COLUMN     "revoked_at" TIMESTAMPTZ(3);

-- AlterTable
ALTER TABLE "audit_events" ALTER COLUMN "org_id" DROP NOT NULL;

-- CreateTable
CREATE TABLE "email_verifications" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "used_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "email_verifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "password_resets" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "used_at" TIMESTAMPTZ(3),
    "ip_address" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "password_resets_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "email_verifications_token_hash_key" ON "email_verifications"("token_hash");

-- CreateIndex
CREATE INDEX "email_verifications_user_id_idx" ON "email_verifications"("user_id");

-- CreateIndex
CREATE INDEX "email_verifications_expires_at_idx" ON "email_verifications"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "password_resets_token_hash_key" ON "password_resets"("token_hash");

-- CreateIndex
CREATE INDEX "password_resets_user_id_idx" ON "password_resets"("user_id");

-- CreateIndex
CREATE INDEX "password_resets_expires_at_idx" ON "password_resets"("expires_at");

-- AddForeignKey
ALTER TABLE "organizations" ADD CONSTRAINT "organizations_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_accepted_by_id_fkey" FOREIGN KEY ("accepted_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "email_verifications" ADD CONSTRAINT "email_verifications_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "password_resets" ADD CONSTRAINT "password_resets_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- email_verifications / password_resets: global like sessions (resolved by token hash before any
-- org or user context exists), so no RLS. Only hashes are stored; app gets DML.
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "email_verifications", "password_resets" TO meetops_app;

-- audit_events: org rows readable/insertable only in their org context; NULL-org (global auth)
-- rows are insert-only for the app and never readable through RLS. UPDATE/DELETE stay revoked.
DROP POLICY IF EXISTS tenant_isolation ON "audit_events";
DROP POLICY IF EXISTS audit_read_own_org ON "audit_events";
CREATE POLICY audit_read_own_org ON "audit_events" FOR SELECT
  USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);
DROP POLICY IF EXISTS audit_insert ON "audit_events";
CREATE POLICY audit_insert ON "audit_events" FOR INSERT
  WITH CHECK (org_id IS NULL OR org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE "audit_events" FROM meetops_app;

-- accept_invitation now records accepted_by_id.
CREATE OR REPLACE FUNCTION accept_invitation(p_token_hash text, p_user_id uuid)
RETURNS TABLE (membership_id uuid, org_id uuid, role "MembershipRole")
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  inv public.invitations%ROWTYPE;
  u_email text;
  m_id uuid;
BEGIN
  SELECT * INTO inv FROM public.invitations i
  WHERE i.token_hash = p_token_hash AND i.deleted_at IS NULL FOR UPDATE;
  IF NOT FOUND OR inv.status <> 'pending' OR inv.revoked_at IS NOT NULL OR inv.expires_at <= now() THEN
    RAISE EXCEPTION 'invitation_invalid' USING ERRCODE = 'P0002';
  END IF;
  SELECT u.email INTO u_email FROM public.users u WHERE u.id = p_user_id AND u.deleted_at IS NULL;
  IF u_email IS NULL OR lower(u_email) <> lower(inv.email) THEN
    RAISE EXCEPTION 'invitation_invalid' USING ERRCODE = 'P0002';
  END IF;

  INSERT INTO public.memberships (id, org_id, user_id, role, created_at, updated_at)
  VALUES (gen_random_uuid(), inv.org_id, p_user_id, inv.role, now(), now())
  ON CONFLICT (org_id, user_id) DO UPDATE SET deleted_at = NULL, updated_at = now()
  RETURNING id INTO m_id;

  UPDATE public.invitations
  SET status = 'accepted', accepted_at = now(), accepted_by_id = p_user_id, updated_at = now()
  WHERE id = inv.id;

  INSERT INTO public.audit_events (id, org_id, actor_id, actor_type, action, target_type, target_id, metadata, created_at)
  VALUES (gen_random_uuid(), inv.org_id, p_user_id, 'user', 'invitation.accepted', 'invitation', inv.id::text,
          jsonb_build_object('membership_id', m_id, 'role', inv.role), now());

  RETURN QUERY SELECT m_id, inv.org_id, inv.role;
END
$$;
ALTER FUNCTION accept_invitation(text, uuid) OWNER TO meetops_migrator;
REVOKE ALL ON FUNCTION accept_invitation(text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION accept_invitation(text, uuid) TO meetops_app;

-- lookup ignores soft-deleted invitations.
CREATE OR REPLACE FUNCTION lookup_invitation_by_token_hash(p_token_hash text)
RETURNS TABLE (id uuid, org_id uuid, email text, role "MembershipRole", status "InvitationStatus", expires_at timestamptz)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT i.id, i.org_id, i.email, i.role, i.status, i.expires_at
  FROM public.invitations i
  WHERE i.token_hash = p_token_hash AND i.deleted_at IS NULL
  LIMIT 1
$$;
