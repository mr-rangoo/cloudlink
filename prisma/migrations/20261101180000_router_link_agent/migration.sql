BEGIN;
-- AlterTable
ALTER TABLE "Router" ADD COLUMN     "agentKeyHash" TEXT,
ADD COLUMN     "agentLastSeenAt" TIMESTAMPTZ(6),
ADD COLUMN     "agentReport" JSONB,
ADD COLUMN     "linkedAt" TIMESTAMPTZ(6),
ADD COLUMN     "servicesConfig" JSONB,
ALTER COLUMN "host" DROP NOT NULL;

-- CreateTable
CREATE TABLE "RouterChange" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "routerId" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "config" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "deliveries" INTEGER NOT NULL DEFAULT 0,
    "requestedById" UUID,
    "error" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deliveredAt" TIMESTAMPTZ(6),
    "appliedAt" TIMESTAMPTZ(6),

    CONSTRAINT "RouterChange_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "RouterChange_routerId_status_idx" ON "RouterChange"("routerId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Router_agentKeyHash_key" ON "Router"("agentKeyHash");

-- AddForeignKey
ALTER TABLE "RouterChange" ADD CONSTRAINT "RouterChange_routerId_fkey" FOREIGN KEY ("routerId") REFERENCES "Router"("id") ON DELETE CASCADE ON UPDATE CASCADE;


ALTER TABLE "RouterChange" ADD CONSTRAINT "RouterChange_status" CHECK ("status" IN ('PENDING', 'DELIVERED', 'APPLIED', 'FAILED', 'SUPERSEDED'));
ALTER TABLE "RouterChange" ADD CONSTRAINT "RouterChange_kind" CHECK ("kind" IN ('services'));

COMMIT;
