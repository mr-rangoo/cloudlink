BEGIN;

-- CreateEnum
CREATE TYPE "VoucherStatus" AS ENUM ('UNUSED', 'REDEEMED', 'EXPIRED', 'VOID');

-- CreateTable
CREATE TABLE "Agent" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "branchId" UUID,
    "name" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "commissionRate" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "status" "RecordStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "Agent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VoucherBatch" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "branchId" UUID,
    "batchNumber" TEXT NOT NULL,
    "packageId" UUID NOT NULL,
    "packageName" TEXT NOT NULL,
    "durationUnit" "BillingUnit" NOT NULL,
    "durationCount" INTEGER NOT NULL,
    "downloadKbps" INTEGER,
    "uploadKbps" INTEGER,
    "netPrice" DECIMAL(14,2) NOT NULL,
    "taxRate" DECIMAL(5,2) NOT NULL,
    "faceValue" DECIMAL(14,2) NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "quantity" INTEGER NOT NULL,
    "agentId" UUID,
    "expiresAt" TIMESTAMPTZ(6),
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "notes" TEXT,
    "exportCount" INTEGER NOT NULL DEFAULT 0,
    "createdById" UUID,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "VoucherBatch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Voucher" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "batchId" UUID NOT NULL,
    "codeHash" TEXT NOT NULL,
    "codeEncrypted" TEXT NOT NULL,
    "codeHint" TEXT NOT NULL,
    "status" "VoucherStatus" NOT NULL DEFAULT 'UNUSED',
    "redeemedAt" TIMESTAMPTZ(6),
    "voidedAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Voucher_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VoucherRedemption" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "voucherId" UUID NOT NULL,
    "batchId" UUID NOT NULL,
    "agentId" UUID,
    "channel" TEXT NOT NULL,
    "clientMac" TEXT,
    "clientIp" TEXT,
    "redeemedByUserId" UUID,
    "faceValue" DECIMAL(14,2) NOT NULL,
    "accessEndsAt" TIMESTAMPTZ(6) NOT NULL,
    "activationStatus" TEXT NOT NULL DEFAULT 'PENDING',
    "activationDetail" TEXT,
    "activatedAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "VoucherRedemption_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentCommission" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "agentId" UUID NOT NULL,
    "redemptionId" UUID NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AgentCommission_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentRemittance" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "agentId" UUID NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "method" "PaymentMethod" NOT NULL,
    "reference" TEXT,
    "receivedAt" TIMESTAMPTZ(6) NOT NULL,
    "recordedById" UUID,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AgentRemittance_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Agent_organizationId_phone_key" ON "Agent"("organizationId", "phone");

-- CreateIndex
CREATE INDEX "VoucherBatch_organizationId_createdAt_idx" ON "VoucherBatch"("organizationId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "VoucherBatch_organizationId_batchNumber_key" ON "VoucherBatch"("organizationId", "batchNumber");

-- CreateIndex
CREATE INDEX "Voucher_batchId_status_idx" ON "Voucher"("batchId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Voucher_organizationId_codeHash_key" ON "Voucher"("organizationId", "codeHash");

-- CreateIndex
CREATE UNIQUE INDEX "VoucherRedemption_voucherId_key" ON "VoucherRedemption"("voucherId");

-- CreateIndex
CREATE INDEX "VoucherRedemption_organizationId_createdAt_idx" ON "VoucherRedemption"("organizationId", "createdAt");

-- CreateIndex
CREATE INDEX "VoucherRedemption_agentId_idx" ON "VoucherRedemption"("agentId");

-- CreateIndex
CREATE UNIQUE INDEX "AgentCommission_redemptionId_key" ON "AgentCommission"("redemptionId");

-- CreateIndex
CREATE INDEX "AgentCommission_agentId_idx" ON "AgentCommission"("agentId");

-- CreateIndex
CREATE INDEX "AgentRemittance_agentId_idx" ON "AgentRemittance"("agentId");

-- AddForeignKey
ALTER TABLE "Voucher" ADD CONSTRAINT "Voucher_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "VoucherBatch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VoucherRedemption" ADD CONSTRAINT "VoucherRedemption_voucherId_fkey" FOREIGN KEY ("voucherId") REFERENCES "Voucher"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "Agent" ADD CONSTRAINT "Agent_commission_range" CHECK ("commissionRate" >= 0 AND "commissionRate" <= 100);
ALTER TABLE "VoucherBatch" ADD CONSTRAINT "VoucherBatch_values" CHECK ("quantity" BETWEEN 1 AND 5000 AND "faceValue" >= 0 AND "netPrice" >= 0 AND "durationCount" >= 1);
ALTER TABLE "VoucherRedemption" ADD CONSTRAINT "VoucherRedemption_face" CHECK ("faceValue" >= 0);
ALTER TABLE "AgentCommission" ADD CONSTRAINT "AgentCommission_amount" CHECK ("amount" >= 0);
ALTER TABLE "AgentRemittance" ADD CONSTRAINT "AgentRemittance_amount" CHECK ("amount" > 0);
ALTER TABLE "Voucher" ADD CONSTRAINT "Voucher_redeemed_has_time" CHECK (("status" = 'REDEEMED') = ("redeemedAt" IS NOT NULL));
-- Redemptions, commissions and remittances are financial history: append-only.
CREATE TRIGGER "VoucherRedemption_no_delete" BEFORE DELETE ON "VoucherRedemption" FOR EACH ROW EXECUTE FUNCTION cloudlink_forbid_mutation();
CREATE TRIGGER "AgentCommission_append_only" BEFORE UPDATE OR DELETE ON "AgentCommission" FOR EACH ROW EXECUTE FUNCTION cloudlink_forbid_mutation();
CREATE TRIGGER "AgentRemittance_append_only" BEFORE UPDATE OR DELETE ON "AgentRemittance" FOR EACH ROW EXECUTE FUNCTION cloudlink_forbid_mutation();

COMMIT;
