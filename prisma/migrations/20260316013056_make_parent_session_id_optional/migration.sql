-- CreateTable
CREATE TABLE "Genome" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "accountId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "spec" TEXT NOT NULL,
    "parentSessionId" TEXT,
    "teamId" TEXT,
    "namespace" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "tags" TEXT,
    "category" TEXT,
    "spawnCount" INTEGER NOT NULL DEFAULT 0,
    "lastSpawnedAt" DATETIME,
    "isPublic" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Genome_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "Genome_accountId_updatedAt_idx" ON "Genome"("accountId", "updatedAt" DESC);

-- CreateIndex
CREATE INDEX "Genome_teamId_idx" ON "Genome"("teamId");

-- CreateIndex
CREATE INDEX "Genome_parentSessionId_idx" ON "Genome"("parentSessionId");

-- CreateIndex
CREATE INDEX "Genome_namespace_idx" ON "Genome"("namespace");

-- CreateIndex
CREATE INDEX "Genome_category_idx" ON "Genome"("category");

-- CreateIndex
CREATE UNIQUE INDEX "Genome_namespace_name_version_key" ON "Genome"("namespace", "name", "version");
