BEGIN;

-- AlterTable
ALTER TABLE "Router" ADD COLUMN     "onboardedAt" TIMESTAMPTZ(6),
ADD COLUMN     "onboardedFromIp" TEXT,
ADD COLUMN     "setupExpiresAt" TIMESTAMPTZ(6),
ADD COLUMN     "setupTokenHash" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Router_setupTokenHash_key" ON "Router"("setupTokenHash");


COMMIT;
