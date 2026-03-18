-- AlterTable: Add lifecycle fields to Genome (architecture-v2 Tier 0.5)
ALTER TABLE "Genome" ADD COLUMN "status" TEXT NOT NULL DEFAULT 'unverified';
ALTER TABLE "Genome" ADD COLUMN "origin" TEXT;
ALTER TABLE "Genome" ADD COLUMN "variantOf" TEXT;
ALTER TABLE "Genome" ADD COLUMN "mutationNote" TEXT;

-- CreateIndex
CREATE INDEX "Genome_status_idx" ON "Genome"("status");
CREATE INDEX "Genome_origin_idx" ON "Genome"("origin");
CREATE INDEX "Genome_variantOf_idx" ON "Genome"("variantOf");
