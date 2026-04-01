-- CreateTable
CREATE TABLE "AccountJoinTicket" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AccountJoinTicket_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AccountJoinTicket_tokenHash_key" ON "AccountJoinTicket"("tokenHash");

-- CreateIndex
CREATE INDEX "AccountJoinTicket_accountId_createdAt_idx" ON "AccountJoinTicket"("accountId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "AccountJoinTicket_expiresAt_idx" ON "AccountJoinTicket"("expiresAt");

-- AddForeignKey
ALTER TABLE "AccountJoinTicket"
ADD CONSTRAINT "AccountJoinTicket_accountId_fkey"
FOREIGN KEY ("accountId") REFERENCES "Account"("id")
ON DELETE CASCADE ON UPDATE CASCADE;
