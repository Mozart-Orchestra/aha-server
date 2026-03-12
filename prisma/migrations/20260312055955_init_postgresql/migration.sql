-- CreateEnum
CREATE TYPE "RelationshipStatus" AS ENUM ('none', 'requested', 'pending', 'friend', 'rejected');

-- CreateTable
CREATE TABLE "Account" (
    "id" TEXT NOT NULL,
    "publicKey" TEXT NOT NULL,
    "googleId" TEXT,
    "seq" INTEGER NOT NULL DEFAULT 0,
    "feedSeq" TEXT NOT NULL DEFAULT '0',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "settings" TEXT,
    "settingsVersion" INTEGER NOT NULL DEFAULT 0,
    "githubUserId" TEXT,
    "firstName" TEXT,
    "lastName" TEXT,
    "username" TEXT,
    "avatar" JSONB,

    CONSTRAINT "Account_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TerminalAuthRequest" (
    "id" TEXT NOT NULL,
    "publicKey" TEXT NOT NULL,
    "supportsV2" BOOLEAN NOT NULL DEFAULT false,
    "response" TEXT,
    "responseAccountId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TerminalAuthRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AccountAuthRequest" (
    "id" TEXT NOT NULL,
    "publicKey" TEXT NOT NULL,
    "response" TEXT,
    "responseAccountId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AccountAuthRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AccountPushToken" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AccountPushToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "tag" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "metadata" TEXT NOT NULL,
    "metadataVersion" INTEGER NOT NULL DEFAULT 0,
    "agentState" TEXT,
    "agentStateVersion" INTEGER NOT NULL DEFAULT 0,
    "dataEncryptionKey" BYTEA,
    "seq" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "lastActiveAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "displayName" TEXT,
    "machineId" TEXT,
    "mode" TEXT,
    "roleId" TEXT,
    "rootPathHash" TEXT,

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SessionMessage" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "localId" TEXT,
    "seq" INTEGER NOT NULL,
    "content" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SessionMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GithubUser" (
    "id" TEXT NOT NULL,
    "profile" JSONB NOT NULL,
    "token" BYTEA,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GithubUser_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GithubOrganization" (
    "id" TEXT NOT NULL,
    "profile" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GithubOrganization_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GlobalLock" (
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GlobalLock_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "RepeatKey" (
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RepeatKey_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "SimpleCache" (
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SimpleCache_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "UsageReport" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "sessionId" TEXT,
    "data" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UsageReport_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Machine" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "metadata" TEXT NOT NULL,
    "metadataVersion" INTEGER NOT NULL DEFAULT 0,
    "daemonState" TEXT,
    "daemonStateVersion" INTEGER NOT NULL DEFAULT 0,
    "dataEncryptionKey" BYTEA,
    "seq" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "lastActiveAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Machine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UploadedFile" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "width" INTEGER,
    "height" INTEGER,
    "thumbhash" TEXT,
    "reuseKey" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UploadedFile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ServiceAccountToken" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "vendor" TEXT NOT NULL,
    "token" BYTEA NOT NULL,
    "metadata" JSONB,
    "lastUsedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ServiceAccountToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Artifact" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "header" BYTEA NOT NULL,
    "headerVersion" INTEGER NOT NULL DEFAULT 0,
    "body" BYTEA NOT NULL,
    "bodyVersion" INTEGER NOT NULL DEFAULT 0,
    "dataEncryptionKey" BYTEA NOT NULL,
    "seq" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Artifact_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AccessKey" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "machineId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "data" TEXT NOT NULL,
    "dataVersion" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AccessKey_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserRelationship" (
    "fromUserId" TEXT NOT NULL,
    "toUserId" TEXT NOT NULL,
    "status" "RelationshipStatus" NOT NULL DEFAULT 'pending',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "acceptedAt" TIMESTAMP(3),
    "lastNotifiedAt" TIMESTAMP(3),

    CONSTRAINT "UserRelationship_pkey" PRIMARY KEY ("fromUserId","toUserId")
);

-- CreateTable
CREATE TABLE "UserFeedItem" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "counter" TEXT NOT NULL,
    "repeatKey" TEXT,
    "body" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UserFeedItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserKVStore" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "value" BYTEA,
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UserKVStore_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RoleEmbedding" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "roleKey" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "embedding" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RoleEmbedding_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeviceCode" (
    "id" TEXT NOT NULL,
    "userCode" TEXT NOT NULL,
    "deviceCode" TEXT NOT NULL,
    "accountId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "publicKey" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DeviceCode_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Team" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Team_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TeamRole" (
    "id" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TeamRole_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TeamMember" (
    "teamId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "roleId" TEXT NOT NULL,
    "displayName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TeamMember_pkey" PRIMARY KEY ("teamId","sessionId")
);

-- CreateTable
CREATE TABLE "RuntimeAgent" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "roleId" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "machineId" TEXT NOT NULL,
    "displayName" TEXT,
    "status" TEXT NOT NULL DEFAULT 'spawning',
    "currentTaskId" TEXT,
    "tokenUsed" INTEGER NOT NULL DEFAULT 0,
    "cpuPercent" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "memoryMb" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "rootPath" TEXT,
    "spawnedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastHeartbeatAt" TIMESTAMP(3) NOT NULL,
    "stoppedAt" TIMESTAMP(3),

    CONSTRAINT "RuntimeAgent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TeamTask" (
    "id" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "status" TEXT NOT NULL DEFAULT 'todo',
    "priority" INTEGER NOT NULL DEFAULT 0,
    "assigneeId" TEXT,
    "createdById" TEXT NOT NULL,
    "dueDate" TIMESTAMP(3),
    "order" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TeamTask_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TeamMessage" (
    "id" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "senderId" TEXT NOT NULL,
    "content" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TeamMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentGenome" (
    "id" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "roleId" TEXT,
    "roleName" TEXT,
    "genomeType" TEXT NOT NULL DEFAULT 'seed',
    "parentGenomeId" TEXT,
    "generation" INTEGER NOT NULL DEFAULT 0,
    "variantOf" TEXT,
    "runtime" JSONB,
    "prompt" JSONB,
    "tools" JSONB,
    "permissions" JSONB,
    "budgets" JSONB,
    "memory" JSONB,
    "evaluation" JSONB,
    "fitnessScore" DOUBLE PRECISION,
    "fitnessFactors" JSONB,
    "reliabilityScore" DOUBLE PRECISION,
    "tokenEfficiency" DOUBLE PRECISION,
    "taskCompletionRate" DOUBLE PRECISION,
    "status" TEXT NOT NULL DEFAULT 'active',
    "isCurrent" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "lastUsedAt" TIMESTAMP(3),
    "promotedFrom" TEXT,
    "rejectedAt" TIMESTAMP(3),
    "rejectionReason" TEXT,

    CONSTRAINT "AgentGenome_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Account_publicKey_key" ON "Account"("publicKey");

-- CreateIndex
CREATE UNIQUE INDEX "Account_googleId_key" ON "Account"("googleId");

-- CreateIndex
CREATE UNIQUE INDEX "Account_githubUserId_key" ON "Account"("githubUserId");

-- CreateIndex
CREATE UNIQUE INDEX "Account_username_key" ON "Account"("username");

-- CreateIndex
CREATE UNIQUE INDEX "TerminalAuthRequest_publicKey_key" ON "TerminalAuthRequest"("publicKey");

-- CreateIndex
CREATE UNIQUE INDEX "AccountAuthRequest_publicKey_key" ON "AccountAuthRequest"("publicKey");

-- CreateIndex
CREATE UNIQUE INDEX "AccountPushToken_accountId_token_key" ON "AccountPushToken"("accountId", "token");

-- CreateIndex
CREATE INDEX "Session_accountId_updatedAt_idx" ON "Session"("accountId", "updatedAt" DESC);

-- CreateIndex
CREATE INDEX "Session_mode_idx" ON "Session"("mode");

-- CreateIndex
CREATE INDEX "Session_machineId_idx" ON "Session"("machineId");

-- CreateIndex
CREATE INDEX "Session_roleId_idx" ON "Session"("roleId");

-- CreateIndex
CREATE UNIQUE INDEX "Session_accountId_tag_key" ON "Session"("accountId", "tag");

-- CreateIndex
CREATE INDEX "SessionMessage_sessionId_seq_idx" ON "SessionMessage"("sessionId", "seq");

-- CreateIndex
CREATE UNIQUE INDEX "SessionMessage_sessionId_localId_key" ON "SessionMessage"("sessionId", "localId");

-- CreateIndex
CREATE INDEX "UsageReport_accountId_idx" ON "UsageReport"("accountId");

-- CreateIndex
CREATE INDEX "UsageReport_sessionId_idx" ON "UsageReport"("sessionId");

-- CreateIndex
CREATE UNIQUE INDEX "UsageReport_accountId_sessionId_key_key" ON "UsageReport"("accountId", "sessionId", "key");

-- CreateIndex
CREATE INDEX "Machine_accountId_idx" ON "Machine"("accountId");

-- CreateIndex
CREATE UNIQUE INDEX "Machine_accountId_id_key" ON "Machine"("accountId", "id");

-- CreateIndex
CREATE INDEX "UploadedFile_accountId_idx" ON "UploadedFile"("accountId");

-- CreateIndex
CREATE UNIQUE INDEX "UploadedFile_accountId_path_key" ON "UploadedFile"("accountId", "path");

-- CreateIndex
CREATE INDEX "ServiceAccountToken_accountId_idx" ON "ServiceAccountToken"("accountId");

-- CreateIndex
CREATE UNIQUE INDEX "ServiceAccountToken_accountId_vendor_key" ON "ServiceAccountToken"("accountId", "vendor");

-- CreateIndex
CREATE INDEX "Artifact_accountId_idx" ON "Artifact"("accountId");

-- CreateIndex
CREATE INDEX "Artifact_accountId_updatedAt_idx" ON "Artifact"("accountId", "updatedAt" DESC);

-- CreateIndex
CREATE INDEX "AccessKey_accountId_idx" ON "AccessKey"("accountId");

-- CreateIndex
CREATE INDEX "AccessKey_sessionId_idx" ON "AccessKey"("sessionId");

-- CreateIndex
CREATE INDEX "AccessKey_machineId_idx" ON "AccessKey"("machineId");

-- CreateIndex
CREATE UNIQUE INDEX "AccessKey_accountId_machineId_sessionId_key" ON "AccessKey"("accountId", "machineId", "sessionId");

-- CreateIndex
CREATE INDEX "UserRelationship_toUserId_status_idx" ON "UserRelationship"("toUserId", "status");

-- CreateIndex
CREATE INDEX "UserRelationship_fromUserId_status_idx" ON "UserRelationship"("fromUserId", "status");

-- CreateIndex
CREATE INDEX "UserFeedItem_userId_counter_idx" ON "UserFeedItem"("userId", "counter" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "UserFeedItem_userId_counter_key" ON "UserFeedItem"("userId", "counter");

-- CreateIndex
CREATE UNIQUE INDEX "UserFeedItem_userId_repeatKey_key" ON "UserFeedItem"("userId", "repeatKey");

-- CreateIndex
CREATE INDEX "UserKVStore_accountId_idx" ON "UserKVStore"("accountId");

-- CreateIndex
CREATE INDEX "UserKVStore_key_idx" ON "UserKVStore"("key");

-- CreateIndex
CREATE INDEX "UserKVStore_updatedAt_idx" ON "UserKVStore"("updatedAt" DESC);

-- CreateIndex
CREATE INDEX "UserKVStore_key_updatedAt_idx" ON "UserKVStore"("key", "updatedAt" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "UserKVStore_accountId_key_key" ON "UserKVStore"("accountId", "key");

-- CreateIndex
CREATE INDEX "RoleEmbedding_accountId_idx" ON "RoleEmbedding"("accountId");

-- CreateIndex
CREATE UNIQUE INDEX "RoleEmbedding_accountId_roleKey_key" ON "RoleEmbedding"("accountId", "roleKey");

-- CreateIndex
CREATE UNIQUE INDEX "DeviceCode_userCode_key" ON "DeviceCode"("userCode");

-- CreateIndex
CREATE UNIQUE INDEX "DeviceCode_deviceCode_key" ON "DeviceCode"("deviceCode");

-- CreateIndex
CREATE INDEX "DeviceCode_userCode_idx" ON "DeviceCode"("userCode");

-- CreateIndex
CREATE INDEX "DeviceCode_deviceCode_idx" ON "DeviceCode"("deviceCode");

-- CreateIndex
CREATE INDEX "DeviceCode_status_expiresAt_idx" ON "DeviceCode"("status", "expiresAt");

-- CreateIndex
CREATE INDEX "Team_accountId_idx" ON "Team"("accountId");

-- CreateIndex
CREATE INDEX "TeamRole_teamId_idx" ON "TeamRole"("teamId");

-- CreateIndex
CREATE UNIQUE INDEX "TeamRole_teamId_id_key" ON "TeamRole"("teamId", "id");

-- CreateIndex
CREATE INDEX "TeamMember_teamId_idx" ON "TeamMember"("teamId");

-- CreateIndex
CREATE INDEX "TeamMember_sessionId_idx" ON "TeamMember"("sessionId");

-- CreateIndex
CREATE INDEX "TeamMember_roleId_idx" ON "TeamMember"("roleId");

-- CreateIndex
CREATE UNIQUE INDEX "RuntimeAgent_sessionId_key" ON "RuntimeAgent"("sessionId");

-- CreateIndex
CREATE INDEX "RuntimeAgent_teamId_idx" ON "RuntimeAgent"("teamId");

-- CreateIndex
CREATE INDEX "RuntimeAgent_teamId_status_idx" ON "RuntimeAgent"("teamId", "status");

-- CreateIndex
CREATE INDEX "RuntimeAgent_accountId_idx" ON "RuntimeAgent"("accountId");

-- CreateIndex
CREATE INDEX "RuntimeAgent_machineId_idx" ON "RuntimeAgent"("machineId");

-- CreateIndex
CREATE INDEX "RuntimeAgent_status_idx" ON "RuntimeAgent"("status");

-- CreateIndex
CREATE INDEX "RuntimeAgent_spawnedAt_idx" ON "RuntimeAgent"("spawnedAt");

-- CreateIndex
CREATE INDEX "TeamTask_teamId_idx" ON "TeamTask"("teamId");

-- CreateIndex
CREATE INDEX "TeamTask_teamId_status_idx" ON "TeamTask"("teamId", "status");

-- CreateIndex
CREATE INDEX "TeamTask_assigneeId_idx" ON "TeamTask"("assigneeId");

-- CreateIndex
CREATE INDEX "TeamTask_createdById_idx" ON "TeamTask"("createdById");

-- CreateIndex
CREATE INDEX "TeamMessage_teamId_idx" ON "TeamMessage"("teamId");

-- CreateIndex
CREATE INDEX "TeamMessage_senderId_idx" ON "TeamMessage"("senderId");

-- CreateIndex
CREATE INDEX "TeamMessage_createdAt_idx" ON "TeamMessage"("createdAt");

-- CreateIndex
CREATE INDEX "AgentGenome_teamId_idx" ON "AgentGenome"("teamId");

-- CreateIndex
CREATE INDEX "AgentGenome_teamId_roleId_idx" ON "AgentGenome"("teamId", "roleId");

-- CreateIndex
CREATE INDEX "AgentGenome_teamId_status_idx" ON "AgentGenome"("teamId", "status");

-- CreateIndex
CREATE INDEX "AgentGenome_teamId_isCurrent_idx" ON "AgentGenome"("teamId", "isCurrent");

-- CreateIndex
CREATE INDEX "AgentGenome_fitnessScore_idx" ON "AgentGenome"("fitnessScore");

-- CreateIndex
CREATE INDEX "AgentGenome_parentGenomeId_idx" ON "AgentGenome"("parentGenomeId");

-- AddForeignKey
ALTER TABLE "Account" ADD CONSTRAINT "Account_githubUserId_fkey" FOREIGN KEY ("githubUserId") REFERENCES "GithubUser"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TerminalAuthRequest" ADD CONSTRAINT "TerminalAuthRequest_responseAccountId_fkey" FOREIGN KEY ("responseAccountId") REFERENCES "Account"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccountAuthRequest" ADD CONSTRAINT "AccountAuthRequest_responseAccountId_fkey" FOREIGN KEY ("responseAccountId") REFERENCES "Account"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccountPushToken" ADD CONSTRAINT "AccountPushToken_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SessionMessage" ADD CONSTRAINT "SessionMessage_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "Session"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UsageReport" ADD CONSTRAINT "UsageReport_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UsageReport" ADD CONSTRAINT "UsageReport_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "Session"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Machine" ADD CONSTRAINT "Machine_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UploadedFile" ADD CONSTRAINT "UploadedFile_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ServiceAccountToken" ADD CONSTRAINT "ServiceAccountToken_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Artifact" ADD CONSTRAINT "Artifact_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccessKey" ADD CONSTRAINT "AccessKey_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccessKey" ADD CONSTRAINT "AccessKey_accountId_machineId_fkey" FOREIGN KEY ("accountId", "machineId") REFERENCES "Machine"("accountId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccessKey" ADD CONSTRAINT "AccessKey_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "Session"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserRelationship" ADD CONSTRAINT "UserRelationship_fromUserId_fkey" FOREIGN KEY ("fromUserId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserRelationship" ADD CONSTRAINT "UserRelationship_toUserId_fkey" FOREIGN KEY ("toUserId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserFeedItem" ADD CONSTRAINT "UserFeedItem_userId_fkey" FOREIGN KEY ("userId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserKVStore" ADD CONSTRAINT "UserKVStore_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeviceCode" ADD CONSTRAINT "DeviceCode_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TeamRole" ADD CONSTRAINT "TeamRole_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TeamMember" ADD CONSTRAINT "TeamMember_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TeamMember" ADD CONSTRAINT "TeamMember_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "Session"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RuntimeAgent" ADD CONSTRAINT "RuntimeAgent_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TeamTask" ADD CONSTRAINT "TeamTask_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TeamMessage" ADD CONSTRAINT "TeamMessage_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE;
