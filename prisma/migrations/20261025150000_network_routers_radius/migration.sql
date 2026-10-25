BEGIN;

-- CreateEnum
CREATE TYPE "RouterStatus" AS ENUM ('UNKNOWN', 'ONLINE', 'OFFLINE', 'ERROR');

-- CreateEnum
CREATE TYPE "PppoeAuthMode" AS ENUM ('LOCAL', 'RADIUS');

-- CreateEnum
CREATE TYPE "NetworkOperationStatus" AS ENUM ('QUEUED', 'RUNNING', 'RETRYING', 'SUCCEEDED', 'SIMULATED', 'FAILED', 'CANCELLED');

-- AlterTable
ALTER TABLE "Package" ADD COLUMN     "networkProfile" TEXT;

-- AlterTable
ALTER TABLE "Subscription" ADD COLUMN     "networkPasswordEnc" TEXT,
ADD COLUMN     "networkRouterId" UUID,
ADD COLUMN     "networkStatus" TEXT NOT NULL DEFAULT 'NOT_PROVISIONED',
ADD COLUMN     "networkUpdatedAt" TIMESTAMPTZ(6),
ADD COLUMN     "networkUsername" TEXT;

-- AlterTable
ALTER TABLE "VoucherBatch" ADD COLUMN     "routerId" UUID;

-- CreateTable
CREATE TABLE "Router" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "branchId" UUID,
    "name" TEXT NOT NULL,
    "host" TEXT NOT NULL,
    "apiPort" INTEGER NOT NULL DEFAULT 8728,
    "useTls" BOOLEAN NOT NULL DEFAULT false,
    "pppoeAuth" "PppoeAuthMode" NOT NULL DEFAULT 'LOCAL',
    "hotspotEnabled" BOOLEAN NOT NULL DEFAULT false,
    "pppoeEnabled" BOOLEAN NOT NULL DEFAULT true,
    "status" "RouterStatus" NOT NULL DEFAULT 'UNKNOWN',
    "identity" TEXT,
    "routerOsVersion" TEXT,
    "boardName" TEXT,
    "lastSeenAt" TIMESTAMPTZ(6),
    "lastCheckedAt" TIMESTAMPTZ(6),
    "lastError" TEXT,
    "notes" TEXT,
    "archivedAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "Router_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RouterCredential" (
    "routerId" UUID NOT NULL,
    "encryptedSecret" TEXT NOT NULL,
    "updatedById" UUID,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "RouterCredential_pkey" PRIMARY KEY ("routerId")
);

-- CreateTable
CREATE TABLE "NetworkOperation" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "routerId" UUID,
    "subscriberId" UUID,
    "subscriptionId" UUID,
    "redemptionId" UUID,
    "type" TEXT NOT NULL,
    "params" JSONB NOT NULL,
    "status" "NetworkOperationStatus" NOT NULL DEFAULT 'QUEUED',
    "verification" TEXT NOT NULL DEFAULT 'PENDING',
    "idempotencyKey" TEXT NOT NULL,
    "requestedById" UUID,
    "requestedBy" TEXT NOT NULL,
    "resultDetail" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 5,
    "backgroundOperationId" UUID,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMPTZ(6),
    "completedAt" TIMESTAMPTZ(6),
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "NetworkOperation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NetworkOperationAttempt" (
    "id" UUID NOT NULL,
    "operationId" UUID NOT NULL,
    "attemptNumber" INTEGER NOT NULL,
    "outcome" TEXT NOT NULL,
    "errorCode" TEXT,
    "detail" TEXT,
    "durationMs" INTEGER NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "NetworkOperationAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NetworkSession" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "routerId" UUID NOT NULL,
    "subscriberId" UUID,
    "kind" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "address" TEXT,
    "macAddress" TEXT,
    "uptimeSeconds" INTEGER,
    "bytesIn" BIGINT,
    "bytesOut" BIGINT,
    "source" TEXT NOT NULL,
    "startedAt" TIMESTAMPTZ(6),
    "lastSeenAt" TIMESTAMPTZ(6) NOT NULL,
    "endedAt" TIMESTAMPTZ(6),

    CONSTRAINT "NetworkSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RouterAlert" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "routerId" UUID,
    "operationId" UUID,
    "type" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMPTZ(6),

    CONSTRAINT "RouterAlert_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Router_organizationId_status_idx" ON "Router"("organizationId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Router_organizationId_name_key" ON "Router"("organizationId", "name");

-- CreateIndex
CREATE INDEX "NetworkOperation_organizationId_status_createdAt_idx" ON "NetworkOperation"("organizationId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "NetworkOperation_routerId_createdAt_idx" ON "NetworkOperation"("routerId", "createdAt");

-- CreateIndex
CREATE INDEX "NetworkOperation_subscriptionId_idx" ON "NetworkOperation"("subscriptionId");

-- CreateIndex
CREATE UNIQUE INDEX "NetworkOperation_organizationId_idempotencyKey_key" ON "NetworkOperation"("organizationId", "idempotencyKey");

-- CreateIndex
CREATE INDEX "NetworkOperationAttempt_operationId_idx" ON "NetworkOperationAttempt"("operationId");

-- CreateIndex
CREATE INDEX "NetworkSession_organizationId_endedAt_idx" ON "NetworkSession"("organizationId", "endedAt");

-- CreateIndex
CREATE INDEX "NetworkSession_subscriberId_idx" ON "NetworkSession"("subscriberId");

-- CreateIndex
CREATE UNIQUE INDEX "NetworkSession_routerId_kind_externalId_key" ON "NetworkSession"("routerId", "kind", "externalId");

-- CreateIndex
CREATE INDEX "RouterAlert_organizationId_status_idx" ON "RouterAlert"("organizationId", "status");

-- CreateIndex
CREATE INDEX "RouterAlert_routerId_type_status_idx" ON "RouterAlert"("routerId", "type", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Subscription_organizationId_networkUsername_key" ON "Subscription"("organizationId", "networkUsername");

-- AddForeignKey
ALTER TABLE "RouterCredential" ADD CONSTRAINT "RouterCredential_routerId_fkey" FOREIGN KEY ("routerId") REFERENCES "Router"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NetworkOperationAttempt" ADD CONSTRAINT "NetworkOperationAttempt_operationId_fkey" FOREIGN KEY ("operationId") REFERENCES "NetworkOperation"("id") ON DELETE CASCADE ON UPDATE CASCADE;


COMMIT;
