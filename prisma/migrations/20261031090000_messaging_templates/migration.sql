-- Messaging: expiry reminder lead time per organization, and non-secret notification metadata (e.g. the voucher
-- whose code the worker fills in at send time, so the code is never stored in the message). Additive only.
BEGIN;

-- AlterTable
ALTER TABLE "BillingSettings" ADD COLUMN     "expiryReminderDays" INTEGER NOT NULL DEFAULT 3;

-- AlterTable
ALTER TABLE "Notification" ADD COLUMN     "metadata" JSONB;

ALTER TABLE "BillingSettings" ADD CONSTRAINT "BillingSettings_expiryReminderDays" CHECK ("expiryReminderDays" BETWEEN 0 AND 30);

COMMIT;
