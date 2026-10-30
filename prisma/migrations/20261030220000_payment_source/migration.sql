-- How each payment arrived (staff entry, M-Pesa prompt, captive-portal purchase, paybill/till), for filters and
-- reports. Existing rows are backfilled from their linked M-Pesa request, else from the provider. Additive only.
BEGIN;

-- AlterTable
ALTER TABLE "Payment" ADD COLUMN     "source" TEXT NOT NULL DEFAULT 'manual';

-- CreateIndex
CREATE INDEX "Payment_organizationId_source_receivedAt_idx" ON "Payment"("organizationId", "source", "receivedAt");

UPDATE "Payment" p SET "source" = CASE WHEN a."purpose" = 'hotspot_purchase' THEN 'hotspot' ELSE 'stk' END
FROM "PaymentAttempt" a WHERE a."paymentId" = p."id";
UPDATE "Payment" p SET "source" = 'c2b'
WHERE p."provider" <> 'manual' AND NOT EXISTS (SELECT 1 FROM "PaymentAttempt" a WHERE a."paymentId" = p."id");

ALTER TABLE "Payment" ADD CONSTRAINT "Payment_source" CHECK ("source" IN ('manual', 'stk', 'hotspot', 'c2b'));

COMMIT;
