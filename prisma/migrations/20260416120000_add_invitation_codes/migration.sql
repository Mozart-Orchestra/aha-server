-- AlterTable: Account invitation fields
ALTER TABLE "Account"
ADD COLUMN "invitationVerifiedAt" TIMESTAMP(3),
ADD COLUMN "invitationCodeUsed"   TEXT;

-- CreateTable: InvitationCode
CREATE TABLE "InvitationCode" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "issuedByAccountId" TEXT,
    "maxUses" INTEGER NOT NULL DEFAULT 1,
    "usedCount" INTEGER NOT NULL DEFAULT 0,
    "expiresAt" TIMESTAMP(3),
    "active" BOOLEAN NOT NULL DEFAULT true,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InvitationCode_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "InvitationCode_code_key" ON "InvitationCode"("code");
CREATE INDEX "InvitationCode_issuedByAccountId_createdAt_idx"
    ON "InvitationCode"("issuedByAccountId", "createdAt" DESC);
CREATE INDEX "InvitationCode_active_expiresAt_idx"
    ON "InvitationCode"("active", "expiresAt");

ALTER TABLE "InvitationCode"
ADD CONSTRAINT "InvitationCode_issuedByAccountId_fkey"
FOREIGN KEY ("issuedByAccountId") REFERENCES "Account"("id")
ON DELETE SET NULL ON UPDATE CASCADE;

-- CreateTable: InvitationRedemption
CREATE TABLE "InvitationRedemption" (
    "id" TEXT NOT NULL,
    "codeId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "redeemedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ip" TEXT,
    "userAgent" TEXT,

    CONSTRAINT "InvitationRedemption_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "InvitationRedemption_codeId_accountId_key"
    ON "InvitationRedemption"("codeId", "accountId");
CREATE INDEX "InvitationRedemption_accountId_idx"
    ON "InvitationRedemption"("accountId");
CREATE INDEX "InvitationRedemption_codeId_redeemedAt_idx"
    ON "InvitationRedemption"("codeId", "redeemedAt" DESC);

ALTER TABLE "InvitationRedemption"
ADD CONSTRAINT "InvitationRedemption_codeId_fkey"
FOREIGN KEY ("codeId") REFERENCES "InvitationCode"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "InvitationRedemption"
ADD CONSTRAINT "InvitationRedemption_accountId_fkey"
FOREIGN KEY ("accountId") REFERENCES "Account"("id")
ON DELETE CASCADE ON UPDATE CASCADE;
