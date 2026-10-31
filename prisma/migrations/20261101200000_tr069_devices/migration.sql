BEGIN;
-- CreateTable
CREATE TABLE "Tr069Device" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "serialNumber" TEXT NOT NULL,
    "manufacturer" TEXT,
    "oui" TEXT,
    "productClass" TEXT,
    "softwareVersion" TEXT,
    "label" TEXT,
    "branchId" UUID,
    "subscriberId" UUID,
    "acsDeviceId" TEXT,
    "lastInformAt" TIMESTAMPTZ(6),
    "rxPowerDbm" DECIMAL(5,2),
    "ipAddress" TEXT,
    "simulated" BOOLEAN NOT NULL DEFAULT false,
    "lastSyncedAt" TIMESTAMPTZ(6),
    "createdById" UUID,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "Tr069Device_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Tr069Device_organizationId_lastInformAt_idx" ON "Tr069Device"("organizationId", "lastInformAt");

-- CreateIndex
CREATE INDEX "Tr069Device_subscriberId_idx" ON "Tr069Device"("subscriberId");

-- CreateIndex
CREATE UNIQUE INDEX "Tr069Device_organizationId_serialNumber_key" ON "Tr069Device"("organizationId", "serialNumber");


COMMIT;
