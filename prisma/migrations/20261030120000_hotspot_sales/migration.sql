-- Hotspot self-service sales: plan purchases on the captive portal, hotspot subscriptions on routers.
-- Additive only (nullable columns or defaults).
BEGIN;

-- AlterTable
ALTER TABLE "PaymentAttempt" ADD COLUMN     "activatedAt" TIMESTAMPTZ(6),
ADD COLUMN     "clientIp" TEXT,
ADD COLUMN     "clientMac" TEXT,
ADD COLUMN     "packageId" UUID,
ADD COLUMN     "portalTokenHash" TEXT,
ADD COLUMN     "purpose" TEXT NOT NULL DEFAULT 'account',
ADD COLUMN     "routerId" UUID,
ADD COLUMN     "subscriptionId" UUID;

ALTER TABLE "PaymentAttempt"
  ADD CONSTRAINT "PaymentAttempt_purpose" CHECK ("purpose" IN ('account', 'hotspot_purchase')),
  ADD CONSTRAINT "PaymentAttempt_purchase_complete" CHECK ("purpose" <> 'hotspot_purchase' OR ("packageId" IS NOT NULL AND "portalTokenHash" IS NOT NULL));

-- AlterTable
ALTER TABLE "Router" ADD COLUMN     "hotspotDnsName" TEXT;
ALTER TABLE "Router" ADD CONSTRAINT "Router_hotspot_dns_name" CHECK ("hotspotDnsName" IS NULL OR "hotspotDnsName" ~ '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$');

-- AlterTable
ALTER TABLE "Subscriber" ADD COLUMN     "source" TEXT NOT NULL DEFAULT 'staff';
ALTER TABLE "Subscriber" ADD CONSTRAINT "Subscriber_source" CHECK ("source" IN ('staff', 'hotspot', 'import', 'lead'));

-- AlterTable
ALTER TABLE "Subscription" ADD COLUMN     "networkMac" TEXT;
ALTER TABLE "Subscription" ADD CONSTRAINT "Subscription_network_mac" CHECK ("networkMac" IS NULL OR "networkMac" ~ '^([0-9A-F]{2}:){5}[0-9A-F]{2}$');

-- CreateIndex
CREATE UNIQUE INDEX "PaymentAttempt_portalTokenHash_key" ON "PaymentAttempt"("portalTokenHash");

-- CreateIndex
CREATE INDEX "PaymentAttempt_subscriptionId_idx" ON "PaymentAttempt"("subscriptionId");

COMMIT;
