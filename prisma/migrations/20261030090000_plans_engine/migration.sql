-- Plans engine: plan kinds, availability, burst, fair use policy, time-of-day schedule and router (NAS) restriction.
-- Additive only: new columns are nullable or have defaults, so existing packages keep their behaviour.
BEGIN;

-- CreateEnum
CREATE TYPE "PackageKind" AS ENUM ('TIME', 'DATA', 'TRIAL', 'DEVICE');

-- AlterEnum (PostgreSQL 12+ allows this inside a transaction; the value is not used before COMMIT)
ALTER TYPE "BillingUnit" ADD VALUE 'MINUTE' BEFORE 'HOUR';

-- AlterTable
ALTER TABLE "Package" ADD COLUMN     "burstDownloadKbps" INTEGER,
ADD COLUMN     "burstThresholdDownloadKbps" INTEGER,
ADD COLUMN     "burstThresholdUploadKbps" INTEGER,
ADD COLUMN     "burstTimeSeconds" INTEGER,
ADD COLUMN     "burstUploadKbps" INTEGER,
ADD COLUMN     "fupAction" TEXT,
ADD COLUMN     "fupDownloadKbps" INTEGER,
ADD COLUMN     "fupEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "fupThresholdMb" INTEGER,
ADD COLUMN     "fupUploadKbps" INTEGER,
ADD COLUMN     "highlight" TEXT,
ADD COLUMN     "kind" "PackageKind" NOT NULL DEFAULT 'TIME',
ADD COLUMN     "listed" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "scheduleDays" INTEGER,
ADD COLUMN     "scheduleEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "scheduleEndMinute" INTEGER,
ADD COLUMN     "scheduleStartMinute" INTEGER,
ADD COLUMN     "sortOrder" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "trialCooldownDays" INTEGER;

ALTER TABLE "Package"
  ADD CONSTRAINT "Package_burst_positive" CHECK (
    ("burstDownloadKbps" IS NULL OR "burstDownloadKbps" > 0) AND ("burstUploadKbps" IS NULL OR "burstUploadKbps" > 0)
    AND ("burstThresholdDownloadKbps" IS NULL OR "burstThresholdDownloadKbps" > 0) AND ("burstThresholdUploadKbps" IS NULL OR "burstThresholdUploadKbps" > 0)
    AND ("burstTimeSeconds" IS NULL OR "burstTimeSeconds" BETWEEN 1 AND 3600)),
  ADD CONSTRAINT "Package_burst_all_or_none" CHECK (
    ("burstDownloadKbps" IS NULL AND "burstUploadKbps" IS NULL AND "burstThresholdDownloadKbps" IS NULL AND "burstThresholdUploadKbps" IS NULL AND "burstTimeSeconds" IS NULL)
    OR ("burstDownloadKbps" IS NOT NULL AND "burstUploadKbps" IS NOT NULL AND "burstThresholdDownloadKbps" IS NOT NULL AND "burstThresholdUploadKbps" IS NOT NULL AND "burstTimeSeconds" IS NOT NULL)),
  ADD CONSTRAINT "Package_fup_action" CHECK ("fupAction" IS NULL OR "fupAction" IN ('THROTTLE', 'DISCONNECT')),
  ADD CONSTRAINT "Package_fup_complete" CHECK (
    NOT "fupEnabled" OR ("fupThresholdMb" > 0 AND "fupAction" IS NOT NULL AND ("fupAction" = 'DISCONNECT' OR ("fupDownloadKbps" > 0 AND "fupUploadKbps" > 0)))),
  ADD CONSTRAINT "Package_schedule_range" CHECK (
    ("scheduleStartMinute" IS NULL OR "scheduleStartMinute" BETWEEN 0 AND 1439)
    AND ("scheduleEndMinute" IS NULL OR "scheduleEndMinute" BETWEEN 0 AND 1439)
    AND ("scheduleDays" IS NULL OR "scheduleDays" BETWEEN 1 AND 127)),
  ADD CONSTRAINT "Package_schedule_complete" CHECK (
    NOT "scheduleEnabled" OR ("scheduleStartMinute" IS NOT NULL AND "scheduleEndMinute" IS NOT NULL AND "scheduleStartMinute" <> "scheduleEndMinute")),
  ADD CONSTRAINT "Package_highlight" CHECK ("highlight" IS NULL OR "highlight" IN ('POPULAR', 'OFFER')),
  ADD CONSTRAINT "Package_trial_cooldown" CHECK ("trialCooldownDays" IS NULL OR "trialCooldownDays" BETWEEN 0 AND 3650),
  ADD CONSTRAINT "Package_quota_positive" CHECK ("dataQuotaMb" IS NULL OR "dataQuotaMb" > 0);

-- CreateTable
CREATE TABLE "PackageRouter" (
    "packageId" UUID NOT NULL,
    "routerId" UUID NOT NULL,
    "organizationId" UUID NOT NULL,

    CONSTRAINT "PackageRouter_pkey" PRIMARY KEY ("packageId","routerId")
);

-- CreateIndex
CREATE INDEX "PackageRouter_routerId_idx" ON "PackageRouter"("routerId");

-- AddForeignKey
ALTER TABLE "PackageRouter" ADD CONSTRAINT "PackageRouter_packageId_fkey" FOREIGN KEY ("packageId") REFERENCES "Package"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PackageRouter" ADD CONSTRAINT "PackageRouter_routerId_fkey" FOREIGN KEY ("routerId") REFERENCES "Router"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- A restriction may only name a router of the plan's own organization.
CREATE FUNCTION package_router_same_org() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "Package" p JOIN "Router" r ON r."organizationId" = p."organizationId"
                 WHERE p."id" = NEW."packageId" AND r."id" = NEW."routerId" AND p."organizationId" = NEW."organizationId") THEN
    RAISE EXCEPTION 'package and router must belong to the same organization';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER package_router_same_org BEFORE INSERT OR UPDATE ON "PackageRouter" FOR EACH ROW EXECUTE FUNCTION package_router_same_org();

COMMIT;
