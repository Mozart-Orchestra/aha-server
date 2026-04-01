-- CreateTable
CREATE TABLE "AccountRecoveryMaterial" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "publicKey" TEXT NOT NULL,
    "wrappedSecret" BYTEA NOT NULL,
    "wrappingVersion" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "lastRecoveredAt" TIMESTAMP(3),

    CONSTRAINT "AccountRecoveryMaterial_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AccountRecoveryMaterial_accountId_key" ON "AccountRecoveryMaterial"("accountId");

-- CreateIndex
CREATE INDEX "AccountRecoveryMaterial_publicKey_idx" ON "AccountRecoveryMaterial"("publicKey");

-- AddForeignKey
ALTER TABLE "AccountRecoveryMaterial"
ADD CONSTRAINT "AccountRecoveryMaterial_accountId_fkey"
FOREIGN KEY ("accountId") REFERENCES "Account"("id")
ON DELETE CASCADE ON UPDATE CASCADE;
