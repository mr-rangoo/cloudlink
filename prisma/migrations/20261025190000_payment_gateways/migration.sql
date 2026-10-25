BEGIN;

-- CreateEnum
CREATE TYPE "PaymentAttemptStatus" AS ENUM ('PENDING', 'SUBMITTED', 'CONFIRMED', 'FAILED', 'CANCELLED', 'EXPIRED', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "WebhookEventStatus" AS ENUM ('RECEIVED', 'PROCESSED', 'REJECTED', 'FAILED');

-- CreateTable
CREATE TABLE "PaymentAttempt" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "subscriberId" UUID,
    "invoiceId" UUID,
    "provider" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "phone" TEXT NOT NULL,
    "accountReference" TEXT NOT NULL,
    "status" "PaymentAttemptStatus" NOT NULL DEFAULT 'PENDING',
    "idempotencyKey" TEXT NOT NULL,
    "callbackTokenHash" TEXT NOT NULL,
    "merchantRequestId" TEXT,
    "checkoutRequestId" TEXT,
    "resultCode" TEXT,
    "resultDesc" TEXT,
    "providerReceipt" TEXT,
    "paymentId" UUID,
    "requestedById" UUID,
    "requestedBy" TEXT NOT NULL,
    "detail" TEXT,
    "submittedAt" TIMESTAMPTZ(6),
    "completedAt" TIMESTAMPTZ(6),
    "lastQueriedAt" TIMESTAMPTZ(6),
    "queryCount" INTEGER NOT NULL DEFAULT 0,
    "metadata" JSONB,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "PaymentAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WebhookEvent" (
    "id" UUID NOT NULL,
    "organizationId" UUID,
    "provider" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "eventKey" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "status" "WebhookEventStatus" NOT NULL DEFAULT 'RECEIVED',
    "payload" JSONB NOT NULL,
    "attemptId" UUID,
    "paymentId" UUID,
    "error" TEXT,
    "sourceIp" TEXT,
    "duplicateCount" INTEGER NOT NULL DEFAULT 0,
    "conflictingDuplicate" BOOLEAN NOT NULL DEFAULT false,
    "receivedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMPTZ(6),

    CONSTRAINT "WebhookEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PaymentAttempt_callbackTokenHash_key" ON "PaymentAttempt"("callbackTokenHash");

-- CreateIndex
CREATE UNIQUE INDEX "PaymentAttempt_paymentId_key" ON "PaymentAttempt"("paymentId");

-- CreateIndex
CREATE INDEX "PaymentAttempt_organizationId_status_createdAt_idx" ON "PaymentAttempt"("organizationId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "PaymentAttempt_subscriberId_status_idx" ON "PaymentAttempt"("subscriberId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "PaymentAttempt_organizationId_idempotencyKey_key" ON "PaymentAttempt"("organizationId", "idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "PaymentAttempt_provider_checkoutRequestId_key" ON "PaymentAttempt"("provider", "checkoutRequestId");

-- CreateIndex
CREATE INDEX "WebhookEvent_organizationId_receivedAt_idx" ON "WebhookEvent"("organizationId", "receivedAt");

-- CreateIndex
CREATE INDEX "WebhookEvent_status_receivedAt_idx" ON "WebhookEvent"("status", "receivedAt");

-- CreateIndex
CREATE UNIQUE INDEX "WebhookEvent_provider_kind_eventKey_key" ON "WebhookEvent"("provider", "kind", "eventKey");


-- Domain rules
ALTER TABLE "PaymentAttempt" ADD CONSTRAINT "PaymentAttempt_amount_positive" CHECK ("amount" > 0);
ALTER TABLE "PaymentAttempt" ADD CONSTRAINT "PaymentAttempt_currency" CHECK ("currency" ~ '^[A-Z]{3}$');
ALTER TABLE "PaymentAttempt" ADD CONSTRAINT "PaymentAttempt_confirmed_has_payment" CHECK ("status" <> 'CONFIRMED' OR "paymentId" IS NOT NULL);
ALTER TABLE "WebhookEvent" ADD CONSTRAINT "WebhookEvent_duplicates" CHECK ("duplicateCount" >= 0);

-- An M-Pesa receipt can back only one live payment, whichever path recorded it (STK, C2B or manual entry).
CREATE UNIQUE INDEX "Payment_mpesa_receipt_live_key" ON "Payment" ("organizationId", "providerTransactionId")
  WHERE "method" = 'MPESA' AND "providerTransactionId" IS NOT NULL AND "status" <> 'REVERSED';

COMMIT;
