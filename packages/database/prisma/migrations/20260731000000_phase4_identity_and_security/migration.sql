-- AlterTable
ALTER TABLE "AuditLog" ADD COLUMN     "actorType" TEXT;

-- CreateTable
CREATE TABLE "SecurityEvent" (
    "id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "result" TEXT NOT NULL,
    "reason" TEXT,
    "actorId" TEXT,
    "actorType" TEXT,
    "organizationId" TEXT,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "requestId" TEXT,
    "application" TEXT,
    "provider" TEXT,
    "risk" JSONB,
    "context" JSONB,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SecurityEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ApiKey" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "keyPrefix" TEXT NOT NULL,
    "keyHash" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "scopes" TEXT[],
    "ipAllowlist" TEXT[],
    "expiresAt" TIMESTAMP(3),
    "lastUsedAt" TIMESTAMP(3),
    "lastUsedIp" TEXT,
    "usageCount" INTEGER NOT NULL DEFAULT 0,
    "revokedAt" TIMESTAMP(3),
    "revokedReason" TEXT,
    "rotatedFromId" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "ApiKey_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ServiceAccount" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "status" TEXT NOT NULL DEFAULT 'active',
    "roles" TEXT[],
    "scopes" TEXT[],
    "oidcClientId" TEXT,
    "credentialHash" TEXT,
    "credentialPrefix" TEXT,
    "credentialExpiresAt" TIMESTAMP(3),
    "credentialRotatedAt" TIMESTAMP(3),
    "lastUsedAt" TIMESTAMP(3),
    "lastUsedIp" TEXT,
    "expiresAt" TIMESTAMP(3),
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "ServiceAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserSession" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "familyId" TEXT NOT NULL,
    "clientId" TEXT,
    "deviceLabel" TEXT,
    "userAgent" TEXT,
    "ipHash" TEXT,
    "organizationId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastActivityAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "revokedReason" TEXT,
    "authenticationLevel" TEXT NOT NULL DEFAULT 'low',
    "mfaCompleted" BOOLEAN NOT NULL DEFAULT false,
    "provider" TEXT NOT NULL DEFAULT 'local',

    CONSTRAINT "UserSession_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SecurityEvent_type_occurredAt_idx" ON "SecurityEvent"("type", "occurredAt");

-- CreateIndex
CREATE INDEX "SecurityEvent_severity_occurredAt_idx" ON "SecurityEvent"("severity", "occurredAt");

-- CreateIndex
CREATE INDEX "SecurityEvent_organizationId_occurredAt_idx" ON "SecurityEvent"("organizationId", "occurredAt");

-- CreateIndex
CREATE INDEX "SecurityEvent_actorId_occurredAt_idx" ON "SecurityEvent"("actorId", "occurredAt");

-- CreateIndex
CREATE INDEX "SecurityEvent_requestId_idx" ON "SecurityEvent"("requestId");

-- CreateIndex
CREATE UNIQUE INDEX "ApiKey_keyHash_key" ON "ApiKey"("keyHash");

-- CreateIndex
CREATE INDEX "ApiKey_organizationId_revokedAt_idx" ON "ApiKey"("organizationId", "revokedAt");

-- CreateIndex
CREATE INDEX "ApiKey_keyPrefix_idx" ON "ApiKey"("keyPrefix");

-- CreateIndex
CREATE INDEX "ApiKey_expiresAt_idx" ON "ApiKey"("expiresAt");

-- CreateIndex
CREATE INDEX "ApiKey_deletedAt_idx" ON "ApiKey"("deletedAt");

-- CreateIndex
CREATE UNIQUE INDEX "ApiKey_organizationId_name_key" ON "ApiKey"("organizationId", "name");

-- CreateIndex
CREATE INDEX "ServiceAccount_organizationId_status_idx" ON "ServiceAccount"("organizationId", "status");

-- CreateIndex
CREATE INDEX "ServiceAccount_credentialPrefix_idx" ON "ServiceAccount"("credentialPrefix");

-- CreateIndex
CREATE INDEX "ServiceAccount_oidcClientId_idx" ON "ServiceAccount"("oidcClientId");

-- CreateIndex
CREATE INDEX "ServiceAccount_deletedAt_idx" ON "ServiceAccount"("deletedAt");

-- CreateIndex
CREATE UNIQUE INDEX "ServiceAccount_organizationId_name_key" ON "ServiceAccount"("organizationId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "UserSession_familyId_key" ON "UserSession"("familyId");

-- CreateIndex
CREATE INDEX "UserSession_userId_revokedAt_idx" ON "UserSession"("userId", "revokedAt");

-- CreateIndex
CREATE INDEX "UserSession_userId_lastActivityAt_idx" ON "UserSession"("userId", "lastActivityAt");

-- CreateIndex
CREATE INDEX "UserSession_expiresAt_idx" ON "UserSession"("expiresAt");

-- CreateIndex
CREATE INDEX "UserSession_revokedAt_idx" ON "UserSession"("revokedAt");


-- Refresh-token rotation: separate "used" from "revoked".
--
-- Reuse detection depends on telling them apart. A used token presented a second
-- time means the token was copied, and the response is to revoke the whole family;
-- a revoked token was already handled. Backfill marks every existing rotated token
-- as used, so history stays consistent with the new column.
ALTER TABLE "RefreshToken" ADD COLUMN "usedAt" TIMESTAMP(3);

UPDATE "RefreshToken"
SET "usedAt" = "revokedAt"
WHERE "revokedReason" = 'rotated' AND "revokedAt" IS NOT NULL;
