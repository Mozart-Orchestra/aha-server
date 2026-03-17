-- CreateTable
CREATE TABLE "TeamContextEntry" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "accountId" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'fact',
    "value" JSONB NOT NULL,
    "summary" TEXT,
    "tags" JSONB,
    "version" INTEGER NOT NULL DEFAULT 1,
    "updatedBySessionId" TEXT,
    "updatedByRole" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "TeamContextEntry_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "TeamContextEntry_accountId_teamId_key_key" ON "TeamContextEntry"("accountId", "teamId", "key");

-- CreateIndex
CREATE INDEX "TeamContextEntry_accountId_teamId_updatedAt_idx" ON "TeamContextEntry"("accountId", "teamId", "updatedAt" DESC);

-- CreateIndex
CREATE INDEX "TeamContextEntry_teamId_kind_idx" ON "TeamContextEntry"("teamId", "kind");
