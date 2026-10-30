-- VIP flag on subscribers, and compensation support: a compensated period re-anchors billing at its new end, so the
-- current period index becomes -1 (the next regular period is index 0 from the new anchor). Additive / relaxing only.
BEGIN;

-- AlterTable
ALTER TABLE "Subscriber" ADD COLUMN     "vip" BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX "Subscriber_organizationId_vip_idx" ON "Subscriber"("organizationId") WHERE "vip";

ALTER TABLE "Subscription" DROP CONSTRAINT "Subscription_periodIndex_nonnegative";
ALTER TABLE "Subscription" ADD CONSTRAINT "Subscription_periodIndex_range" CHECK ("periodIndex" >= -1);

COMMIT;
