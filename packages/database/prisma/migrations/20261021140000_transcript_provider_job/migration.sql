-- AlterTable
ALTER TABLE "transcripts" ADD COLUMN     "provider" TEXT,
ADD COLUMN     "provider_job_id" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "transcripts_org_id_provider_provider_job_id_key" ON "transcripts"("org_id", "provider", "provider_job_id");

