-- AlterTable
ALTER TABLE "Genome" ADD COLUMN "hubGenomeId" TEXT;
ALTER TABLE "Genome" ADD COLUMN "deletedAt" DATETIME;

-- CreateIndex
CREATE INDEX "Genome_deletedAt_idx" ON "Genome"("deletedAt");
