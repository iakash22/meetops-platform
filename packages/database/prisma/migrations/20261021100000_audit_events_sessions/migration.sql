-- DropForeignKey
ALTER TABLE "audit_logs" DROP CONSTRAINT "audit_logs_org_id_fkey";

-- DropForeignKey
ALTER TABLE "audit_logs" DROP CONSTRAINT "audit_logs_actor_id_fkey";

-- AlterTable
ALTER TABLE "sessions" ADD COLUMN     "auth_level" TEXT NOT NULL DEFAULT 'password',
ADD COLUMN     "last_seen_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- DropTable
DROP TABLE "audit_logs";

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
CREATE INDEX "audit_events_org_id_created_at_idx" ON "audit_events"("org_id", "created_at");

-- CreateIndex
CREATE INDEX "audit_events_org_id_target_type_target_id_idx" ON "audit_events"("org_id", "target_type", "target_id");

-- CreateIndex
CREATE INDEX "audit_events_org_id_actor_id_idx" ON "audit_events"("org_id", "actor_id");

-- AddForeignKey
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

