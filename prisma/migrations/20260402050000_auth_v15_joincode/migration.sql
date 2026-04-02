-- AlterTable
ALTER TABLE "Account"
ADD COLUMN "encryptedContentSecretKey" BYTEA,
ADD COLUMN "contentKeyVersion" INTEGER NOT NULL DEFAULT 1;

-- CreateTable
CREATE TABLE "JoinCode" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "JoinCode_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "JoinCode_code_key" ON "JoinCode"("code");

-- CreateIndex
CREATE INDEX "JoinCode_accountId_createdAt_idx" ON "JoinCode"("accountId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "JoinCode_expiresAt_idx" ON "JoinCode"("expiresAt");

-- AddForeignKey
ALTER TABLE "JoinCode"
ADD CONSTRAINT "JoinCode_accountId_fkey"
FOREIGN KEY ("accountId") REFERENCES "Account"("id")
ON DELETE CASCADE ON UPDATE CASCADE;
