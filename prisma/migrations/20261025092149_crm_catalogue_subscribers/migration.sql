-- CreateEnum
CREATE TYPE "ServiceType" AS ENUM ('PPPOE', 'HOTSPOT', 'STATIC_IP', 'OTHER');

-- CreateEnum
CREATE TYPE "BillingUnit" AS ENUM ('HOUR', 'DAY', 'WEEK', 'MONTH', 'YEAR');

-- CreateEnum
CREATE TYPE "SubscriberType" AS ENUM ('INDIVIDUAL', 'BUSINESS');

-- CreateEnum
CREATE TYPE "SubscriberStatus" AS ENUM ('ACTIVE', 'INACTIVE', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "SubscriptionStatus" AS ENUM ('PENDING', 'ACTIVE', 'SUSPENDED', 'EXPIRED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "LeadStage" AS ENUM ('NEW', 'CONTACTED', 'QUALIFIED', 'SITE_SURVEY', 'PROPOSAL', 'WON', 'LOST');

-- CreateEnum
CREATE TYPE "LeadSource" AS ENUM ('WALK_IN', 'REFERRAL', 'WEBSITE', 'SOCIAL_MEDIA', 'PHONE_CALL', 'FIELD_AGENT', 'OTHER');

-- CreateEnum
CREATE TYPE "ImportJobStatus" AS ENUM ('PREVIEWED', 'COMMITTED', 'FAILED');

-- CreateTable
CREATE TABLE "OrganizationCounter" (
    "organizationId" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "value" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "OrganizationCounter_pkey" PRIMARY KEY ("organizationId","key")
);

-- CreateTable
CREATE TABLE "Package" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "serviceType" "ServiceType" NOT NULL,
    "price" DECIMAL(14,2) NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "taxRate" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "billingUnit" "BillingUnit" NOT NULL DEFAULT 'MONTH',
    "billingCount" INTEGER NOT NULL DEFAULT 1,
    "downloadKbps" INTEGER,
    "uploadKbps" INTEGER,
    "dataQuotaMb" INTEGER,
    "deviceLimit" INTEGER,
    "status" "RecordStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "Package_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Subscriber" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "branchId" UUID,
    "accountNumber" TEXT NOT NULL,
    "type" "SubscriberType" NOT NULL DEFAULT 'INDIVIDUAL',
    "displayName" TEXT NOT NULL,
    "firstName" TEXT,
    "lastName" TEXT,
    "companyName" TEXT,
    "email" TEXT,
    "emailNormalized" TEXT,
    "phone" TEXT NOT NULL,
    "altPhone" TEXT,
    "idNumber" TEXT,
    "status" "SubscriberStatus" NOT NULL DEFAULT 'ACTIVE',
    "notes" TEXT,
    "createdById" UUID,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "Subscriber_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SubscriberContact" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "subscriberId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "phone" TEXT,
    "email" TEXT,
    "relationship" TEXT,
    "isPrimary" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SubscriberContact_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SubscriberAddress" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "subscriberId" UUID NOT NULL,
    "label" TEXT NOT NULL DEFAULT 'Installation',
    "line1" TEXT NOT NULL,
    "area" TEXT,
    "town" TEXT,
    "county" TEXT,
    "latitude" DECIMAL(9,6),
    "longitude" DECIMAL(9,6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SubscriberAddress_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SubscriberActivity" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "subscriberId" UUID NOT NULL,
    "actorUserId" UUID,
    "type" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "metadata" JSONB,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SubscriberActivity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Subscription" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "branchId" UUID,
    "subscriberId" UUID NOT NULL,
    "packageId" UUID NOT NULL,
    "status" "SubscriptionStatus" NOT NULL DEFAULT 'PENDING',
    "packageName" TEXT NOT NULL,
    "serviceType" "ServiceType" NOT NULL,
    "price" DECIMAL(14,2) NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "taxRate" DECIMAL(5,2) NOT NULL,
    "billingUnit" "BillingUnit" NOT NULL,
    "billingCount" INTEGER NOT NULL,
    "billingAnchorAt" TIMESTAMPTZ(6),
    "periodIndex" INTEGER NOT NULL DEFAULT 0,
    "currentPeriodStart" TIMESTAMPTZ(6),
    "currentPeriodEnd" TIMESTAMPTZ(6),
    "nextBillingAt" TIMESTAMPTZ(6),
    "graceDays" INTEGER NOT NULL DEFAULT 0,
    "autoRenew" BOOLEAN NOT NULL DEFAULT true,
    "activatedAt" TIMESTAMPTZ(6),
    "suspendedAt" TIMESTAMPTZ(6),
    "cancelledAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "Subscription_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SubscriptionEvent" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "subscriptionId" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "fromStatus" "SubscriptionStatus",
    "toStatus" "SubscriptionStatus",
    "actorUserId" UUID,
    "actorType" TEXT NOT NULL,
    "metadata" JSONB,
    "idempotencyKey" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SubscriptionEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Lead" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "branchId" UUID,
    "name" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "email" TEXT,
    "emailNormalized" TEXT,
    "source" "LeadSource" NOT NULL DEFAULT 'OTHER',
    "stage" "LeadStage" NOT NULL DEFAULT 'NEW',
    "ownerId" UUID,
    "interestedPackageId" UUID,
    "location" TEXT,
    "notes" TEXT,
    "lostReason" TEXT,
    "convertedSubscriberId" UUID,
    "convertedAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "Lead_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LeadActivity" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "leadId" UUID NOT NULL,
    "actorUserId" UUID,
    "type" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "metadata" JSONB,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LeadActivity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ImportJob" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "status" "ImportJobStatus" NOT NULL DEFAULT 'PREVIEWED',
    "fileName" TEXT NOT NULL,
    "totalRows" INTEGER NOT NULL,
    "validRows" INTEGER NOT NULL,
    "errorRows" INTEGER NOT NULL,
    "errors" JSONB NOT NULL,
    "normalizedRows" JSONB,
    "createdById" UUID,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "committedAt" TIMESTAMPTZ(6),

    CONSTRAINT "ImportJob_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Package_organizationId_status_idx" ON "Package"("organizationId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Package_organizationId_name_key" ON "Package"("organizationId", "name");

-- CreateIndex
CREATE INDEX "Subscriber_organizationId_status_createdAt_idx" ON "Subscriber"("organizationId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "Subscriber_organizationId_phone_idx" ON "Subscriber"("organizationId", "phone");

-- CreateIndex
CREATE INDEX "Subscriber_organizationId_emailNormalized_idx" ON "Subscriber"("organizationId", "emailNormalized");

-- CreateIndex
CREATE INDEX "Subscriber_organizationId_branchId_idx" ON "Subscriber"("organizationId", "branchId");

-- CreateIndex
CREATE UNIQUE INDEX "Subscriber_organizationId_accountNumber_key" ON "Subscriber"("organizationId", "accountNumber");

-- CreateIndex
CREATE INDEX "SubscriberContact_subscriberId_idx" ON "SubscriberContact"("subscriberId");

-- CreateIndex
CREATE INDEX "SubscriberAddress_subscriberId_idx" ON "SubscriberAddress"("subscriberId");

-- CreateIndex
CREATE INDEX "SubscriberActivity_subscriberId_createdAt_idx" ON "SubscriberActivity"("subscriberId", "createdAt");

-- CreateIndex
CREATE INDEX "SubscriberActivity_organizationId_createdAt_idx" ON "SubscriberActivity"("organizationId", "createdAt");

-- CreateIndex
CREATE INDEX "Subscription_organizationId_status_nextBillingAt_idx" ON "Subscription"("organizationId", "status", "nextBillingAt");

-- CreateIndex
CREATE INDEX "Subscription_organizationId_status_currentPeriodEnd_idx" ON "Subscription"("organizationId", "status", "currentPeriodEnd");

-- CreateIndex
CREATE INDEX "Subscription_subscriberId_idx" ON "Subscription"("subscriberId");

-- CreateIndex
CREATE INDEX "SubscriptionEvent_organizationId_createdAt_idx" ON "SubscriptionEvent"("organizationId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "SubscriptionEvent_subscriptionId_idempotencyKey_key" ON "SubscriptionEvent"("subscriptionId", "idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "Lead_convertedSubscriberId_key" ON "Lead"("convertedSubscriberId");

-- CreateIndex
CREATE INDEX "Lead_organizationId_stage_createdAt_idx" ON "Lead"("organizationId", "stage", "createdAt");

-- CreateIndex
CREATE INDEX "Lead_organizationId_phone_idx" ON "Lead"("organizationId", "phone");

-- CreateIndex
CREATE INDEX "Lead_organizationId_ownerId_idx" ON "Lead"("organizationId", "ownerId");

-- CreateIndex
CREATE INDEX "LeadActivity_leadId_createdAt_idx" ON "LeadActivity"("leadId", "createdAt");

-- CreateIndex
CREATE INDEX "ImportJob_organizationId_createdAt_idx" ON "ImportJob"("organizationId", "createdAt");

-- AddForeignKey
ALTER TABLE "SubscriberContact" ADD CONSTRAINT "SubscriberContact_subscriberId_fkey" FOREIGN KEY ("subscriberId") REFERENCES "Subscriber"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SubscriberAddress" ADD CONSTRAINT "SubscriberAddress_subscriberId_fkey" FOREIGN KEY ("subscriberId") REFERENCES "Subscriber"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SubscriberActivity" ADD CONSTRAINT "SubscriberActivity_subscriberId_fkey" FOREIGN KEY ("subscriberId") REFERENCES "Subscriber"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Subscription" ADD CONSTRAINT "Subscription_subscriberId_fkey" FOREIGN KEY ("subscriberId") REFERENCES "Subscriber"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Subscription" ADD CONSTRAINT "Subscription_packageId_fkey" FOREIGN KEY ("packageId") REFERENCES "Package"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SubscriptionEvent" ADD CONSTRAINT "SubscriptionEvent_subscriptionId_fkey" FOREIGN KEY ("subscriptionId") REFERENCES "Subscription"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Lead" ADD CONSTRAINT "Lead_interestedPackageId_fkey" FOREIGN KEY ("interestedPackageId") REFERENCES "Package"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Lead" ADD CONSTRAINT "Lead_convertedSubscriberId_fkey" FOREIGN KEY ("convertedSubscriberId") REFERENCES "Subscriber"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeadActivity" ADD CONSTRAINT "LeadActivity_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE CASCADE ON UPDATE CASCADE;
