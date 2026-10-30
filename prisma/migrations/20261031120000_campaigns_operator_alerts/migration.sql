-- Bulk message campaigns (each recipient's message is a Notification with campaignId) and operator alert settings.
-- Additive only.
BEGIN;

-- AlterTable
ALTER TABLE "Notification" ADD COLUMN     "campaignId" UUID;

-- CreateTable
CREATE TABLE "MessageCampaign" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "channel" "NotificationChannel" NOT NULL,
    "kind" TEXT NOT NULL,
    "subject" TEXT,
    "body" TEXT NOT NULL,
    "audience" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "scheduledAt" TIMESTAMPTZ(6),
    "startedAt" TIMESTAMPTZ(6),
    "completedAt" TIMESTAMPTZ(6),
    "recipients" INTEGER NOT NULL DEFAULT 0,
    "queued" INTEGER NOT NULL DEFAULT 0,
    "skipped" INTEGER NOT NULL DEFAULT 0,
    "createdById" UUID,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "MessageCampaign_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OperatorAlertSettings" (
    "organizationId" UUID NOT NULL,
    "recipients" JSONB NOT NULL DEFAULT '[]',
    "events" JSONB NOT NULL DEFAULT '[]',
    "digestHour" INTEGER NOT NULL DEFAULT 7,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "OperatorAlertSettings_pkey" PRIMARY KEY ("organizationId")
);

-- CreateIndex
CREATE INDEX "MessageCampaign_organizationId_createdAt_idx" ON "MessageCampaign"("organizationId", "createdAt");

-- CreateIndex
CREATE INDEX "Notification_campaignId_status_idx" ON "Notification"("campaignId", "status");


ALTER TABLE "MessageCampaign" ADD CONSTRAINT "MessageCampaign_kind" CHECK ("kind" IN ('service', 'marketing'));
ALTER TABLE "MessageCampaign" ADD CONSTRAINT "MessageCampaign_status" CHECK ("status" IN ('DRAFT', 'SCHEDULED', 'SENDING', 'SENT', 'CANCELLED'));
ALTER TABLE "MessageCampaign" ADD CONSTRAINT "MessageCampaign_counts" CHECK ("recipients" >= 0 AND "queued" >= 0 AND "skipped" >= 0);
ALTER TABLE "OperatorAlertSettings" ADD CONSTRAINT "OperatorAlertSettings_digestHour" CHECK ("digestHour" BETWEEN 0 AND 23);

COMMIT;
