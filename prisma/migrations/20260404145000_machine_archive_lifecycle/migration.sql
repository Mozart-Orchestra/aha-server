ALTER TABLE "Machine"
ADD COLUMN "archivedAt" TIMESTAMP(3);

CREATE INDEX "Machine_archivedAt_idx" ON "Machine"("archivedAt");
