-- CreateTable
CREATE TABLE "RoleEmbedding" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "accountId" TEXT NOT NULL,
    "roleKey" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "embedding" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE INDEX "RoleEmbedding_accountId_idx" ON "RoleEmbedding"("accountId");

-- CreateIndex
CREATE UNIQUE INDEX "RoleEmbedding_accountId_roleKey_key" ON "RoleEmbedding"("accountId", "roleKey");
